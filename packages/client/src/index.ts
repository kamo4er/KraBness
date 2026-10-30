// Клиент хаба KamHarn: REST + WebSocket с переподключением и replay.
// Работает в браузере и в React Native (нужны только fetch и WebSocket).
import {
  applyDelta,
  applyEvent,
  emptyView,
  upsertPart,
  type AppRelease,
  type ClaudeLimits,
  type UsageReport,
  type SessionBotInfo,
  type FileHit,
  type UsageTotals,
  type ClaudeTranscript,
  type CreateSessionRequest,
  type FileView,
  type GitInfo,
  type EngineInfo,
  type ModelRef,
  type PermissionMode,
  type PermissionReply,
  type QuestionAnswers,
  type ServerMessage,
  type SessionInfo,
  type ListeningPort,
  type HubNotice,
  type TelegramStatus,
  type TelegramProxy,
  type McpOverview,
  type McpServer,
  type SkillInfo,
  type WakeRuntime,
  type RemoteSettings,
  type ChecksConfig,
  type TaskInfo,
  type CreateTaskRequest,
  type TaskAction,
  type RemoteStatus,
  type NewSessionPrefs,
  type WakeSetup,
  type CustomProvider,
  type OAuthStart,
  type ProviderEntry,
  type ProviderModel,
  type SessionGroup,
  type WorktreeStatus,
  type SessionView,
  type SlashCommand,
  type UpdateStatus,
  type ClaudeAuthInfo,
} from "@kamharn/protocol";

export * from "@kamharn/protocol";
export { speakableText, SPEECH_MAX } from "./speech.ts";
export { splitArgs, joinArgs, parsePairs } from "./args.ts";
export { ago, baseName, fmtTokens, fmtCost, localDay } from "./format.ts";
export { parseFileRef, resolveFileRef, type FileRef } from "./paths.ts";
export { mentionAt, mentionText, applyMention } from "./mention.ts";
export { artifactDocument, artifactSource, isArtifactFile, isArtifactLang } from "./artifact.ts";
export { engineUsable, engineName, modelKey, parseModelKey, modelOptions, optionReady, defaultTaskModels, type EngineModelOption } from "./taskModels.ts";
export { t, tn, locale, getLang, getLangSetting, applyLangSetting, onLangChange } from "./i18n.ts";
import { applyLangSetting, locale } from "./i18n.ts";

export type ConnState = "connecting" | "online" | "offline" | "unauthorized";

export interface ClientState {
  conn: ConnState;
  deviceId?: string;
  sessions: SessionInfo[];
  /** группы сессий в списке */
  groups: SessionGroup[];
  /** задачи (конвейер над сессиями) */
  tasks: TaskInfo[];
  /** расход токенов по сессиям (итоги) */
  usage: Record<string, UsageTotals>;
  views: Record<string, SessionView>;
  /** лимиты подписки Claude (последние известные) */
  limits?: ClaudeLimits;
  /** обновления хаба (новая версия на GitHub) */
  update?: UpdateStatus;
  /** счётчик изменений по сессии — для перерисовки */
  versions: Record<string, number>;
}

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  push: boolean;
}

export interface HubInfo {
  /** язык (настройка хаба): auto — у каждого устройства свой системный */
  language?: import("@kamharn/protocol").LangSetting;
  urls: string[];
  version: string;
  startedAt?: number;
  /** запущен сторожем scripts/hub-service.ps1 — умеет перезапускаться */
  supervised: boolean;
  /** умеет усыплять ПК (POST /api/hub/sleep) */
  canSleep?: boolean;
}

export interface UploadedFile {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Listener = () => void;

export class HubClient {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private open = new Set<string>();
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private notifyTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private present = false;
  private noticeListeners = new Set<(n: HubNotice) => void>();
  state: ClientState = { conn: "connecting", sessions: [], groups: [], tasks: [], usage: {}, views: {}, versions: {} };

  constructor(public baseUrl: string, public token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ---------- подписка на состояние (useSyncExternalStore) ----------

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): ClientState => this.state;

