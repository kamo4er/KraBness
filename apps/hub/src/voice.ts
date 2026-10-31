// Голос на ПК: хаб держит процесс voice/main.py (слово-активатор → Whisper → Диспетчер → ответ вслух), пока он включён в настройках.
// Падает — перезапуск с паузой 2→60 с. Состояние — по строкам «STATE …» из его вывода, хвост лога — в статусе и data/logs/voice.log.
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { VoiceStatus } from "@kamharn/protocol";
import { REPO_ROOT, type ConfigStore } from "./config.ts";
import { findUvx } from "./dispatcher.ts";
import { killTree, spawn } from "./proc.ts";
import { L } from "./lang.ts";

const LOG_LINES = 40;
/** пауза конца фразы по умолчанию (с), как в voice/main.py --wake-pause */
export const DEFAULT_PAUSE = 1.3;

export interface VoiceDeps {
  config: ConfigStore;
  hubUrl: () => string;
  log?: (m: string) => void;
  /** папка сервиса (в тестах — своя) */
  dir?: string;
  /** чем запускать (в тестах — node с подделкой) */
  command?: () => { cmd: string; args: string[] } | undefined;
}

/** uv рядом с uvx (winget кладёт оба в одну папку). */
export function findUv(): string | undefined {
  const uvx = findUvx();
  if (!uvx) return undefined;
  const uv = join(dirname(uvx), process.platform === "win32" ? "uv.exe" : "uv");
  return existsSync(uv) ? uv : undefined;
}

export class VoiceService {
  private proc?: ChildProcess;
  private state: VoiceStatus["state"] = "off";
  private lines: string[] = [];
  private backoff = 2000;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private readonly dir: string;
  private readonly logFile: string;

  constructor(private d: VoiceDeps) {
    this.dir = d.dir ?? join(REPO_ROOT, "voice");
    const logs = join(d.config.config.dataDir, "logs");
    mkdirSync(logs, { recursive: true });
    this.logFile = join(logs, "voice.log");
  }

  private command(): { cmd: string; args: string[] } | undefined {
    if (this.d.command) return this.d.command();
    const uv = findUv();
    if (!uv) return undefined;
    const v = this.d.config.config.voice ?? {};
    const args = ["run", "--project", this.dir, "python", join(this.dir, "main.py"), "--hub", this.d.hubUrl()];
    if (v.device) args.push("--device", v.device);
    if (v.threshold) args.push("--threshold", String(v.threshold));
    // пауза конца фразы: у фразы с «Крабиком» — она, у команды после сигнала — чуть дольше
    if (v.pause) args.push("--wake-pause", String(v.pause), "--pause", String(Math.round((v.pause + 0.3) * 10) / 10));
    return { cmd: uv, args };
  }

  /** Почему нельзя включить (или undefined — можно). */
  unavailable(): string | undefined {
    if (process.platform !== "win32" && !this.d.command) return L("Голос на ПК пока только для Windows", "PC voice is Windows-only for now");
    if (!existsSync(join(this.dir, "main.py"))) return L("Нет папки voice рядом с хабом", "The voice folder is missing next to the hub");
    if (!this.command()) return L("Нужен uv (менеджер Python): winget install astral-sh.uv", "uv (Python manager) is required: winget install astral-sh.uv");
    return undefined;
  }

  status(): VoiceStatus {
    const why = this.unavailable();
    return { enabled: !!this.d.config.config.voice?.enabled, state: this.state, ...(why ? { unavailable: why } : {}), log: this.lines.slice(-LOG_LINES), device: this.d.config.config.voice?.device ?? "", pause: this.d.config.config.voice?.pause ?? DEFAULT_PAUSE };
  }

  /** При запуске хаба и после смены настройки. */
  start(): void {
    if (this.closed || this.proc || !this.d.config.config.voice?.enabled || this.unavailable()) return;
    const c = this.command()!;
    this.state = "starting";
    this.note(`$ ${[c.cmd, ...c.args].join(" ")}`);
    const p = spawn(c.cmd, c.args, { cwd: this.dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" } });
    this.proc = p;
    const onData = (buf: Buffer) => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        // прогресс-бары загрузки моделей — шум
        if (!line.trim() || /\d+%\|/.test(line)) continue;
        const m = /^STATE (\w+)/.exec(line);
        if (m) {
          this.state = m[1] as VoiceStatus["state"];
          if (this.state === "listening") this.backoff = 2000;
        }
        this.note(line);
      }
    };
    p.stdout?.on("data", onData);
    p.stderr?.on("data", onData);
    p.on("error", (e) => this.note(`error: ${e.message}`));
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.proc = undefined;
      this.state = "off";
      this.note(`exit ${code}`);
      if (this.closed || !this.d.config.config.voice?.enabled) return;
      this.state = "restarting";
      this.timer = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const p = this.proc;
    this.proc = undefined;
    this.state = "off";
    if (p) killTree(p);
  }

  /** Включить/выключить и микрофон (пусто — системный). */
  set(patch: { enabled?: boolean; device?: string; pause?: number }): VoiceStatus {
    const cur = this.d.config.config.voice ?? {};
    const pause = typeof patch.pause === "number" && patch.pause >= 0.5 && patch.pause <= 5 ? { pause: patch.pause } : {};
    const next = { ...cur, ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}), ...(typeof patch.device === "string" ? { device: patch.device.trim() } : {}), ...pause };
    if (!next.device) delete next.device;
    this.d.config.config.voice = next;
    this.d.config.save();
    this.stop();
    this.backoff = 2000;
    this.start();
    return this.status();
  }

  close(): void {
    this.closed = true;
    this.stop();
  }

  private note(line: string): void {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200);
    try {
      appendFileSync(this.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // лог не главное
    }
    this.d.log?.(`[voice] ${line}`);
  }
}
