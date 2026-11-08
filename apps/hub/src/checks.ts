// Автопроверка: агент закончил ход — хаб сам гоняет команды проверки проекта (тесты, сборку, типы) в папке сессии.
// Результат — карточка «проверка» в ленте. Красная — хвост вывода уходит агенту «почини» (до MAX_ATTEMPTS кругов,
// стоп, если та же ошибка повторилась), зелёная или попытки кончились — одно уведомление с итогом.
// Команды хранятся по папке проекта (у ветки сессии — основная), хаб предлагает их по файлам проекта.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CheckResult, ChecksConfig, CheckStatus, Part, SessionInfo, StoredEvent } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { killTree } from "./proc.ts";
import { L } from "./lang.ts";

export const MAX_ATTEMPTS = 3;
/** хвост вывода: в ленту и в промпт агенту (начало длинного лога обычно не нужно) */
const OUTPUT_TAIL = 6000;
const TIMEOUT_MS = 10 * 60_000;

const tail = (s: string) => (s.length > OUTPUT_TAIL ? "…\n" + s.slice(-OUTPUT_TAIL) : s);

/** Запустить команду в папке и дождаться: код выхода (null — не запустилась или убита по таймауту) и хвост вывода. */
export function runCommand(command: string, cwd: string, timeoutMs = TIMEOUT_MS, onStart?: (kill: () => void) => void): Promise<CheckResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    // как в terminal.ts: chcp 65001 во внешнем cmd, команда во вложенном (иначе кириллица в cp866)
    const proc =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/v:on", "/d", "/s", "/c", '"chcp 65001>nul & cmd /d /s /c !KH_CMD!"'], {
            cwd,
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: { ...process.env, KH_CMD: command, CI: "1" },
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("sh", ["-c", command], { cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // держим с запасом, обрезаем при выдаче
    const add = (s: string) => void (out = (out + s).slice(-OUTPUT_TAIL * 4));
    proc.stdout?.setEncoding("utf8").on("data", add);
    proc.stderr?.setEncoding("utf8").on("data", add);
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, timeoutMs);
    onStart?.(() => killTree(proc));
    const finish = (code: number | null, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ command, code: timedOut ? null : code, ms: Date.now() - t0, output: tail(out + extra).trim(), ...(timedOut ? { timedOut: true } : {}) });
    };
    proc.on("error", (e) => finish(null, `\n[${L("не запустилось", "failed to start")}: ${e.message}]`));
    proc.on("close", (code) => finish(code));
  });
}

