// Общий протокол KamHarn: хаб ↔ клиенты (веб-UI, Android).
// Движки (opencode, claude) нормализуются хабом в эти типы.

export type EngineId = "opencode" | "claude";

/** manual — спрашивать и shell, и правки; acceptEdits — только shell; auto — ничего не спрашивать. */
export type PermissionMode = "manual" | "acceptEdits" | "auto";

export type SessionStatus = "idle" | "busy" | "retry" | "error";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ModelInfo extends ModelRef {
  engine: EngineId;
  name: string;
  tools?: boolean;
  free?: boolean;
  /** локальный сервер модели (LM Studio, Ollama…) сейчас не отвечает */
  offline?: boolean;
}

/** Что показывать в «Новой сессии»: включённые движки и что выбрано по умолчанию (настройки хаба). */
export interface NewSessionPrefs {
  /** включённые движки (выключенные в новой сессии не показываются; старые сессии работают) */
  engines: EngineId[];
  /** движок по умолчанию */
  engine: EngineId;
  /** модель по умолчанию для каждого движка */
  models: Partial<Record<EngineId, ModelRef>>;
}

export interface EngineInfo {
  id: EngineId;
  available: boolean;
  error?: string;
  models: ModelInfo[];
  defaultModel?: ModelRef;
  /** только у claude: вход в Claude Code на ПК */
  auth?: ClaudeAuthInfo;
}

/** Вход в Claude Code на ПК хаба (`claude auth status`). Вход у каждого свой — хранится в ~/.claude того ПК. */
export interface ClaudeAuthInfo {
  /** claude CLI найден */
  installed: boolean;
  loggedIn: boolean;
  /** subscription — по подписке Claude; apiKey — ключ из настроек KraBness; other — иначе (например, вход через Anthropic Console) */
  method?: "subscription" | "apiKey" | "other";
  /** pro, max… */
  subscription?: string;
  email?: string;
  /** в KraBness сохранён свой API-ключ (сам ключ наружу не отдаётся) */
  apiKey: boolean;
}

export interface SessionInfo {
  id: string;
  engine: EngineId;
  directory: string;
  title: string;
  model: ModelRef;
  permissionMode: PermissionMode;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  /** seq последнего сохранённого события сессии */
  lastSeq: number;
  /** упёрлись в лимит Claude: когда хаб сам напишет «Продолжай» (мс; 0 или нет — не ждёт) */
  resumeAt?: number;
  /** сессия работает в отдельной ветке */
  worktree?: WorktreeInfo;
  /** группа в списке сессий (нет — «Без группы») */
  groupId?: string;
}

/** Группа сессий: порядок в списке и системный промпт для всех её сессий. */
export interface SessionGroup {
  id: string;
  name: string;
  /** эмодзи перед названием */
  icon?: string;
  /** добавляется к системному промпту каждой сессии группы (со следующего сообщения) */
  prompt?: string;
  sort: number;
}

export interface MessageInfo {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  completedAt?: number;
  model?: ModelRef;
  /** пересказ разговора после сжатия контекста — клиенты показывают его свёрнутым */
  summary?: boolean;
}

export type ToolStatus = "pending" | "running" | "completed" | "error";

export type Part =
  | { type: "text"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string }
  | {
      type: "tool";
      id: string;
      tool: string;
      status: ToolStatus;
      title?: string;
      input?: unknown;
      output?: string;
      error?: string;
    }
  | { type: "file"; id: string; fileId: string; name: string; mime: string; size: number }
  /** контекст агента сжат (вручную или сам, когда кончалось место): всё выше клиенты сворачивают */
  | { type: "compaction"; id: string; trigger: "manual" | "auto"; preTokens?: number; postTokens?: number };

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
  id: string;
  /** bash, edit, write, webfetch ... */
  tool: string;
  /** короткое описание для UI и пушей: команда, путь файла и т.п. */
  title: string;
  detail?: unknown;
  canAlways: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  /** короткая подпись (чип) */
  header?: string;
  options: QuestionOption[];
  /** можно выбрать несколько вариантов */
  multiple?: boolean;
  /** можно ответить своим текстом */
  custom?: boolean;
}

/** Вопрос агента пользователю (AskUserQuestion у claude, question у opencode). */
export interface QuestionRequest {
  id: string;
  questions: QuestionItem[];
}

/** Ответы по порядку вопросов: выбранные метки или свой текст. null — пользователь отказался отвечать. */
export type QuestionAnswers = string[][] | null;

