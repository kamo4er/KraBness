// Превью dev-серверов на телефоне: dev-сервер слушает localhost ПК, хаб открывает к нему прокси на Tailscale-адресе.
// Прокси на отдельном порту (а не /preview/<порт>/ на хабе): dev-серверы ссылаются на абсолютные пути (/src, /@vite).
// Доступ — по ключу текущего запуска хаба: ?kh_preview=<ключ> один раз, дальше кука.
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { ListeningPort } from "@kamharn/protocol";
import { L } from "./lang.ts";

const COOKIE = "kh_preview";
// системное и своё: в списке превью не нужно
const SKIP = /^(system|idle|svchost|lsass|wininit|services|spoolsv|tailscaled|tailscale-ipn|opencode|searchhost|msedgewebview2|onedrive|steam|nvcontainer|amnezia\S*|code|memu\S*|adb|vmms|jhi_service|mysqld|synology.*)$/i;

/** Отвечает ли порт по HTTP (превью имеет смысл только для веб-серверов). */
function speaksHttp(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: address, port, method: "HEAD", path: "/", timeout: 1500, headers: { host: `localhost:${port}` } }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

const PS_LIST = [
  "$l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 1024 }",
  "$p = @{}; Get-CimInstance Win32_Process | ForEach-Object { $p[[int]$_.ProcessId] = $_ }",
  "$l | ForEach-Object { $x = $p[[int]$_.OwningProcess]; [pscustomobject]@{ port = $_.LocalPort; address = $_.LocalAddress; pid = $_.OwningProcess; process = if ($x) { $x.Name -replace '\\.exe$','' } else { '' }; command = if ($x -and $x.CommandLine) { $x.CommandLine } else { '' } } } | ConvertTo-Json -Compress",
].join("; ");