/** Что можно гонять в этом проекте: по package.json, pyproject, Cargo.toml, go.mod. */
export function suggestChecks(dir: string): string[] {
  const out: string[] = [];
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      const pm = existsSync(join(dir, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(dir, "yarn.lock")) ? "yarn" : "npm";
      const run = (name: string) => (pm === "npm" ? (name === "test" ? "npm test" : `npm run ${name}`) : `${pm} ${name}`);
      for (const name of ["typecheck", "lint", "test"]) {
        const sc = scripts[name];
        // заглушка из npm init («no test specified») — не проверка
        if (sc && !/no test specified/.test(sc)) out.push(run(name));
      }
    } catch {
      /* битый package.json */
    }
  }
  if (["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((f) => existsSync(join(dir, f)))) out.push("python -m pytest");
  if (existsSync(join(dir, "Cargo.toml"))) out.push("cargo test");
  if (existsSync(join(dir, "go.mod"))) out.push("go test ./...");
  return out;
}

/** Папка, по которой хранятся команды: у ветки сессии — основной проект, иначе папка сессии. */
export const checksDir = (s: Pick<SessionInfo, "directory" | "worktree">): string => s.worktree?.repo ?? s.directory;

/** Подпись ошибки: какая команда и чем кончился вывод (без цифр — время и номера строк меняются). */
const signature = (r: CheckResult) => `${r.command}|${r.code}|${r.output.slice(-600).replace(/\d+/g, "#")}`;

export function fixPrompt(r: CheckResult, attempt: number): string {
  const head = r.timedOut
    ? L(`Автопроверка: команда \`${r.command}\` не уложилась в отведённое время.`, `Auto-check: the command \`${r.command}\` ran out of time.`)
    : L(`Автопроверка: команда \`${r.command}\` упала (код ${r.code ?? "?"}).`, `Auto-check: the command \`${r.command}\` failed (exit code ${r.code ?? "?"}).`);
  return [
    head,
    L(`Конец вывода:`, `End of the output:`),
    "```",
    r.output,
    "```",
    L(
      `Найди и почини причину. Проверки не отключай и не ослабляй. Это попытка ${attempt} из ${MAX_ATTEMPTS}; после ответа хаб запустит проверки снова.`,
      `Find and fix the cause. Don't disable or weaken the checks. This is attempt ${attempt} of ${MAX_ATTEMPTS}; the hub will run the checks again after your answer.`,
    ),
  ].join("\n");
}

export interface AutoCheckDeps {
  sessions: {
    on(event: "event", cb: (e: StoredEvent) => void): unknown;
    get(id: string): SessionInfo;
    prompt(id: string, text: string): Promise<void>;
    hubPart(sessionId: string, messageId: string, part: Part): void;
  };
  config: ConfigStore;
  /** итог для уведомлений (обычное «готово» при автопроверке молчит) */
  notify: (sessionId: string, message: string) => void;
  log?: (m: string) => void;
  /** тесты подставляют свой запуск команд */
  run?: (command: string, cwd: string) => Promise<CheckResult>;
}

interface State {
  /** сколько раз уже отправили агенту «почини» подряд */
  attempts: number;
  lastFail?: string;
  running: boolean;
  /** следующее сообщение пользователя в ленте — наш промпт, а не человек */
  ourPrompt: boolean;
  kill?: () => void;
}

/** чем кончился круг проверок: оркестратор ждёт именно этого, а не просто idle сессии */
export interface CheckSettled {
  sessionId: string;
  status: CheckStatus;
  /** ошибку отправили агенту — будет ещё ход, ждём следующий круг */
  sentFix: boolean;
}

export class AutoCheck {
  private busy = new Set<string>();
  private state = new Map<string, State>();
  private listeners = new Set<(e: CheckSettled) => void>();

  /** подписка на окончание круга проверок (оркестратор задач) */
  onSettled(cb: (e: CheckSettled) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private settled(e: CheckSettled): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch (err) {
        this.d.log?.(`[checks] ${(err as Error).message}`);
      }
    }
  }

  /** идёт ли сейчас прогон (оркестратор не считает сессию «успокоившейся», пока он идёт) */
  running(id: string): boolean {
    return !!this.state.get(id)?.running;
  }

  constructor(private d: AutoCheckDeps) {
    d.sessions.on("event", (e) => this.onEvent(e));
  }

  private st(id: string): State {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = { attempts: 0, running: false, ourPrompt: false }));
    return s;
  }

  commands(s: Pick<SessionInfo, "directory" | "worktree">): string[] {
    return this.d.config.config.checks?.[checksDir(s)] ?? [];
  }

  /** Включена и есть что гонять — тогда обычное «готово» молчит, итог присылает автопроверка. */
  active(id: string): boolean {
    try {
      const s = this.d.sessions.get(id);
      return !!s.autoCheck && this.commands(s).length > 0;
    } catch {
      return false;
    }
  }

  config(s: Pick<SessionInfo, "directory" | "worktree">): ChecksConfig {
    const dir = checksDir(s);
    return { directory: dir, commands: this.commands(s), suggested: suggestChecks(dir) };
  }

  setCommands(s: Pick<SessionInfo, "directory" | "worktree">, list: unknown): ChecksConfig {
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new Error(L("commands: массив строк", "commands: an array of strings"));
    const clean = [...new Set(list.map((x: string) => x.trim()).filter(Boolean))];
    if (clean.length > 10) throw new Error(L("Не больше 10 команд", "No more than 10 commands"));
    if (clean.some((c) => c.length > 500)) throw new Error(L("Команда длиннее 500 символов", "A command is longer than 500 characters"));
    this.d.config.setChecks(checksDir(s), clean);
    return this.config(s);
  }

  private onEvent(e: StoredEvent): void {
    const id = e.sessionId;
    const ev = e.event;
    if (ev.type === "session.updated") {
      if (ev.patch.status === "busy" || ev.patch.status === "retry") this.busy.add(id);
      // настоящий конец хода: idle после busy, увиденного в этом запуске (рестарт хаба сам ставит idle — это не ход)
      if (ev.patch.status === "idle" && this.busy.delete(id)) void this.afterTurn(id);
      if (ev.patch.autoCheck === false) this.stop(id);
    }
    if (ev.type === "message.upserted" && ev.message.role === "user") {
      const st = this.st(id);
      if (st.ourPrompt) st.ourPrompt = false;
      // человек написал сам — круги починки начинаются заново
      else {
        st.attempts = 0;
        delete st.lastFail;
      }
    }
  }

  private async afterTurn(id: string): Promise<void> {
    let s: SessionInfo;
    try {
      s = this.d.sessions.get(id);
    } catch {
      return;
    }
    if (!s.autoCheck || !this.commands(s).length) return;
    await this.run(id, true);
  }

  /** Прогнать проверки сейчас. fix — при ошибке вернуть её агенту (автопроверка), иначе только показать. */
  async run(id: string, fix: boolean): Promise<void> {
    const s = this.d.sessions.get(id);
    const commands = this.commands(s);
    const st = this.st(id);
    if (st.running) return;
    if (!commands.length) throw new Error(L("Команды проверки для этого проекта не заданы", "No check commands for this project"));
    st.running = true;
    const messageId = `chk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const part: Extract<Part, { type: "check" }> = { type: "check", id: `${messageId}:c`, status: "running", attempt: st.attempts + 1, maxAttempts: MAX_ATTEMPTS, results: [] };
    const show = () => this.d.sessions.hubPart(id, messageId, { ...part, results: [...part.results] });
    try {
      show();
      let failed: CheckResult | undefined;
      for (const command of commands) {
        const r = await (this.d.run ?? ((c, cwd) => runCommand(c, cwd, undefined, (k) => (st.kill = k))))(command, s.directory);
        delete st.kill;
        part.results.push(r);
        // выключили посреди прогона — дальше не идём
        if (!this.d.sessions.get(id).autoCheck && fix) {
          part.status = "stopped";
          part.note = L("Автопроверку выключили", "Auto-check was turned off");
          show();
          return;
        }
        if (r.code !== 0) {
          failed = r;
          break;
        }
        show();
      }
      const title = s.title;
      if (!failed) {
        part.status = "passed";
        show();
        if (fix) this.d.notify(id, L(`✓ Готово, проверки прошли: ${title}`, `✓ Done, checks passed: ${title}`));
        st.attempts = 0;
        delete st.lastFail;
        if (fix) this.settled({ sessionId: id, status: "passed", sentFix: false });
        return;
      }
      part.status = "failed";
      if (!fix) {
        show();
        return;
      }
      let sentFix = false;
      const sig = signature(failed);
      const now = this.d.sessions.get(id);
      if (st.attempts >= MAX_ATTEMPTS) {
        part.note = L(`Попытки кончились (${MAX_ATTEMPTS}) — нужен ты`, `Out of attempts (${MAX_ATTEMPTS}) — over to you`);
        this.d.notify(id, L(`✗ Проверки не прошли после ${MAX_ATTEMPTS} попыток: ${title}`, `✗ Checks still fail after ${MAX_ATTEMPTS} attempts: ${title}`));
      } else if (st.lastFail === sig) {
        part.note = L("Та же ошибка второй раз подряд — остановился, нужен ты", "The same error twice in a row — stopped, over to you");
        this.d.notify(id, L(`✗ Агент не может починить проверку: ${title}`, `✗ The agent can't fix the check: ${title}`));
      } else if (now.resumeAt) {
        // агент упёрся в лимит и ждёт сброса: «почини» ему сейчас не отправить
        const at = new Date(now.resumeAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        part.note = L(`Агент ждёт сброса лимита (до ${at}) — отправлю ошибку, когда он продолжит`, `The agent is waiting for the limit to reset (until ${at}) — I'll send the error when it continues`);
      } else if (now.status === "busy" || now.status === "retry") {
        part.note = L("Агент уже работает над новым сообщением — ошибку не отправляю", "The agent is already working on a new message — not sending the error");
      } else {
        sentFix = true;
        st.attempts++;
        st.lastFail = sig;
        part.note = L(`Отправил ошибку агенту (попытка ${st.attempts} из ${MAX_ATTEMPTS})`, `Sent the error to the agent (attempt ${st.attempts} of ${MAX_ATTEMPTS})`);
        show();
        st.ourPrompt = true;
        try {
          await this.d.sessions.prompt(id, fixPrompt(failed, st.attempts));
        } catch (e) {
          st.ourPrompt = false;
          sentFix = false;
          part.note = `${L("Не смог отправить агенту", "Couldn't send it to the agent")}: ${(e as Error).message}`;
        }
      }
      show();
      this.settled({ sessionId: id, status: "failed", sentFix });
    } catch (e) {
      this.d.log?.(`[checks] ${(e as Error).message}`);
    } finally {
      st.running = false;
      delete st.kill;
    }
  }

  /** Выключили автопроверку — гасим идущую команду. */
  stop(id: string): void {
    this.state.get(id)?.kill?.();
  }

  close(): void {
    for (const st of this.state.values()) st.kill?.();
  }
}
