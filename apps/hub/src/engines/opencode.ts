// Движок opencode: хаб поднимает свой `opencode serve` на localhost с паролем и
// работает с ним через v1 HTTP API + общий SSE-поток /global/event.
// (v2 /api/session в 1.19.x принимает промпт, но цикл агента по нему не запускается.)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, type ChildProcess } from "node:child_process";
import type { CustomProvider, EngineInfo, ModelInfo, ModelRef, Part, PermissionMode, PermissionReply, QuestionAnswers, SessionEvent, ToolStatus } from "@kamharn/protocol";
import type { Engine, EngineSink, PermissionRule, PromptFile } from "./types.ts";
import { killPidTree, killTree, spawn } from "../proc.ts";
import { readSse } from "../sse.ts";
import { L } from "../lang.ts";
import { opencodeRecord } from "../usage.ts";

export interface OpencodeOptions {
  bin?: string;
  /** 0 — выбрать свободный порт */
  port: number;
  /** pid-файл: при старте добиваем процесс, оставшийся от упавшего хаба */
  pidFile?: string;
  defaultModel?: ModelRef;
  /** URL MCP-сервера хаба для opencode (добавляется поверх пользовательского конфига) */
  mcpUrl?: string;
  /** поиск зарегистрированного файла по пути — чтобы показать вложения пользователя */
  fileByPath?: (path: string) => { id: string; name: string; mime: string; size: number } | undefined;
  log?: (msg: string) => void;
  /** свои OpenAI-совместимые серверы (LM Studio, Ollama…) — добавляются в конфиг opencode при запуске */
  customProviders?: () => CustomProvider[];
  /** свои MCP-серверы KamHarn (раздел mcp конфига opencode), читается при каждом запуске */
  extraMcp?: () => Record<string, unknown>;
  /** дополнительные переменные окружения процесса opencode (читаются при каждом запуске) */
  env?: () => Record<string, string>;
  /** избранные модели по провайдерам: в выборе модели только они (нет списка — все) */
  favorites?: () => Record<string, string[]>;
  /** сессии, где нельзя ответить «разрешать всегда» */
  noAlways?: (engineSessionId: string) => boolean;
}

interface Tracked {
  directory: string;
  permissionMode: PermissionMode;
}

type Json = Record<string, any>;

/** сколько карточка ждёт аргументы вызова; не дождалась — показывается без них */
const CARD_WAIT_MS = 1500;

// PATCH сессии дописывает правила к старым, а действует последнее совпавшее,
// поэтому каждый режим задаёт и bash, и edit явно
const PERMISSION_RULES: Record<PermissionMode, PermissionRule[]> = {
  manual: [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
  ],
  acceptEdits: [
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ],
  auto: [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "allow" },
  ],
};

/** Что показать на карточке разрешения MCP-инструмента: в permission.asked аргументов нет, только callID вызова. */
export function callTitle(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Json;
  const main = [o.text, o.url, o.shortcut, o.command, o.name].find((v) => typeof v === "string") as string | undefined;
  const text = main ?? (Object.keys(o).length ? JSON.stringify(o) : "");
  // Enter после ввода — это уже отправка
  return (o.press_enter === true ? `${text} ⏎` : text).slice(0, 300);
}

function killStale(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  rmSync(pidFile, { force: true });
  if (!pid) return;
  if (process.platform === "win32") {
    // убиваем, только если это действительно opencode (pid мог переиспользоваться)
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    if (/opencode/i.test(r.stdout ?? "")) killPidTree(pid);
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* уже нет */
    }
  }
}

export function resolveOpencodeBin(bin?: string): string {
  if (bin) return bin;
  if (process.platform === "win32" && process.env.APPDATA) {
    const exe = join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(exe)) return exe;
  }
  return "opencode";
}