/** Сохраняемые события сессии (получают seq и попадают в replay). */
export type SessionEvent =
  | { type: "session.updated"; patch: Partial<Pick<SessionInfo, "title" | "status" | "model" | "permissionMode" | "resumeAt" | "groupId">> }
  | { type: "message.upserted"; message: MessageInfo }
  | { type: "part.upserted"; messageId: string; part: Part }
  | { type: "permission.asked"; request: PermissionRequest }
  | { type: "permission.resolved"; id: string; reply: PermissionReply; by?: string }
  | { type: "question.asked"; request: QuestionRequest }
  | { type: "question.resolved"; id: string; answers: QuestionAnswers; by?: string }
  | { type: "error"; message: string };

/** Транзиентная дельта текста: не сохраняется, при переподключении состояние догоняется снапшотом. */
export interface PartDelta {
  messageId: string;
  partId: string;
  field: "text";
  delta: string;
}

export interface StoredEvent {
  seq: number;
  sessionId: string;
  ts: number;
  event: SessionEvent;
}

// ---------- WebSocket ----------

export type ClientMessage =
  | { t: "sub"; sessionId: string; after: number }
  | { t: "unsub"; sessionId: string }
  | { t: "ping" }
  /** пользователь сейчас за этим клиентом (веб: вкладка видна, в фокусе, был ввод); active повторяется как пульс */
  | { t: "presence"; active: boolean };

export type ServerMessage =
  | { t: "hello"; deviceId: string; sessions: SessionInfo[]; limits?: ClaudeLimits; groups?: SessionGroup[]; language?: import("./i18n.ts").LangSetting; update?: UpdateStatus }
  /** статус обновлений поменялся (нашлась новая версия, идёт установка) */
  | { t: "update"; update: UpdateStatus }
  /** язык поменяли в настройках — переключиться сразу */
  | { t: "language"; language: import("./i18n.ts").LangSetting }
  /** группы сессий изменились (создали, переименовали, удалили, поменяли промпт) */
  | { t: "groups"; groups: SessionGroup[] }
  /** уведомление для приложения: показать самому, без Firebase (если на телефоне выбран такой способ) */
  | { t: "notify"; notice: HubNotice }
  /** лимиты подписки Claude обновились */
  | { t: "limits"; limits: ClaudeLimits }
  /** создание/обновление сессии в общем списке */
  | { t: "session"; session: SessionInfo }
  | { t: "session.deleted"; sessionId: string }
  | { t: "ev"; sessionId: string; seq: number; ts: number; event: SessionEvent }
  | ({ t: "delta"; sessionId: string } & PartDelta)
  /**
   * Replay по подписке закончен: дальше идут живые события.
   * parts — текущее состояние частей, которые ещё стримятся (текст, накопленный из дельт).
   */
  | { t: "live"; sessionId: string; seq: number; parts: Array<{ messageId: string; part: Part }> }
  | { t: "pong" }
  /** кэш клиента новее журнала хаба (БД сбросили): выбросить состояние чата, дальше идёт replay с начала */
  | { t: "reset"; sessionId: string }
  | { t: "err"; message: string };

// ---------- REST ----------

export interface CreateSessionRequest {
  engine: EngineId;
  directory: string;
  model?: ModelRef;
  permissionMode?: PermissionMode;
  title?: string;
  /** работать в отдельной ветке (git worktree рядом с проектом) */
  worktree?: boolean;
  /** сразу в группу */
  groupId?: string;
}

/** Копия проекта сессии (git worktree). */
export interface WorktreeInfo {
  /** корень основного репозитория */
  repo: string;
  /** папка копии */
  path: string;
  branch: string;
  /** ветка, в которую вливаем */
  base: string;
}

export interface WorktreeStatus {
  branch: string;
  base: string;
  /** коммитов в ветке сессии, которых нет в основной */
  ahead: number;
  /** незакоммиченных файлов в копии */
  dirty: number;
  /** git status --porcelain (до 30 строк) */
  files: string[];
}

export interface PromptRequest {
  text: string;
  fileIds?: string[];
}

export interface PermissionReplyRequest {
  reply: PermissionReply;
}

/** Содержимое файла проекта для просмотра. */
export interface FileView {
  path: string;
  size: number;
  mime: string;
  text?: string;
  /** показана только начальная часть */
  truncated?: boolean;
  binary?: boolean;
  /** sha256 содержимого (у текстовых, показанных целиком) — для правки: файл не поменялся ли за это время */
  sha256?: string;
}

