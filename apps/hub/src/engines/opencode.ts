// Движок opencode: хаб поднимает свой `opencode serve` на localhost с паролем и
// работает с ним через v1 HTTP API + общий SSE-поток /global/event.
// (v2 /api/session в 1.19.x принимает промпт, но цикл агента по нему не запускается.)
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync, type ChildProcess } from "node:child_process";
import type { CustomProvider, EngineInfo, ModelInfo, ModelRef, Part, PermissionMode, PermissionReply, QuestionAnswers, SessionEvent, ToolStatus } from "@kamharn/protocol";
import type { Engine, EngineSink, PromptFile } from "./types.ts";
import { killPidTree, killTree, spawn } from "../proc.ts";
import { readSse } from "../sse.ts";
import { L } from "../lang.ts";

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
  /** избранные модели по провайдерам: в выборе модели только они (нет списка — все) */
  favorites?: () => Record<string, string[]>;
}

interface Tracked {
  directory: string;
  permissionMode: PermissionMode;
}

type Json = Record<string, any>;

// PATCH сессии дописывает правила к старым, а действует последнее совпавшее,
// поэтому каждый режим задаёт и bash, и edit явно
const PERMISSION_RULES: Record<PermissionMode, Array<{ permission: string; pattern: string; action: "ask" | "allow" | "deny" }>> = {
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
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(extraConfig) },
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

  async createSession(o: { directory: string; model: ModelRef; permissionMode: PermissionMode; title?: string; confined?: boolean }): Promise<string> {
    const s = await this.req(
      "POST",
      "/session",
      {
        ...(o.title ? { title: o.title } : {}),
        model: { id: o.model.modelId, providerID: o.model.providerId },
        // правила режима ниже не трогают external_directory, поэтому запрет переживает смену режима
        permission: [...PERMISSION_RULES[o.permissionMode], ...(o.confined ? [{ permission: "external_directory", pattern: "*", action: "deny" as const }] : [])],
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

  async prompt(engineSessionId: string, o: { text: string; files: PromptFile[]; model: ModelRef; system?: string; effort?: string }): Promise<void> {
    let text = o.text;
    if (o.files.length) text += `\n\n[${L("Вложения от пользователя", "Attachments from the user")}: ${o.files.map((f) => f.path).join(", ")}]`;
    const parts: Json[] = [{ type: "text", text }];
    if (o.files.length) this.sentFiles.set(engineSessionId, [...(this.sentFiles.get(engineSessionId) ?? []), ...o.files].slice(-50));
    for (const f of o.files) {
      parts.push({ type: "file", mime: f.mime, filename: f.name, url: pathToFileURL(f.path).href });
    }
    await this.req(
      "POST",
      `/session/${engineSessionId}/prompt_async`,
      // system — промпт группы: opencode принимает его в каждом сообщении
      { model: { providerID: o.model.providerId, modelID: o.model.modelId }, parts, ...(o.system ? { system: o.system } : {}), ...(o.effort ? { variant: o.effort } : {}) },
      this.dir(engineSessionId),
    );
  }

  /** summarize в v1 отвечает только когда пересказ готов (на бесплатной модели — около минуты): не ждём, ход виден по событиям. */
  async compact(engineSessionId: string, o: { model: ModelRef }): Promise<void> {
    void this.req("POST", `/session/${engineSessionId}/summarize`, { providerID: o.model.providerId, modelID: o.model.modelId }, this.dir(engineSessionId)).catch((e: Error) =>
      this.sink?.event(engineSessionId, { type: "error", message: `${L("Не удалось сжать контекст", "Failed to compact the context")}: ${e.message}` }),
    );
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
        break;
      }
      case "message.part.updated": {
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
        const title =
          meta.command ?? meta.filepath ?? meta.filePath ?? (Array.isArray(p.patterns) ? p.patterns.join(" ") : String(p.permission));
        this.emit(sid, `perm:${p.id}`, {
          type: "permission.asked",
          request: { id: p.id, tool: p.permission, title: String(title), detail: meta, canAlways: Array.isArray(p.always) && p.always.length > 0 },
        });
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