  private set(patch: Partial<ClientState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** дельты приходят часто — перерисовку склеиваем */
  private emitSoon(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.state = { ...this.state };
      this.emit();
    }, 40);
  }

  private bump(sessionId: string): void {
    this.state.versions = { ...this.state.versions, [sessionId]: (this.state.versions[sessionId] ?? 0) + 1 };
  }

  // ---------- WebSocket ----------

  connect(): void {
    this.closed = false;
    if (this.ws && this.ws.readyState <= 1) return;
    this.set({ conn: "connecting" });
    const url = this.baseUrl.replace(/^http/, "ws") + "/ws" + (this.token ? `?token=${encodeURIComponent(this.token)}` : "");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      for (const id of this.open) this.sendSub(id);
      if (this.present) this.send({ t: "presence", active: true });
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), 25_000);
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.closed) return;
      // 1008/4401 или отказ на апгрейде с 401 браузер показывает как 1006 — проверяем REST-ом
      void this.checkAuth().then((ok) => {
        if (!ok) return this.set({ conn: "unauthorized" });
        this.set({ conn: "offline" });
        const delay = Math.min(15_000, 500 * 2 ** this.retry++);
        this.retryTimer = setTimeout(() => this.connect(), delay);
      });
      void e;
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = undefined;
  }

  /** Переподключиться немедленно (например, приложение вернулось из фона). */
  reconnectNow(): void {
    if (this.ws && this.ws.readyState === 1) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retry = 0;
    this.connect();
  }

  private async checkAuth(): Promise<boolean> {
    try {
      const r = await fetch(this.baseUrl + "/api/sessions", { headers: this.headers() });
      return r.status !== 401;
    } catch {
      return true; // сеть недоступна — это не про авторизацию
    }
  }

  private send(m: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private sendSub(sessionId: string): void {
    const after = this.state.views[sessionId]?.lastSeq ?? 0;
    this.send({ t: "sub", sessionId, after });
  }

  /** Открыть сессию: подписка на её события (с места, где остановились). */
  openSession(sessionId: string): void {
    this.open.add(sessionId);
    if (!this.state.views[sessionId]) {
      const info = this.state.sessions.find((s) => s.id === sessionId);
      this.state.views = { ...this.state.views, [sessionId]: emptyView(info) };
    }
    this.sendSub(sessionId);
  }

  /**
   * Подставить сохранённое на устройстве состояние чата (до openSession): тогда хаб пришлёт
   * только события после его lastSeq, а не весь журнал. Более свежее состояние в памяти не трогаем.
   */
  hydrate(sessionId: string, view: SessionView): void {
    const cur = this.state.views[sessionId];
    if (cur && cur.lastSeq >= view.lastSeq) return;
    // если кэш новее журнала хаба (БД сбросили), хаб ответит reset — см. onMessage
    const info = this.state.sessions.find((s) => s.id === sessionId);
    if (info) view.info = { ...info, lastSeq: view.lastSeq };
    this.state.views = { ...this.state.views, [sessionId]: view };
    this.bump(sessionId);
    this.emitSoon();
  }

  /** Сохранённый на устройстве список сессий и групп — пока хаб не прислал свежий (hello его заменит). */
  hydrateSessions(sessions: SessionInfo[], groups: SessionGroup[] = []): void {
    if (this.state.sessions.length) return;
    this.set({ sessions, groups });
  }

  /** Уведомления хаба по WebSocket — для приложения, которое показывает их само (без Firebase). */
  onNotice(cb: (n: HubNotice) => void): () => void {
    this.noticeListeners.add(cb);
    return () => void this.noticeListeners.delete(cb);
  }

  /** Пользователь за этим клиентом — пока это так, хаб не шлёт пуши на телефон. Вызывать повторно как пульс. */
  setPresence(active: boolean): void {
    this.present = active;
    this.send({ t: "presence", active });
  }

  closeSession(sessionId: string): void {
    this.open.delete(sessionId);
    this.send({ t: "unsub", sessionId });
  }

  private onMessage(m: ServerMessage): void {
    switch (m.t) {
      case "hello":
        applyLangSetting(m.language);
        this.set({ conn: "online", deviceId: m.deviceId, sessions: m.sessions, groups: m.groups ?? [], tasks: m.tasks ?? [], usage: m.usage ?? {}, ...(m.limits ? { limits: m.limits } : {}), ...(m.update ? { update: m.update } : {}) });
        break;
      case "groups":
        this.set({ groups: m.groups });
        break;
      case "tasks":
        this.set({ tasks: m.tasks });
        break;
      case "usage":
        this.set({ usage: { ...this.state.usage, [m.sessionId]: m.usage } });
        break;
      case "language":
        applyLangSetting(m.language);
        break;
      case "notify":
        for (const l of this.noticeListeners) l(m.notice);
        break;
      case "limits":
        this.set({ limits: m.limits });
        break;
      case "update":
        this.set({ update: m.update });
        break;
      case "session": {
        const others = this.state.sessions.filter((s) => s.id !== m.session.id);
        const sessions = [m.session, ...others].sort((a, b) => b.updatedAt - a.updatedAt);
        const v = this.state.views[m.session.id];
        if (v) v.info = { ...m.session, lastSeq: v.lastSeq };
        this.set({ sessions });
        break;
      }
      case "session.deleted": {
        const { [m.sessionId]: _, ...views } = this.state.views;
        this.open.delete(m.sessionId);
        this.set({ sessions: this.state.sessions.filter((s) => s.id !== m.sessionId), views });
        break;
      }
      case "ev": {
        const v = this.state.views[m.sessionId];
        if (!v) return;
        applyEvent(v, { seq: m.seq, sessionId: m.sessionId, ts: m.ts, event: m.event });
        this.bump(m.sessionId);
        this.emitSoon();
        break;
      }
      case "delta": {
        const v = this.state.views[m.sessionId];
        if (!v) return;
        applyDelta(v, m);
        this.bump(m.sessionId);
        this.emitSoon();
        break;
      }
      case "reset": {
        const info = this.state.sessions.find((s) => s.id === m.sessionId) ?? this.state.views[m.sessionId]?.info;
        this.state.views = { ...this.state.views, [m.sessionId]: emptyView(info) };
        this.bump(m.sessionId);
        this.emitSoon();
        break;
      }
      case "live": {
        const v = this.state.views[m.sessionId];
        if (!v) return;
        for (const { messageId, part } of m.parts) upsertPart(v, messageId, part);
        this.bump(m.sessionId);
        this.emitSoon();
        break;
      }
      case "err":
        console.warn("[kamharn]", m.message);
        break;
    }
  }

  // ---------- REST ----------

  private headers(json = false): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) };
  }

  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.baseUrl + path, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, (j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as T;
  }

  engines = () => this.api<EngineInfo[]>("GET", "/api/engines");
  createSession = (req: CreateSessionRequest) => this.api<SessionInfo>("POST", "/api/sessions", req);
  /** resumeAt: 0 — отменить автопродолжение после лимита; groupId: null — убрать из группы */
  updateSession = (id: string, patch: { title?: string; model?: ModelRef; permissionMode?: PermissionMode; resumeAt?: 0; groupId?: string | null; autoCheck?: boolean; effort?: string }) =>
    this.api<SessionInfo>("PATCH", `/api/sessions/${id}`, patch);
  deleteSession = (id: string) => this.api("DELETE", `/api/sessions/${id}`);
  prompt = (id: string, text: string, fileIds: string[] = []) => this.api("POST", `/api/sessions/${id}/prompt`, { text, fileIds });
  abort = (id: string) => this.api("POST", `/api/sessions/${id}/abort`, {});
  /** сжать контекст агента: история → пересказ, в ленте отметка «контекст сжат» */
  compact = (id: string) => this.api("POST", `/api/sessions/${id}/compact`, {});
  reply = (id: string, permId: string, reply: PermissionReply) => this.api("POST", `/api/sessions/${id}/permissions/${permId}`, { reply });
  /** Ответ на вопрос агента: метки/текст по каждому вопросу; null — не отвечать. */
  answer = (id: string, questionId: string, answers: QuestionAnswers) => this.api("POST", `/api/sessions/${id}/questions/${questionId}`, { answers });

  roots = () => this.api<string[]>("GET", "/api/roots");
  /** Меню «/»: скиллы и команды Claude для сессии. */
  commands = (id: string) => this.api<SlashCommand[]>("GET", `/api/sessions/${id}/commands`);
  /** «@»: файлы и папки проекта сессии под запрос */
  searchFiles = (id: string, q: string) => this.api<FileHit[]>("GET", `/api/sessions/${id}/files?q=${encodeURIComponent(q)}`);
  /** MCP-серверы из настроек Claude: подключать ли их в сессиях KamHarn. */
  claudeMcp = () => this.api<{ enabled: boolean; servers: string[] }>("GET", "/api/claude/mcp");
  setClaudeMcp = (enabled: boolean) => this.api<{ enabled: boolean; servers: string[] }>("PUT", "/api/claude/mcp", { enabled });
  /** Просмотр проекта: текст файла, сам файл (картинки, скачивание), git-изменения сессии. */
  readFile = (path: string) => this.api<FileView>("GET", "/api/fs/read?path=" + encodeURIComponent(path));
  /** сохранить правку; base — sha256 из readFile (409 — файл успели поменять) */
  writeFile = (path: string, text: string, base: string) => this.api<FileView>("PUT", "/api/fs/write", { path, text, base });
  /** снимок экрана ПК (JPEG) — для <img>, загрузчика или браузера */
  screenUrl(): string {
    return `${this.baseUrl}/api/screen?t=${Date.now()}` + (this.token ? `&token=${encodeURIComponent(this.token)}` : "");
  }

  rawUrl(path: string): string {
    return `${this.baseUrl}/api/fs/raw?path=${encodeURIComponent(path)}` + (this.token ? `&token=${encodeURIComponent(this.token)}` : "");
  }
  git = (id: string) => this.api<GitInfo>("GET", `/api/sessions/${id}/git`);
  /** Продолжить сессию на бесплатной модели (opencode) с выжимкой контекста. */
  /** model — модель opencode (без неё — по умолчанию) */
  handoff = (id: string, model?: ModelRef) => this.api<SessionInfo>("POST", `/api/sessions/${id}/handoff`, model ? { model } : {});
  /** Ревью незакоммиченных изменений папки сессии бесплатной моделью. */
  review = (id: string, model?: ModelRef) => this.api<SessionInfo>("POST", `/api/sessions/${id}/review`, model ? { model } : {});
  // ---------- свои MCP-серверы ----------
  mcpOverview = () => this.api<McpOverview>("GET", "/api/mcp");
  /** env/headers: пустое значение у существующего ключа — оставить прежнее (значения хаб не отдаёт) */
  saveMcp = (server: McpServer, oldName?: string) => this.api<McpOverview>("PUT", "/api/mcp", { server, ...(oldName ? { oldName } : {}) });
  removeMcp = (name: string) => this.api<McpOverview>("DELETE", `/api/mcp/${encodeURIComponent(name)}`);
  setClaudeUserMcp = (enabled: boolean) => this.api<McpOverview>("PUT", "/api/mcp/claude-user", { enabled });

  // ---------- скиллы (~/.claude/skills) ----------
  skills = () => this.api<SkillInfo[]>("GET", "/api/skills");
  skillText = (name: string) => this.api<{ name: string; text: string }>("GET", `/api/skills/${encodeURIComponent(name)}`);
  /** create — новый скилл (409, если имя занято) */
  saveSkill = (name: string, text: string, create = false) => this.api<SkillInfo>("PUT", `/api/skills/${encodeURIComponent(name)}`, { text, create });
  removeSkill = (name: string) => this.api("DELETE", `/api/skills/${encodeURIComponent(name)}`);
  skillFromGithub = (url: string, overwrite = false) => this.api<SkillInfo>("POST", "/api/skills/github", { url, overwrite });
  /** SKILL.md или zip; 409 — такой скилл уже есть (повторить с overwrite) */
  async uploadSkill(name: string, body: Blob, overwrite = false): Promise<SkillInfo> {
    const r = await fetch(`${this.baseUrl}/api/skills/upload?name=${encodeURIComponent(name)}${overwrite ? "&overwrite=1" : ""}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/octet-stream" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, (j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as SkillInfo;
  }

  claudeTranscripts = (hidden = false) => this.api<ClaudeTranscript[]>("GET", `/api/claude/transcripts${hidden ? "?hidden=1" : ""}`);
  /** убрать из списка «продолжить» (файл Claude не трогается) или вернуть */
  hideTranscript = (id: string, hidden = true) => this.api("POST", `/api/claude/transcripts/${encodeURIComponent(id)}/${hidden ? "hide" : "unhide"}`, {});
  /** Продолжить сессию Claude Code в KamHarn (копией, исходный транскрипт не меняется). */
  importClaude = (id: string) => this.api<SessionInfo>("POST", "/api/claude/import", { id });
  quickPrompts = () => this.api<string[]>("GET", "/api/quick-prompts");
  setQuickPrompts = (prompts: string[]) => this.api<string[]>("PUT", "/api/quick-prompts", { prompts });
  addRoot = (path: string) => this.api<string[]>("POST", "/api/roots", { path });
  removeRoot = (path: string) => this.api<string[]>("DELETE", "/api/roots", { path });
  list = (path?: string) => this.api<FsEntry[]>("GET", "/api/fs/list" + (path ? `?path=${encodeURIComponent(path)}` : ""));

  pairStart = () => this.api<{ code: string; expiresAt: number }>("POST", "/api/pair/start", {});
  pairComplete = (code: string, name: string) => this.api<{ deviceId: string; token: string }>("POST", "/api/pair/complete", { code, name });
  devices = () => this.api<DeviceInfo[]>("GET", "/api/devices");
  removeDevice = (id: string) => this.api("DELETE", `/api/devices/${id}`);
  hubInfo = () => this.api<HubInfo>("GET", "/api/hub");
  /** сменить язык для всех (хаб разошлёт подключённым) */
  setLanguage = (language: import("@kamharn/protocol").LangSetting) => this.api<{ language: string }>("PUT", "/api/language", { language });
  /** вход в Claude Code на ПК: статус (спрашивает claude заново), окно входа на ПК, свой API-ключ Anthropic */
  claudeAuth = () => this.api<ClaudeAuthInfo & { error?: string }>("GET", "/api/claude/auth");
  claudeLogin = () => this.api<{ ok: true }>("POST", "/api/claude/login", {});
  setClaudeKey = (key: string) => this.api<ClaudeAuthInfo & { error?: string }>("PUT", "/api/claude/key", { key });
  removeClaudeKey = () => this.api<ClaudeAuthInfo & { error?: string }>("DELETE", "/api/claude/key");
  updateStatus = () => this.api<UpdateStatus>("GET", "/api/update");
  checkUpdate = () => this.api<UpdateStatus>("POST", "/api/update/check", {});
  installUpdate = () => this.api<UpdateStatus>("POST", "/api/update/install", {});
  setUpdateAuto = (auto: boolean) => this.api<UpdateStatus>("PUT", "/api/update/settings", { auto });
  /** Перезапуск хаба (работает, только если его запустил сторож). */
  // ---------- Telegram-бот для уведомлений ----------
  telegramStatus = () => this.api<TelegramStatus>("GET", "/api/telegram");
  setTelegramToken = (token: string) => this.api<TelegramStatus>("POST", "/api/telegram", { token });
  removeTelegram = () => this.api("DELETE", "/api/telegram");
  /** null — напрямую; пароль не указан и логин тот же — хаб оставит старый */
  setTelegramProxy = (proxy: TelegramProxy | null) => this.api<TelegramStatus>("PUT", "/api/telegram/proxy", { proxy });
  testTelegram = () => this.api("POST", "/api/telegram/test", {});
  remoteStatus = () => this.api<RemoteStatus>("GET", "/api/remote");
  saveRemote = (r: Partial<RemoteSettings>) => this.api<RemoteStatus>("PUT", "/api/remote", r);
  removeRemote = () => this.api<RemoteStatus>("DELETE", "/api/remote");
  testRemote = () => this.api<{ ok: true; ms: number }>("POST", "/api/remote/test", {});
  addresses = () => this.api<{ urls: string[]; publicUrls: string[]; previewUrl: string }>("GET", "/api/addresses");
  setPreviewUrl = (url: string) => this.api<{ previewUrl: string }>("PUT", "/api/addresses/preview", { url });
  checks = (id: string) => this.api<ChecksConfig>("GET", `/api/sessions/${id}/checks`);
  setChecks = (id: string, commands: string[]) => this.api<ChecksConfig>("PUT", `/api/sessions/${id}/checks`, { commands });
  runChecks = (id: string) => this.api("POST", `/api/sessions/${id}/checks/run`, {});
  setPublicUrls = (publicUrls: string[]) => this.api<{ urls: string[]; publicUrls: string[] }>("PUT", "/api/addresses", { publicUrls });
  checkAddress = (url: string) => this.api<{ ok: true; ms: number }>("POST", "/api/addresses/check", { url });

  // ---------- провайдеры моделей (opencode) ----------
  providers = () => this.api<ProviderEntry[]>("GET", "/api/providers");
  providerModels = (id: string) => this.api<ProviderModel[]>("GET", `/api/providers/${encodeURIComponent(id)}/models`);
  /** пустой список — показывать все модели провайдера */
  setFavorites = (id: string, models: string[]) => this.api("PUT", `/api/providers/${encodeURIComponent(id)}/favorites`, { models });
  setProviderKey = (id: string, key: string, inputs?: Record<string, string>) => this.api("POST", `/api/providers/${encodeURIComponent(id)}/key`, { key, inputs });
  oauthStart = (id: string, method: number, inputs?: Record<string, string>) => this.api<OAuthStart>("POST", `/api/providers/${encodeURIComponent(id)}/oauth`, { method, inputs });
  oauthStatus = (id: string) => this.api<{ status: "waiting" | "done" | "error"; error?: string }>("GET", `/api/providers/${encodeURIComponent(id)}/oauth`);
  oauthCode = (id: string, method: number, code: string) => this.api("POST", `/api/providers/${encodeURIComponent(id)}/oauth/code`, { method, code });
  disconnectProvider = (id: string) => this.api("DELETE", `/api/providers/${encodeURIComponent(id)}`);
  addCustomProvider = (p: { name: string; baseURL: string; apiKey?: string; models: string[] }) => this.api<CustomProvider>("POST", "/api/providers/custom", p);
  /** список моделей у OpenAI-совместимого сервера (запрос идёт с ПК) */
  probeServer = (baseURL: string, apiKey?: string) => this.api<{ models: string[] }>("POST", "/api/providers/probe", { baseURL, apiKey });

  createGroup = (g: { name: string; icon?: string; prompt?: string; noUserRules?: boolean }) => this.api<SessionGroup>("POST", "/api/groups", g);
  updateGroup = (id: string, g: { name?: string; icon?: string; prompt?: string; noUserRules?: boolean; sort?: number }) => this.api<SessionGroup>("PATCH", `/api/groups/${id}`, g);
  deleteGroup = (id: string) => this.api("DELETE", `/api/groups/${id}`);

  tasks = () => this.api<TaskInfo[]>("GET", "/api/tasks");
  /** бот сессии в Telegram */
  sessionBot = (id: string) => this.api<SessionBotInfo>("GET", `/api/sessions/${id}/telegram`);
  setSessionBot = (id: string, token: string) => this.api<SessionBotInfo>("PUT", `/api/sessions/${id}/telegram`, { token });
  sessionBotCode = (id: string) => this.api<SessionBotInfo>("POST", `/api/sessions/${id}/telegram/code`);
  renameSessionBotChat = (id: string, chat: number, name: string) => this.api<SessionBotInfo>("PATCH", `/api/sessions/${id}/telegram/chats/${chat}`, { name });
  unlinkSessionBotChat = (id: string, chat: number) => this.api<SessionBotInfo>("DELETE", `/api/sessions/${id}/telegram/chats/${chat}`);
  removeSessionBot = (id: string) => this.api<SessionBotInfo>("DELETE", `/api/sessions/${id}/telegram`);
  /** расход токенов за период (локальные даты YYYY-MM-DD, включительно) */
  usageReport = (from: string, to: string) => this.api<UsageReport>("GET", `/api/usage?from=${from}&to=${to}`);
  createTask = (req: CreateTaskRequest) => this.api<TaskInfo>("POST", "/api/tasks", req);
  task = (id: string) => this.api<TaskInfo>("GET", `/api/tasks/${id}`);
  taskAction = (id: string, a: TaskAction) => this.api<TaskInfo>("POST", `/api/tasks/${id}/action`, a);
  deleteTask = (id: string) => this.api("DELETE", `/api/tasks/${id}`);
  tasksParallel = () => this.api<{ parallel: number }>("GET", "/api/tasks/parallel");
  setTasksParallel = (parallel: number) => this.api<{ parallel: number }>("PUT", "/api/tasks/parallel", { parallel });
  /** перенести сессию в группу (null — без группы); список обновится у всех по событию сессии */
  moveSession = (id: string, groupId: string | null) => this.updateSession(id, { groupId });
  /** отдельная ветка сессии: сколько сделано, влить одним коммитом в основную, выбросить */
  worktreeStatus = (id: string) => this.api<WorktreeStatus>("GET", `/api/sessions/${id}/worktree`);
  worktreeMerge = (id: string) => this.api<{ commit: string; files: number }>("POST", `/api/sessions/${id}/worktree/merge`, {});
  worktreeDiscard = (id: string) => this.api("POST", `/api/sessions/${id}/worktree/discard`, {});
  /** мини-терминал: история команд сессии и то, что выполняется сейчас */
  termInfo = (sessionId: string) => this.api<{ history: string[]; running?: { runId: string; command: string } }>("GET", `/api/sessions/${sessionId}/term`);
  termRun = (sessionId: string, command: string) => this.api<{ runId: string }>("POST", `/api/sessions/${sessionId}/term`, { command });
  termRead = (runId: string, from: number) => this.api<{ data: string; next: number; done: boolean; exitCode?: number | null }>("GET", `/api/term/${runId}?from=${from}`);
  termStop = (runId: string) => this.api("POST", `/api/term/${runId}/stop`, {});
  /** dev-серверы на ПК; с sessionId — порты этого проекта первыми */
  ports = (sessionId?: string) => this.api<ListeningPort[]>("GET", "/api/ports" + (sessionId ? `?session=${encodeURIComponent(sessionId)}` : ""));
  /** ссылка на превью порта для этого устройства (через Tailscale) */
  /** session — с панелью замечаний по вёрстке (уйдут агенту этой сессии) */
  // via — по какому адресу клиент ходит в хаб: через NAS/свой домен хаб даст общий адрес превью, иначе — Tailscale
  openPreview = (port: number, session?: string) => this.api<{ url: string }>("POST", "/api/preview", { port, via: this.baseUrl, ...(session ? { session } : {}) });
  sleepPc = (delaySec = 20) => this.api<{ ok: true; delaySec: number }>("POST", "/api/hub/sleep", { delaySec });
  wakeConfig = () => this.api<WakeRuntime>("GET", "/api/wake");
  // ---------- «Новая сессия»: включённые движки и выбор по умолчанию ----------
  newSessionPrefs = () => this.api<NewSessionPrefs>("GET", "/api/new-session");
  saveNewSessionPrefs = (p: Partial<NewSessionPrefs>) => this.api<NewSessionPrefs>("PUT", "/api/new-session", p);
  // ---------- настройка пробуждения ПК ----------
  wakeSetup = () => this.api<WakeSetup>("GET", "/api/wake/setup");
  /** token пустой — оставить прежний */
  saveWake = (w: { url: string; token?: string; mac: string; broadcast: string }) => this.api<WakeSetup>("PUT", "/api/wake/setup", w);
  removeWake = () => this.api<WakeSetup>("DELETE", "/api/wake/setup");
  newWakeToken = () => this.api<{ token: string }>("POST", "/api/wake/token", {});
  testWake = () => this.api<{ pc: string }>("POST", "/api/wake/test", {});
  wakeScriptUrl(): string {
    return `${this.baseUrl}/api/wake/script` + (this.token ? `?token=${encodeURIComponent(this.token)}` : "");
  }
  restartHub = (delaySec = 0) => this.api<{ ok: true; delaySec: number }>("POST", "/api/hub/restart", { delaySec });

  /** Загрузка файла в сессию. body — File/Blob в браузере. */
  async upload(sessionId: string, name: string, body: Blob, mime?: string): Promise<UploadedFile> {
    const r = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/files?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { ...this.headers(), "content-type": mime || body.type || "application/octet-stream" },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, (j as { error?: string }).error ?? `HTTP ${r.status}`);
    return j as UploadedFile;
  }

  /** Последняя опубликованная сборка Android-приложения (404 — не публиковали). */
  appLatest = () => this.api<AppRelease>("GET", "/api/app/latest");

  appApkUrl(): string {
    return `${this.baseUrl}/api/app/apk` + (this.token ? `?token=${encodeURIComponent(this.token)}` : "");
  }

  fileUrl(fileId: string): string {
    return `${this.baseUrl}/api/files/${fileId}` + (this.token ? `?token=${encodeURIComponent(this.token)}` : "");
  }
}

// ---------- лимиты подписки Claude: проценты для UI ----------

export interface LimitView {
  /** проценты 0..100; окно уже сброшено — 0 */
  fiveHour?: number;
  sevenDay?: number;
  fiveHourReset?: string;
  sevenDayReset?: string;
  /** ok | warn (≥80%) | danger (≥95%) */
  level: "ok" | "warn" | "danger";
  /** сколько минут назад обновлено */
  ageMin: number;
}


export function limitView(l: ClaudeLimits | undefined, now = Date.now()): LimitView | undefined {
  if (!l) return undefined;
  const pct = (w?: { utilization: number; resetsAt: number }) => (w ? (now >= w.resetsAt ? 0 : Math.round(w.utilization * 100)) : undefined);
  const hm = (t: number) => {
    const d = new Date(t);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const fiveHour = pct(l.fiveHour);
  const sevenDay = pct(l.sevenDay);
  const max = Math.max(fiveHour ?? 0, sevenDay ?? 0);
  return {
    ...(fiveHour !== undefined ? { fiveHour } : {}),
    ...(sevenDay !== undefined ? { sevenDay } : {}),
    ...(l.fiveHour && now < l.fiveHour.resetsAt ? { fiveHourReset: hm(l.fiveHour.resetsAt) } : {}),
    ...(l.sevenDay && now < l.sevenDay.resetsAt ? { sevenDayReset: `${new Date(l.sevenDay.resetsAt).toLocaleDateString(locale(), { weekday: "short" })} ${hm(l.sevenDay.resetsAt)}` } : {}),
    level: max >= 95 ? "danger" : max >= 80 ? "warn" : "ok",
    ageMin: Math.max(0, Math.round((now - l.updatedAt) / 60_000)),
  };
}