/** git-изменения в папке сессии. */
export interface GitInfo {
  repo: boolean;
  branch?: string;
  /** status: две буквы porcelain (M, A, D, ??), path — от корня репозитория */
  files: Array<{ status: string; path: string }>;
  /** git diff HEAD по папке сессии */
  diff: string;
  truncated: boolean;
}

/** Пункт меню «/»: скилл или команда Claude. */
export interface SlashCommand {
  name: string;
  description?: string;
  kind: "skill" | "command";
}

/** Окно лимита подписки Claude: доля использования 0..1 и время сброса (мс). */
export interface UsageWindow {
  utilization: number;
  resetsAt: number;
}

/** Лимиты подписки Claude из последнего ответа CLI (rate_limit_event). */
export interface ClaudeLimits {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** allowed | allowed_warning | rejected … */
  status?: string;
  updatedAt: number;
}

/** Уведомление о событии сессии: уходит в FCM, в приложения по WebSocket и в Telegram. */
export interface HubNotice {
  sessionId: string;
  /** название сессии */
  title: string;
  message: string;
  kind: "permission" | "question" | "error" | "done";
  /** для permission — на что отвечать кнопками */
  requestId?: string;
  /** одинаковый тег заменяет предыдущее уведомление */
  tag?: string;
}

/** Телеграм-бот для уведомлений: настроен ли, привязан ли чат. */
export interface TelegramStatus {
  configured: boolean;
  /** @имя бота */
  bot?: string;
  bound: boolean;
  /** код для привязки: написать боту «/start <код>» */
  code?: string;
  error?: string;
  /** прокси до Telegram (пароль не отдаём) */
  proxy?: Omit<TelegramProxy, "password"> & { hasPassword: boolean };
}

/** Удалённый доступ через свой сервер: хаб держит SSH-туннель на VPS, там HTTPS (Caddy). */
export interface RemoteSettings {
  /** адрес VPS (IP или домен) */
  host: string;
  /** пользователь туннеля на VPS (scripts/vps-setup.sh заводит krabtunnel) */
  user: string;
  sshPort: number;
  /** порт на VPS, куда приходит туннель (127.0.0.1:<remotePort>, на него смотрит Caddy) */
  remotePort: number;
  /** публичный адрес: https://krab.<ip>.sslip.io */
  url: string;
  enabled: boolean;
}

export interface RemoteStatus {
  configured: boolean;
  settings?: RemoteSettings;
  /** открытый ключ хаба — его надо прописать на VPS */
  publicKey: string;
  /** команда для VPS: ставит Caddy и пользователя туннеля с этим ключом */
  setupCommand: string;
  state: "off" | "connecting" | "up" | "error";
  error?: string;
  /** когда состояние сменилось (мс) */
  since: number;
}

