// Диспетчер — особая сессия Claude: помощник, который раздаёт работу остальным сессиям, следит за ними и докладывает.
// Сам код не пишет. Инструменты управления харнессом (MCP harness в mcp.ts) есть только у него.
// План — tmp/plans/krabness-dispatcher.md.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { applyEvent, emptyView, type BrainDownReason, type BrainRef, type DispatcherBrains, type StoredEvent, type CreateTaskRequest, type EngineId, type ModelRef, type PermissionMode, type PermissionReply, type QuestionAnswers, type SessionInfo, type SessionView, type TaskInfo } from "@kamharn/protocol";
import { isLimitError, resumeTime } from "./autoresume.ts";
import type { ConfigStore } from "./config.ts";
import { authFailedText } from "./engines/claude.ts";
import type { PermissionRule } from "./engines/types.ts";
import { FILE_MARKER, type FileStore } from "./files.ts";
import { captureScreen } from "./screen.ts";
import { HttpError, type DispatcherHooks, type SessionManager } from "./sessions.ts";
import { L } from "./lang.ts";
import type { Memory } from "./memory.ts";

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
/** снимки — главный расход контекста: при 0,6 ~1,1 тыс. токенов вместо ~3,5 тыс., Sonnet попадает по кнопкам 52×22 (проба 2026-11-01, tmp/probe/alive-clicks.mjs) */
const SCREENSHOT_SCALE = "0.6";

// ---------- контекст: разбух — ответ всё дольше (297 тыс. токенов — 42 с до первого действия) ----------

/** тихое сжатие в паузу от этого размера */
const COMPACT_AT = 100_000;
/** пауза: разговор мог продолжиться, а кэш модели живёт 5 минут — позже сжатие перечитает всё заново */
const COMPACT_PAUSE_MS = 2 * 60_000;
/** защита внутри длинного хода (забег по сайту): порог CLI ниже окна на 25–30 тыс., здесь ~200 тыс. (проба tmp/probe/alive-compact.mjs) */
const COMPACT_WINDOW = "235000";

function compactInstructions(): string {
  return L(
    "Сохрани незавершённые поручения и обещания пользователю, решения и договорённости, какие сессии чем заняты. Содержимое снимков экрана и пройденные шаги не пересказывай.",
    "Keep unfinished tasks and promises to the user, decisions and agreements, which sessions are doing what. Don't retell screenshots or finished steps.",
  );
}

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
    mcp: { windows: { type: "stdio", command: uvx, args: [WINDOWS_MCP, "serve", "--exclude-tools", WINDOWS_MCP_EXCLUDE], env: { ANONYMIZED_TELEMETRY: "false", WINDOWS_MCP_SCREENSHOT_SCALE: SCREENSHOT_SCALE }, alwaysLoad: true } },
    allowedTools: COMPUTER_ALLOWED,
  };
}

// ---------- мозг на opencode: своих разрешений нет, поэтому белый список ----------

/** MCP мозга на opencode: только в папке Диспетчера (ensureMcp). Имя не kamharn: тот общий и есть у всех. */
const HARNESS_MCP = "krabness";
/** wait_session ждёт до 20 минут, а таймаут вызова у opencode задаётся на сервер */
const HARNESS_TIMEOUT = 21 * 60_000;
/** App ~20 с, Snapshot ~30 с; первый запуск uvx тоже укладывается сюда, если пакеты уже скачаны */
const WINDOWS_TIMEOUT = 120_000;

/**
 * Последнее совпавшее правило главное: всё незнакомое (в том числе свои MCP пользователя) спрашивает.
 * Мышь и снимки — без вопросов, как COMPUTER_ALLOWED у Claude; Type, Shortcut, App, Clipboard — с вопросом: классификатора у opencode нет.
 * task запрещён: события подсессий движок не показывает, карточка разрешения из неё не дошла бы, и ход завис бы.
 * Общий kamharn запрещён: send_file_to_user есть в своём сервере, с папкой сессии для относительных путей.
 * Проверено на Kimi: tmp/probe/oc-disp-2.mjs.
 */
export function opencodeRules(): PermissionRule[] {
  const rule = (permission: string, action: PermissionRule["action"], pattern = "*"): PermissionRule => ({ permission, pattern, action });
  return [
    rule("*", "ask"),
    ...["read", "glob", "grep", "list", "todowrite", "question", "skill", "webfetch", "websearch", "lsp", "doom_loop"].map((p) => rule(p, "allow")),
    rule("read", "ask", "*.env"),
    rule("edit", "allow"),
    rule("bash", "ask"),
    rule("task", "deny"),
    ...COMPUTER_ALLOWED.map((t) => rule(t.replace("mcp__windows__", "windows_"), "allow")),
    rule("kamharn_*", "deny"),
    rule(`${HARNESS_MCP}_*`, "allow"),
  ];
}

/** Режим подтверждений мозга: у Claude решает классификатор, у opencode спрашиваем (правила выше). */
const brainMode = (engine: EngineId): PermissionMode => (engine === "claude" ? "auto" : "acceptEdits");

/** Окружение процесса Claude у Диспетчера. */
export const DISPATCHER_ENV: Record<string, string> = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: COMPACT_WINDOW };

/** Windows-MCP как сервер в конфиге opencode. */
function opencodeWindows(uvx: string): Record<string, unknown> {
  const w = (computerExtras(uvx).mcp as { windows: { command: string; args: string[]; env: Record<string, string> } }).windows;
  return { type: "local", command: [w.command, ...w.args], environment: w.env, enabled: true, timeout: WINDOWS_TIMEOUT };
}

/** Скачать пакет и зависимости, не запуская сервер. */
function warmWindowsMcp(uvx: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(uvx, [WINDOWS_MCP, "--help"], { stdio: "ignore", windowsHide: true });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}

