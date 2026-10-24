// HTTP + WebSocket API хаба.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { MAX_FILE_BYTES, type FileStore } from "./files.ts";
import { gitInfo, mimeOf, readFileView, writeTextFile } from "./project.ts";
import type {
  AppRelease,
  ClaudeLimits,
  ClientMessage,
  CreateSessionRequest,
  ModelRef,
  PartDelta,
  PermissionMode,
  PermissionReplyRequest,
  QuestionReplyRequest,
  PromptRequest,
  ServerMessage,
  SessionInfo,
  StoredEvent,
  SessionGroup,
  HubNotice,
  TelegramProxy,
  McpServer,
  EngineId,
  NewSessionPrefs,
  LangSetting,
} from "@kamharn/protocol";
import { LOCAL_DEVICE, isLoopback, type Auth } from "./auth.ts";
import { REPO_ROOT, type ConfigStore } from "./config.ts";
import type { Db } from "./db.ts";
import type { Presence } from "./presence.ts";
import { listPorts, type Previews } from "./preview.ts";
import { captureScreen } from "./screen.ts";
import type { Terminal } from "./terminal.ts";
import type { Providers } from "./providers.ts";
import type { TelegramBot } from "./telegram.ts";
import { HttpError, type SessionManager } from "./sessions.ts";
import type { McpRegistry } from "./usermcp.ts";
import { Wake } from "./wake.ts";
import { L, setHubLang } from "./lang.ts";

/** будильник для устройства в домашней сети — отдаём из настроек, чтобы не искать в репозитории */
const WAKE_SCRIPT = join(REPO_ROOT, "scripts", "nas-wake", "wake.py");
import type { Skills } from "./skills.ts";
import type { Updates } from "./updates.ts";
import type { ClaudeLogin } from "./claudeauth.ts";

export interface ServerDeps {
  /** отправка пушей (FCM); undefined — не настроено */
  push?: { enabled: boolean };
  /** провайдеры моделей opencode (нет — opencode выключен или ещё не стартовал) */
  providers?: () => Providers | undefined;
  /** подписка на уведомления (для приложений, которые показывают их сами, без Firebase) */
  notices?: (cb: (n: HubNotice) => void) => () => void;
  /** свой Telegram-бот для уведомлений */
  mcpServers?: Pick<McpRegistry, "overview" | "save" | "remove">;
  skills?: Skills;
  telegram?: Pick<TelegramBot, "status" | "setToken" | "remove" | "test" | "setProxy">;
  /** мини-терминал в папке сессии */
  terminal?: Terminal;
  /** снимок экрана ПК (тесты подставляют свой) */
  screen?: () => Promise<Buffer>;
  /** прокси превью dev-серверов */
  previews?: Pick<Previews, "open">;
  /** кто из клиентов сейчас активен (глушит пуши) */
  presence?: Pick<Presence, "set" | "drop">;
  sessions: SessionManager;
  auth: Auth;
  config: ConfigStore;
  db: Db;
  files: FileStore;
  version: string;
  /** адреса, на которых слушает хаб (известны после listen) */
  urls: () => string[];
  /** папка собранного веб-UI */
  webDir?: string;
  startedAt?: number;
  /** перезапуск самого хаба: только если его запустил сторож (scripts/hub-service.ps1) */
  restart?: { supervised: boolean; schedule(delayMs: number): void };
  /** обновления с GitHub Releases */
  updates?: Updates;
  /** вход в Claude Code: статус, свой API-ключ, окно входа на ПК */
  claudeLogin?: ClaudeLogin;
  /** усыпить ПК через delayMs; undefined — не умеем (тесты, не Windows) */
  sleep?: { schedule(delayMs: number): void };
}

/** Отдача файла с поддержкой Range — чтобы браузер и загрузчики докачивали большой файл после обрыва связи. */
function sendFile(req: FastifyRequest, reply: FastifyReply, path: string, mime: string, name: string) {
  const st = statSync(path);
  const size = st.size;
  // ETag обязателен для докачки: системный DownloadManager Android без него после обрыва
  // не продолжает, а падает с ERROR_CANNOT_RESUME (1008)
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header("content-type", mime);
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header("accept-ranges", "bytes");
  reply.header("etag", etag);
  reply.header("last-modified", st.mtime.toUTCString());
  // докачка файла, который успел поменяться, — отказ (DownloadManager шлёт If-Match)
  const ifMatch = req.headers["if-match"];
  if (ifMatch && ifMatch !== "*" && !String(ifMatch).split(/\s*,\s*/).includes(etag)) return reply.code(412).send();
  // If-Range с чужим ETag — отдаём файл целиком, а не кусок
  const ifRange = req.headers["if-range"];
  const rangeOk = !ifRange || ifRange === etag || ifRange === st.mtime.toUTCString();
  const m = rangeOk ? /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? "").trim()) : null;
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header("content-length", String(size));
  return reply.send(createReadStream(path));
}