export class OpencodeEngine implements Engine {
  readonly id = "opencode" as const;
  private child?: ChildProcess;
  private base = "";
  private auth = "";
  private sink?: EngineSink;
  private sse?: AbortController;
  private tracked = new Map<string, Tracked>();
  /** последнее отправленное представление (для отсева дублей opencode) */
  private lastEmitted = new Map<string, string>();
  /** запросы, одобренные хабом по режиму сессии: их не показываем */
  private autoReplied = new Set<string>();
  /** последние вложения, отправленные в сессию (opencode возвращает их без пути) */
  private sentFiles = new Map<string, PromptFile[]>();
  /** аргументы идущих вызовов инструментов: сессия:callID → input */
  private calls = new Map<string, unknown>();
  /** карточки MCP-инструментов, которые ждут аргументов вызова: сессия:callID → показать */
  private waitingCards = new Map<string, { show: (input?: unknown) => void; timer: NodeJS.Timeout }>();
  /** чьё следующее сообщение пользователя скрыть и какие уже скрыты */
  private hideNext = new Set<string>();
  private hiddenMsgs = new Set<string>();
  /** размер контекста по последнему ответу модели */
  private context = new Map<string, number>();
  private startError?: string;
  private log: (msg: string) => void;

  constructor(private opts: OpencodeOptions) {
    this.log = opts.log ?? ((m) => console.log(`[opencode] ${m}`));
  }

  async start(sink: EngineSink): Promise<void> {
    this.sink = sink;
    this.startError = undefined;
    if (this.opts.pidFile) killStale(this.opts.pidFile);
    const password = randomBytes(24).toString("hex");
    this.auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
    const bin = resolveOpencodeBin(this.opts.bin);
    // порт 0 — opencode сам выбирает свободный, адрес читаем из его вывода
    // свои серверы: ключ обязателен для «подключён» у opencode, локальным серверам он не нужен — ставим заглушку
    const provider = Object.fromEntries(
      (this.opts.customProviders?.() ?? []).map((p) => [
        p.id,
        { npm: "@ai-sdk/openai-compatible", name: p.name, options: { baseURL: p.baseURL, apiKey: p.apiKey || "not-needed" }, models: Object.fromEntries(p.models.map((m) => [m, { name: m }])) },
      ]),
    );
    const extraConfig = {
      mcp: { ...this.opts.extraMcp?.(), ...(this.opts.mcpUrl ? { kamharn: { type: "remote", url: this.opts.mcpUrl, oauth: false } } : {}) },
      ...(Object.keys(provider).length ? { provider } : {}),
    };
    const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", String(this.opts.port)], {
      env: { ...process.env, ...this.opts.env?.(), OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(extraConfig) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    if (this.opts.pidFile && child.pid) writeFileSync(this.opts.pidFile, String(child.pid));
    if (this.opts.port) this.base = `http://127.0.0.1:${this.opts.port}`;
    const onOut = (d: Buffer) => {
      const s = d.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(s);
      if (m && !this.base) this.base = m[1]!.replace(/\/$/, "");
      if (!/OPENCODE_SERVER_PASSWORD is not set/.test(s)) this.log(s.trim());
    };
    child.stdout?.on("data", onOut);
    child.stderr?.on("data", onOut);
    let exited = false;
    child.on("exit", (code) => {
      exited = true;
      this.log(L(`процесс завершился (code ${code})`, `process exited (code ${code})`));
    });
    child.on("error", (e) => {
      exited = true;
      this.startError =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? L("opencode не установлен: npm i -g opencode-ai, затем перезапусти хаб", "opencode isn't installed: npm i -g opencode-ai, then restart the hub")
          : e.message;
    });

    const deadline = Date.now() + 30_000;
    for (;;) {
      if (exited) {
        // присваивается в обработчике error — TypeScript этого не видит
        const err = this.startError as string | undefined;
        throw new Error(err?.startsWith("opencode") ? err : `${L("opencode не запустился", "opencode failed to start")}: ${err ?? L("процесс завершился", "process exited")}`);
      }
      if (this.base) {
        try {
          const r = await this.req("GET", "/global/health");
          if (r?.healthy) break;
        } catch {
          /* ещё не готов */
        }
      }
      if (Date.now() > deadline) throw new Error(L("opencode не ответил за 30 с", "opencode didn't answer in 30 s"));
      await new Promise((r) => setTimeout(r, 300));
    }
    this.log(`${L("готов на", "ready at")} ${this.base}`);
    this.subscribe();
  }

  /** Перезапустить opencode с новым конфигом (свои серверы). Сессии продолжатся — они живут в его базе. */
  restart(): Promise<void> {
    // два быстрых переключения (MCP, провайдеры) не должны запускать два opencode разом: второй старт
    // перезаписал бы процесс и пароль, а первый остался бы сиротой
    const next = this.restarting.then(async () => {
      if (!this.sink) return;
      await this.stop();
      if (!this.opts.port) this.base = "";
      await new Promise((r) => setTimeout(r, 500));
      await this.start(this.sink);
    });
    this.restarting = next.catch(() => {});
    return next;
  }

  private restarting: Promise<void> = Promise.resolve();

  // ---------- провайдеры: ключи и вход по подписке хранит сам opencode (как `opencode auth login`) ----------

  /** состояние MCP-серверов: имя → { status: connected | failed | disabled | …, error } */
  mcpStatus(): Promise<Record<string, { status: string; error?: string }>> {
    return this.req("GET", "/mcp");
  }

  providers(): Promise<{ all: Json[]; connected: string[] }> {
    return this.req("GET", "/provider");
  }

  authMethods(): Promise<Record<string, Array<{ type: "api" | "oauth"; label: string; prompts?: Json[] }>>> {
    return this.req("GET", "/provider/auth");
  }

  async setKey(providerId: string, key: string, metadata?: Record<string, string>): Promise<void> {
    await this.req("PUT", `/auth/${encodeURIComponent(providerId)}`, { type: "api", key, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) });
    await this.req("POST", "/instance/dispose", {});
  }

