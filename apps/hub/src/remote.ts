// Удалённый доступ через свой сервер (VPS) — когда Tailscale с телефона не работает (VPN на ПК, мобильная сеть).
// Хаб сам держит исходящий SSH-туннель: ssh -N -R 127.0.0.1:<remotePort>:127.0.0.1:<tunnelPort> user@vps,
// на VPS Caddy с сертификатом Let's Encrypt проксирует https://<url> → 127.0.0.1:<remotePort> (scripts/vps-setup.sh).
// Туннель приходит на отдельный порт хаба (tunnelPort): его запросы никогда не считаются локальными
// (tunnelSockets в auth.ts), иначе любой процесс на VPS получил бы доверие localhost без токена.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import type { RemoteSettings, RemoteStatus } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { DEFAULT_REPO } from "./updates.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

export const DEFAULT_REMOTE_PORT = 17420;
const MAX_BACKOFF_MS = 60_000;

/** ssh и ssh-keygen: на Windows — встроенный OpenSSH (у git-bash свой, с другими правилами к правам на ключ) */
function openssh(name: "ssh" | "ssh-keygen"): string {
  if (process.platform === "win32") {
    const p = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", `${name}.exe`);
    if (existsSync(p)) return p;
  }
  return name;
}

/** https://krab.1-2-3-4.sslip.io — домен без регистрации, Let's Encrypt его выдаёт */
export const defaultRemoteUrl = (host: string): string => (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `https://krab.${host.replace(/\./g, "-")}.sslip.io` : "");

/** последняя строка ssh — понятным текстом, исходная в скобках */
function explain(line: string): string {
  const hint = /Permission denied/i.test(line)
    ? L("Сервер не принял ключ хаба: выполни на VPS команду настройки", "The server rejected the hub's key: run the setup command on the VPS")
    : /remote port forwarding failed/i.test(line)
      ? L("Порт на сервере занят или не разрешён этому ключу", "The port on the server is busy or not allowed for this key")
      : /Could not resolve hostname/i.test(line)
        ? L("Адрес сервера не найден", "The server address wasn't found")
        : /timed out|Connection refused|unreachable/i.test(line)
          ? L("Сервер не отвечает по SSH", "The server doesn't answer over SSH")
          : /Host key verification failed|IDENTIFICATION HAS CHANGED/i.test(line)
            ? L("Ключ сервера изменился. Если сервер переустанавливали — сохрани настройки заново", "The server key has changed. If the server was reinstalled, save the settings again")
            : "";
  return hint ? `${hint} (${line})` : line;
}

/** Доходит ли запрос до этого хаба по адресу url (снаружи: VPS, свой прокси): /api/health и версия. */
export async function probeHub(url: string, version: string): Promise<{ ok: true; ms: number }> {
  const t0 = Date.now();
  let r: Response;
  try {
    r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const err = e as Error & { cause?: Error };
    throw new HttpError(502, `${L("Адрес не отвечает", "The address doesn't answer")}: ${err.name === "TimeoutError" ? L("нет ответа за 10 с", "no answer in 10 s") : (err.cause?.message ?? err.message)}`);
  }
  // прокси (Caddy, DSM) отвечает 502/504, когда до хаба не достучался
  if (r.status === 502 || r.status === 504) throw new HttpError(502, L("Сервер отвечает, но до хаба не достаёт (туннель или прокси)", "The server answers but can't reach the hub (tunnel or proxy)"));
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; version?: string };
  if (!r.ok || j.ok !== true) throw new HttpError(502, `${L("По адресу отвечает не хаб", "Something other than the hub answers there")} (HTTP ${r.status})`);
  if (j.version !== version) throw new HttpError(502, `${L("По адресу отвечает другой хаб, версия", "Another hub answers there, version")} ${j.version}`);
  return { ok: true, ms: Date.now() - t0 };
}

/** Свой публичный адрес: https://домен без пути; http — только loopback (проверки на этом ПК). */
export function checkPublicUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, `${L("Не адрес", "Not an address")}: ${raw}`);
  }
  // по http токен ушёл бы через интернет открытым текстом
  const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new HttpError(400, `${L("Адрес — только https://домен, без пути", "Address — https://domain only, no path")}: ${raw}`);
  }
  return url.origin;
}

export interface RemoteOptions {
  config: ConfigStore;
  /** версия хаба: проверка, что по адресу отвечает именно он */
  version: string;
  log?: (m: string) => void;
  /** где хранить pid ssh (data/remote-ssh.json) */
  dataDir?: string;
  /** тесты подставляют свой ssh (sshBin + sshPrefix: node fake-ssh.mjs) */
  sshBin?: string;
  sshPrefix?: string[];
  /** столько ssh должен прожить, чтобы считать туннель поднятым (с ExitOnForwardFailure он падает сразу) */
  upAfterMs?: number;
}