declare module "fastify" {
  interface FastifyRequest {
    deviceId: string;
  }
}

const PUBLIC_ROUTES = new Set(["/api/health", "/api/pair/complete"]);

/** имя самого ПК: localhost и весь loopback (127.0.0.0/8, ::1) */
const localName = (h: string) => h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
/** vite dev (npm run web:dev) проксирует API на хаб со своей страницы */
const DEV_PORT = "5173";

/** Заголовок Host → [имя, порт]; кривой — пустое имя. */
function hostOf(req: FastifyRequest): [string, string] {
  try {
    const u = new URL(`http://${req.headers.host ?? ""}`);
    return [u.hostname, u.port || "80"];
  } catch {
    return ["", ""];
  }
}

/** Пришёл через обратный прокси (tailscale serve/funnel, ssh -L): адрес loopback, но это не сам ПК. */
const proxied = (req: FastifyRequest) => !!(req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["tailscale-user-login"]);

/**
 * Запрос со страницы другого сайта: Origin не сам хаб (тот же localhost-порт; ещё vite dev) или браузер пометил cross-site.
 * Любой localhost не годится: на нём бывают чужие dev-серверы и страницы, собранные агентом.
 */
function crossSite(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const o = new URL(origin);
      if (!localName(o.hostname)) return true;
      const port = o.port || (o.protocol === "https:" ? "443" : "80");
      return port !== hostOf(req)[1] && port !== DEV_PORT;
    } catch {
      return true; // «null» — file://, песочница iframe
    }
  }
  return req.headers["sec-fetch-site"] === "cross-site";
}