  oauthAuthorize(providerId: string, method: number, inputs?: Record<string, string>): Promise<{ url: string; method: "auto" | "code"; instructions: string }> {
    return this.req("POST", `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, { method, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) });
  }

  /** auto — ждёт, пока пользователь войдёт (минуты); code — сразу проверяет код */
  async oauthCallback(providerId: string, method: number, code?: string): Promise<boolean> {
    const ok = await this.req("POST", `/provider/${encodeURIComponent(providerId)}/oauth/callback`, { method, ...(code ? { code } : {}) });
    await this.req("POST", "/instance/dispose", {});
    return ok === true;
  }

  async disconnect(providerId: string): Promise<void> {
    await this.req("DELETE", `/auth/${encodeURIComponent(providerId)}`);
    await this.req("POST", "/instance/dispose", {});
  }

  async stop(): Promise<void> {
    this.sse?.abort();
    if (this.child) killTree(this.child);
    if (this.opts.pidFile) rmSync(this.opts.pidFile, { force: true });
  }

  private subscribe(): void {
    const ac = new AbortController();
    this.sse = ac;
    const loop = async () => {
      while (!ac.signal.aborted) {
        try {
          await readSse(`${this.base}/global/event`, { authorization: this.auth }, ac.signal, (ev) => {
            if (!ev.data) return;
            const g = JSON.parse(ev.data) as Json;
            const payload = g.payload as Json | undefined;
            if (!payload || payload.type === "sync") return;
            this.handle(payload);
          });
        } catch (e) {
          if (ac.signal.aborted) return;
          this.log(L(`SSE оборвался: ${(e as Error).message}, переподключаюсь`, `SSE dropped: ${(e as Error).message}, reconnecting`));
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    void loop();
  }

  private async req(method: string, path: string, body?: unknown, directory?: string): Promise<any> {
    // opencode не запущен (не установлен, упал): без адреса new URL дал бы непонятное «Invalid URL»
    if (!this.base) throw new Error(this.startError ?? L("opencode не запущен", "opencode isn't running"));
    const url = new URL(this.base + path);
    if (directory) url.searchParams.set("directory", directory);
    const r = await fetch(url, {
      method,
      headers: { authorization: this.auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`opencode ${method} ${path} → ${r.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  }

  async info(): Promise<EngineInfo> {
    try {
      const [prov, cfg] = await Promise.all([this.req("GET", "/provider"), this.req("GET", "/config")]);
      const connected = new Set<string>(prov.connected ?? []);
      const models: ModelInfo[] = [];
      const favorites = this.opts.favorites?.() ?? {};
      for (const p of prov.all ?? []) {
        if (!connected.has(p.id)) continue;
        const offline = !(await this.localProviderUp(p));
        const fav = favorites[p.id];
        for (const m of Object.values<Json>(p.models ?? {})) {
          if (m.status === "deprecated") continue;
          if (fav?.length && !fav.includes(m.id)) continue;
          models.push({
            engine: "opencode",
            providerId: p.id,
            modelId: m.id,
            name: m.name ?? m.id,
            tools: m.capabilities?.toolcall ?? undefined,
            free: m.cost ? m.cost.input === 0 && m.cost.output === 0 : undefined,
            ...(offline ? { offline: true } : {}),
            // варианты модели = уровни рассуждений (у каждой модели свои: low/high/max, none/minimal…)
            ...(m.variants && Object.keys(m.variants).length ? { efforts: Object.keys(m.variants) } : {}),
            ...(m.capabilities?.input?.image ? { vision: true } : {}),
          });
        }
      }
      let defaultModel = this.opts.defaultModel;
      if (!defaultModel && typeof cfg?.model === "string" && cfg.model.includes("/")) {
        const [providerId, ...rest] = cfg.model.split("/");
        defaultModel = { providerId: providerId!, modelId: rest.join("/") };
      }
      // модель по умолчанию не запущена — предлагаем первую рабочую (лучше бесплатную с инструментами)
      const isOffline = (r?: ModelRef) => !!r && models.some((m) => m.providerId === r.providerId && m.modelId === r.modelId && m.offline);
      if (!defaultModel || isOffline(defaultModel)) {
        const alt = models.find((m) => !m.offline && m.free && m.tools) ?? models.find((m) => !m.offline);
        if (alt) defaultModel = { providerId: alt.providerId, modelId: alt.modelId };
      }
      return { id: "opencode", available: true, models, defaultModel };
    } catch (e) {
      return { id: "opencode", available: false, error: (e as Error).message, models: [] };
    }
  }

  private upCache = new Map<string, { at: number; up: boolean }>();

  /** Провайдер на localhost (LM Studio, Ollama, llama.cpp) — проверяем, что сервер отвечает. Облачные считаем доступными. */
  private async localProviderUp(p: Json): Promise<boolean> {
    const firstModel = Object.values<Json>(p.models ?? {})[0];
    const base: unknown = p.options?.baseURL ?? firstModel?.api?.url;
    if (typeof base !== "string" || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base)) return true;
    const cached = this.upCache.get(base);
    if (cached && Date.now() - cached.at < 10_000) return cached.up;
    let up = false;
    try {
      // любой HTTP-ответ значит, что сервер жив
      await fetch(base.replace(/\/$/, "") + "/models", { signal: AbortSignal.timeout(1500) });
      up = true;
    } catch {
      up = false;
    }
    this.upCache.set(base, { at: Date.now(), up });
    return up;
  }

  async createSession(o: { directory: string; model: ModelRef; permissionMode: PermissionMode; title?: string; confined?: boolean; extraRules?: PermissionRule[] }): Promise<string> {
    const s = await this.req(
      "POST",
      "/session",
      {
        ...(o.title ? { title: o.title } : {}),
        model: { id: o.model.modelId, providerID: o.model.providerId },
        // правила режима ниже не трогают external_directory, поэтому запрет переживает смену режима
        permission: [...PERMISSION_RULES[o.permissionMode], ...(o.extraRules ?? []), ...(o.confined ? [{ permission: "external_directory", pattern: "*", action: "deny" as const }] : [])],
      },
      o.directory,
    );
    this.tracked.set(s.id, { directory: o.directory, permissionMode: o.permissionMode });
    return s.id as string;
  }

  attach(engineSessionId: string, o: { directory: string; permissionMode: PermissionMode }): void {
    this.tracked.set(engineSessionId, { directory: o.directory, permissionMode: o.permissionMode });
  }

  private dir(engineSessionId: string): string {
    const t = this.tracked.get(engineSessionId);
    if (!t) throw new Error(`opencode: ${L("неизвестная сессия", "unknown session")} ${engineSessionId}`);
    return t.directory;
  }

  /** MCP-серверы только этой папки: у opencode они живут в экземпляре папки, поэтому другие папки их не видят. После перезапуска или dispose их нет — зовём перед каждым сообщением. */
  async ensureMcp(directory: string, servers: Record<string, Json>): Promise<Record<string, { status: string; error?: string }>> {
    let st = ((await this.req("GET", "/mcp", undefined, directory)) ?? {}) as Record<string, { status: string; error?: string }>;
    for (const [name, config] of Object.entries(servers)) {
      if (st[name]?.status !== "connected") st = await this.req("POST", "/mcp", { name, config }, directory);
    }
    return st;
  }

  async releaseMcp(directory: string, name: string): Promise<void> {
    await this.req("POST", `/mcp/${encodeURIComponent(name)}/disconnect`, {}, directory);
  }

  contextTokens(engineSessionId: string): number | undefined {
    return this.context.get(engineSessionId);
  }

  async prompt(engineSessionId: string, o: { text: string; files: PromptFile[]; model: ModelRef; system?: string; effort?: string; hidden?: string; hideUser?: boolean }): Promise<void> {
    let text = o.text;
    if (o.files.length) text += `\n\n[${L("Вложения от пользователя", "Attachments from the user")}: ${o.files.map((f) => f.path).join(", ")}]`;
    // synthetic: модель видит и помнит, в ленту не идёт (mapPart)
    const parts: Json[] = [...(o.hidden ? [{ type: "text", text: o.hidden, synthetic: true }] : []), { type: "text", text }];
    if (o.files.length) this.sentFiles.set(engineSessionId, [...(this.sentFiles.get(engineSessionId) ?? []), ...o.files].slice(-50));
    for (const f of o.files) {
      parts.push({ type: "file", mime: f.mime, filename: f.name, url: pathToFileURL(f.path).href });
    }
    if (o.hideUser) this.hideNext.add(engineSessionId);
    try {
      await this.req(
        "POST",
        `/session/${engineSessionId}/prompt_async`,
        // system — промпт группы: opencode принимает его в каждом сообщении
        { model: { providerID: o.model.providerId, modelID: o.model.modelId }, parts, ...(o.system ? { system: o.system } : {}), ...(o.effort ? { variant: o.effort } : {}) },
        this.dir(engineSessionId),
      );
    } catch (e) {
      this.hideNext.delete(engineSessionId);
      throw e;
    }
  }

  /** summarize в v1 отвечает только когда пересказ готов (на бесплатной модели — около минуты): не ждём, ход виден по событиям. */
  async compact(engineSessionId: string, o: { model: ModelRef }): Promise<void> {
    void this.req("POST", `/session/${engineSessionId}/summarize`, { providerID: o.model.providerId, modelID: o.model.modelId }, this.dir(engineSessionId)).catch((e: Error) =>
      this.sink?.event(engineSessionId, { type: "error", message: `${L("Не удалось сжать контекст", "Failed to compact the context")}: ${e.message}` }),
    );
  }

  /** Все сообщения сессии (для расхода задним числом). */
  async messages(engineSessionId: string, directory: string): Promise<Json[]> {
    const r = await this.req("GET", `/session/${engineSessionId}/message`, undefined, directory);
    return Array.isArray(r) ? r : [];
  }

  async abort(engineSessionId: string): Promise<void> {
    await this.req("POST", `/session/${engineSessionId}/abort`, {}, this.dir(engineSessionId));
  }

  async replyPermission(engineSessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    await this.req("POST", `/permission/${requestId}/reply`, { reply }, this.dir(engineSessionId));
  }

  async replyQuestion(engineSessionId: string, requestId: string, answers: QuestionAnswers): Promise<void> {
    const dir = this.dir(engineSessionId);
    if (answers) await this.req("POST", `/question/${requestId}/reply`, { answers }, dir);
    else await this.req("POST", `/question/${requestId}/reject`, {}, dir);
  }

  async setPermissionMode(engineSessionId: string, mode: PermissionMode): Promise<void> {
    const dir = this.dir(engineSessionId);
    await this.req("PATCH", `/session/${engineSessionId}`, { permission: PERMISSION_RULES[mode] }, dir);
    this.tracked.get(engineSessionId)!.permissionMode = mode;
    const pending = ((await this.req("GET", "/permission", undefined, dir)) ?? []) as Json[];
    for (const p of pending) {
      if (p.sessionID === engineSessionId && this.allows(mode, p.permission)) await this.replyPermission(engineSessionId, p.id, "once");
    }
  }

  /** Файл хаба для file-части opencode. */
  private fileOf(sid: string, part: Json): { id: string; name: string; mime: string; size: number } | undefined {
    if (typeof part.url !== "string") return undefined;
    if (part.url.startsWith("file:")) {
      try {
        return this.opts.fileByPath?.(fileURLToPath(part.url));
      } catch {
        return undefined;
      }
    }
    // вложение пользователя opencode хранит как data: URL — узнаём его по имени среди отправленных
    const f = this.sentFiles.get(sid)?.findLast((x) => x.name === part.filename && x.mime === part.mime);
    return f && { id: f.fileId, name: f.name, mime: f.mime, size: f.size };
  }

  private allows(mode: PermissionMode, permission: string): boolean {
    return PERMISSION_RULES[mode].some((r) => r.permission === permission && r.action === "allow");
  }

  forget(engineSessionId: string): void {
    this.tracked.delete(engineSessionId);
    this.sentFiles.delete(engineSessionId);
    this.hideNext.delete(engineSessionId);
    this.context.delete(engineSessionId);
    for (const k of this.calls.keys()) if (k.startsWith(engineSessionId + ":")) this.calls.delete(k);
    for (const [k, w] of this.waitingCards) {
      if (k.startsWith(engineSessionId + ":")) {
        clearTimeout(w.timer);
        this.waitingCards.delete(k);
      }
    }
    for (const k of this.lastEmitted.keys()) if (k.startsWith(engineSessionId + ":")) this.lastEmitted.delete(k);
  }

  // ---------- нормализация событий ----------

  private emit(sid: string, key: string, ev: SessionEvent): void {
    const k = `${sid}:${key}`;
    const json = JSON.stringify(ev);
    if (this.lastEmitted.get(k) === json) return;
    this.lastEmitted.set(k, json);
    this.sink?.event(sid, ev);
  }

  /** Публичный ради тестов на записанных событиях. */
  handle(payload: Json): void {
    const p = (payload.properties ?? {}) as Json;
    const sid: string | undefined = p.sessionID ?? p.info?.sessionID;
    if (!sid || !this.tracked.has(sid)) return;

    switch (payload.type) {
      case "message.updated": {
        const info = p.info as Json;
        if (info.role === "user" && (this.hiddenMsgs.has(info.id) || this.hideNext.delete(sid))) {
          this.hiddenMsgs.add(info.id);
          break;
        }
        const model: ModelRef | undefined = info.providerID
          ? { providerId: info.providerID, modelId: info.modelID }
          : info.model
            ? { providerId: info.model.providerID, modelId: info.model.modelID }
            : undefined;
        this.emit(sid, `msg:${info.id}`, {
          type: "message.upserted",
          message: {
            id: info.id,
            role: info.role,
            createdAt: info.time?.created ?? Date.now(),
            ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
            ...(model ? { model } : {}),
            // пересказ после сжатия (mode: compaction); у сообщений пользователя summary — объект с diffs, не он
            ...(info.summary === true ? { summary: true } : {}),
          },
        });
        // расход — когда ответ завершён (до этого токены нулевые); ключ по сообщению, повтор события его перезапишет
        if (info.role === "assistant" && info.time?.completed) {
          const u = opencodeRecord(info);
          if (u) this.sink?.usage?.(sid, u);
          const tk = (info.tokens ?? {}) as Json;
          // пересказ читал весь старый контекст; после него в контексте только сам пересказ
          this.context.set(sid, info.summary === true ? Number(tk.output) || 0 : (Number(tk.input) || 0) + (Number(tk.cache?.read) || 0) + (Number(tk.cache?.write) || 0));
        }
        break;
      }
      case "message.part.updated": {
        if (this.hiddenMsgs.has(p.part.messageID)) break;
        if (p.part.type === "tool" && p.part.callID) {
          const k = `${sid}:${p.part.callID}`;
          const status = p.part.state?.status;
          if (status === "completed" || status === "error") this.calls.delete(k);
          // у pending аргументы ещё пустые
          else if (status === "running") {
            this.calls.set(k, p.part.state?.input);
            const w = this.waitingCards.get(k);
            if (w) {
              clearTimeout(w.timer);
              this.waitingCards.delete(k);
              w.show(p.part.state?.input);
            }
          }
        }
        const part = mapPart(p.part as Json, (fp) => this.fileOf(sid, fp));
        if (part) this.emit(sid, `part:${part.id}`, { type: "part.upserted", messageId: p.part.messageID, part });
        break;
      }
      case "message.part.delta": {
        if (p.field === "text" && typeof p.delta === "string") {
          this.sink?.delta(sid, { messageId: p.messageID, partId: p.partID, field: "text", delta: p.delta });
        }
        break;
      }
      case "permission.asked": {
        // opencode не применяет новые правила сессии посреди хода — то, что режим разрешает, одобряем сами
        if (this.allows(this.tracked.get(sid)!.permissionMode, p.permission)) {
          this.autoReplied.add(p.id);
          this.replyPermission(sid, p.id, "once").catch((e) => this.log(`${L("автоодобрение", "auto-approve")} ${p.id}: ${(e as Error).message}`));
          break;
        }
        const meta = (p.metadata ?? {}) as Json;
        const patterns = Array.isArray(p.patterns) ? p.patterns.join(" ") : "";
        const show = (input?: unknown) => {
          // MCP-инструмент: patterns — просто «*»
          const title = meta.command ?? meta.filepath ?? meta.filePath ?? ((!patterns || patterns === "*") ? callTitle(input) || String(p.permission) : patterns);
          this.emit(sid, `perm:${p.id}`, {
            type: "permission.asked",
            request: { id: p.id, tool: p.permission, title: String(title), detail: input !== undefined ? { ...meta, input } : meta, canAlways: Array.isArray(p.always) && p.always.length > 0 && !this.opts.noAlways?.(sid) },
          });
        };
        const callKey = p.tool?.callID ? `${sid}:${p.tool.callID}` : undefined;
        const known = callKey ? this.calls.get(callKey) : undefined;
        // аргументы приходят сразу следом за вопросом: без них человек не увидит, что разрешает
        if (callKey && known === undefined && patterns === "*" && !Object.keys(meta).length) {
          const timer = setTimeout(() => {
            this.waitingCards.delete(callKey);
            show();
          }, CARD_WAIT_MS);
          timer.unref?.();
          this.waitingCards.set(callKey, { show, timer });
        } else show(known);
        break;
      }
      case "permission.replied":
        if (this.autoReplied.delete(p.requestID)) break;
        this.emit(sid, `perm:${p.requestID}`, { type: "permission.resolved", id: p.requestID, reply: p.reply });
        break;
      case "question.asked": {
        const questions = (Array.isArray(p.questions) ? p.questions : []).map((q: Json) => ({
          question: String(q.question ?? ""),
          ...(q.header ? { header: String(q.header) } : {}),
          options: (Array.isArray(q.options) ? q.options : []).map((o: Json) => ({ label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}) })),
          multiple: !!q.multiple,
          // по схеме opencode свой ответ разрешён, если custom не выключен явно
          custom: q.custom !== false,
        }));
        this.emit(sid, `question:${p.id}`, { type: "question.asked", request: { id: p.id, questions } });
        break;
      }
      case "question.replied":
        this.emit(sid, `question:${p.requestID}`, { type: "question.resolved", id: p.requestID, answers: Array.isArray(p.answers) ? p.answers : [] });
        break;
      case "question.rejected":
        this.emit(sid, `question:${p.requestID}`, { type: "question.resolved", id: p.requestID, answers: null });
        break;
      case "session.status": {
        const t = p.status?.type;
        const status = t === "busy" ? "busy" : t === "retry" ? "retry" : "idle";
        this.emit(sid, "status", { type: "session.updated", patch: { status } });
        break;
      }
      case "session.updated": {
        const title = p.info?.title;
        if (typeof title === "string") this.emit(sid, "title", { type: "session.updated", patch: { title } });
        break;
      }
      case "session.error": {
        const err = p.error as Json | undefined;
        const message = err?.data?.message ?? err?.name ?? L("Неизвестная ошибка", "Unknown error");
        this.sink?.event(sid, { type: "error", message: String(message) });
        break;
      }
    }
  }
}

