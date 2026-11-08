// Превью dev-серверов на телефоне: dev-сервер слушает localhost ПК, хаб открывает к нему прокси на Tailscale-адресе.
// Прокси на отдельном порту (а не /preview/<порт>/ на хабе): dev-серверы ссылаются на абсолютные пути (/src, /@vite).
// Доступ — по ключу текущего запуска хаба: ?kh_preview=<ключ> один раз, дальше кука.
// Режим замечаний (открыт из чата сессии): в HTML-страницы вставляется панель /__krab/overlay.js, замечания с неё
// приходят на /__krab/comments и уходят агенту этой сессии.
import { createHmac, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, inflate } from "node:zlib";
import type { ListeningPort } from "@kamharn/protocol";
import { hubLang, L } from "./lang.ts";

const COOKIE = "kh_preview";
/** кука режима замечаний: <id сессии>.<подпись> — куда слать замечания с этой страницы */
const NOTE = "kh_note";
/** общий адрес превью: какой порт смотрит этот браузер (кука) и как он задаётся в ссылке */
const PV = "kh_pv";
const PORT = "kh_port";
const isIpUrl = (u: string): boolean => {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return /^[\d.]+$/.test(h) || h.includes(":") || h === "localhost";
  } catch {
    return true;
  }
};
/** пути панели замечаний: их обслуживает сам прокси, до dev-сервера они не доходят */
const KRAB = "/__krab/";
/** больше — HTML не трогаем (отдаём как есть, без панели) */
const MAX_HTML = 10 * 1024 * 1024;
const MAX_COMMENTS_BODY = 30 * 1024 * 1024;
const unzip: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: promisify(gunzip),
  "x-gzip": promisify(gunzip),
  br: promisify(brotliDecompress),
  deflate: promisify(inflate),
};
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

export interface PreviewNotes {
  /** собранная панель замечаний (apps/web/dist/krab-overlay.js) */
  overlay: () => string;
  /** замечания со страницы → агенту сессии */
  onComments: (sessionId: string, body: unknown) => Promise<unknown>;
}

/**
 * Адрес для прокси превью из адресов хаба: Tailscale (100.64.0.0/10) — до него телефон достаёт и из мобильной сети;
 * иначе первый не локальный (домашняя сеть). Только IP: публичные адреса через NAS/VPS — это другие машины.
 */
export function previewHost(urls: string[]): string | undefined {
  const hosts = urls.map((u) => new URL(u).hostname.replace(/^\[|\]$/g, "")).filter((h) => /^[\d.]+$|:/.test(h) && h !== "127.0.0.1" && h !== "::1");
  return hosts.find((h) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) ?? hosts[0];
}