function computerPrompt(alt?: BrainPromptAlt): string {
  const text = L(
    `Компьютер (MCP windows): Screenshot/Snapshot — посмотреть экран и элементы, Click, Type, Shortcut, Scroll, Move, App (запустить или переключить программу), Clipboard, WaitFor. Показать экран пользователю — show_screen (снимки Windows-MCP отправить нельзя).
- Перед действием посмотри на экран, после — проверь результат.
- Снимки уменьшены: координаты с картинки умножай на Screenshot Coordinate Scale из ответа инструмента. Мелкий текст не читается — сними region.
- Скорость: Screenshot, Click, клавиши — доли секунды; App ~20 с, Snapshot ~30 с.
  - Открыть сайт или поиск на сайте — open_url (запрос — сразу в адресе), а не App + Ctrl+T + ввод адреса. Нужная вкладка уже открыта — кликни по ней.
  - Смотри через Screenshot (можно region). Snapshot — только если элемент не найти по снимку.
  - Окно переключай кликом по значку на панели задач или по окну. App — только запустить программу, которой там нет.
  - Не жди наугад: сразу Screenshot, не догрузилось — Wait 1–2 с и снова.
  - Предсказуемые шаги подряд — одним ответом (несколько вызовов), Screenshot в конце.
- Отправить сообщение или письмо, оплатить, подтвердить покупку, удалить, выйти из аккаунта — только после «да» пользователя: спроси (AskUserQuestion) и дождись ответа.
- Окна KraBness, терминалы и редакторы, где работают агенты, не трогай без прямой просьбы.
- Пользователь может работать за ПК в это же время: не воюй за мышь, если ControlStatus говорит, что он активен — подожди или спроси. CONTROL_UNAVAILABLE и короткий USER_CONTROL бывают и от сбоя: через 15 с проверь снова, прежде чем решить, что он вернулся.`,
    `Computer (MCP windows): Screenshot/Snapshot — look at the screen and its elements, Click, Type, Shortcut, Scroll, Move, App (launch or switch a program), Clipboard, WaitFor. To show the screen to the user — show_screen (Windows-MCP screenshots can't be sent).
- Look at the screen before acting, check the result after.
- Screenshots are downscaled: multiply image coordinates by the Screenshot Coordinate Scale from the tool's answer. Small text is unreadable — capture a region.
- Speed: Screenshot, Click, keys take a fraction of a second; App ~20 s, Snapshot ~30 s.
  - To open a site or search on a site — open_url (the query goes right into the address), not App + Ctrl+T + typing. The tab is already open — click it.
  - Look with Screenshot (region works too). Snapshot — only if you can't find the element on the screenshot.
  - Switch windows by clicking the taskbar icon or the window. App — only to launch a program that isn't there.
  - Don't wait blindly: Screenshot right away; not loaded yet — Wait 1–2 s and look again.
  - Predictable steps in a row — in one reply (several calls), Screenshot at the end.
- Sending a message or an email, paying, confirming a purchase, deleting, signing out — only after the user's "yes": ask (AskUserQuestion) and wait for the answer.
- Don't touch KraBness windows, terminals and editors where agents work unless directly asked.
- The user may be at the PC at the same time: don't fight for the mouse — if ControlStatus says they are active, wait or ask. CONTROL_UNAVAILABLE and a brief USER_CONTROL also come from a glitch: check again in 15 s before deciding they are back.`,
  );
  return alt ? text.replace("AskUserQuestion", "question") : text;
}

// ---------- память: два файла в папке Диспетчера, их текст — в его промпте ----------

export const MEMORY_FILES = { user: "USER.md", notes: "MEMORY.md" } as const;
/** больше — в промпт не тащим целиком: файл пора сжать */
const MEMORY_MAX = 8000;

function memoryHeader(kind: keyof typeof MEMORY_FILES): string {
  return kind === "user"
    ? L("# О пользователе\n\nКто он, как к нему обращаться, предпочтения, люди, устройства.\n", "# About the user\n\nWho they are, how to address them, preferences, people, devices.\n")
    : L("# Заметки Диспетчера\n\nДоговорённости, решения, где что лежит.\n", "# Dispatcher notes\n\nAgreements, decisions, where things are.\n");
}

/** Создать файлы памяти, если их нет. */
export function initMemory(dir: string): void {
  for (const kind of Object.keys(MEMORY_FILES) as Array<keyof typeof MEMORY_FILES>) {
    const p = join(dir, MEMORY_FILES[kind]);
    if (!existsSync(p)) writeFileSync(p, memoryHeader(kind));
  }
}

/** Текст памяти для промпта (пустые заготовки не тащим). */
export function memoryText(dir: string): string {
  const parts: string[] = [];
  for (const kind of Object.keys(MEMORY_FILES) as Array<keyof typeof MEMORY_FILES>) {
    let text = "";
    try {
      text = readFileSync(join(dir, MEMORY_FILES[kind]), "utf8").trim();
    } catch {
      continue;
    }
    if (!text || text === memoryHeader(kind).trim()) continue;
    if (text.length > MEMORY_MAX) text = text.slice(0, MEMORY_MAX) + L("\n…(дальше обрезано — сожми файл)", "\n…(cut — compact the file)");
    parts.push(`<${MEMORY_FILES[kind]}>\n${text}\n</${MEMORY_FILES[kind]}>`);
  }
  return parts.join("\n\n");
}

/** Дописать факт в память: about=user — о пользователе, иначе — в заметки. */
export function rememberFact(dir: string, fact: string, about: "user" | "notes"): string {
  const clean = fact.replace(/\s+/g, " ").trim();
  if (!clean) throw new HttpError(400, "Empty fact");
  const p = join(dir, MEMORY_FILES[about]);
  if (!existsSync(p)) writeFileSync(p, memoryHeader(about));
  if (statSync(p).size > MEMORY_MAX * 2) throw new HttpError(409, `${MEMORY_FILES[about]} is too big — compact it first (Edit the file: merge, drop stale lines).`);
  appendFileSync(p, `- ${clean} (${new Date().toISOString().slice(0, 10)})\n`);
  return `Saved to ${MEMORY_FILES[about]}.`;
}

function memoryPrompt(memory: string): string {
  return L(
    `Память (файлы USER.md и MEMORY.md в твоей папке; новое — remember, править и сжимать — обычным Edit). Что было раньше, по дням и по всем чатам, — recall: сначала вспомни и посмотри на проекты ниже, потом иди прямо туда, а не перебирай варианты. Точная фраза в чатах — search_history.\n\n${memory || "(пока пусто)"}`,
    `Memory (USER.md and MEMORY.md in your folder; new facts — remember, edit and compact — with a normal Edit). What happened before, by day and across all chats — recall: first remember and look at the projects below, then go straight there instead of trying options. An exact phrase in chats — search_history.\n\n${memory || "(empty so far)"}`,
  );
}

/** Отличия промпта мозга не на Claude. Для Claude их нет: лишнее изменение — перезапуск процесса и промах кэша. */
export interface BrainPromptAlt {
  /** есть инструмент ask_model */
  ask: boolean;
  /** запасной мозг: почему Claude недоступен и до какого времени */
  fallback?: { until?: number };
}

function altPrompt(alt: BrainPromptAlt): string {
  const until = alt.fallback?.until ? hhmm(alt.fallback.until) : "";
  const base = L(
    `Имена инструментов: инструменты хаба с приставкой ${HARNESS_MCP}_ (${HARNESS_MCP}_list_sessions), компьютера — windows_ (windows_Click). Отказ на карточке разрешения — решение пользователя: не обходи его другим путём, спроси (question). Субагентов нет.`,
    `Tool names: hub tools are prefixed ${HARNESS_MCP}_ (${HARNESS_MCP}_list_sessions), computer tools windows_ (windows_Click). A refusal on a permission card is the user's decision: don't work around it, ask (question). There are no subagents.`,
  );
  if (!alt.fallback) return base;
  return base + "\n" + L(
    `Сейчас ты запасной мозг: Claude недоступен${until ? ` до ${until}` : ""}. Новые сессии создавай в opencode.`,
    `You are the fallback brain right now: Claude is unavailable${until ? ` until ${until}` : ""}. Create new sessions in opencode.`,
  );
}