/** Прокси до api.telegram.org — там, где Telegram заблокирован (свой VPS с SOCKS5 или HTTP-прокси). */
export interface TelegramProxy {
  type: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

// ---------- свои MCP-серверы (KamHarn отдаёт их обоим движкам) ----------

export interface McpServer {
  /** латиница, цифры, - и _ */
  name: string;
  enabled: boolean;
  engines: "both" | "claude" | "opencode";
  /** stdio — запуск командой; http/sse — удалённый сервер */
  type: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  /** переменные окружения (ключи API) */
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** Состояние сервера при последнем запуске движка. */
export interface McpServerStatus {
  /** connected / failed / pending / disabled… — как сообщил движок */
  status: string;
  error?: string;
  at: number;
}

/** Сервер для клиентов: значения env и headers не отдаются, только имена. */
export interface McpServerView extends Omit<McpServer, "env" | "headers"> {
  envKeys: string[];
  headerKeys: string[];
  status: { claude?: McpServerStatus; opencode?: McpServerStatus };
}

export interface McpOverview {
  servers: McpServerView[];
  /** серверы из настроек Claude (~/.claude.json) и галка «подключать их» */
  claude: { enabled: boolean; servers: string[] };
  /** сохранено, но opencode не перезапустился */
  opencodeError?: string;
}

// ---------- пробуждение ПК (будильник scripts/nas-wake/wake.py в домашней сети) ----------

/** Сетевая карта ПК, через которую его можно разбудить. */
export interface WakeNic {
  name: string;
  mac: string;
  address: string;
  broadcast: string;
}

/** Настройка пробуждения для экрана настроек (токен не отдаётся). */
export interface WakeSetup {
  configured: boolean;
  /** адрес будильника: http://<IP устройства в Tailscale>:7421 */
  url?: string;
  hasToken: boolean;
  mac?: string;
  broadcast?: string;
  /** найденные сетевые карты ПК */
  nics: WakeNic[];
  /** адрес хаба в Tailscale — по нему будильник проверяет, проснулся ли ПК */
  pcHost?: string;
  pcPort: number;
}

/** Выпуск KraBness на GitHub. */
export interface UpdateRelease {
  version: string;
  /** что нового: разделы «## Русский» и «## English» из описания выпуска */
  notes: { ru: string; en: string };
  url: string;
  publishedAt?: number;
}

/** Обновления хаба: раз в сутки хаб смотрит GitHub Releases, ставит по кнопке. */
export interface UpdateStatus {
  current: string;
  latest?: UpdateRelease;
  /** latest новее current */
  available: boolean;
  checkedAt?: number;
  /** проверка не удалась */
  error?: string;
  /** проверять раз в сутки */
  auto: boolean;
  /** можно поставить по кнопке; иначе reason: git — папка git (обновлять через git pull), manual — хаб без сторожа */
  canInstall: boolean;
  reason?: "git" | "manual";
  state: "idle" | "checking" | "downloading" | "restarting";
  /** итог последней установки (пишет scripts/apply-update.mjs) */
  last?: { version: string; ok: boolean; at: number; error?: string; rolledBack?: string };
}

/** То, что приложение запоминает, чтобы будить спящий ПК. */
export interface WakeRuntime {
  url: string;
  token: string;
  mac?: string;
  broadcast?: string;
  pcHost?: string;
  pcPort?: number;
}

/** Скилл в ~/.claude/skills (видят Claude и opencode). */
export interface SkillInfo {
  name: string;
  description?: string;
  /** файлов в папке скилла (SKILL.md, скрипты, шаблоны) */
  files: number;
  size: number;
  updatedAt: number;
}

// ---------- провайдеры моделей (opencode) ----------

/** Свой OpenAI-совместимый сервер: LM Studio, Ollama, vLLM… */
export interface CustomProvider {
  id: string;
  name: string;
  /** например http://127.0.0.1:1234/v1 */
  baseURL: string;
  apiKey?: string;
  models: string[];
}

export interface ProviderAuthMethod {
  /** номер способа у opencode (нужен для входа) */
  index: number;
  type: "api" | "oauth";
  label: string;
  /** доп. поля, которые просит провайдер (id аккаунта и т.п.) */
  prompts?: Array<{ type: string; key: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string; hint?: string }> }>;
}

export interface ProviderEntry {
  id: string;
  name: string;
  connected: boolean;
  /** показывать наверху списка */
  popular: boolean;
  /** свой сервер (не из каталога opencode) */
  custom: boolean;
  /** моделей у провайдера */
  models: number;
  /** сколько отмечено в избранное (0 — показываются все) */
  favorites: number;
  methods: ProviderAuthMethod[];
}

export interface ProviderModel {
  id: string;
  name: string;
  free?: boolean;
  tools?: boolean;
  favorite: boolean;
}

/** Вход по подписке: открыть url и (если есть) ввести код из instructions. */
export interface OAuthStart {
  url: string;
  instructions: string;
  /** auto — хаб сам дождётся входа; code — нужно вставить код со страницы */
  method: "auto" | "code";
}

/** Порт, который слушает процесс на ПК (кандидат для превью dev-сервера). */
export interface ListeningPort {
  port: number;
  /** адрес, на котором слушает процесс */
  address: string;
  pid: number;
  process: string;
  command: string;
  /** командная строка процесса упоминает папку сессии */
  project: boolean;
}

/** Сессия Claude Code (транскрипт ~/.claude/projects), которую можно продолжить в KamHarn. */
export interface ClaudeTranscript {
  id: string;
  directory: string;
  /** первая реплика пользователя */
  title: string;
  updatedAt: number;
  size: number;
  /** откуда: VS Code или терминал (у старых транскриптов неизвестно) */
  source?: "vscode" | "cli";
}

/** Опубликованная сборка Android-приложения (data/apk/latest.json). */
export interface AppRelease {
  version: string;
  versionCode: number;
  /** имя файла в data/apk */
  file: string;
  size: number;
  sha256: string;
  builtAt: number;
}

export interface QuestionReplyRequest {
  answers: QuestionAnswers;
}

export * from "./reducer.ts";
export * from "./i18n.ts";
