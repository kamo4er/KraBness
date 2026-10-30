// Сборка хаба целиком: конфиг → БД → движки → HTTP/WS. Используется и main.ts, и тестами.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { ConfigStore, REPO_ROOT, type HubConfig } from "./config.ts";
import { Db } from "./db.ts";
import { Auth } from "./auth.ts";
import { SessionManager } from "./sessions.ts";
import { backfillUsage } from "./usage.ts";
import { randomBytes } from "node:crypto";
import { OpencodeEngine } from "./engines/opencode.ts";
import { ClaudeEngine } from "./engines/claude.ts";
import { FileStore } from "./files.ts";
import { PushSender } from "./push.ts";
import { Notifier } from "./notifier.ts";
import { AutoResume } from "./autoresume.ts";
import { previewHost, Previews } from "./preview.ts";
import { sendLayoutComments } from "./comments.ts";
import { Terminal } from "./terminal.ts";
import { Providers } from "./providers.ts";
import { TelegramBot } from "./telegram.ts";
import { SessionBots } from "./sessionbot.ts";
import { Presence } from "./presence.ts";
import { registerMcp } from "./mcp.ts";
import { McpRegistry } from "./usermcp.ts";
import { setHubLang } from "./lang.ts";
import { Skills } from "./skills.ts";
import { Updates } from "./updates.ts";
import { ClaudeLogin } from "./claudeauth.ts";
import { RemoteTunnel } from "./remote.ts";
import { AutoCheck } from "./checks.ts";
import { Orchestrator } from "./orchestrator.ts";
import { tunnelSockets } from "./auth.ts";
import { buildServer } from "./server.ts";
import { L } from "./lang.ts";

/** версия установки — из корневого package.json (её же ставит выпуск) */
export const VERSION: string = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";

export interface Hub {
  app: FastifyInstance;
  sessions: SessionManager;
  config: ConfigStore;
  db: Db;
  files: FileStore;
  presence: Presence;
  urls: string[];
  close(): Promise<void>;
}

export function tailscaleIp(): string | undefined {
  // PATH у уже запущенных процессов может не знать про свежий Tailscale — пробуем и стандартный путь
  const bins = ["tailscale"];
  if (process.platform === "win32") bins.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"));
  for (const bin of bins) {
    try {
      const r = spawnSync(bin, ["ip", "-4"], { encoding: "utf8", timeout: 5000, windowsHide: true });
      const ip = r.stdout?.trim().split(/\s+/)[0];
      if (r.status === 0 && ip) return ip;
    } catch {
      /* следующий вариант */
    }
  }
  return undefined;
}

export interface HubOptions {
  configPath?: string;
  overrides?: Partial<HubConfig>;
  log?: (m: string) => void;
  /** папка скиллов (по умолчанию ~/.claude/skills; тесты дают временную, null — без скиллов) */
  skillsDir?: string | null;
  /** хаб под сторожем: перезапуск = корректно выйти, сторож поднимет заново */
  onRestart?: () => void;
  /** усыпить ПК; не задано — /api/hub/sleep отвечает 409 (тесты не должны усыплять машину) */
  onSleep?: () => void;
  /** снимок экрана (тесты подставляют свой, чтобы не снимать настоящий экран) */
  screen?: () => Promise<Buffer>;
  /** папка собранного веб-UI (тесты подставляют свою) */
  webDir?: string;
  /** обновления с GitHub: check — проверять раз в сутки (main.ts), api и root — тесты подставляют свои */
  updates?: { check?: boolean; api?: string; root?: string };
  /** вход в Claude: тесты подставляют свой адрес Anthropic API и заглушку окна входа */
  claudeLogin?: { api?: string; openTerminal?: (bin: string) => void };
  /** удалённый доступ через VPS: тесты подставляют свой ssh */
  remote?: { sshBin?: string; sshPrefix?: string[]; upAfterMs?: number };
}