/** Вставить панель замечаний в HTML: перед </head>, иначе перед </body>, иначе в конец. */
export function injectOverlay(html: string, src: string): string {
  const tag = `<script src="${src}" defer></script>`;
  for (const close of [/<\/head\s*>/i, /<\/body\s*>/i]) {
    const m = close.exec(html);
    if (m) return html.slice(0, m.index) + tag + html.slice(m.index);
  }
  return html + tag;
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
    private notes?: PreviewNotes,
    /** общий адрес превью за обратным прокси (NAS): запросы с этим именем приходят на порт хаба */
    private shared?: () => string | undefined,
  ) {}

  /** какие dev-серверы открывали (для общего адреса: по куке kh_pv — порт, отсюда — куда проксировать) */
  private targets = new Map<number, { port: number; address: string }>();

  /**
   * Ссылка на превью порта: напрямую, если dev-сервер слушает все адреса, иначе через прокси хаба.
   * С session — режим замечаний: всегда через прокси (иначе панель некуда вставить), замечания уйдут в эту сессию.
   * via — адрес, по которому клиент ходит в хаб: по имени (NAS, свой домен) — значит, и превью через общий адрес.
   */
  async open(target: { port: number; address: string }, opts: { session?: string; via?: string } = {}): Promise<string> {
    const note = opts.session && this.notes ? opts.session : undefined;
    this.targets.set(target.port, target);
    const shared = this.shared?.();
    if (shared && opts.via && !isIpUrl(opts.via)) {
      const q = new URLSearchParams({ [COOKIE]: this.keyFor(target.port), [PORT]: String(target.port), ...(note ? { [NOTE]: this.noteFor(target.port, note) } : {}) });
      return `${shared.replace(/\/+$/, "")}/?${q}`;
    }
    const host = this.host();
    if (!host) throw new Error(L("Нет Tailscale-адреса — превью с телефона недоступно", "No Tailscale address — preview from the phone isn't available"));
    const h = host.includes(":") ? `[${host}]` : host;
    if (!note && (isWildcard(target.address) || target.address === host)) return `http://${h}:${target.port}/`;
    let p = this.proxies.get(target.port);
    if (!p) {
      p = await this.start(host, target);
      this.proxies.set(target.port, p);
      this.log(`[hub] ${L("превью", "preview")}: ${host}:${p.port} → ${target.address}:${target.port}`);
    }
    const q = new URLSearchParams({ [COOKIE]: this.keyFor(target.port), ...(note ? { [NOTE]: this.noteFor(target.port, note) } : {}) });
    return `http://${h}:${p.port}/?${q}`;
  }

  /**
   * Свой ключ и своя кука на каждый порт: куки не различают порты, и dev-сервер, открытый напрямую на том же адресе,
   * получил бы ключ ко всем превью. Так утечёт ключ только к этому порту.
   */
  keyFor(port: number): string {
    return createHmac("sha256", this.key).update(String(port)).digest("hex").slice(0, 32);
  }

  /** Значение куки режима замечаний: сессия и подпись (порт + сессия) — подставить чужую сессию нельзя. */
  noteFor(port: number, session: string): string {
    return `${session}.${createHmac("sha256", this.key).update(`note:${port}:${session}`).digest("hex").slice(0, 32)}`;
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

  /** Запрос на общий адрес превью (по имени хоста)? Такие хаб отдаёт сюда, а не своему API. */
  isShared(req: IncomingMessage): boolean {
    const u = this.shared?.();
    if (!u) return false;
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    return !!host && host === new URL(u).hostname.toLowerCase();
  }

  /** Порт dev-сервера для общего адреса: из ссылки (первый заход) или куки kh_pv. */
  private sharedTarget(req: IncomingMessage): { port: number; address: string } | undefined {
    let port = Number(cookie(req, PV));
    try {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get(PORT);
      if (q) port = Number(q);
    } catch {
      /* кривой адрес — разберётся handle */
    }
    return this.targets.get(port);
  }

  handleShared(req: IncomingMessage, res: ServerResponse): void {
    const target = this.sharedTarget(req);
    if (!target) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(L("Превью не открыто: открой его из чата KraBness (кнопка ▶).", "No preview open: open it from the KraBness chat (the ▶ button)."));
    }
    this.handle(req, res, target);
  }

  upgradeShared(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const target = this.sharedTarget(req);
    if (!target) return void socket.destroy();
    this.upgrade(req, socket, head, target);
  }

  private authorized(req: IncomingMessage, port: number): boolean {
    return cookie(req, `${COOKIE}_${port}`) === this.keyFor(port);
  }

  /** Сессия режима замечаний из куки (подпись проверена) или undefined. */
  private noteSession(req: IncomingMessage, port: number): string | undefined {
    const v = cookie(req, `${NOTE}_${port}`);
    const sid = v?.split(".")[0];
    return sid && v === this.noteFor(port, sid) ? sid : undefined;
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
      // фактический порт: 0 в списке — «любой свободный»
      if (ok) return { server, port: (server.address() as AddressInfo).port, sockets };
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
      const note = url.searchParams.get(NOTE);
      const shared = url.searchParams.has(PORT);
      url.searchParams.delete(COOKIE);
      url.searchParams.delete(NOTE);
      url.searchParams.delete(PORT);
      // только свой путь: «//evil.example» в location — уже чужой сайт
      const location = "/" + url.pathname.replace(/^\/+/, "") + url.search;
      const cookies = [`${COOKIE}_${target.port}=${key}; Path=/; HttpOnly; SameSite=Lax`];
      const sid = note?.split(".")[0];
      // режим замечаний: подпись верна — запомнить сессию; обычная ссылка — выключить
      if (sid && note === this.noteFor(target.port, sid)) cookies.push(`${NOTE}_${target.port}=${note}; Path=/; HttpOnly; SameSite=Lax`);
      else cookies.push(`${NOTE}_${target.port}=; Path=/; Max-Age=0`);
      // общий адрес: дальше этот браузер смотрит этот порт
      if (shared) cookies.push(`${PV}=${target.port}; Path=/; HttpOnly; SameSite=Lax`);
      res.writeHead(302, { "set-cookie": cookies, location });
      return void res.end();
    }
    if (!this.authorized(req, target.port)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(L("Превью открывается из KraBness (кнопка «Превью» в чате).", "Open the preview from KraBness (the “Preview” button in chat)."));
    }
    const note = this.notes ? this.noteSession(req, target.port) : undefined;
    if (url.pathname.startsWith(KRAB)) return void this.krab(req, res, url, note);
    // страница (не скрипт и не картинка) в режиме замечаний — в неё вставим панель
    const page = !!note && req.method === "GET" && /text\/html/.test(String(req.headers.accept ?? ""));
    const headers = rewrite(req.headers, target.port);
    // сжатый HTML пришлось бы разжимать: просим без сжатия (сожмёт всё равно — разожмём)
    if (page) headers["accept-encoding"] = "identity";
    const up = request({ host: target.address, port: target.port, method: req.method, path: req.url, headers }, (r) => {
      if (page && /text\/html/i.test(String(r.headers["content-type"] ?? ""))) return void this.sendPage(r, res);
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(L(`dev-сервер на порту ${target.port} не отвечает: ${e.message}`, `the dev server on port ${target.port} doesn't answer: ${e.message}`));
    });
    req.pipe(up);
  }

  /** HTML-страница в режиме замечаний: собрать, разжать, вставить панель. Слишком большую — как есть. */
  private sendPage(r: IncomingMessage, res: ServerResponse): void {
    const parts: Buffer[] = [];
    let size = 0;
    let passed = false;
    r.on("data", (d: Buffer) => {
      if (passed) return;
      size += d.length;
      parts.push(d);
      if (size > MAX_HTML) {
        passed = true;
        res.writeHead(r.statusCode ?? 200, r.headers);
        for (const p of parts) res.write(p);
        r.pipe(res);
      }
    });
    r.on("end", () => {
      if (passed) return;
      const raw = Buffer.concat(parts);
      const enc = String(r.headers["content-encoding"] ?? "").trim().toLowerCase();
      const decode = !enc || enc === "identity" ? Promise.resolve(raw) : unzip[enc] ? unzip[enc](raw) : Promise.reject(new Error(enc));
      decode.then(
        (body) => {
          const html = injectOverlay(body.toString("utf8"), `${KRAB}overlay.js?lang=${hubLang()}`);
          const headers = { ...r.headers };
          delete headers["content-encoding"];
          delete headers["content-length"];
          // отдаём целиком с content-length: «кусками» от dev-сервера вместе с ним — битый ответ
          delete headers["transfer-encoding"];
          delete headers.etag;
          res.writeHead(r.statusCode ?? 200, { ...headers, "content-length": Buffer.byteLength(html), "cache-control": "no-store" });
          res.end(html);
        },
        // не смогли разжать — отдаём как пришло, без панели
        () => (res.writeHead(r.statusCode ?? 200, r.headers), res.end(raw)),
      );
    });
    r.on("error", () => res.destroy());
  }

  /** /__krab/*: сама панель и приём замечаний. Только в режиме замечаний. */
  private krab(req: IncomingMessage, res: ServerResponse, url: URL, note: string | undefined): void {
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!note || !this.notes) return json(403, { error: L("Режим замечаний не включён: открой превью из чата сессии", "Comment mode is off: open the preview from the session chat") });
    if (url.pathname === `${KRAB}overlay.js` && req.method === "GET") {
      const file = this.notes.overlay();
      if (!existsSync(file)) return json(404, { error: L("Панель не собрана: npm run web:build", "The panel isn't built: npm run web:build") });
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return void createReadStream(file).pipe(res);
    }
    if (url.pathname === `${KRAB}comments` && req.method === "POST") {
      // свой заголовок: чужая страница без CORS его не пришлёт — значит, отправила наша панель
      if (req.headers["x-krab"] !== "1") return json(403, { error: "x-krab" });
      const parts: Buffer[] = [];
      let size = 0;
      req.on("data", (d: Buffer) => {
        size += d.length;
        if (size > MAX_COMMENTS_BODY) req.destroy();
        else parts.push(d);
      });
      req.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(parts).toString("utf8"));
        } catch {
          return json(400, { error: "bad json" });
        }
        this.notes!.onComments(note, body).then(
          (out) => json(200, out),
          (e: Error & { statusCode?: number }) => json(typeof e.statusCode === "number" ? e.statusCode : 400, { error: e.message }),
        );
      });
      return;
    }
    json(404, { error: "not found" });
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

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const c of String(req.headers.cookie ?? "").split(/;\s*/)) {
    const i = c.indexOf("=");
    if (i > 0 && c.slice(0, i) === name) return c.slice(i + 1);
  }
  return undefined;
}

/** Host и Origin — как будто запрос пришёл с localhost: Vite и др. отказывают чужим хостам. */
function rewrite(h: IncomingMessage["headers"], port: number): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = { ...h, host: `localhost:${port}` };
  if (h.origin) out.origin = `http://localhost:${port}`;
  if (h.referer) out.referer = String(h.referer).replace(/^https?:\/\/[^/]+/, `http://localhost:${port}`);
  // куки превью и режима замечаний dev-серверу не нужны
  if (typeof h.cookie === "string") {
    const rest = h.cookie.split(/;\s*/).filter((c) => !c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}_`) && !c.startsWith(`${NOTE}_`) && !c.startsWith(`${PV}=`)).join("; ");
    if (rest) out.cookie = rest;
    else delete out.cookie;
  }
  return out;
}