function tokenOf(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const q = (req.query as Record<string, string | undefined>)?.token;
  return q || undefined;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { sessions, auth, config, db, files } = deps;
  // forceCloseConnections: при close() рвём keep-alive и прочие висящие соединения, а не ждём их
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, forceCloseConnections: true });
  // сжатие: первая загрузка большого чата — мегабайты JSON, а он жмётся в разы
  await app.register(websocket, { options: { perMessageDeflate: { threshold: 1024 } } });
  // всё, кроме JSON, отдаём роуту потоком (загрузка файлов)
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  app.decorateRequest("deviceId", "");
  app.addHook("onRequest", async (req, reply) => {
    const local = isLoopback(req.socket.remoteAddress) && !proxied(req);
    // DNS rebinding: страница evil.com, перепривязанная на 127.0.0.1, шлёт свой Host и для браузера она same-origin
    if (local && !localName(hostOf(req)[0])) return reply.code(403).send({ error: L("Чужой адрес в заголовке Host", "Foreign address in the Host header") });
    // решаем по маршруту, который нашёл роутер, а не по сырому url: роутер раскодирует %XX, и /%61pi/… — это /api/…
    const route = req.routeOptions.url ?? "";
    if (!route.startsWith("/api/") && route !== "/ws") return;
    if (PUBLIC_ROUTES.has(route)) return;
    const deviceId = auth.authenticate(local ? req.socket.remoteAddress : undefined, tokenOf(req));
    if (!deviceId) return reply.code(401).send({ error: L("Нужна авторизация (pairing)", "Authorization required (pairing)") });
    // localhost доверенный — значит, его нельзя отдавать чужим сайтам, открытым в браузере на ПК:
    // «слепой» POST (no-cors) поставил бы скилл или усыпил ПК, а WebSocket (на него CORS не действует) читал бы сессии
    if (deviceId === LOCAL_DEVICE && crossSite(req)) return reply.code(403).send({ error: L("Запрос к хабу со стороннего сайта отклонён", "Request to the hub from a third-party site rejected") });
    req.deviceId = deviceId;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
    reply.code(status).send({ error: err.message });
  });

  // ---------- общее ----------

  app.get("/api/health", async () => ({ ok: true, version: deps.version }));
  app.get("/api/hub", async () => ({
    language: config.config.language ?? "auto",
    version: deps.version,
    urls: deps.urls(),
    startedAt: deps.startedAt,
    supervised: !!deps.restart?.supervised,
    canSleep: !!deps.sleep,
  }));
  // язык: один на хабе; всем подключённым сразу говорим переключиться
  const langListeners = new Set<(l: LangSetting) => void>();
  app.put<{ Body: { language?: string } }>("/api/language", async (req) => {
    const l = req.body?.language;
    if (l !== "auto" && l !== "ru" && l !== "en") throw new HttpError(400, L("language: auto, ru или en", "language: auto, ru or en"));
    config.setLanguage(l);
    setHubLang(l);
    for (const cb of langListeners) cb(l);
    return { language: l };
  });
  // ---------- вход в Claude Code ----------
  const claudeLogin = () => {
    if (!deps.claudeLogin) throw new HttpError(404, L("Движок Claude недоступен", "The Claude engine is unavailable"));
    return deps.claudeLogin;
  };
  app.get("/api/claude/auth", async () => claudeLogin().status());
  app.post("/api/claude/login", async () => claudeLogin().login());
  app.put<{ Body: { key?: string } }>("/api/claude/key", async (req) => {
    if (typeof req.body?.key !== "string" || !req.body.key.trim()) throw new HttpError(400, L("key: API-ключ Anthropic", "key: an Anthropic API key"));
    return claudeLogin().setKey(req.body.key);
  });
  app.delete("/api/claude/key", async () => claudeLogin().setKey(null));

  // ---------- обновления ----------
  const updates = () => {
    if (!deps.updates) throw new HttpError(404, L("Обновления недоступны", "Updates are unavailable"));
    return deps.updates;
  };
  app.get("/api/update", async () => updates().status());
  app.post("/api/update/check", async () => updates().check());
  app.post("/api/update/install", async () => updates().install());
  app.put<{ Body: { auto?: boolean } }>("/api/update/settings", async (req) => {
    if (typeof req.body?.auto !== "boolean") throw new HttpError(400, L("auto: true или false", "auto: true or false"));
    return updates().setAuto(req.body.auto);
  });

  app.post<{ Body: { delaySec?: number } }>("/api/hub/sleep", async (req) => {
    if (!deps.sleep) throw new HttpError(409, L("Этот хаб не умеет усыплять ПК", "This hub can't put the PC to sleep"));
    // задержка — чтобы ответ успел дойти до телефона
    const asked = Number(req.body?.delaySec ?? 20);
    const delaySec = Math.min(300, Math.max(5, Number.isFinite(asked) ? asked : 20));
    deps.sleep.schedule(delaySec * 1000);
    return { ok: true, delaySec };
  });
  // адрес и токен сервиса пробуждения: приложение запоминает их, пока ПК не спит
  // пробуждение ПК: /api/wake — приложению (как будить), /api/wake/setup — экрану настройки
  const wake = new Wake(config, {
    // адрес хаба в Tailscale: будильник в локалке видит ПК по нему (хаб слушает Tailscale и localhost)
    pcHost: () => deps.urls().map((u) => new URL(u).hostname).find((h) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)),
    // порт, на котором хаб реально слушает (в конфиге бывает 0 — «любой свободный»)
    pcPort: () => Number(deps.urls()[0] ? new URL(deps.urls()[0]!).port : 0) || config.config.port,
  });
  app.get("/api/wake", async () => wake.runtime());
  app.get("/api/wake/setup", async () => wake.setup());
  app.put<{ Body: { url?: string; token?: string; mac?: string; broadcast?: string } }>("/api/wake/setup", async (req) => wake.save(req.body ?? {}));
  app.delete("/api/wake/setup", async () => wake.remove());
  app.post("/api/wake/token", async () => ({ token: Wake.newToken() }));
  app.post("/api/wake/test", async () => wake.test());
  app.get("/api/wake/script", async (_req, reply) => {
    reply.header("content-type", "text/x-python; charset=utf-8").header("content-disposition", 'attachment; filename="wake.py"');
    return readFileSync(WAKE_SCRIPT, "utf8");
  });
  app.post<{ Body: { delaySec?: number } }>("/api/hub/restart", async (req) => {
    if (!deps.restart?.supervised) {
      throw new HttpError(409, L("Хаб запущен вручную, а не сторожем (scripts/hub-service.ps1) — перезапустить сам себя не может", "The hub was started manually, not by the supervisor (scripts/hub-service.ps1) — it can't restart itself"));
    }
    const delaySec = Math.min(300, Math.max(0, Number(req.body?.delaySec ?? 0) || 0));
    deps.restart.schedule(delaySec * 1000);
    return { ok: true, delaySec };
  });
  app.get("/api/engines", async () => sessions.enginesInfo());
  // «Новая сессия»: включённые движки и что по умолчанию. Без настройки — все, по умолчанию первый (opencode)
  const ENGINES: EngineId[] = ["opencode", "claude"];
  const newSessionPrefs = (): NewSessionPrefs => {
    const p = config.config.newSession ?? {};
    const engines = (p.engines ?? ENGINES).filter((e) => ENGINES.includes(e));
    const list = engines.length ? engines : ENGINES;
    return { engines: list, engine: p.engine && list.includes(p.engine) ? p.engine : list[0]!, models: p.models ?? {} };
  };
  app.get("/api/new-session", async () => newSessionPrefs());
  app.put<{ Body: Partial<NewSessionPrefs> }>("/api/new-session", async (req) => {
    const b = req.body ?? {};
    const engines = Array.isArray(b.engines) ? ENGINES.filter((e) => b.engines!.includes(e)) : newSessionPrefs().engines;
    if (!engines.length) throw new HttpError(400, L("Оставь включённым хотя бы один движок", "Keep at least one engine enabled"));
    const engine = b.engine && engines.includes(b.engine) ? b.engine : engines[0]!;
    const models: NewSessionPrefs["models"] = {};
    for (const e of ENGINES) {
      const m = (b.models ?? newSessionPrefs().models)[e];
      if (m && typeof m.providerId === "string" && typeof m.modelId === "string") models[e] = { providerId: m.providerId, modelId: m.modelId };
    }
    config.setNewSession({ engines, engine, models });
    return newSessionPrefs();
  });

  // снимок экрана ПК: посмотреть с телефона, что там происходит
  app.get("/api/screen", async (_req, reply) => {
    let jpg: Buffer;
    try {
      jpg = await (deps.screen ?? captureScreen)();
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpg);
  });

  // ---------- группы сессий ----------

  type GroupBody = { name?: string; icon?: string; prompt?: string; sort?: number };
  app.get("/api/groups", async () => sessions.groups());
  app.post<{ Body: GroupBody }>("/api/groups", async (req) => sessions.createGroup({ ...req.body, name: String(req.body?.name ?? "") }));
  app.patch<{ Params: { id: string }; Body: GroupBody }>("/api/groups/:id", async (req) => sessions.updateGroup(req.params.id, req.body ?? {}));
  app.delete<{ Params: { id: string } }>("/api/groups/:id", async (req) => {
    sessions.deleteGroup(req.params.id);
    return { ok: true };
  });

  // ---------- отдельная ветка сессии ----------

  app.get<{ Params: { id: string } }>("/api/sessions/:id/worktree", async (req) => sessions.worktreeStatus(req.params.id));
  app.post<{ Params: { id: string } }>("/api/sessions/:id/worktree/merge", async (req) => sessions.mergeWorktree(req.params.id));
  app.post<{ Params: { id: string } }>("/api/sessions/:id/worktree/discard", async (req) => {
    await sessions.discardWorktree(req.params.id);
    return { ok: true };
  });

  // ---------- Telegram-бот для уведомлений ----------

  const tg = () => {
    if (!deps.telegram) throw new HttpError(409, L("Telegram недоступен", "Telegram is unavailable"));
    return deps.telegram;
  };
  app.get("/api/telegram", async () => tg().status());
  app.post<{ Body: { token?: string } }>("/api/telegram", async (req) => {
    try {
      return await tg().setToken(String(req.body?.token ?? ""));
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });
  app.delete("/api/telegram", async () => (tg().remove(), { ok: true }));
  app.put<{ Body: { proxy?: TelegramProxy | null } }>("/api/telegram/proxy", async (req) => {
    try {
      return await tg().setProxy(req.body?.proxy ?? null);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });
  app.post("/api/telegram/test", async () => {
    try {
      await tg().test();
      return { ok: true };
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  // ---------- провайдеры моделей (opencode) ----------

  const prov = () => {
    const p = deps.providers?.();
    if (!p) throw new HttpError(409, L("opencode не запущен — провайдеры недоступны", "opencode is not running — providers are unavailable"));
    return p;
  };
  // ошибки opencode (неверный ключ и т.п.) — понятным 409, а не 500
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(409, (e as Error).message);
    }
  };
  type Str = Record<string, string>;
  app.get("/api/providers", async () => wrap(() => prov().list()));
  app.get<{ Params: { id: string } }>("/api/providers/:id/models", async (req) => wrap(() => prov().models(req.params.id)));
  app.put<{ Params: { id: string }; Body: { models?: string[] } }>("/api/providers/:id/favorites", async (req) => {
    prov().setFavorites(req.params.id, Array.isArray(req.body?.models) ? req.body.models : []);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { key?: string; inputs?: Str } }>("/api/providers/:id/key", async (req) =>
    wrap(async () => (await prov().setKey(req.params.id, String(req.body?.key ?? ""), req.body?.inputs), { ok: true })),
  );
  app.post<{ Params: { id: string }; Body: { method?: number; inputs?: Str } }>("/api/providers/:id/oauth", async (req) =>
    wrap(() => prov().oauthStart(req.params.id, Number(req.body?.method ?? 0), req.body?.inputs)),
  );
  app.get<{ Params: { id: string } }>("/api/providers/:id/oauth", async (req) => prov().oauthStatus(req.params.id));
  app.post<{ Params: { id: string }; Body: { method?: number; code?: string } }>("/api/providers/:id/oauth/code", async (req) =>
    wrap(async () => (await prov().oauthCode(req.params.id, Number(req.body?.method ?? 0), String(req.body?.code ?? "")), { ok: true })),
  );
  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req) => wrap(async () => (await prov().disconnect(req.params.id), { ok: true })));
  app.post<{ Body: { name?: string; baseURL?: string; apiKey?: string; models?: string[] } }>("/api/providers/custom", async (req) =>
    wrap(() => prov().addCustom({ name: String(req.body?.name ?? ""), baseURL: String(req.body?.baseURL ?? ""), apiKey: req.body?.apiKey, models: req.body?.models ?? [] })),
  );
  app.post<{ Body: { baseURL?: string; apiKey?: string } }>("/api/providers/probe", async (req) =>
    wrap(async () => ({ models: await prov().probe(String(req.body?.baseURL ?? ""), req.body?.apiKey) })),
  );

  // ---------- мини-терминал ----------

  const term = () => {
    if (!deps.terminal) throw new HttpError(409, L("Терминал недоступен", "The terminal is unavailable"));
    return deps.terminal;
  };
  const termErr = (e: unknown) => new HttpError(409, (e as Error).message);
  app.get<{ Params: { id: string } }>("/api/sessions/:id/term", async (req) => term().info(sessions.get(req.params.id).id));
  app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/sessions/:id/term", async (req) => {
    const s = sessions.get(req.params.id);
    try {
      return { runId: term().start(s.id, s.directory, String(req.body?.command ?? "")) };
    } catch (e) {
      throw termErr(e);
    }
  });
  app.get<{ Params: { runId: string }; Querystring: { from?: string } }>("/api/term/:runId", async (req) => {
    try {
      return term().read(req.params.runId, Number(req.query.from ?? 0) || 0);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });
  app.post<{ Params: { runId: string } }>("/api/term/:runId/stop", async (req) => {
    try {
      term().stop(req.params.runId);
      return { ok: true };
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
  });

  // ---------- превью dev-серверов ----------

  const ports = (directory?: string) => listPorts({ directory, exclude: [config.config.port], selfPid: process.pid });
  app.get<{ Querystring: { session?: string } }>("/api/ports", async (req) =>
    ports(req.query.session ? sessions.get(req.query.session).directory : undefined),
  );
  app.post<{ Body: { port?: number } }>("/api/preview", async (req) => {
    if (!deps.previews) throw new HttpError(409, L("Превью недоступно", "Preview is unavailable"));
    const port = Number(req.body?.port);
    const target = (await ports()).find((p) => p.port === port);
    if (!target) throw new HttpError(404, L(`Порт ${port} никто не слушает`, `Nothing listens on port ${port}`));
    try {
      return { url: await deps.previews.open(target) };
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  });

  // ---------- папки ----------

  app.get("/api/roots", async () => config.config.roots);
  app.post<{ Body: { path: string } }>("/api/roots", async (req) => {
    try {
      config.addRoot(req.body.path);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    return config.config.roots;
  });
  app.delete<{ Body: { path: string } }>("/api/roots", async (req) => {
    config.removeRoot(req.body.path);
    return config.config.roots;
  });
  app.get<{ Querystring: { hidden?: string } }>("/api/claude/transcripts", async (req) => sessions.claudeTranscripts(req.query.hidden === "1"));
  app.post<{ Params: { id: string; op: string } }>("/api/claude/transcripts/:id/:op", async (req) => {
    if (req.params.op !== "hide" && req.params.op !== "unhide") throw new HttpError(404, L("Нет такого действия", "No such action"));
    sessions.hideTranscript(req.params.id, req.params.op === "hide");
    return { ok: true };
  });
  app.get("/api/limits", async () => sessions.limits ?? null);
  app.get("/api/claude/mcp", async () => sessions.claudeMcp());
  // свои MCP-серверы (оба движка) + серверы из настроек Claude
  const mcpReg = () => {
    if (!deps.mcpServers) throw new HttpError(404, L("Нет реестра MCP", "No MCP registry"));
    return deps.mcpServers;
  };
  app.get("/api/mcp", async () => mcpReg().overview());
  app.put<{ Body: { oldName?: string; server: McpServer } }>("/api/mcp", async (req) => mcpReg().save(req.body?.oldName || undefined, req.body?.server));
  app.delete<{ Params: { name: string } }>("/api/mcp/:name", async (req) => mcpReg().remove(req.params.name));
  // скиллы (~/.claude/skills)
  const sk = () => {
    if (!deps.skills) throw new HttpError(404, L("Скиллы недоступны", "Skills are unavailable"));
    return deps.skills;
  };
  app.get("/api/skills", async () => sk().list());
  app.get<{ Params: { name: string } }>("/api/skills/:name", async (req) => sk().read(req.params.name));
  // большой SKILL.md (инструкции со вставками) не должен упираться в общий лимит JSON 1 МБ
  app.put<{ Params: { name: string }; Body: { text?: string; create?: boolean } }>("/api/skills/:name", { bodyLimit: 4 * 1024 * 1024 }, async (req) =>
    sk().write(req.params.name, String(req.body?.text ?? ""), req.body?.create === true),
  );
  app.delete<{ Params: { name: string } }>("/api/skills/:name", async (req) => (sk().remove(req.params.name), { ok: true }));
  app.post<{ Body: { url?: string; overwrite?: boolean } }>("/api/skills/github", async (req) => sk().fromGithub(String(req.body?.url ?? ""), req.body?.overwrite === true));
  app.put<{ Body: { enabled: boolean } }>("/api/mcp/claude-user", async (req) => {
    sessions.setClaudeMcp(req.body?.enabled === true);
    return mcpReg().overview();
  });
  // model — выбранная модель opencode (без неё — модель по умолчанию)
  const modelOf = (b: { model?: ModelRef } | undefined): ModelRef | undefined =>
    b?.model && typeof b.model.providerId === "string" && typeof b.model.modelId === "string" ? { providerId: b.model.providerId, modelId: b.model.modelId } : undefined;
  app.post<{ Params: { id: string }; Body: { model?: ModelRef } }>("/api/sessions/:id/handoff", async (req) => sessions.handoff(req.params.id, modelOf(req.body)));
  app.post<{ Params: { id: string }; Body: { model?: ModelRef } }>("/api/sessions/:id/review", async (req) => sessions.review(req.params.id, modelOf(req.body)));
  app.put<{ Body: { enabled: boolean } }>("/api/claude/mcp", async (req) => sessions.setClaudeMcp(req.body?.enabled === true));
  app.get<{ Params: { id: string } }>("/api/sessions/:id/commands", async (req) => sessions.commands(req.params.id));
  app.post<{ Body: { id: string } }>("/api/claude/import", async (req) => sessions.importClaude(String(req.body?.id ?? "")));
  app.get("/api/quick-prompts", async () => config.quickPrompts);
  app.put<{ Body: { prompts: unknown } }>("/api/quick-prompts", async (req) => {
    try {
      return config.setQuickPrompts(req.body?.prompts);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/fs/list", async (req) => {
    if (!req.query.path) return config.config.roots.map((p) => ({ name: p, path: p, dir: true }));
    let dir: string;
    try {
      dir = config.resolveAllowed(req.query.path);
    } catch (e) {
      throw new HttpError(403, (e as Error).message);
    }
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => {
        const path = join(dir, d.name);
        let size: number | undefined;
        if (d.isFile()) {
          try {
            size = statSync(path).size;
          } catch {
            /* исчез между readdir и stat */
          }
        }
        return { name: d.name, path, dir: d.isDirectory(), ...(size !== undefined ? { size } : {}) };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  });

  // ---------- просмотр проекта: файлы и git (без агента) ----------

  const allowedFile = (p?: string): string => {
    if (!p) throw new HttpError(400, L("path обязателен", "path is required"));
    let real: string;
    try {
      real = config.resolveAllowed(p);
    } catch (e) {
      throw new HttpError(403, (e as Error).message);
    }
    if (!statSync(real).isFile()) throw new HttpError(400, L("Это не файл", "Not a file"));
    return real;
  };
  app.get<{ Querystring: { path?: string } }>("/api/fs/read", async (req) => readFileView(allowedFile(req.query.path)));
  // правка руками: только существующие текстовые файлы в разрешённых папках; base — sha256 открытой версии
  app.put<{ Body: { path?: string; text?: unknown; base?: string } }>("/api/fs/write", { bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    if (typeof req.body?.text !== "string") throw new HttpError(400, L("text обязателен", "text is required"));
    return writeTextFile(allowedFile(req.body.path), req.body.text, req.body.base);
  });
  app.get<{ Querystring: { path?: string } }>("/api/fs/raw", async (req, reply) => {
    const p = allowedFile(req.query.path);
    return sendFile(req, reply, p, mimeOf(p), basename(p));
  });
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git", async (req) => gitInfo(sessions.get(req.params.id).directory));

  // ---------- сессии ----------

  app.get("/api/sessions", async () => sessions.list());
  app.post<{ Body: CreateSessionRequest }>("/api/sessions", async (req) => sessions.create(req.body));
  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
    const { engineSessionId: _, ...info } = sessions.get(req.params.id);
    return info;
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; model?: ModelRef; permissionMode?: PermissionMode; resumeAt?: number; groupId?: string | null } }>("/api/sessions/:id", async (req) =>
    sessions.update(req.params.id, req.body ?? {}),
  );
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
    sessions.delete(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/sessions/:id/events", async (req) =>
    sessions.eventsAfter(req.params.id, Number(req.query.after ?? 0)),
  );
  app.post<{ Params: { id: string }; Body: PromptRequest }>("/api/sessions/:id/prompt", async (req) => {
    await sessions.prompt(req.params.id, req.body.text ?? "", req.body.fileIds ?? []);
    return { ok: true };
  });

  // ---------- файлы ----------

  // загрузка: тело запроса — сырые байты файла, имя в ?name=. Своя область без встроенных парсеров:
  // иначе application/json и text/plain разбирались Fastify, и в файл писалось «[object Object]»
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    raw.post<{ Params: { id: string }; Querystring: { name?: string } }>(
      "/api/sessions/:id/files",
      { bodyLimit: MAX_FILE_BYTES },
      async (req) => {
        const s = sessions.get(req.params.id);
        const name = req.query.name;
        if (!name) throw new HttpError(400, L("Нужен ?name=", "?name= is required"));
        const body = req.body as Readable | undefined;
        const stream = body instanceof Readable ? body : Readable.from([]);
        const f = await files.saveIncoming(s.id, s.directory, name, stream, req.headers["content-type"]);
        return { fileId: f.id, name: f.name, mime: f.mime, size: f.size };
      },
    );
  });

  app.get<{ Params: { fileId: string } }>("/api/files/:fileId", async (req, reply) => {
    const f = files.get(req.params.fileId);
    if (!f || !existsSync(f.path)) throw new HttpError(404, L("Файл не найден", "File not found"));
    reply.header("x-sha256", f.sha256);
    return sendFile(req, reply, f.path, f.mime, f.name);
  });

  // загрузка скилла (SKILL.md или zip) — тоже сырым телом
  await app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    raw.post<{ Querystring: { name?: string; overwrite?: string } }>("/api/skills/upload", { bodyLimit: 50 * 1024 * 1024 }, async (req) => {
      if (!req.query.name) throw new HttpError(400, L("Нужен ?name=", "?name= is required"));
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      return sk().upload(req.query.name, body, req.query.overwrite === "1");
    });
  });

  // ---------- Android-приложение: последняя сборка (кладёт apps/mobile → npm run release) ----------

  const latestApp = (): AppRelease | undefined => {
    try {
      return JSON.parse(readFileSync(join(deps.config.config.dataDir, "apk", "latest.json"), "utf8")) as AppRelease;
    } catch {
      return undefined;
    }
  };
  app.get("/api/app/latest", async () => {
    const r = latestApp();
    if (!r) throw new HttpError(404, L("Сборки приложения нет (apps/mobile → npm run release)", "No app build (apps/mobile → npm run release)"));
    return r;
  });
  app.get("/api/app/apk", async (req, reply) => {
    const r = latestApp();
    const path = r && join(deps.config.config.dataDir, "apk", r.file);
    if (!r || !path || !existsSync(path)) throw new HttpError(404, L("Сборки приложения нет (apps/mobile → npm run release)", "No app build (apps/mobile → npm run release)"));
    reply.header("x-sha256", r.sha256);
    return sendFile(req, reply, path, "application/vnd.android.package-archive", r.file);
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req) => {
    await sessions.abort(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/sessions/:id/compact", async (req) => {
    await sessions.compact(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string; permId: string }; Body: PermissionReplyRequest }>(
    "/api/sessions/:id/permissions/:permId",
    async (req) => {
      const { reply } = req.body;
      if (!["once", "always", "reject"].includes(reply)) throw new HttpError(400, "reply: once | always | reject");
      await sessions.replyPermission(req.params.id, req.params.permId, reply, req.deviceId);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string; qid: string }; Body: QuestionReplyRequest }>("/api/sessions/:id/questions/:qid", async (req) => {
    await sessions.replyQuestion(req.params.id, req.params.qid, req.body?.answers ?? null, req.deviceId);
    return { ok: true };
  });

  // ---------- устройства ----------

  app.post("/api/pair/start", async (req) => {
    if (req.deviceId !== "local") throw new HttpError(403, L("Pairing запускается только с самого ПК", "Pairing can only be started on the PC itself"));
    return auth.startPairing();
  });
  app.post<{ Body: { code: string; name?: string } }>("/api/pair/complete", async (req) => {
    const r = auth.completePairing(String(req.body?.code ?? ""), String(req.body?.name ?? "device"));
    if (!r) throw new HttpError(403, L("Неверный или просроченный код", "Invalid or expired code"));
    return r;
  });
  app.get("/api/devices", async () => db.listDevices().map(({ tokenHash: _, fcmToken, ...d }) => ({ ...d, push: !!fcmToken })));
  /** FCM-токен этого устройства для пушей (null — отписаться) */
  app.post<{ Body: { token?: string | null } }>("/api/devices/me/push", async (req) => {
    const token = typeof req.body?.token === "string" && req.body.token.length < 4096 ? req.body.token : null;
    // localhost (ПК, эмулятор через adb reverse) не проходит pairing — заводим ему запись, войти по ней нельзя
    if (!db.listDevices().some((d) => d.id === req.deviceId)) {
      const now = Date.now();
      db.insertDevice({ id: req.deviceId, name: "localhost", tokenHash: randomBytes(32).toString("hex"), createdAt: now, lastSeen: now, fcmToken: null });
    }
    db.setFcmToken(req.deviceId, token);
    return { ok: true, push: deps.push?.enabled ?? false };
  });
  app.delete<{ Params: { id: string } }>("/api/devices/:id", async (req) => {
    db.deleteDevice(req.params.id);
    return { ok: true };
  });

  // ---------- WebSocket ----------

  app.get("/ws", { websocket: true }, (socket: WebSocket, req) => {
    const send = (m: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    /** sessionId → последний отправленный seq */
    const subs = new Map<string, number>();

    const onSession = (s: SessionInfo) => send({ t: "session", session: s });
    const onDeleted = (id: string) => {
      subs.delete(id);
      send({ t: "session.deleted", sessionId: id });
    };
    const onEvent = (e: StoredEvent) => {
      const last = subs.get(e.sessionId);
      if (last === undefined || e.seq <= last) return;
      subs.set(e.sessionId, e.seq);
      send({ t: "ev", sessionId: e.sessionId, seq: e.seq, ts: e.ts, event: e.event });
    };
    const onDelta = (sessionId: string, d: PartDelta) => {
      if (subs.has(sessionId)) send({ t: "delta", sessionId, ...d });
    };
    const onLimits = (limits: ClaudeLimits) => send({ t: "limits", limits });
    const onGroups = (groups: SessionGroup[]) => send({ t: "groups", groups });
    const onLang = (language: LangSetting) => send({ t: "language", language });
    langListeners.add(onLang);
    const offUpdate = deps.updates?.subscribe((update) => send({ t: "update", update }));
    const offNotices = deps.notices?.((notice) => send({ t: "notify", notice }));
    sessions.on("session", onSession);
    sessions.on("session.deleted", onDeleted);
    sessions.on("event", onEvent);
    sessions.on("delta", onDelta);
    sessions.on("limits", onLimits);
    sessions.on("groups", onGroups);

    socket.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return send({ t: "err", message: "bad json" });
      }
      try {
        if (msg.t === "ping") return send({ t: "pong" });
        if (msg.t === "presence") return void deps.presence?.set(socket, msg.active === true);
        if (msg.t === "unsub") return void subs.delete(msg.sessionId);
        if (msg.t === "sub") {
          // Всё синхронно: между чтением журнала и пометкой «live» новые события вклиниться не могут.
          let after = msg.after;
          if (after > sessions.get(msg.sessionId).lastSeq) {
            send({ t: "reset", sessionId: msg.sessionId });
            after = 0;
          }
          const backlog = sessions.eventsAfter(msg.sessionId, after);
          let last = after;
          for (const e of backlog) {
            send({ t: "ev", sessionId: e.sessionId, seq: e.seq, ts: e.ts, event: e.event });
            last = e.seq;
          }
          subs.set(msg.sessionId, last);
          send({ t: "live", sessionId: msg.sessionId, seq: last, parts: sessions.liveSnapshot(msg.sessionId) });
        }
      } catch (e) {
        send({ t: "err", message: (e as Error).message });
      }
    });

    socket.on("close", () => {
      sessions.off("session", onSession);
      sessions.off("session.deleted", onDeleted);
      sessions.off("event", onEvent);
      sessions.off("delta", onDelta);
      sessions.off("limits", onLimits);
      sessions.off("groups", onGroups);
      langListeners.delete(onLang);
      offUpdate?.();
      offNotices?.();
      deps.presence?.drop(socket);
    });

    const limits = sessions.limits;
    send({ t: "hello", deviceId: req.deviceId, sessions: sessions.list(), groups: sessions.groups(), language: config.config.language ?? "auto", ...(limits ? { limits } : {}), ...(deps.updates ? { update: deps.updates.status() } : {}) });
  });

  // ---------- веб-UI ----------

  if (deps.webDir && existsSync(join(deps.webDir, "index.html"))) {
    const webRoot = resolve(deps.webDir);
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/api/") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "Not found" });
      // wildcard: false знает только файлы, что были при старте; после `npm run web:build` у бандла новое имя —
      // ищем его на диске, иначе браузер получил бы index.html вместо JS и веб сломался бы до рестарта хаба
      let rel = "";
      try {
        rel = decodeURIComponent(req.url.split("?")[0]!).replace(/^\/+/, "");
      } catch {
        /* битый URL — отдадим index.html */
      }
      if (rel) {
        const full = resolve(webRoot, rel);
        if (full.startsWith(webRoot + sep) && existsSync(full) && statSync(full).isFile()) return reply.sendFile(rel);
        if (rel.startsWith("assets/")) return reply.code(404).send({ error: "Not found" });
      }
      // SPA: остальные GET вне /api — index.html
      return reply.sendFile("index.html");
    });
  }

  return app;
}