export class RemoteTunnel {
  private child?: ChildProcess;
  private retry?: NodeJS.Timeout;
  private upTimer?: NodeJS.Timeout;
  private backoff = 2000;
  private state: RemoteStatus["state"] = "off";
  private error?: string;
  private since = Date.now();
  private localPort = 0;
  private closed = false;
  private lastLogged?: string;
  readonly keyPath: string;
  private knownHosts: string;
  /** pid текущего ssh — чтобы после падения хаба убить сироту */
  private pidFile?: string;

  constructor(private o: RemoteOptions) {
    // ключ и known_hosts — рядом с конфигом (config/, вне git)
    const dir = dirname(o.config.path);
    this.keyPath = join(dir, "remote_ed25519");
    this.knownHosts = join(dir, "remote_known_hosts");
    this.pidFile = o.dataDir ? join(o.dataDir, "remote-ssh.json") : undefined;
  }

  private get cfg(): RemoteSettings | undefined {
    return this.o.config.config.remote;
  }

  /** публичный адрес — в известные адреса хаба и в QR, пока туннель включён */
  publicUrls(): string[] {
    const c = this.cfg;
    return c?.enabled ? [c.url] : [];
  }


  /** localPort — порт хаба только для туннеля */
  async start(localPort: number): Promise<void> {
    this.localPort = localPort;
    this.reapOrphan();
    this.apply();
  }

