// Диспетчер — особая сессия Claude: помощник, который раздаёт работу остальным сессиям, следит за ними и докладывает.
// Сам код не пишет. Инструменты управления харнессом (MCP harness в mcp.ts) есть только у него.
// План — tmp/plans/krabness-dispatcher.md.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { applyEvent, emptyView, type CreateTaskRequest, type EngineId, type ModelRef, type PermissionReply, type QuestionAnswers, type SessionInfo, type SessionView, type TaskInfo } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { FILE_MARKER, type FileStore } from "./files.ts";
import { captureScreen } from "./screen.ts";
import { HttpError, type SessionManager } from "./sessions.ts";
import { L } from "./lang.ts";

/** Команды, на которые Диспетчер сам «да» не говорит: необратимое — только человек. */
export const DANGEROUS = /\bgit\s+(push|reset\s+--hard|clean\b|branch\s+-D|checkout\s+--\s|restore\b)|\brm\s+-|\bRemove-Item\b|\brmdir\b|\brd\s+\/s|\bdel\s|\bformat\s+[a-z]:|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b|\bshutdown\b/i;

const TEXT_MAX = 1500;
const USER_MAX = 600;
/** сколько последних событий журнала смотреть, чтобы пересказать сессию (весь журнал большой сессии — тысячи событий) */
const TAIL_EVENTS = 4000;

// ---------- компьютер: Windows-MCP (CursorTouch, MIT) ----------

/** версия закреплена: обновление чужого пакета с доступом к мыши и клавиатуре не должно приезжать само */
export const WINDOWS_MCP = "windows-mcp==0.8.8";
/** у Claude свои команды и файлы (через классификатор и подтверждения хаба) — второй путь к PowerShell, реестру и kill не нужен */
const WINDOWS_MCP_EXCLUDE = "PowerShell,FileSystem,Registry,Process,Notification,Scrape";
/** смотреть и двигать мышь — без вопросов; ввод, клавиши, запуск программ, буфер — решает классификатор Claude */
const COMPUTER_ALLOWED = ["Screenshot", "Snapshot", "DisplayInventory", "ControlStatus", "Wait", "WaitFor", "Click", "Move", "Scroll"].map((t) => `mcp__windows__${t}`);

/** uvx: в PATH, в ссылках winget или в папке пакета winget, в ~/.local/bin */
export function findUvx(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = process.platform === "win32" ? "uvx.exe" : "uvx";
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const local = env.LOCALAPPDATA;
  if (local) {
    dirs.push(join(local, "Microsoft", "WinGet", "Links"));
    const pkgs = join(local, "Microsoft", "WinGet", "Packages");
    try {
      for (const d of readdirSync(pkgs)) if (d.startsWith("astral-sh.uv_")) dirs.push(join(pkgs, d));
    } catch {
      // winget нет — ничего
    }
  }
  dirs.push(join(homedir(), ".local", "bin"));
  return dirs.map((d) => join(d, exe)).find((p) => existsSync(p));
}

/** Управление ПК доступно: Windows, не выключено в config, есть uvx. */
export function computerCommand(config: ConfigStore): string | undefined {
  if (process.platform !== "win32" || config.config.dispatcher?.computer === false) return undefined;
  return findUvx();
}

/** MCP «windows» и разрешённые инструменты — для сессии Диспетчера. */
export function computerExtras(uvx: string): { mcp: Record<string, unknown>; allowedTools: string[] } {
  return {
    mcp: { windows: { type: "stdio", command: uvx, args: [WINDOWS_MCP, "serve", "--exclude-tools", WINDOWS_MCP_EXCLUDE], env: { ANONYMIZED_TELEMETRY: "false" } } },
    allowedTools: COMPUTER_ALLOWED,
  };
}