export function dispatcherPrompt(computer = false, memory?: string, extra?: string, alt?: BrainPromptAlt): string {
  return basePrompt(alt) + (computer ? "\n\n" + computerPrompt(alt) : "") + (memory !== undefined ? "\n\n" + memoryPrompt(memory) : "") + (extra ? "\n\n" + extra : "") + (alt ? "\n\n" + altPrompt(alt) : "");
}


function basePrompt(alt?: BrainPromptAlt): string {
  const noAsk = !!alt && !alt.ask;
  const tools = `list_sessions, read_session, send_to_session, wait_session, answer_request, create_session, create_task, list_models, search_history, remember${noAsk ? "" : ", ask_model"}`;
  const work = alt
    ? L("Новая работа: смотри, что есть в list_models; сложное — самая сильная модель, рутина и правки по списку — та, что дешевле.", "New work: see what list_models has; hard things — the strongest model, routine and list edits — a cheaper one.")
    : L("Новая работа: сложное — сессия Claude (Opus или Sonnet), рутина и правки по списку — opencode с Kimi, если она есть в list_models.", "New work: hard things — a Claude session (Opus or Sonnet), routine and list edits — opencode with Kimi if list_models has it.");
  const save = noAsk ? "" : L("\n- Береги лимит: пересказать, перевести, классифицировать, набросать текст — отдай ask_model (quick — Haiku, local — локальная модель, бесплатно).", "\n- Save the limit: summarizing, translating, classifying, drafting text — hand it to ask_model (quick — Haiku, local — the local model, free).");
  return L(
    `Ты — Диспетчер KraBness: личный помощник пользователя на его ПК. Тебя зовут голосом или текстом с телефона и с ПК.

Что ты делаешь:
- Раздаёшь работу кодинг-сессиям KraBness и следишь за ними: инструменты ${tools}.
- Код в проектах сам не пишешь и файлы проектов не правишь — это делают сессии. Твоя папка — для твоих заметок.
- Отвечаешь коротко: первая строка — итог (её могут озвучить), детали ниже.

Как работать с сессиями:
- Прежде чем писать в сессию, прочитай её хвост (read_session): что она делает, ждёт ли ответа.
- Пиши в сессию как постановщик задачи: что сделать и как проверить. Потом wait_session и доложи итог.
- Сессия спрашивает или просит разрешения — ответь сам (answer_request), если ответ очевиден из того, что хотел пользователь. Сомневаешься — спроси пользователя.
- Влить ветку, git push, удалить файлы или сессии, всё необратимое — никогда сам: только с прямого «да» пользователя в этом разговоре.
- ${work} Большая задача от цели до отчёта — create_task.
- Не дёргай сессию, которая работает: дождись (wait_session).${save}`,
    `You are the KraBness Dispatcher: the user's personal assistant on their PC. They call you by voice or text from the phone and the PC.

What you do:
- Hand out work to KraBness coding sessions and watch them: tools ${tools}.
- You don't write project code or edit project files yourself — sessions do that. Your folder is for your own notes.
- Answer briefly: the first line is the result (it may be read aloud), details below.

Working with sessions:
- Before writing to a session, read its tail (read_session): what it is doing, whether it is waiting for an answer.
- Write to a session like a task setter: what to do and how to check it. Then wait_session and report the result.
- A session asks a question or for permission — answer it yourself (answer_request) when the answer is obvious from what the user wanted. When in doubt, ask the user.
- Merging a branch, git push, deleting files or sessions, anything irreversible — never on your own: only with the user's direct "yes" in this conversation.
- ${work} A big task from goal to report — create_task.
- Don't poke a session that is working: wait for it (wait_session).${save}`,
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
  /** разовый вопрос модели Claude без инструментов (ClaudeEngine.ask) */
  ask?: (prompt: string, model: string) => Promise<string>;
  /** пауза перед тихим сжатием (в тестах — короткая) */
  compactPauseMs?: number;
  /** снимок экрана (в тестах — подделка) */
  screen?: () => Promise<Buffer>;
  /** открыть адрес в браузере по умолчанию (в тестах — подделка) */
  openUrl?: (url: string) => void;
  /** разовое уведомление пользователю */
  notify?: (sessionId: string, message: string) => void;
  log?: (m: string) => void;
  /** адрес MCP хаба без скоупа: мозгу на opencode его сервер подключаем сами */
  mcpBaseUrl?: () => string;
  /** MCP папки у opencode; нет — движка нет */
  opencodeMcp?: () => OpencodeMcp | undefined;
  /** погасить простаивающий процесс Claude (вместе с его Windows-MCP) */
  releaseClaude?: (engineSessionId: string) => void;
  /** запуск прогрева Windows-MCP (в тестах — подделка) */
  warmComputer?: (uvx: string) => Promise<boolean>;
  /** долгая память: дневник, факты, карта проектов; закрытых групп для Диспетчера нет */
  memory?: Memory;
}

export interface OpencodeMcp {
  ensureMcp(directory: string, servers: Record<string, Record<string, unknown>>): Promise<Record<string, { status: string; error?: string }>>;
  releaseMcp(directory: string, name: string): Promise<void>;
}

type BrainRole = "primary" | "fallback";

/** Что Диспетчер помнит о мозгах: на диске, переживает рестарт хаба. */
interface BrainState {
  active: BrainRole;
  reason?: BrainDownReason;
  /** раньше этого времени Claude упрётся в лимит */
  until?: number;
  /** сессия каждого движка под лентой */
  esids: Partial<Record<EngineId, string>>;
  /** докуда каждый движок читал ленту: остальное он получит сводкой */
  seen: Partial<Record<EngineId, number>>;
  /** что человек выбрал в шапке чата поверх настройки */
  chosen: Partial<Record<BrainRole, { model: ModelRef; effort?: string }>>;
  /** настройку поменяли: применить, даже если роль та же */
  dirty?: boolean;
  /** мозг сменился, следующее сообщение несёт ему сводку */
  catchUp?: { reason?: BrainDownReason };
  /** «Вернуть на основной»: окна лимитов старше этого не считаем */
  overrideAt?: number;
}

/** сводка для нового мозга: не длиннее, сообщений не больше */
const CATCHUP_MAX = 6000;
const CATCHUP_MESSAGES = 12;
/** окно на стороне Anthropic обновляется не мгновенно; rejected без окон считаем свежим столько */
const LIMIT_FRESH_MS = 30 * 60_000;
/** если повтор хода не начался (движок молчит), голос не должен ждать вечно */
const REROUTE_MAX_MS = 60_000;

/** Адрес — в браузере по умолчанию, без оболочки: `&` в адресе cmd не разрежет.
 *  Не explorer.exe: запущенный из хаба, он молча ничего не открывал (2026-11-01). Адрес сюда приходит уже проверенный (только http(s), нормализованный URL). */
function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
  p.on("error", () => {});
  p.unref();
}


// не \b: после кириллицы JS границу слова не видит
const YES = /^(да|давай|ага|угу|конечно|разрешаю|можно|ок|окей|отправляй|делай|yes|ok)(?!\p{L})/iu;
const NO = /^(нет|не надо|не нужно|отмена|отмени|стоп|no|cancel)(?!\p{L})/iu;