  /**
   * ssh от прошлого запуска хаба (хаб упал, не успев его убить): держит порт на VPS и ведёт на старый порт хаба —
   * новый туннель не поднимется, а старый порт может занять кто-то другой и оказаться в интернете.
   */
  private reapOrphan(): void {
    if (!this.pidFile || !existsSync(this.pidFile)) return;
    let pid = 0;
    try {
      pid = Number((JSON.parse(readFileSync(this.pidFile, "utf8")) as { pid?: number }).pid);
    } catch {
      /* битый файл */
    }
    rmSync(this.pidFile, { force: true });
    if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "win32") return;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    // PID мог достаться другому процессу — убиваем, только если в его командной строке наш ключ
    if (r.stdout?.includes(this.keyPath)) {
      spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
      this.o.log?.(`[remote] ${L("убит ssh от прошлого запуска", "killed ssh left from the previous run")} (pid ${pid})`);
    }
  }

  private set(state: RemoteStatus["state"], error?: string): void {
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    this.since = Date.now();
  }

  private apply(): void {
    this.stop();
    this.backoff = 2000;
    const c = this.cfg;
    if (this.closed || !this.localPort || !c?.enabled) return this.set("off");
    this.connect(c);
  }

  private stop(): void {
    clearTimeout(this.retry);
    clearTimeout(this.upTimer);
    this.retry = this.upTimer = undefined;
    const ch = this.child;
    this.child = undefined;
    ch?.kill();
    if (ch && this.pidFile) rmSync(this.pidFile, { force: true });
  }

  private connect(c: RemoteSettings): void {
    try {
      this.ensureKey();
    } catch (e) {
      return this.set("error", (e as Error).message);
    }
    const args = [
      ...(this.o.sshPrefix ?? []),
      "-N",
      "-n",
      "-T",
      // чужой ~/.ssh/config (ProxyJump, Host *) туннелю не нужен
      "-F",
      "none",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      // ssh разбирает значение -o сам: кавычки — для пробелов в пути, прямые слэши — чтобы \ не стал экранированием
      "-o",
      `UserKnownHostsFile="${this.knownHosts.replace(/\\/g, "/")}"`,
      "-o",
      "LogLevel=ERROR",
      "-i",
      this.keyPath,
      "-p",
      String(c.sshPort),
      "-R",
      `127.0.0.1:${c.remotePort}:127.0.0.1:${this.localPort}`,
      `${c.user}@${c.host}`,
    ];
    this.set("connecting", this.error);
    const child = spawn(this.o.sshBin ?? openssh("ssh"), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    this.child = child;
    if (this.pidFile && child.pid) writeFileSync(this.pidFile, JSON.stringify({ pid: child.pid }));
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      stderr = (stderr + d).slice(-4000);
    });
    this.upTimer = setTimeout(() => {
      if (this.child !== child) return;
      this.set("up");
      this.backoff = 2000;
      this.lastLogged = undefined;
      this.o.log?.(`[remote] ${L("туннель поднят", "tunnel is up")}: ${c.url}`);
    }, this.o.upAfterMs ?? 4000);
    let done = false;
    const finish = (line: string) => {
      if (done || this.child !== child) return;
      done = true;
      clearTimeout(this.upTimer);
      this.child = undefined;
      if (this.pidFile) rmSync(this.pidFile, { force: true });
      this.set("error", explain(line));
      // при переподключениях одна и та же ошибка в лог — один раз
      if (line !== this.lastLogged) this.o.log?.(`[remote] ${line}`);
      this.lastLogged = line;
      if (this.closed) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.retry = setTimeout(() => {
        const cur = this.cfg;
        if (cur?.enabled && !this.closed) this.connect(cur);
      }, wait);
    };
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ENOENT" ? L("Не найден ssh: нужен клиент OpenSSH (Параметры → Система → Дополнительные компоненты)", "ssh not found: the OpenSSH client is required (Settings → System → Optional features)") : e.message),
    );
    child.on("exit", (code) => {
      const last = stderr.trim().split(/\r?\n/).pop()?.trim();
      finish(last || L(`ssh завершился (код ${code})`, `ssh exited (code ${code})`));
    });
  }

  /** ключ хаба для VPS: создаётся один раз, закрытая часть остаётся на ПК */
  private ensureKey(): void {
    if (existsSync(this.keyPath) && existsSync(this.keyPath + ".pub")) return;
    rmSync(this.keyPath, { force: true });
    rmSync(this.keyPath + ".pub", { force: true });
    const r = spawnSync(openssh("ssh-keygen"), ["-q", "-t", "ed25519", "-N", "", "-C", "krabness-hub-tunnel", "-f", this.keyPath], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
    if (r.error || r.status !== 0 || !existsSync(this.keyPath + ".pub")) {
      throw new Error(`${L("Не удалось создать ключ (нужен OpenSSH)", "Couldn't create a key (OpenSSH is required)")}: ${r.error?.message ?? r.stderr?.trim()}`);
    }
    // OpenSSH для Windows не берёт ключ, который могут читать другие пользователи (а права наследуются от папки установки)
    if (process.platform === "win32") spawnSync("icacls", [this.keyPath, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { windowsHide: true, timeout: 20_000 });
  }

  status(): RemoteStatus {
    let publicKey = "";
    let keyError: string | undefined;
    try {
      this.ensureKey();
      publicKey = readFileSync(this.keyPath + ".pub", "utf8").trim();
    } catch (e) {
      keyError = (e as Error).message;
    }
    const c = this.cfg;
    const repo = this.o.config.config.updates?.repo || DEFAULT_REPO;
    const port = c && c.remotePort !== DEFAULT_REMOTE_PORT ? ` --port ${c.remotePort}` : "";
    const setupCommand = publicKey ? `curl -fsSL https://raw.githubusercontent.com/${repo}/main/scripts/vps-setup.sh | sudo bash -s -- --key '${publicKey}'${port}` : "";
    const error = this.error ?? keyError;
    return { configured: !!c, ...(c ? { settings: c } : {}), publicKey, setupCommand, state: this.state, ...(error ? { error } : {}), since: this.since };
  }

  save(b: Partial<RemoteSettings>): RemoteStatus {
    const host = String(b.host ?? "")
      .trim()
      .replace(/^\[(.*)\]$/, "$1");
    if (!host || host.startsWith("-") || !/^([a-z0-9.-]+|[0-9a-f:]+)$/i.test(host)) throw new HttpError(400, L("Адрес сервера — IP или домен, без ssh:// и порта", "Server address — IP or domain, without ssh:// and port"));
    const user = String(b.user ?? "").trim() || "krabtunnel";
    if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new HttpError(400, L("Неверное имя пользователя", "Invalid user name"));
    const port = (v: unknown, def: number, min: number) => {
      const n = v === undefined || v === "" ? def : Number(v);
      if (!Number.isInteger(n) || n < min || n > 65535) throw new HttpError(400, L(`Порт — число от ${min} до 65535`, `Port — a number from ${min} to 65535`));
      return n;
    };
    const sshPort = port(b.sshPort, 22, 1);
    const remotePort = port(b.remotePort, DEFAULT_REMOTE_PORT, 1024);
    const raw = String(b.url ?? "").trim() || defaultRemoteUrl(host);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new HttpError(400, L("Публичный адрес — вида https://krab.1-2-3-4.sslip.io", "Public address — like https://krab.1-2-3-4.sslip.io"));
    }
    // по http токен ушёл бы через интернет открытым текстом; http — только для проверок на этом ПК
    const loopback = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname);
    if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new HttpError(400, L("Публичный адрес — только https://домен, без пути", "Public address — https://domain only, no path"));
    }
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new HttpError(400, "enabled: true | false");
    // сохранение — заново доверяем ключу сервера (переустановили VPS — достаточно сохранить ещё раз)
    rmSync(this.knownHosts, { force: true });
    this.o.config.setRemote({ host, user, sshPort, remotePort, url: url.origin, enabled: b.enabled ?? true });
    this.error = undefined;
    this.apply();
    return this.status();
  }

  remove(): RemoteStatus {
    this.o.config.setRemote(undefined);
    rmSync(this.knownHosts, { force: true });
    this.error = undefined;
    this.apply();
    return this.status();
  }

  /** доходит ли до хаба запрос снаружи: https://<url>/api/health через VPS и туннель */
  async test(): Promise<{ ok: true; ms: number }> {
    const c = this.cfg;
    if (!c) throw new HttpError(409, L("Удалённый доступ не настроен", "Remote access isn't set up"));
    return probeHub(c.url, this.o.version);
  }

  close(): void {
    this.closed = true;
    this.stop();
  }
}