function computerPrompt(): string {
  return L(
    `Компьютер (MCP windows): Screenshot/Snapshot — посмотреть экран и элементы, Click, Type, Shortcut, Scroll, Move, App (запустить или переключить программу), Clipboard, WaitFor. Показать экран пользователю — show_screen (снимки Windows-MCP отправить нельзя).
- Перед действием посмотри на экран (Snapshot), после — проверь результат.
- Отправить сообщение или письмо, оплатить, подтвердить покупку, удалить, выйти из аккаунта — только после «да» пользователя: спроси (AskUserQuestion) и дождись ответа.
- Окна KraBness, терминалы и редакторы, где работают агенты, не трогай без прямой просьбы.
- Пользователь может работать за ПК в это же время: не воюй за мышь, если ControlStatus говорит, что он активен — подожди или спроси.`,
    `Computer (MCP windows): Screenshot/Snapshot — look at the screen and its elements, Click, Type, Shortcut, Scroll, Move, App (launch or switch a program), Clipboard, WaitFor. To show the screen to the user — show_screen (Windows-MCP screenshots can't be sent).
- Look at the screen before acting (Snapshot), check the result after.
- Sending a message or an email, paying, confirming a purchase, deleting, signing out — only after the user's "yes": ask (AskUserQuestion) and wait for the answer.
- Don't touch KraBness windows, terminals and editors where agents work unless directly asked.
- The user may be at the PC at the same time: don't fight for the mouse — if ControlStatus says they are active, wait or ask.`,
  );
}

export function dispatcherPrompt(computer = false): string {
  return basePrompt() + (computer ? "\n\n" + computerPrompt() : "");
}