/** Ответ голосом на вопрос с вариантами: вариант, упомянутый в ответе; «да»/«нет» — первый/последний; иначе свой текст. */
export function matchAnswer(text: string, options: string[]): string {
  const said = text.trim().toLowerCase().replace(/[.!?…]+$/, "");
  const hit = options.find((o) => said.includes(o.toLowerCase().replace(/\s*\(.*\)$/, "")));
  if (hit) return hit;
  if (options.length && YES.test(said)) return options[0]!;
  if (options.length > 1 && NO.test(said)) return options.at(-1)!;
  return text.trim();
}

export class Dispatcher implements DispatcherHooks {
  /** когда Диспетчер последний раз написал в сессию и видели ли с тех пор «работает» — чтобы wait не вернулся до начала хода */
  private sent = new Map<string, { at: number; busy: boolean }>();
  private waiters = new Set<() => void>();
  private compactTimer?: NodeJS.Timeout;
  private quietTimer?: NodeJS.Timeout;
  /** ход, запущенный самим хабом: уведомления о его конце молчат */
  private quietRun?: string;
  private brainState?: BrainState;
  /** ход оборвался на лимите, идёт повтор на запасном: до этого времени ход для всех ещё идёт */
  private rerouteUntil = 0;
  /** следующая сводка говорит, что сообщение повторено */
  private repeating = false;
  /** мозг на opencode: что у него есть прямо сейчас (проверяется перед каждым сообщением) */
  private flags = { computer: false, ask: false, claudeUp: false };
  private warm?: "running" | "done" | "failed";
  private closed = false;

  constructor(private d: DispatcherDeps) {
    d.sessions.hooks = this;
    d.sessions.on("session.deleted", () => this.onDeleted());
    d.sessions.on("event", (e) => {
      this.onBrainEvent(e);
      if (e.event.type === "session.updated" && e.event.patch.status) {
        const s = this.sent.get(e.sessionId);
        if (s && e.event.patch.status === "busy") s.busy = true;
        if (e.sessionId === this.session()?.id) {
          this.planCompact(e.sessionId, e.event.patch.status);
          // снимаем с задержкой: уведомления смотрят на это же событие idle
          if (e.event.patch.status === "idle" && this.quietRun) this.quietTimer = setTimeout(() => (this.quietRun = undefined), 1000);
          if (e.event.patch.status === "busy") this.rerouteUntil = 0;
        }
      }
      // любое событие может закончить ожидание: конец хода, новый вопрос или разрешение
      for (const w of [...this.waiters]) w();
    });
  }

  start(): void {}