/** Порты, которые слушают процессы на ПК (Windows). */
export function listPorts(opts: { directory?: string; exclude?: number[]; selfPid?: number } = {}): Promise<ListeningPort[]> {
  return new Promise((resolve) => {
    if (process.platform !== "win32") return resolve([]);
    execFile("powershell.exe", ["-NoProfile", "-Command", PS_LIST], { windowsHide: true, timeout: 20_000, maxBuffer: 8 << 20 }, (err, out) => {
      if (err || !out.trim()) return resolve([]);
      let raw: unknown;
      try {
        raw = JSON.parse(out);
      } catch {
        return resolve([]);
      }
      const dir = opts.directory?.toLowerCase().replace(/[\\/]+$/, "");
      const seen = new Map<number, ListeningPort>();
      for (const r of (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>) {
        const port = Number(r.port);
        const pid = Number(r.pid);
        const name = String(r.process ?? "");
        if (opts.exclude?.includes(port) || pid === opts.selfPid || SKIP.test(name)) continue;
        const command = String(r.command ?? "");
        const p: ListeningPort = { port, address: String(r.address), pid, process: name, command: command.slice(0, 300), project: !!dir && command.toLowerCase().includes(dir) };
        // IPv4 и IPv6 на одном порту — одна запись; localhost-адрес полезнее для прокси
        const prev = seen.get(port);
        if (!prev || isLocal(p.address)) seen.set(port, p);
      }
      const all = [...seen.values()];
      void Promise.all(all.map((p) => speaksHttp(isWildcard(p.address) ? "127.0.0.1" : p.address, p.port))).then((ok) =>
        resolve(all.filter((_, i) => ok[i]).sort((a, b) => Number(b.project) - Number(a.project) || a.port - b.port)),
      );
    });
  });
}

const isLocal = (a: string) => a === "127.0.0.1" || a === "::1";
const isWildcard = (a: string) => a === "0.0.0.0" || a === "::";

interface Proxy {
  server: Server;
  port: number;
  sockets: Set<Socket>;
}

export class Previews {
  readonly key = randomBytes(16).toString("hex");
  private proxies = new Map<number, Proxy>();

  constructor(
    /** адрес, на котором открывать прокси (Tailscale IP); undefined — превью недоступно */
    private host: () => string | undefined,
    private log: (m: string) => void = () => {},
    /** порты для прокси, если порт dev-сервера на этом адресе занят */
    private fallback: number[] = Array.from({ length: 20 }, (_, i) => 7421 + i),
  ) {}

  /** Ссылка на превью порта: напрямую, если dev-сервер слушает все адреса, иначе через прокси хаба. */
  async open(target: { port: number; address: string }): Promise<string> {
    const host = this.host();
    if (!host) throw new Error(L("Нет Tailscale-адреса — превью с телефона недоступно", "No Tailscale address — preview from the phone isn't available"));
    const h = host.includes(":") ? `[${host}]` : host;
    if (isWildcard(target.address) || target.address === host) return `http://${h}:${target.port}/`;
    let p = this.proxies.get(target.port);
    if (!p) {
      p = await this.start(host, target);
      this.proxies.set(target.port, p);
      this.log(`[hub] ${L("превью", "preview")}: ${host}:${p.port} → ${target.address}:${target.port}`);
    }
    return `http://${h}:${p.port}/?${COOKIE}=${this.keyFor(target.port)}`;
  }

  /**
   * Свой ключ и своя кука на каждый порт: куки не различают порты, и dev-сервер, открытый напрямую на том же адресе,
   * получил бы ключ ко всем превью. Так утечёт ключ только к этому порту.
   */
  keyFor(port: number): string {
    return createHmac("sha256", this.key).update(String(port)).digest("hex").slice(0, 32);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.proxies.values()].map(
        (p) =>
          new Promise<void>((r) => {
            for (const s of p.sockets) s.destroy();
            p.server.close(() => r());
          }),
      ),
    );
    this.proxies.clear();
  }

  private authorized(req: IncomingMessage, port: number): boolean {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}_${port}=([0-9a-f]+)`).exec(req.headers.cookie ?? "");
    return m?.[1] === this.keyFor(port);
  }

  private async start(host: string, target: { port: number; address: string }): Promise<Proxy> {
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => this.handle(req, res, target));
    server.on("upgrade", (req, socket: Socket, head) => this.upgrade(req, socket, head, target));
    server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
    for (const port of [target.port, ...this.fallback]) {
      const ok = await new Promise<boolean>((r) => {
        server.once("error", () => r(false));
        server.listen(port, host, () => r(true));
      });
      if (ok) return { server, port, sockets };
    }
    throw new Error(L("Нет свободного порта для превью", "No free port for the preview"));
  }

  private handle(req: IncomingMessage, res: ServerResponse, target: { port: number; address: string }): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://x");
    } catch {
      // кривая строка запроса не должна ронять хаб (сырой http-сервер: исключение здесь — uncaughtException)
      res.writeHead(400);
      return void res.end();
    }
    const key = this.keyFor(target.port);
    if (url.searchParams.get(COOKIE) === key) {
      url.searchParams.delete(COOKIE);
      // только свой путь: «//evil.example» в location — уже чужой сайт
      const location = "/" + url.pathname.replace(/^\/+/, "") + url.search;
      res.writeHead(302, { "set-cookie": `${COOKIE}_${target.port}=${key}; Path=/; HttpOnly; SameSite=Lax`, location });
      return void res.end();
    }
    if (!this.authorized(req, target.port)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(L("Превью открывается из KraBness (кнопка «Превью» в чате).", "Open the preview from KraBness (the “Preview” button in chat)."));
    }
    const up = request(
      { host: target.address, port: target.port, method: req.method, path: req.url, headers: rewrite(req.headers, target.port) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(L(`dev-сервер на порту ${target.port} не отвечает: ${e.message}`, `the dev server on port ${target.port} doesn't answer: ${e.message}`));
    });
    req.pipe(up);
  }

  // WebSocket (горячая перезагрузка): сырой проброс с переписанными заголовками
  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer, target: { port: number; address: string }): void {
    if (!this.authorized(req, target.port)) return void socket.destroy();
    const up = connect(target.port, target.address, () => {
      const headers = rewrite(req.headers, target.port);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))];
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const done = () => (up.destroy(), socket.destroy());
    up.on("error", done);
    socket.on("error", done);
    up.on("close", done);
    socket.on("close", done);
  }
}

/** Host и Origin — как будто запрос пришёл с localhost: Vite и др. отказывают чужим хостам. */
function rewrite(h: IncomingMessage["headers"], port: number): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...h, host: `localhost:${port}` };
  if (h.origin) out.origin = `http://localhost:${port}`;
  if (h.referer) out.referer = String(h.referer).replace(/^https?:\/\/[^/]+/, `http://localhost:${port}`);
  // кука доступа к превью dev-серверу не нужна
  if (typeof h.cookie === "string") {
    const rest = h.cookie.split(/;\s*/).filter((c) => !c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}_`)).join("; ");
    if (rest) out.cookie = rest;
    else delete out.cookie;
  }
  return out;
}