function basePrompt(): string {
  return L(
    `Ты — Диспетчер KraBness: личный помощник пользователя на его ПК. Тебя зовут голосом или текстом с телефона и с ПК.

Что ты делаешь:
- Раздаёшь работу кодинг-сессиям KraBness и следишь за ними: инструменты list_sessions, read_session, send_to_session, wait_session, answer_request, create_session, create_task, list_models.
- Код в проектах сам не пишешь и файлы проектов не правишь — это делают сессии. Твоя папка — для твоих заметок.
- Отвечаешь коротко: первая строка — итог (её могут озвучить), детали ниже.

Как работать с сессиями:
- Прежде чем писать в сессию, прочитай её хвост (read_session): что она делает, ждёт ли ответа.
- Пиши в сессию как постановщик задачи: что сделать и как проверить. Потом wait_session и доложи итог.
- Сессия спрашивает или просит разрешения — ответь сам (answer_request), если ответ очевиден из того, что хотел пользователь. Сомневаешься — спроси пользователя.
- Влить ветку, git push, удалить файлы или сессии, всё необратимое — никогда сам: только с прямого «да» пользователя в этом разговоре.
- Новая работа: сложное — сессия Claude (Opus или Sonnet), рутина и правки по списку — opencode с Kimi, если она есть в list_models. Большая задача от цели до отчёта — create_task.
- Не дёргай сессию, которая работает: дождись (wait_session).`,
    `You are the KraBness Dispatcher: the user's personal assistant on their PC. They call you by voice or text from the phone and the PC.

What you do:
- Hand out work to KraBness coding sessions and watch them: tools list_sessions, read_session, send_to_session, wait_session, answer_request, create_session, create_task, list_models.
- You don't write project code or edit project files yourself — sessions do that. Your folder is for your own notes.
- Answer briefly: the first line is the result (it may be read aloud), details below.

Working with sessions:
- Before writing to a session, read its tail (read_session): what it is doing, whether it is waiting for an answer.
- Write to a session like a task setter: what to do and how to check it. Then wait_session and report the result.
- A session asks a question or for permission — answer it yourself (answer_request) when the answer is obvious from what the user wanted. When in doubt, ask the user.
- Merging a branch, git push, deleting files or sessions, anything irreversible — never on your own: only with the user's direct "yes" in this conversation.
- New work: hard things — a Claude session (Opus or Sonnet), routine and list edits — opencode with Kimi if list_models has it. A big task from goal to report — create_task.
- Don't poke a session that is working: wait for it (wait_session).`,
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);
const hhmm = (ms: number) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");

/** Одна строка о сессии для списка. */
export function sessionLine(s: SessionInfo, last?: string): string {
  const model = `${s.engine} ${s.model.modelId}`;
  return `${s.id} · ${s.title} · ${s.status} · ${model} · ${s.directory}${last ? `\n    ↳ ${clip(last.replace(/\s+/g, " "), 160)}` : ""}`;
}

/** Пересказ хвоста сессии для агента: реплики без простыней инструментов, ждущие ответа запросы — с id. */
export function sessionDigest(view: SessionView, n: number): string {
  const info = view.info;
  const out: string[] = [];
  if (info) out.push(`# ${info.title} — ${info.status} · ${info.engine} ${info.model.modelId} · ${info.directory}`);
  const msgs = view.messages.filter((m) => m.parts.length).slice(-Math.max(1, n));
  for (const m of msgs) {
    const text = m.parts.flatMap((p) => (p.type === "text" && p.text.trim() ? [p.text.trim()] : [])).join("\n\n");
    const tools = new Map<string, number>();
    for (const p of m.parts) if (p.type === "tool") tools.set(p.tool, (tools.get(p.tool) ?? 0) + 1);
    const files = m.parts.flatMap((p) => (p.type === "file" ? [p.name] : []));
    const toolLine = tools.size ? `[${L("инструменты", "tools")}: ${[...tools].map(([t, c]) => (c > 1 ? `${t}×${c}` : t)).join(", ")}]` : "";
    const who = m.info.role === "user" ? L("пользователь", "user") : L("агент", "agent");
    const body = [text ? clip(text, m.info.role === "user" ? USER_MAX : TEXT_MAX) : "", toolLine, files.length ? `[${L("файлы", "files")}: ${files.join(", ")}]` : ""].filter(Boolean).join("\n");
    if (body) out.push(`[${who} ${hhmm(m.info.createdAt)}] ${body}`);
  }
  for (const p of view.permissions) out.push(`⏳ ${L("ждёт разрешения", "waiting for permission")}: request_id=${p.id} · ${p.tool}: ${clip(p.title, 300)}`);
  for (const q of view.questions) {
    const qs = q.questions.map((x, i) => `${i + 1}) ${x.question}${x.options.length ? ` [${x.options.map((o) => o.label).join(" | ")}]` : ""}`).join("; ");
    out.push(`❓ ${L("вопрос", "question")}: request_id=${q.id} · ${clip(qs, 800)}`);
  }
  if (view.errors.length) out.push(`⚠ ${clip(view.errors.at(-1)!, 400)}`);
  return out.join("\n\n");
}

export interface DispatcherDeps {
  sessions: SessionManager;
  config: ConfigStore;
  tasks?: { create(req: CreateTaskRequest): Promise<TaskInfo> };
  files?: FileStore;
  /** снимок экрана (в тестах — подделка) */
  screen?: () => Promise<Buffer>;
}

export class Dispatcher {
  /** когда Диспетчер последний раз написал в сессию и видели ли с тех пор «работает» — чтобы wait не вернулся до начала хода */
  private sent = new Map<string, { at: number; busy: boolean }>();
  private waiters = new Set<() => void>();

  constructor(private d: DispatcherDeps) {
    d.sessions.on("event", (e) => {
      if (e.event.type === "session.updated" && e.event.patch.status) {
        const s = this.sent.get(e.sessionId);
        if (s && e.event.patch.status === "busy") s.busy = true;
      }
      // любое событие может закончить ожидание: конец хода, новый вопрос или разрешение
      for (const w of [...this.waiters]) w();
    });
  }

  /** Сессия Диспетчера, если создана. */
  session(): SessionInfo | undefined {
    return this.d.sessions.list().filter((s) => s.kind === "dispatcher").sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** MCP-скоуп (id сессии Claude) принадлежит Диспетчеру? */
  isScope(engineSessionId: string): boolean {
    const id = this.d.sessions.idByEngine("claude", engineSessionId);
    return !!id && this.d.sessions.get(id).kind === "dispatcher";
  }

  /** Есть — вернуть, нет — создать: Claude, папка Dispatcher в первой разрешённой, режим «Автономно». */
  async ensure(): Promise<SessionInfo> {
    const have = this.session();
    if (have) return have;
    const root = this.d.config.config.roots[0];
    if (!root) throw new HttpError(409, L("Нет разрешённых папок", "No allowed folders"));
    const directory = join(root, "Dispatcher");
    mkdirSync(directory, { recursive: true });
    const model: ModelRef = { providerId: "anthropic", modelId: this.d.config.config.dispatcher?.model || "claude-opus-5-5" };
    return this.d.sessions.create({ engine: "claude", directory, model, permissionMode: "auto", title: L("🦀 Диспетчер", "🦀 Dispatcher"), kind: "dispatcher" });
  }

  // ---------- инструменты ----------

  private view(id: string): SessionView {
    const s = this.d.sessions.get(id);
    let view = emptyView(s);
    for (const e of this.d.sessions.eventsAfter(id, Math.max(0, s.lastSeq - TAIL_EVENTS))) view = applyEvent(view, e);
    view.info = this.d.sessions.get(id);
    return view;
  }

  private target(id: string): SessionInfo {
    const s = this.d.sessions.get(id);
    if (s.kind === "dispatcher") throw new HttpError(400, L("Это сессия самого Диспетчера", "This is the Dispatcher's own session"));
    return s;
  }

  listSessions(): string {
    const list = this.d.sessions.list().filter((s) => s.kind !== "dispatcher" && !s.taskId);
    if (!list.length) return L("Сессий нет.", "No sessions.");
    return list
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => {
        const v = this.view(s.id);
        const last = [...v.messages].reverse().find((m) => m.parts.some((p) => p.type === "text" && p.text.trim()));
        const text = last?.parts.find((p) => p.type === "text")?.text ?? "";
        const waiting = v.permissions.length || v.questions.length ? ` ⏳ ${L("ждёт ответа", "waiting for an answer")}` : "";
        return sessionLine(s, text) + waiting;
      })
      .join("\n");
  }

  readSession(id: string, n = 6): string {
    this.target(id);
    return sessionDigest(this.view(id), Math.min(Math.max(1, n), 40));
  }

  async send(id: string, text: string): Promise<string> {
    const s = this.target(id);
    if (!text.trim()) throw new HttpError(400, L("Пустое сообщение", "Empty message"));
    // отметка до отправки: движок может сказать «работает» ещё до того, как prompt вернётся
    this.sent.set(s.id, { at: Date.now(), busy: false });
    try {
      // пометка видна и человеку в чате сессии, и агенту: задачу поставил Диспетчер
      await this.d.sessions.prompt(s.id, `[${L("Диспетчер", "Dispatcher")}] ${text.trim()}`);
    } catch (e) {
      this.sent.delete(s.id);
      throw e;
    }
    return L(`Отправлено в «${s.title}». Дождись ответа: wait_session.`, `Sent to “${s.title}”. Wait for the answer: wait_session.`);
  }

  /** Ждёт конца хода (или вопроса, разрешения, ошибки) и возвращает пересказ хвоста. */
  async wait(id: string, timeoutSec = 300): Promise<string> {
    this.target(id);
    const deadline = Date.now() + Math.min(Math.max(5, timeoutSec), 1200) * 1000;
    const done = () => {
      const s = this.d.sessions.get(id);
      const v = this.view(id);
      if (v.permissions.length || v.questions.length) return true;
      const sent = this.sent.get(id);
      // только что отправили, а ход ещё не начался — ждём начала (но не вечно: промпт мог не дойти)
      if (sent && !sent.busy && Date.now() - sent.at < 20_000) return false;
      return s.status !== "busy" && s.status !== "retry";
    };
    while (!done()) {
      const left = deadline - Date.now();
      if (left <= 0) return L("Ещё работает (вышло время ожидания). Позже снова wait_session или read_session.", "Still working (wait timed out). Call wait_session or read_session again later.") + "\n\n" + this.readSession(id, 2);
      await new Promise<void>((resolve) => {
        const t = setTimeout(fin, Math.min(left, 5000));
        function fin() {
          clearTimeout(t);
          resolve();
        }
        const w = () => {
          this.waiters.delete(w);
          fin();
        };
        this.waiters.add(w);
      });
    }
    this.sent.delete(id);
    return this.readSession(id, 3);
  }

  async answer(id: string, requestId: string, reply?: string, answers?: string[][]): Promise<string> {
    this.target(id);
    const v = this.view(id);
    const perm = v.permissions.find((p) => p.id === requestId);
    if (perm) {
      const r = (reply ?? "") as PermissionReply;
      if (!["once", "always", "reject"].includes(r)) throw new HttpError(400, "reply: once | always | reject");
      if (r !== "reject" && DANGEROUS.test(`${perm.title}\n${JSON.stringify(perm.detail ?? "")}`)) {
        return L(
          "Отказано: это необратимое действие (push, удаление и т.п.). Спроси пользователя — он ответит в чате сессии или скажет тебе «да».",
          "Refused: this is an irreversible action (push, deletion, etc.). Ask the user — they will answer in the session chat or tell you “yes”.",
        );
      }
      await this.d.sessions.replyPermission(id, requestId, r, "dispatcher");
      return L(`Ответил: ${r}.`, `Replied: ${r}.`);
    }
    const q = v.questions.find((x) => x.id === requestId);
    if (q) {
      const a: QuestionAnswers = answers ?? (reply ? [[reply]] : null);
      await this.d.sessions.replyQuestion(id, requestId, a, "dispatcher");
      return L("Ответил на вопрос.", "Answered the question.");
    }
    throw new HttpError(404, L("Такого запроса нет (уже отвечен?). Посмотри read_session.", "No such request (already answered?). Check read_session."));
  }

  async createSession(req: { directory: string; engine: EngineId; model?: ModelRef; title?: string; worktree?: boolean }): Promise<string> {
    const s = await this.d.sessions.create({ directory: req.directory, engine: req.engine, permissionMode: "auto", ...(req.model ? { model: req.model } : {}), ...(req.title ? { title: req.title } : {}), ...(req.worktree ? { worktree: true } : {}) });
    return L(`Создана сессия ${s.id} (${s.engine} ${s.model.modelId}) в ${s.directory}.`, `Created session ${s.id} (${s.engine} ${s.model.modelId}) in ${s.directory}.`);
  }

  async createTask(req: { goal: string; directory: string; title?: string }): Promise<string> {
    if (!this.d.tasks) throw new HttpError(409, L("Задачи недоступны", "Tasks are unavailable"));
    const t = await this.d.tasks.create({ goal: req.goal, directory: req.directory, ...(req.title ? { title: req.title } : {}) });
    return L(`Задача ${t.id} «${t.title}» в очереди. Ход виден на странице задач.`, `Task ${t.id} “${t.title}” is queued. Progress is on the tasks page.`);
  }

  /** Снимок экрана пользователю в чат Диспетчера: снимки Windows-MCP лежат в служебной папке Claude, отправлять оттуда нельзя. */
  async showScreen(engineSessionId: string): Promise<string> {
    const d = this.session();
    if (!d || !this.d.files) throw new HttpError(409, L("Диспетчер не готов", "The Dispatcher isn't ready"));
    const jpg = await (this.d.screen ?? captureScreen)();
    const dir = join(d.directory, ".kamharn", "screens");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`);
    writeFileSync(path, jpg);
    const f = await this.d.files.registerOutgoing(path, engineSessionId);
    return `Screenshot sent to the user (${Math.ceil(f.size / 1024)} KB). ${FILE_MARKER}${f.id}`;
  }

  async listModels(): Promise<string> {
    const engines = await this.d.sessions.enginesInfo();
    return engines
      .map((e) => (e.available ? `${e.id}: ${e.models.map((m) => `${m.providerId}/${m.modelId}${m.free ? " (free)" : ""}`).join(", ")}` : `${e.id}: ${L("недоступен", "unavailable")} — ${e.error ?? ""}`))
      .join("\n");
  }
}