export async function createHub(opts: HubOptions = {}): Promise<Hub> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const config = new ConfigStore(opts.configPath ?? join(REPO_ROOT, "config", "kamharn.json"), opts.overrides);
  setHubLang(config.config.language);
  const cfg = config.config;
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = new Db(join(cfg.dataDir, "kamharn.db"));
  // с этого момента расход считается вживую; всё раньше — история задним числом (backfillUsage)
  if (!db.getMeta("usage.since")) db.setMeta("usage.since", String(Date.now()));
  const auth = new Auth(db);
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  // пуши: ключ сервисного аккаунта Firebase лежит рядом с конфигом (в git не попадает)
  const push = new PushSender(join(dirname(config.path), "firebase-service-account.json"), log);
  const presence = new Presence();
  // автопроверка создаётся сразу после — уведомления спрашивают её, молчать ли про «готово»
  let autoCheck: AutoCheck | undefined;
  const notifier = new Notifier(db, push, presence, (sid) => autoCheck?.active(sid) ?? false);
  autoCheck = new AutoCheck({ sessions, config, notify: (sid, m) => notifier.notify(sid, m), log });
  // задачи: конвейер над сессиями (исполнитель → проверки → ревью → отчёт)
  const tasks = new Orchestrator({ sessions, db, config, autoCheck, notify: (sid, m) => notifier.notify(sid, m), log });
  // уведомления в свой Telegram-бот (если настроен): кнопки подтверждения и ответ агенту реплаем
  const telegram = new TelegramBot(
    config,
    { replyPermission: (sid, rid, reply) => sessions.replyPermission(sid, rid, reply, "telegram"), prompt: (sid, text) => sessions.prompt(sid, text) },
    log,
  );
  notifier.subscribe((n) => telegram.notify(n));
  // боты сессий: свой Telegram-бот на сессию (пишешь — уходит агенту, ответ и файлы — обратно)
  const sessionBots = new SessionBots(config, sessions, files, log);
  sessions.on("event", (e) => notifier.onEvent(e));
  const autoResume = new AutoResume(sessions, () => sessions.limits, (sid, m) => notifier.notify(sid, m), log);
  sessions.on("event", (e) => autoResume.onEvent(e));

  // MCP хаба доступен только с localhost и только по секрету текущего запуска
  const mcpSecret = randomBytes(16).toString("hex");
  let localBase = "";
  // opencode создаётся после listen — реестр MCP достаёт его через ссылку
  let ocRef: OpencodeEngine | undefined;
  const mcpServers = new McpRegistry(config, {
    claudeChanged: () => claude?.restartIdle(),
    opencodeChanged: async () => {
      await ocRef?.restart();
    },
    opencodeStatus: async () => (ocRef ? ocRef.mcpStatus() : {}),
    claudeUser: () => sessions.claudeMcp(),
  });
  const claude = cfg.engines.claude.enabled
    ? new ClaudeEngine({
        bin: cfg.engines.claude.bin,
        defaultModel: cfg.engines.claude.defaultModel,
        // читается при каждом запуске процесса — переключается из настроек без рестарта хаба
        userMcp: () => config.config.engines.claude.userMcp ?? false,
        apiKey: () => config.config.engines.claude.apiKey,
        ...(cfg.engines.claude.args?.length ? { extraArgs: cfg.engines.claude.args } : {}),
        extraMcp: () => mcpServers.forClaude(),
        onMcpStatus: (list) => mcpServers.noteClaudeInit(list),
        dataDir: cfg.dataDir,
        mcpBaseUrl: () => `${localBase}/mcp/${mcpSecret}`,
        log: (m) => log(`[claude] ${m}`),
      })
    : undefined;

  let urls: string[] = [];
  const terminal = new Terminal(cfg.dataDir);
  // провайдеры моделей появляются, когда стартует opencode (после listen)
  let providers: Providers | undefined;
  // превью dev-серверов открывается на Tailscale-адресе хаба
  // режим замечаний: панель — из сборки веба, замечания — агенту сессии, из которой открыто превью
  const webDir = opts.webDir ?? join(REPO_ROOT, "apps", "web", "dist");
  const previews = new Previews(() => previewHost(urls), log, undefined, {
    overlay: () => join(webDir, "krab-overlay.js"),
    onComments: (sid, body) => sendLayoutComments(sessions, files, sid, body),
  }, () => config.config.previewUrl);
  let restartTimer: NodeJS.Timeout | undefined;
  let sleepTimer: NodeJS.Timeout | undefined;
  const scheduleRestart = (delayMs: number) => {
    if (restartTimer) clearTimeout(restartTimer);
    log(L(`[hub] перезапуск через ${Math.round(delayMs / 1000)} с`, `[hub] restarting in ${Math.round(delayMs / 1000)} s`));
    // ответ на запрос должен успеть уйти
    restartTimer = setTimeout(() => opts.onRestart?.(), Math.max(delayMs, 300));
  };
  const updatesApi = opts.updates?.api ?? cfg.updates?.api;
  const updates = new Updates({
    config,
    current: VERSION,
    root: opts.updates?.root ?? REPO_ROOT,
    dataDir: cfg.dataDir,
    supervised: !!opts.onRestart,
    restart: scheduleRestart,
    ...(updatesApi ? { api: updatesApi } : {}),
    log,
  });
  if (opts.updates?.check) updates.start();
  const remote = new RemoteTunnel({ config, version: VERSION, log, dataDir: cfg.dataDir, ...opts.remote });
  // свой адрес за прокси (NAS) и на VPS — тоже известные адреса хаба (QR, приложение выбирает рабочий)
  const allUrls = () => [...urls, ...(config.config.publicUrls ?? []), ...remote.publicUrls()];
  const app = await buildServer({
    sessions, auth, config, db, files, push, presence, previews, terminal, telegram, sessionBots, version: VERSION,
    autoCheck,
    tasks,
    notices: (cb) => notifier.subscribe(cb),
    mcpServers,
    skills: opts.skillsDir === null ? undefined : new Skills(opts.skillsDir),
    providers: () => providers,
    ...(opts.screen ? { screen: opts.screen } : {}),
    urls: allUrls,
    remote,
    startedAt: Date.now(),
    restart: { supervised: !!opts.onRestart, schedule: scheduleRestart },
    updates,
    claudeLogin: new ClaudeLogin(config, { engine: () => claude, ...opts.claudeLogin, log }),
    ...(opts.onSleep
      ? {
          sleep: {
            schedule(delayMs: number) {
              if (sleepTimer) clearTimeout(sleepTimer);
              log(L(`[hub] сон ПК через ${Math.round(delayMs / 1000)} с`, `[hub] PC sleeps in ${Math.round(delayMs / 1000)} s`));
              sleepTimer = setTimeout(() => opts.onSleep?.(), delayMs);
            },
          },
        }
      : {}),
    webDir,
  });
  registerMcp(app, {
    secret: mcpSecret,
    files,
    claude,
    claudeSessionDir: (esid) => sessions.directoryOf("claude", esid),
  });

  // Слушаем только перечисленные адреса (localhost + Tailscale), не 0.0.0.0.
  // localhost нужен всегда: через него движки ходят в MCP хаба.
  const hosts: string[] = ["127.0.0.1"];
  for (const h of cfg.listen) if (h !== "tailscale" && !hosts.includes(h)) hosts.push(h);

  await app.listen({ host: hosts[0], port: cfg.port });
  const port = (app.server.address() as { port: number }).port;

  // общий адрес превью (своё имя за NAS → этот же порт): такие запросы — в прокси превью, мимо API хаба.
  // Перехватываем на уровне сервера: до роутера Fastify и до WebSocket-плагина.
  for (const ev of ["request", "upgrade"] as const) {
    const own = app.server.listeners(ev) as Array<(...a: unknown[]) => void>;
    app.server.removeAllListeners(ev);
    app.server.on(ev, (req: IncomingMessage, ...rest: unknown[]) => {
      if (!previews.isShared(req)) return void own.forEach((f) => f.call(app.server, req, ...rest));
      if (ev === "request") previews.handleShared(req, rest[0] as ServerResponse);
      else previews.upgradeShared(req, rest[0] as Socket, rest[1] as Buffer);
    });
  }

  // дополнительные адреса — отдельные http-серверы, которые отдают запросы тому же приложению
  const bind = async (host: string): Promise<Server> => {
    const srv = createServer();
    srv.on("request", (req, res) => app.server.emit("request", req, res));
    srv.on("upgrade", (req, sock, head) => app.server.emit("upgrade", req, sock, head));
    await new Promise<void>((res, rej) => srv.once("error", rej).listen(port, host, () => res()));
    return srv;
  };
  const extra: Server[] = [];
  for (const host of hosts.slice(1)) {
    // адреса в домашней сети меняются (DHCP) — пропавший адрес не должен ронять хаб
    try {
      extra.push(await bind(host));
    } catch (e) {
      log(`${L(`[hub] не удалось слушать ${host}`, `[hub] couldn't listen on ${host}`)}: ${(e as Error).message}`);
      hosts.splice(hosts.indexOf(host), 1);
    }
  }

  // Tailscale может подняться (или сменить IP) уже после старта хаба — следим и перепривязываемся
  let ts: { ip: string; srv: Server } | undefined;
  const refreshUrls = () => {
    urls = [...hosts, ...(ts ? [ts.ip] : [])].map((h) => `http://${h}:${port}`);
  };
  const syncTailscale = async (first = false) => {
    const ip = tailscaleIp();
    if (!ip && first) log(L("[hub] Tailscale не подключён — буду проверять каждые 30 с", "[hub] Tailscale isn't connected — will check every 30 s"));
    if (ip === ts?.ip) return;
    if (ts) {
      ts.srv.close();
      log(L(`[hub] Tailscale-адрес ${ts.ip} пропал`, `[hub] Tailscale address ${ts.ip} is gone`));
      ts = undefined;
    }
    if (ip) {
      try {
        ts = { ip, srv: await bind(ip) };
        log(`${L("[hub] слушаю Tailscale", "[hub] listening on Tailscale")}: http://${ip}:${port}`);
      } catch (e) {
        log(`${L(`[hub] не удалось слушать ${ip}`, `[hub] couldn't listen on ${ip}`)}: ${(e as Error).message}`);
      }
    }
    refreshUrls();
  };
  let tsTimer: NodeJS.Timeout | undefined;
  if (cfg.listen.includes("tailscale")) {
    await syncTailscale(true);
    tsTimer = setInterval(() => void syncTailscale(), 30_000);
    tsTimer.unref();
  }
  refreshUrls();

  // туннель с VPS приходит на свой порт: запросы с него не локальные, даже если адрес 127.0.0.1
  const tunnelSrv = createServer();
  tunnelSrv.on("connection", (sock) => tunnelSockets.add(sock));
  tunnelSrv.on("request", (req, res) => app.server.emit("request", req, res));
  tunnelSrv.on("upgrade", (req, sock, head) => app.server.emit("upgrade", req, sock, head));
  await new Promise<void>((res, rej) => tunnelSrv.once("error", rej).listen(0, "127.0.0.1", () => res()));
  await remote.start((tunnelSrv.address() as { port: number }).port);

  localBase = `http://127.0.0.1:${port}`;
  // после listen: просроченный «Продолжай» может уйти сразу, а движкам уже нужен адрес MCP
  autoResume.start();
  tasks.start();
  telegram.start();
  sessionBots.start();

  if (cfg.engines.opencode.enabled) {
    const oc = new OpencodeEngine({
      bin: cfg.engines.opencode.bin,
      port: cfg.engines.opencode.port,
      pidFile: join(cfg.dataDir, "opencode.pid"),
      defaultModel: cfg.engines.opencode.defaultModel,
      mcpUrl: `${localBase}/mcp/${mcpSecret}/opencode`,
      fileByPath: (p) => files.byPath(p),
      log: (m) => log(`[opencode] ${m}`),
      // читаются при каждом запуске/запросе — правки из настроек применяются без рестарта хаба
      customProviders: () => config.config.customProviders ?? [],
      favorites: () => config.config.modelFavorites ?? {},
      extraMcp: () => mcpServers.forOpencode(),
    });
    ocRef = oc;
    providers = new Providers(oc, config, log);
    try {
      await sessions.addEngine(oc);
    } catch (e) {
      log(`${L("[opencode] не стартовал", "[opencode] failed to start")}: ${(e as Error).message}`);
    }
  }
  if (claude) await sessions.addEngine(claude);

  // расход задним числом — один раз, в фоне: транскрипты Claude и история opencode по сессиям хаба
  if (!db.getMeta("usage.backfilled")) {
    void backfillUsage({
      db,
      sessions: sessions.list(),
      engineSessionId: (id) => sessions.engineSessionIdOf(id),
      claudeProjectsDir: sessions.projectsDir,
      ...(ocRef ? { opencodeMessages: (esid: string, dir: string) => ocRef!.messages(esid, dir) } : {}),
      log,
    }).then(
      (n) => {
        db.setMeta("usage.backfilled", String(Date.now()));
        log(`[usage] ${L("история расхода поднята, записей", "usage history imported, records")}: ${n}`);
      },
      (e: Error) => log(`[usage] ${e.message}`),
    );
  }

  return {
    app,
    sessions,
    config,
    db,
    files,
    presence,
    get urls() {
      return allUrls();
    },
    async close() {
      if (tsTimer) clearInterval(tsTimer);
      if (restartTimer) clearTimeout(restartTimer);
      if (sleepTimer) clearTimeout(sleepTimer);
      updates.close();
      autoCheck.close();
      tasks.close();
      remote.close();
      autoResume.close();
      terminal.close();
      telegram.close();
      sessionBots.close();
      await previews.close();
      // Клиенты держат WebSocket постоянно, а server.close() ждёт закрытия всех соединений —
      // без принудительного разрыва хаб висел на выключении вечно (и сторож не мог его перезапустить).
      for (const c of app.websocketServer?.clients ?? []) c.terminate();
      await Promise.all(
        [...extra, tunnelSrv, ...(ts ? [ts.srv] : [])].map(
          (s) =>
            new Promise((r) => {
              s.close(r);
              s.closeAllConnections();
            }),
        ),
      );
      await app.close();
      await sessions.stop();
      db.close();
    },
  };
}