  close(): void {
    this.closed = true;
    this.rerouteUntil = 0;
    if (this.compactTimer) clearTimeout(this.compactTimer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
  }


  private computerOn(): boolean {
    return !!computerCommand(this.d.config);
  }


  /** Ход, запущенный самим хабом: его конец не повод для пуша «готово». Оборвавшийся ход, который сейчас повторится, — тоже. */
  quiet(sessionId: string): boolean {
    return this.quietRun === sessionId || this.rerouting(sessionId);
  }


  // ---------- контекст: сжатие в паузу ----------

  /** Ход кончился — через паузу проверить размер контекста; начался новый — отменить. */
  private planCompact(id: string, status: string): void {
    if (this.compactTimer) clearTimeout(this.compactTimer);
    this.compactTimer = undefined;
    if (status !== "idle") return;
    this.compactTimer = setTimeout(() => void this.autoCompact(id).catch(() => {}), this.d.compactPauseMs ?? COMPACT_PAUSE_MS);
    this.compactTimer.unref?.();
  }

  private async autoCompact(id: string): Promise<void> {
    const limit = this.d.config.config.dispatcher?.compactAt ?? COMPACT_AT;
    if (limit <= 0 || this.d.sessions.get(id).status !== "idle") return;
    if ((this.d.sessions.contextTokens(id) ?? 0) < limit) return;
    // ждёт ответа пользователя: пересказ сейчас только помешает
    const v = this.view(id);
    if (v.permissions.length || v.questions.length) return;
    // opencode сжимает обычным ходом: отметка в ленте остаётся, а пуш «готово» незачем
    if (this.d.sessions.get(id).engine !== "claude") this.quietRun = id;
    await this.d.sessions.compact(id, { silent: true, instructions: compactInstructions() });
  }


  /** Голосом (голос на ПК): ждёт ответа на вопрос или разрешение — это ответ; иначе — новое сообщение Диспетчеру. */
  async say(text: string, fileIds: string[] = []): Promise<{ sessionId: string; answered?: boolean }> {
    if (!text.trim()) throw new HttpError(400, L("Пустое сообщение", "Empty message"));
    const d = await this.ensure();
    const v = this.view(d.id);
    const q = v.questions[0];
    if (q && !fileIds.length) {
      await this.d.sessions.replyQuestion(d.id, q.id, [[matchAnswer(text, q.questions[0]?.options.map((o) => o.label) ?? [])]], "voice");
      return { sessionId: d.id, answered: true };
    }
    const p = v.permissions[0];
    if (p && (YES.test(text.trim()) || NO.test(text.trim()))) {
      await this.d.sessions.replyPermission(d.id, p.id, YES.test(text.trim()) ? "once" : "reject", "voice");
      return { sessionId: d.id, answered: true };
    }
    await this.d.sessions.prompt(d.id, text.trim(), fileIds);
    return { sessionId: d.id };
  }

  /** Сессия Диспетчера, если создана. */
  session(): SessionInfo | undefined {
    return this.d.sessions.list().filter((s) => s.kind === "dispatcher").sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** MCP-скоуп (id сессии движка) принадлежит Диспетчеру? */
  isScope(engineSessionId: string): boolean {
    return this.isClaudeBrain(engineSessionId) || this.isOpencodeBrain(engineSessionId);
  }

  private isClaudeBrain(engineSessionId: string): boolean {
    const id = this.d.sessions.idByEngine("claude", engineSessionId);
    return !!id && this.d.sessions.get(id).kind === "dispatcher";
  }

  isOpencodeBrain(engineSessionId: string): boolean {
    const id = this.d.sessions.idByEngine("opencode", engineSessionId);
    return !!id && this.d.sessions.get(id).kind === "dispatcher";
  }

  /** Есть — вернуть, нет — создать в папке Dispatcher первой разрешённой: на основном мозге или на том, что сейчас может работать. */
  async ensure(): Promise<SessionInfo> {
    const have = this.session();
    if (have) {
      initMemory(have.directory);
      return have;
    }
    const root = this.d.config.config.roots[0];
    if (!root) throw new HttpError(409, L("Нет разрешённых папок", "No allowed folders"));
    const directory = join(root, "Dispatcher");
    mkdirSync(directory, { recursive: true });
    initMemory(directory);
    const { brain, role } = await this.firstBrain();
    const s = await this.d.sessions.create(
      { engine: brain.engine, directory, model: brain.model, permissionMode: brainMode(brain.engine), title: L("🦀 Диспетчер", "🦀 Dispatcher"), kind: "dispatcher", ...(brain.effort ? { effort: brain.effort } : {}) },
      brain.engine === "opencode" ? { extraRules: opencodeRules() } : {},
    );
    this.brainState = { active: role, esids: { [brain.engine]: this.d.sessions.engineSessionIdOf(s.id)! }, seen: {}, chosen: {} };
    this.saveBrains();
    return s;
  }

  // ---------- мозги: одна лента, движок под ней меняется ----------

  private cfg() {
    return this.d.config.config.dispatcher ?? {};
  }

  private primary(): BrainRef {
    return this.cfg().primary ?? { engine: "claude", model: { providerId: "anthropic", modelId: this.cfg().model || "claude-sonnet-5-5" } };
  }

  private fallback(): BrainRef | null {
    return this.cfg().fallback ?? null;
  }

  private brain(role: BrainRole): BrainRef {
    return role === "fallback" ? (this.fallback() ?? this.primary()) : this.primary();
  }

  private get brainFile(): string {
    return join(this.d.config.config.dataDir, "dispatcher-brains.json");
  }

  /** Состояние с диска; запись сессии главнее: она и есть то, на чём Диспетчер работает. */
  private st(): BrainState {
    if (!this.brainState) {
      let st: BrainState | undefined;
      try {
        st = JSON.parse(readFileSync(this.brainFile, "utf8")) as BrainState;
      } catch {
        // первый запуск
      }
      this.brainState = { active: "primary", esids: {}, seen: {}, chosen: {}, ...st };
      const s = this.session();
      if (s) {
        this.brainState.esids[s.engine] = this.d.sessions.engineSessionIdOf(s.id)!;
        if (!st && s.engine !== this.primary().engine && s.engine === this.fallback()?.engine) this.brainState.active = "fallback";
      }
    }
    return this.brainState;
  }

  private saveBrains(): void {
    try {
      mkdirSync(this.d.config.config.dataDir, { recursive: true });
      writeFileSync(this.brainFile, JSON.stringify(this.st(), null, 1));
    } catch (e) {
      this.d.log?.(`[dispatcher] ${(e as Error).message}`);
    }
  }

  /** Запасной поможет, только если он не на том, что упало: лимит и вход Claude общие на все его модели. */
  private fallbackUsable(): boolean {
    const f = this.fallback();
    return !!f && this.cfg().autoFallback !== false && !(f.engine === "claude" && this.primary().engine === "claude");
  }

  /** Диспетчер сам уйдёт от лимита на запасной: автопродолжение ему не нужно. */
  handlesLimit(s: SessionInfo): boolean {
    return s.kind === "dispatcher" && this.fallbackUsable();
  }

  /** Лимит Claude: сам упёрся или окно уже заполнено другими сессиями (тогда даже не пробуем). */
  private claudeLimited(now = Date.now()): boolean {
    const st = this.st();
    if (st.until && st.until > now) return true;
    const l = this.d.sessions.limits;
    if (!l || l.updatedAt <= (st.overrideAt ?? 0)) return false;
    const full = [l.fiveHour, l.sevenDay].some((w) => !!w && w.resetsAt > now && w.utilization >= 0.99);
    if (!full && !(l.status === "rejected" && now - l.updatedAt < LIMIT_FRESH_MS)) return false;
    st.until = resumeTime("", l, now);
    this.saveBrains();
    return true;
  }

  /** Почему мозг сейчас работать не может. */
  private async down(b: BrainRef): Promise<BrainDownReason | undefined> {
    const info = await this.d.sessions.engineInfo(b.engine).catch(() => undefined);
    if (!info) return "unavailable";
    if (b.engine === "claude") {
      if (info.auth && !info.auth.installed) return "unavailable";
      if (info.auth && !info.auth.loggedIn) return "auth";
      // свой API-ключ: подписочных лимитов у него нет
      return !info.auth?.apiKey && this.claudeLimited() ? "limit" : undefined;
    }
    if (!info.available) return "unavailable";
    const m = info.models.find((x) => x.providerId === b.model.providerId && x.modelId === b.model.modelId);
    return !m || m.offline ? "unavailable" : undefined;
  }

  /** Первая модель opencode, которая может быть Диспетчером: с инструментами и запущенная. */
  private async opencodeBrain(): Promise<BrainRef | undefined> {
    const info = await this.d.sessions.engineInfo("opencode").catch(() => undefined);
    if (!info?.available) return undefined;
    const ok = (r?: ModelRef) => !!r && info.models.some((m) => m.providerId === r.providerId && m.modelId === r.modelId && m.tools !== false && !m.offline);
    const pref = this.d.config.config.newSession?.models?.opencode;
    const model = ok(pref) ? pref : ok(info.defaultModel) ? info.defaultModel : info.models.find((m) => m.tools && !m.offline);
    return model ? { engine: "opencode", model: { providerId: model.providerId, modelId: model.modelId } } : undefined;
  }

  /** На чём создать сессию. Без настройки и без входа в Claude основным становится модель opencode: так у человека с одним opencode Диспетчер просто работает. */
  private async firstBrain(): Promise<{ brain: BrainRef; role: BrainRole }> {
    const p = this.primary();
    const why = await this.down(p);
    if (!why || why === "limit") return { brain: p, role: "primary" };
    if (this.fallbackUsable() && !(await this.down(this.fallback()!))) return { brain: this.fallback()!, role: "fallback" };
    if (!this.cfg().primary) {
      const oc = await this.opencodeBrain();
      if (oc) {
        this.d.config.config.dispatcher = { ...this.cfg(), primary: oc };
        this.d.config.save();
        return { brain: oc, role: "primary" };
      }
      throw new HttpError(409, L("Диспетчеру нужна модель с инструментами: войди в Claude Code или подключи модель в «Настройки → Модели»", "The Dispatcher needs a model with tools: sign in to Claude Code or connect a model at Settings → Models"));
    }
    return { brain: p, role: "primary" };
  }

  /** Перед сообщением: занят или ждёт ответа — мозг не меняем; иначе выбрать, кто должен отвечать. */
  async beforePrompt(id: string): Promise<{ hidden?: string } | undefined> {
    const s = this.d.sessions.get(id);
    const v = this.view(id);
    if (s.status !== "busy" && s.status !== "retry" && !v.permissions.length && !v.questions.length) await this.pickBrain(s);
    const now = this.d.sessions.get(id);
    if (now.engine === "opencode") await this.prepareOpencode(now);
    const st = this.st();
    if (!st.catchUp) return undefined;
    const hidden = this.catchUpText(now, st.catchUp.reason);
    st.catchUp = undefined;
    this.repeating = false;
    this.saveBrains();
    return hidden ? { hidden } : undefined;
  }

  private async pickBrain(s: SessionInfo): Promise<void> {
    const st = this.st();
    const why = await this.down(this.primary());
    let role: BrainRole = "primary";
    if (why) {
      if (this.fallbackUsable() && !(await this.down(this.fallback()!))) role = "fallback";
      // основной лежит совсем, а этот работает: оставляем, ошибка «движок не запущен» никому не поможет
      else if (why === "unavailable") return;
    }
    if (role === st.active && !st.dirty && s.engine === this.brain(role).engine) {
      if (role === "fallback") st.reason = why;
      return;
    }
    await this.switchBrain(s, role, role === "fallback" ? why : undefined);
  }

  private async switchBrain(s: SessionInfo, role: BrainRole, reason?: BrainDownReason): Promise<void> {
    const st = this.st();
    const b = this.brain(role);
    // что человек выбрал в шапке чата, остаётся за тем мозгом
    if (!st.dirty) st.chosen[st.active] = { model: s.model, ...(s.effort ? { effort: s.effort } : {}) };
    const picked = st.chosen[role];
    const model = picked?.model ?? b.model;
    const effort = picked ? picked.effort : b.effort;
    const changed = s.engine !== b.engine;
    let esid = st.esids[b.engine];
    if (!esid) {
      esid = await this.d.sessions.createEngineSession(s.id, b.engine, { model, permissionMode: brainMode(b.engine), ...(b.engine === "opencode" ? { extraRules: opencodeRules() } : {}) });
      st.esids[b.engine] = esid;
    }
    if (changed) {
      st.seen[s.engine] = s.lastSeq;
      await this.releaseBrain(s);
      st.catchUp = { ...(reason ? { reason } : {}) };
    }
    this.d.sessions.setBrain(s.id, { engine: b.engine, engineSessionId: esid, model, permissionMode: brainMode(b.engine), ...(effort ? { effort } : {}) });
    st.active = role;
    st.reason = reason;
    st.dirty = false;
    this.saveBrains();
    if (changed) this.announce(s.id, reason, model);
  }

  /** Windows-MCP у прежнего мозга: два экземпляра со сторожем ввода могут принять чужой клик за человека. */
  private async releaseBrain(s: SessionInfo): Promise<void> {
    if (s.engine === "claude") {
      this.d.releaseClaude?.(this.d.sessions.engineSessionIdOf(s.id)!);
      return;
    }
    await this.d.opencodeMcp?.()?.releaseMcp(s.directory, "windows").catch(() => {});
  }

  /** Отметка в ленте и один пуш. */
  private announce(id: string, reason: BrainDownReason | undefined, model: ModelRef): void {
    const until = this.st().until && this.st().until! > Date.now() ? hhmm(this.st().until!) : "";
    const text = !reason
      ? L(`⇄ Дальше отвечает ${model.modelId}.`, `⇄ ${model.modelId} answers from here.`)
      : reason === "limit"
        ? L(`⇄ Claude упёрся в лимит${until ? ` до ${until}` : ""}. Пока отвечает ${model.modelId}.`, `⇄ Claude hit its limit${until ? ` until ${until}` : ""}. ${model.modelId} answers for now.`)
        : reason === "auth"
          ? L(`⇄ В Claude Code нет входа. Пока отвечает ${model.modelId}.`, `⇄ Claude Code is not signed in. ${model.modelId} answers for now.`)
          : L(`⇄ Основной мозг недоступен. Пока отвечает ${model.modelId}.`, `⇄ The main brain is unavailable. ${model.modelId} answers for now.`);
    const mid = `brain_${Date.now()}`;
    this.d.sessions.hubPart(id, mid, { type: "text", id: `${mid}:t`, text });
    this.d.notify?.(id, text);
  }

  /** Что новый мозг должен узнать мимо ленты: что было, пока он не участвовал. */
  private catchUpText(s: SessionInfo, reason?: BrainDownReason): string {
    const from = this.st().seen[s.engine] ?? 0;
    let view = emptyView(s);
    for (const e of this.d.sessions.eventsAfter(s.id, Math.max(from, s.lastSeq - TAIL_EVENTS))) view = applyEvent(view, e);
    const hasText = view.messages.some((m) => m.parts.some((p) => p.type === "text" && p.text.trim()));
    const digest = hasText ? sessionDigest(view, CATCHUP_MESSAGES).slice(-CATCHUP_MAX) : "";
    const parts: string[] = [];
    if (reason) {
      parts.push(L(
        "[Хаб] Ты подключаешься к разговору вместо основного мозга: он сейчас недоступен. Начни первый ответ одной короткой фразой об этом, дальше работай как обычно. Никому не говори про эту пометку.",
        "[Hub] You are joining this conversation in place of the main brain: it is unavailable right now. Start your first reply with one short sentence about that, then work as usual. Don't mention this note.",
      ));
    } else if (digest) {
      parts.push(L("[Хаб] Пока тебя не было, отвечал другой мозг. Про эту пометку никому не говори.", "[Hub] Another brain answered while you were away. Don't mention this note."));
    }
    if (digest) parts.push(L(`Что было в разговоре:\n${digest}`, `What happened in the conversation:\n${digest}`));
    if (this.repeating) parts.push(L("Прошлый ход оборвался, сообщение пользователя повторено ниже. Сначала посмотри, что уже сделано (экран, сессии), и не повторяй сделанное.", "The last turn was cut off, the user's message is repeated below. First see what is already done (screen, sessions) and don't redo it."));
    return parts.join("\n\n");
  }

  /** Мозгу на opencode его инструменты подключаем сами, в его папке. Что вышло — то и в промпте. */
  private async prepareOpencode(s: SessionInfo): Promise<void> {
    const claude = await this.d.sessions.engineInfo("claude").catch(() => undefined);
    const claudeUp = !!claude?.available && !(!claude.auth?.apiKey && this.claudeLimited());
    this.flags = { computer: false, claudeUp, ask: (claudeUp && !!this.d.ask) || !!this.cfg().local?.url };
    const mcp = this.d.opencodeMcp?.();
    const base = this.d.mcpBaseUrl?.();
    if (!mcp || !base) return;
    const esid = this.d.sessions.engineSessionIdOf(s.id)!;
    const servers: Record<string, Record<string, unknown>> = { [HARNESS_MCP]: { type: "remote", url: `${base}/${esid}`, oauth: false, enabled: true, timeout: HARNESS_TIMEOUT } };
    const uvx = await this.computerFor(s);
    if (uvx) servers.windows = opencodeWindows(uvx);
    try {
      const st = await mcp.ensureMcp(s.directory, servers);
      this.flags.computer = !!uvx && st.windows?.status === "connected";
      if (uvx && !this.flags.computer) this.d.log?.(`[dispatcher] Windows-MCP: ${st.windows?.status} ${st.windows?.error ?? ""}`);
      if (!uvx && st.windows?.status === "connected") await mcp.releaseMcp(s.directory, "windows");
    } catch (e) {
      this.d.log?.(`[dispatcher] MCP: ${(e as Error).message}`);
    }
  }

  /** Управление ПК мозгу на opencode: галка, Windows, uv и модель со зрением. */
  private async computerFor(s: SessionInfo): Promise<string | undefined> {
    if (this.cfg().computerOnOpencode !== true) return undefined;
    const uvx = computerCommand(this.d.config);
    if (!uvx) return undefined;
    const info = await this.d.sessions.engineInfo("opencode").catch(() => undefined);
    const m = info?.models.find((x) => x.providerId === s.model.providerId && x.modelId === s.model.modelId);
    return m?.vision ? uvx : undefined;
  }

  /** Системный промпт: у Claude ровно прежний, у opencode — с отличиями. */
  system(s: SessionInfo): string {
    if (s.engine === "claude") return dispatcherPrompt(!!computerCommand(this.d.config), this.memoryBlock(s.directory));
    const st = this.st();
    return dispatcherPrompt(this.flags.computer, this.memoryBlock(s.directory), undefined, { ask: this.flags.ask, ...(st.active === "fallback" ? { fallback: { ...(st.until ? { until: st.until } : {}) } } : {}) });
  }

  /** Файлы памяти плюс долгая память. */
  private memoryBlock(dir: string): string {
    return [memoryText(dir), this.d.memory?.dispatcherText() ?? ""].filter(Boolean).join("\n\n");
  }

  memoryOn(): boolean {
    return !!this.d.memory?.enabled;
  }

  async recall(query: string, day: string | undefined, limit: number): Promise<string> {
    if (!this.d.memory) throw new HttpError(409, L("Память выключена", "Memory is off"));
    const r = await this.d.memory.recall(query, { ...(day ? { day } : {}), limit });
    const parts: string[] = [];
    for (const x of r.diaries) parts.push(`[${L("дневник", "diary")} ${x.day}]\n${x.text}`);
    for (const h of r.items) parts.push(`${h.day} · ${h.where}${h.role === "user" ? ` · ${L("пользователь", "user")}` : ""}: ${clip(h.text.replace(/\s+/g, " "), 400)}`);
    if (!parts.length) return L("В памяти ничего подходящего. Значит, этого не было или было другими словами: попробуй иначе или search_history.", "Nothing suitable in memory. Either it didn't happen or it was in other words: try differently or search_history.");
    return parts.join("\n\n");
  }

  async forget(query: string): Promise<string> {
    if (!this.d.memory) throw new HttpError(409, L("Память выключена", "Memory is off"));
    const gone = await this.d.memory.forget(query);
    return gone.length ? L(`Забыто:\n${gone.join("\n")}`, `Forgotten:\n${gone.join("\n")}`) : L("Такого в памяти нет.", "Nothing like that in memory.");
  }

  /** Закрытые для памяти группы для него не существуют: список, чтение, поиск. */
  private hiddenGroup(s: SessionInfo): boolean {
    return !!this.d.memory?.isClosed(s);
  }

  reserved(directory: string): boolean {
    const root = this.d.config.config.roots[0];
    return directory === this.session()?.directory || (!!root && directory === join(root, "Dispatcher"));
  }

  engineAdded(id: EngineId): void {
    const s = this.session();
    if (!s) return;
    const st = this.st();
    const esid = st.esids[id];
    if (!esid || s.engine === id) return;
    const role: BrainRole = this.primary().engine === id ? "primary" : "fallback";
    this.d.sessions.attachEngineSession(s.id, id, esid, { model: st.chosen[role]?.model ?? this.brain(role).model, permissionMode: brainMode(id), hasHistory: !!st.seen[id] });
  }

  private onDeleted(): void {
    const st = this.brainState;
    if (!st || this.session()) return;
    for (const [engine, esid] of Object.entries(st.esids)) if (esid) this.d.sessions.dropEngineSession(engine as EngineId, esid);
    this.brainState = undefined;
    rmSync(this.brainFile, { force: true });
  }

  /** Идёт ли повтор оборвавшегося хода. */
  rerouting(sessionId: string): boolean {
    return this.rerouteUntil > Date.now() && sessionId === this.session()?.id;
  }

  /** Ход Claude оборвался на лимите или без входа: запомнить и на его idle уйти на запасной. */
  private onBrainEvent(e: StoredEvent): void {
    const s = this.session();
    if (!s || e.sessionId !== s.id) return;
    const ev = e.event;
    if (ev.type === "error" && s.engine === "claude") {
      const limit = isLimitError(ev.message);
      if (!limit && ev.message !== authFailedText()) return;
      const st = this.st();
      if (limit) {
        st.until = resumeTime(ev.message, this.d.sessions.limits);
        st.overrideAt = undefined;
        this.saveBrains();
      }
      if (this.fallbackUsable() && this.quietRun !== s.id) this.rerouteUntil = Date.now() + REROUTE_MAX_MS;
    } else if (ev.type === "session.updated" && ev.patch.status === "idle" && this.rerouting(s.id)) {
      void this.repeatTurn(s.id).catch((err: Error) => {
        // хаб выключается: база уже закрыта, спрашивать её незачем
        if (this.closed) return;
        this.d.log?.(`[dispatcher] ${err.message}`);
        this.endReroute(s.id);
      });
    }
  }

  private endReroute(id: string): void {
    this.rerouteUntil = 0;
    this.repeating = false;
  }

  /** Повторить на запасном последнее сообщение пользователя; в ленте второго пузыря нет. */
  private async repeatTurn(id: string): Promise<void> {
    const f = this.fallback()!;
    const why = await this.down(f);
    if (why) {
      // запасному тоже плохо: как раньше, ждём сброса лимита
      const until = this.st().until;
      if (until) this.d.sessions.setResumeAt(id, until);
      this.endReroute(id);
      return;
    }
    const v = this.view(id);
    const last = [...v.messages].reverse().find((m) => m.info.role === "user");
    const text = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n") ?? "";
    const fileIds = last?.parts.flatMap((p) => (p.type === "file" ? [p.fileId] : [])) ?? [];
    // команды CLI другому мозгу ни о чём не скажут
    if ((!text.trim() && !fileIds.length) || text.startsWith("/")) {
      this.endReroute(id);
      return;
    }
    this.repeating = true;
    await this.d.sessions.prompt(id, text, fileIds, { hideUser: true });
  }

  // ---------- настройки мозгов ----------

  brains(): DispatcherBrains {
    const st = this.st();
    const uvx = computerCommand(this.d.config);
    const computer: DispatcherBrains["computer"] = uvx
      ? { available: true, ...(this.warm ? { warm: this.warm } : {}) }
      : { available: false, reason: process.platform !== "win32" ? "not-windows" : this.cfg().computer === false ? "off" : "no-uvx" };
    return {
      primary: this.primary(),
      fallback: this.fallback(),
      autoFallback: this.cfg().autoFallback !== false,
      computerOnOpencode: this.cfg().computerOnOpencode === true,
      active: st.active,
      ...(st.active === "fallback" && st.reason ? { reason: st.reason } : {}),
      ...(st.active === "fallback" && st.until && st.until > Date.now() ? { until: st.until } : {}),
      computer,
    };
  }

  private async checkBrain(b: BrainRef): Promise<BrainRef> {
    const engine = b?.engine;
    if (engine !== "claude" && engine !== "opencode") throw new HttpError(400, L("Неизвестный движок", "Unknown engine"));
    if (!b.model?.providerId || !b.model.modelId) throw new HttpError(400, L("Не указана модель", "No model given"));
    const info = await this.d.sessions.engineInfo(engine).catch(() => undefined);
    if (!info) throw new HttpError(409, L(`Движок ${engine} не запущен`, `Engine ${engine} is not running`));
    const m = info.models.find((x) => x.providerId === b.model.providerId && x.modelId === b.model.modelId);
    if (!m) throw new HttpError(400, L(`Нет модели ${b.model.modelId}`, `No model ${b.model.modelId}`));
    if (m.tools === false) throw new HttpError(400, L("Этой модели недоступны инструменты: Диспетчер на ней работать не сможет", "This model has no tools: the Dispatcher can't work on it"));
    const effort = typeof b.effort === "string" && m.efforts?.includes(b.effort) ? b.effort : undefined;
    return { engine, model: { providerId: b.model.providerId, modelId: b.model.modelId }, ...(effort ? { effort } : {}) };
  }

  async setBrains(req: Partial<Pick<DispatcherBrains, "primary" | "fallback" | "autoFallback" | "computerOnOpencode">> & { backToPrimary?: boolean }): Promise<DispatcherBrains> {
    const next = { ...this.cfg() };
    const st = this.st();
    if (req.primary) {
      next.primary = await this.checkBrain(req.primary);
      st.chosen.primary = undefined;
      st.dirty = true;
    }
    if (req.fallback !== undefined) {
      next.fallback = req.fallback ? await this.checkBrain(req.fallback) : null;
      st.chosen.fallback = undefined;
      st.dirty = true;
    }
    if (next.fallback?.engine === "claude" && (next.primary?.engine ?? "claude") === "claude") {
      throw new HttpError(400, L("Запасной на том же Claude не спасёт: лимит и вход у них общие", "A fallback on Claude too won't help: they share the limit and the sign-in"));
    }
    if (typeof req.autoFallback === "boolean") next.autoFallback = req.autoFallback;
    if (typeof req.computerOnOpencode === "boolean") next.computerOnOpencode = req.computerOnOpencode;
    this.d.config.config.dispatcher = next;
    this.d.config.save();
    if (req.computerOnOpencode === true) this.warmUp();
    if (req.backToPrimary) {
      st.until = undefined;
      st.reason = undefined;
      st.overrideAt = Date.now();
    }
    this.saveBrains();
    // свободен — применяем сразу, занят — со следующего сообщения
    const s = this.session();
    if (s && s.status === "idle") {
      const v = this.view(s.id);
      if (!v.permissions.length && !v.questions.length) await this.pickBrain(s).catch((e: Error) => this.d.log?.(`[dispatcher] ${e.message}`));
    }
    return this.brains();
  }

  /** Первый запуск Windows-MCP качает Python и ~86 пакетов: дольше таймаута подключения. Качаем заранее. */
  private warmUp(): void {
    const uvx = computerCommand(this.d.config);
    if (!uvx || this.warm === "running" || this.warm === "done") return;
    this.warm = "running";
    void (this.d.warmComputer ?? warmWindowsMcp)(uvx).then(
      (ok) => (this.warm = ok ? "done" : "failed"),
      () => (this.warm = "failed"),
    );
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
    if (this.hiddenGroup(s)) throw new HttpError(403, L("Это закрытая группа: сюда только сам пользователь", "This group is closed: only the user goes here"));
    return s;
  }

  listSessions(): string {
    const list = this.d.sessions.list().filter((s) => s.kind !== "dispatcher" && !s.taskId && !this.hiddenGroup(s));
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

  /** Разовый вопрос дешёвой модели: quick — Haiku через Claude CLI, local — Strata (OpenAI-совместимый сервер), не отвечает — Haiku. */
  async askModel(role: "quick" | "local", prompt: string): Promise<string> {
    if (!prompt.trim()) throw new HttpError(400, "Empty prompt");
    const cfg = this.d.config.config.dispatcher ?? {};
    const quick = async () => {
      if (!this.d.ask) throw new HttpError(409, L("Claude недоступен", "Claude is unavailable"));
      return this.d.ask(prompt, cfg.quickModel || "claude-haiku-5-5");
    };
    // мозг на opencode, а Claude недоступен: Haiku та же подписка
    const noClaude = this.session()?.engine === "opencode" && !this.flags.claudeUp;
    if (role === "quick" && !noClaude) return quick();
    const url = (cfg.local?.url || "http://127.0.0.1:8080/v1").replace(/\/+$/, "");
    try {
      const r = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.local?.model || "strata", messages: [{ role: "user", content: prompt }], max_tokens: 2000 }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = j.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("empty");
      return text;
    } catch {
      if (noClaude) throw new HttpError(409, L("Локальная модель не ответила, а Claude недоступен", "The local model didn't answer and Claude is unavailable"));
      // Strata выключена или не ответила — не повод ронять задачу
      return `${await quick()}\n\n(${L("локальная модель не ответила — ответил Haiku", "the local model didn't answer — Haiku did")})`;
    }
  }

  /** На мозге Claude инструмент всегда есть; на opencode — если есть кому отвечать. */
  askAvailable(): boolean {
    return this.session()?.engine !== "opencode" || this.flags.ask;
  }

  /** Поиск по всем чатам: строки «сессия · кто · дата: кусок текста». */
  searchHistory(query: string, limit = 10): string {
    const hits = this.d.sessions.search(query, Math.min(Math.max(1, limit), 100)).filter((h) => {
      try {
        return !this.hiddenGroup(this.d.sessions.get(h.sessionId));
      } catch {
        return true;
      }
    }).slice(0, Math.min(Math.max(1, limit), 30));
    if (!hits.length) return L("Ничего не нашлось. Попробуй другие слова (ищется по началу слова).", "Nothing found. Try other words (matches word beginnings).");
    return hits
      .map((h) => `${h.sessionId} · ${h.title} · ${h.role === "user" ? L("пользователь", "user") : L("агент", "agent")} · ${new Date(h.ts).toISOString().slice(0, 16).replace("T", " ")}\n    ${h.snippet.replace(/\s+/g, " ")}`)
      .join("\n");
  }

  remember(fact: string, about: "user" | "notes"): string {
    const d = this.session();
    if (!d) throw new HttpError(409, L("Диспетчер не создан", "The Dispatcher isn't created"));
    return rememberFact(d.directory, fact, about);
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

  /** Сайт в браузере за один вызов: Windows-MCP App (переключить окно) идёт ~20 с, плюс Ctrl+T и ввод адреса. */
  openUrl(url: string): string {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      throw new HttpError(400, "Not a URL. Pass a full address: https://…");
    }
    // только веб: file:, ms-settings: и прочие обработчики протоколов — не сюда
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only http(s) addresses.");
    (this.d.openUrl ?? openInBrowser)(u.href);
    return `Opened ${u.href} in a new tab of the default browser. Take a Screenshot to check it loaded.`;
  }

  async listModels(): Promise<string> {
    const engines = await this.d.sessions.enginesInfo();
    return engines
      .map((e) => (e.available ? `${e.id}: ${e.models.map((m) => `${m.providerId}/${m.modelId}${m.free ? " (free)" : ""}`).join(", ")}` : `${e.id}: ${L("недоступен", "unavailable")} — ${e.error ?? ""}`))
      .join("\n");
  }
}