type FileInfo = { id: string; name: string; mime: string; size: number };

function mapPart(part: Json, fileOf: (part: Json) => FileInfo | undefined): Part | undefined {
  switch (part.type) {
    case "file": {
      const f = fileOf(part);
      return f ? { type: "file", id: part.id, fileId: f.id, name: f.name, mime: f.mime, size: f.size } : undefined;
    }
    case "text":
      // synthetic — служебный текст opencode («Called the Read tool…» для вложений)
      if (part.ignored || part.synthetic) return undefined;
      return { type: "text", id: part.id, text: part.text ?? "" };
    case "reasoning":
      return { type: "reasoning", id: part.id, text: part.text ?? "" };
    case "tool": {
      const st = (part.state ?? {}) as Json;
      const status = (["pending", "running", "completed", "error"].includes(st.status) ? st.status : "pending") as ToolStatus;
      const output = st.output ?? st.metadata?.output;
      return {
        type: "tool",
        id: part.id,
        tool: part.tool,
        status,
        ...(st.title ? { title: st.title } : {}),
        ...(st.input !== undefined ? { input: st.input } : {}),
        ...(typeof output === "string" ? { output } : {}),
        ...(st.error ? { error: String(st.error) } : {}),
      };
    }
    case "compaction":
      // отметка «контекст сжат» (summarize или авто), сам пересказ придёт следующим сообщением с summary: true
      return { type: "compaction", id: part.id, trigger: part.auto ? "auto" : "manual" };
    default:
      // step-start/step-finish/snapshot/patch и т.п. клиентам не нужны
      return undefined;
  }
}
