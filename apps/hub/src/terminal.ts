// Мини-терминал: команда в папке сессии без агента и без расхода лимита (git status, npm test…).
// Вывод копится в памяти хаба, клиент забирает его кусками по смещению — так обрыв связи ничего не теряет.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { killTree } from "./proc.ts";
import { L } from "./lang.ts";

/** хвост вывода, который держим в памяти */
const MAX_OUTPUT = 512 * 1024;
const HISTORY = 20;
const RUNS_PER_SESSION = 10;

interface Run {
  id: string;
  sessionId: string;
  command: string;
  startedAt: number;
  exitCode?: number | null;
  done: boolean;
  output: string;
  /** сколько символов с начала выброшено из-за лимита */
  dropped: number;
  proc?: ChildProcess;
}

export interface TermChunk {
  data: string;
  /** смещение для следующего запроса */
  next: number;
  done: boolean;
  exitCode?: number | null;
}

export class Terminal {
  private runs = new Map<string, Run>();
  private historyFile: string;
  private history: Record<string, string[]>;

  constructor(dataDir: string) {
    this.historyFile = join(dataDir, "term-history.json");
    try {
      this.history = existsSync(this.historyFile) ? (JSON.parse(readFileSync(this.historyFile, "utf8")) as Record<string, string[]>) : {};
    } catch {
      this.history = {};
    }
  }

  start(sessionId: string, directory: string, command: string): string {
    const cmd = command.trim();
    if (!cmd) throw new Error(L("Пустая команда", "Empty command"));
    if (this.running(sessionId)) throw new Error(L("Предыдущая команда ещё работает — дождись или останови", "The previous command is still running — wait or stop it"));
    const run: Run = { id: randomBytes(8).toString("hex"), sessionId, command: cmd, startedAt: Date.now(), done: false, output: "", dropped: 0 };
    // cmd.exe: привычные команды Windows и «&&». Кодовую страницу cmd берёт при старте, поэтому chcp 65001
    // во внешнем, а команда — во вложенном cmd (иначе echo пишет кириллицу в cp866). Команда идёт через
    // переменную с отложенным раскрытием (!KH_CMD!): её «&&» и «>» разбирает уже вложенный cmd.
    const proc =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/v:on", "/d", "/s", "/c", '"chcp 65001>nul & cmd /d /s /c !KH_CMD!"'], {
            cwd: directory,
            windowsHide: true,
            windowsVerbatimArguments: true,
            env: { ...process.env, KH_CMD: cmd },
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn("sh", ["-c", cmd], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
    run.proc = proc;
    // setEncoding склеивает символы UTF-8, разрезанные между кусками вывода
    const add = (s: string) => this.append(run, s);
    proc.stdout?.setEncoding("utf8").on("data", add);
    proc.stderr?.setEncoding("utf8").on("data", add);
    proc.on("error", (e) => this.finish(run, null, `\n[${L("не запустилось", "failed to start")}: ${e.message}]\n`));
    proc.on("close", (code) => this.finish(run, code));
    this.runs.set(run.id, run);
    this.remember(sessionId, cmd);
    this.prune(sessionId);
    return run.id;
  }

  read(runId: string, from = 0): TermChunk {
    const run = this.get(runId);
    const total = run.dropped + run.output.length;
    const at = Math.max(0, Math.min(from, total));
    const data = at >= run.dropped ? run.output.slice(at - run.dropped) : `${L("…(начало вывода обрезано)", "…(beginning of output truncated)")}\n${run.output}`;
    return { data, next: total, done: run.done, ...(run.done ? { exitCode: run.exitCode } : {}) };
  }

  stop(runId: string): void {
    const run = this.get(runId);
    if (!run.done && run.proc) killTree(run.proc);
  }

  /** последние команды сессии и то, что сейчас выполняется */
  info(sessionId: string): { history: string[]; running?: { runId: string; command: string } } {
    const r = this.running(sessionId);
    return { history: this.history[sessionId] ?? [], ...(r ? { running: { runId: r.id, command: r.command } } : {}) };
  }

  close(): void {
    for (const r of this.runs.values()) if (!r.done && r.proc) killTree(r.proc);
  }

  private get(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new Error(L("Нет такой команды (хаб перезапускался?)", "No such command (was the hub restarted?)"));
    return run;
  }

  private running(sessionId: string): Run | undefined {
    for (const r of this.runs.values()) if (r.sessionId === sessionId && !r.done) return r;
    return undefined;
  }

  private append(run: Run, s: string): void {
    run.output += s;
    if (run.output.length > MAX_OUTPUT) {
      const cut = run.output.length - MAX_OUTPUT;
      run.output = run.output.slice(cut);
      run.dropped += cut;
    }
  }

  private finish(run: Run, code: number | null, note?: string): void {
    if (run.done) return;
    if (note) this.append(run, note);
    run.done = true;
    run.exitCode = code;
    run.proc = undefined;
  }

  private remember(sessionId: string, cmd: string): void {
    const list = (this.history[sessionId] ?? []).filter((c) => c !== cmd);
    this.history[sessionId] = [cmd, ...list].slice(0, HISTORY);
    try {
      writeFileSync(this.historyFile, JSON.stringify(this.history));
    } catch {}
  }

  private prune(sessionId: string): void {
    const done = [...this.runs.values()].filter((r) => r.sessionId === sessionId && r.done).sort((a, b) => b.startedAt - a.startedAt);
    for (const r of done.slice(RUNS_PER_SESSION)) this.runs.delete(r.id);
  }
}
