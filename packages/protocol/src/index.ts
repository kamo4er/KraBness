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
  /** уровни рассуждений, как их называет движок (claude: --effort, opencode: варианты модели); нет — модель их не знает */
  efforts?: string[];
  /** модель видит картинки (без этого у Диспетчера нет управления ПК: снимки ей не прочитать) */
  vision?: boolean;
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
  /** автопроверка: после хода агента хаб гоняет команды проверки проекта и при ошибке возвращает её агенту */
  autoCheck?: boolean;
  /** сессия — шаг задачи (исполнитель или ревью): в общем списке не показывается, живёт на странице задачи */
  taskId?: string;
  /** особая сессия: Диспетчер — помощник, который управляет остальными сессиями и ПК (клиенты закрепляют её сверху) */
  kind?: SessionKind;
  /** уровень рассуждений (из ModelInfo.efforts); нет — по умолчанию модели. Применяется со следующего сообщения */
  effort?: string;
}

/** Группа сессий: порядок в списке и системный промпт для всех её сессий. */
export interface SessionGroup {
  id: string;
  name: string;
  /** эмодзи перед названием */
  icon?: string;
  /** добавляется к системному промпту каждой сессии группы (со следующего сообщения) */
  prompt?: string;
  /** Claude без глобальных правил пользователя (~/.claude/CLAUDE.md и ~/.claude/rules) — для чатов не про код */
  noUserRules?: boolean;
  /** закрыта для памяти: сессии группы не запоминаются, Диспетчер их не читает */
  noMemory?: boolean;
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

/** Особые сессии. dispatcher — Диспетчер (apps/hub/src/dispatcher.ts). */
export type SessionKind = "dispatcher";

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
  | { type: "compaction"; id: string; trigger: "manual" | "auto"; preTokens?: number; postTokens?: number }
  /** автопроверка хаба: команды проекта после хода агента (attempt — какой круг починки) */
  | { type: "check"; id: string; status: CheckStatus; attempt: number; maxAttempts: number; results: CheckResult[]; note?: string };

export type CheckStatus = "running" | "passed" | "failed" | "stopped";

/** Одна команда проверки: код выхода (null — не запустилась или убита по таймауту) и хвост вывода. */
export interface CheckResult {
  command: string;
  code: number | null;
  ms: number;
  output: string;
  timedOut?: boolean;
}

/** Команды проверки проекта: сохранённые и предложенные хабом по файлам проекта. */
export interface ChecksConfig {
  directory: string;
  commands: string[];
  suggested: string[];
}

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
  | { type: "session.updated"; patch: Partial<Pick<SessionInfo, "engine" | "title" | "status" | "model" | "permissionMode" | "resumeAt" | "groupId" | "autoCheck" | "effort">> }
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
  | { t: "hello"; deviceId: string; sessions: SessionInfo[]; limits?: ClaudeLimits; groups?: SessionGroup[]; tasks?: TaskInfo[]; usage?: Record<string, UsageTotals>; language?: import("./i18n.ts").LangSetting; update?: UpdateStatus }
  /** статус обновлений поменялся (нашлась новая версия, идёт установка) */
  | { t: "update"; update: UpdateStatus }
  /** язык поменяли в настройках — переключиться сразу */
  | { t: "language"; language: import("./i18n.ts").LangSetting }
  /** группы сессий изменились (создали, переименовали, удалили, поменяли промпт) */
  | { t: "groups"; groups: SessionGroup[] }
  /** задачи поменялись (статус, шаги, отчёт) */
  | { t: "tasks"; tasks: TaskInfo[] }
  /** расход сессии изменился */
  | { t: "usage"; sessionId: string; usage: UsageTotals }
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
  /** шаг задачи (ставит хаб) */
  taskId?: string;
  /** особая сессия (ставит хаб, из API не принимается) */
  kind?: SessionKind;
  /** уровень рассуждений; нет — по умолчанию модели */
  effort?: string;
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
/** файл или папка проекта для «@» в поле ввода; путь относительно папки сессии, через «/» */
export interface FileHit {
  path: string;
  dir?: boolean;
}

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

/** Мозг Диспетчера: на каком движке и какой модели он работает. */
export interface BrainRef {
  engine: EngineId;
  model: ModelRef;
  /** уровень рассуждений; нет — по умолчанию модели */
  effort?: string;
}

/** Почему основной мозг Диспетчера не отвечает: лимит подписки, нет входа, движок или модель недоступны. */
export type BrainDownReason = "limit" | "auth" | "unavailable";

/** Настройки и состояние мозгов Диспетчера (GET/PUT /api/dispatcher/brains). */
export interface DispatcherBrains {
  primary: BrainRef;
  /** запасной выбирает сам человек: снимки экрана уйдут этому поставщику */
  fallback: BrainRef | null;
  /** сам переключаться на запасной, когда Claude недоступен, и обратно */
  autoFallback: boolean;
  /** управление ПК у мозга на opencode: там нет классификатора Claude */
  computerOnOpencode: boolean;
  /** кто отвечает сейчас */
  active: "primary" | "fallback";
  /** почему сейчас запасной */
  reason?: BrainDownReason;
  /** когда основной снова сможет отвечать (мс) */
  until?: number;
  /** управление ПК на этой машине */
  computer: {
    available: boolean;
    /** off — выключено в конфиге, not-windows, no-uvx — не установлен uv */
    reason?: "off" | "not-windows" | "no-uvx";
    /** первый запуск Windows-MCP качает Python и пакеты: идёт ли подготовка */
    warm?: "running" | "done" | "failed";
  };
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

/** Настроить сервер из интерфейса: хаб один раз заходит по SSH (пароль или ключ не сохраняются) и ставит всё сам. */
export interface ProvisionRequest {
  host: string;
  sshPort?: number;
  /** root или пользователь с sudo */
  user: string;
  password?: string;
  /** закрытый ключ OpenSSH/PEM — вместо пароля */
  privateKey?: string;
}

/** Ход настройки сервера (GET /api/remote/provision): идёт в фоне — на свежем сервере пара минут. */
export interface ProvisionStatus {
  running: boolean;
  log: string[];
  error?: string;
  /** сервер настроен: что напечатал скрипт, отпечаток ключа сервера и проверка снаружи через туннель */
  done?: {
    host: string;
    user: string;
    url: string;
    hostKey: string;
    reachable: boolean;
    ms?: number;
    note?: string;
  };
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

/** Замечание по вёрстке: человек ткнул в элемент на странице превью и написал, что не так. */
export interface LayoutComment {
  text: string;
  /** CSS-селектор, однозначно находящий элемент на странице */
  selector: string;
  /** начало outerHTML элемента */
  html: string;
  /** положение на странице (с учётом прокрутки), CSS-пиксели */
  rect: { x: number; y: number; w: number; h: number };
  /** вычисленные стили, которые обычно важны для вёрстки */
  styles: Record<string, string>;
  /** снимок элемента: data:image/png;base64,… (может не получиться — тогда нет) */
  image?: string;
}

/** Пачка замечаний со страницы превью → одно сообщение агенту. */
export interface LayoutComments {
  url: string;
  title?: string;
  viewport: { w: number; h: number; dpr: number };
  items: LayoutComment[];
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

// ---------- задачи: конвейер над сессиями (orchestrator.ts) ----------

/**
 * queued — ждёт очереди или назначенного времени; running — идёт шаг; waiting_limit — исполнитель упёрся в лимит Claude и ждёт сброса;
 * ready — готово, ждёт решения (влить / ещё круг / выбросить); merged / discarded — решено; failed — сломалось.
 * approval — только у команды: спецификация готова и ждёт одобрения (одобрить / править / выбросить).
 */
export type TaskStatus = "queued" | "running" | "waiting_limit" | "approval" | "ready" | "merged" | "discarded" | "failed";

/**
 * work — исполнитель делает; checks — автопроверка; review — ревью другой моделью; fix — исполнитель правит по ревью или по просьбе;
 * у команды ещё: analysis — аналитик пишет спецификацию; ux — дизайнер рисует интерфейс и прототип; design — архитектор проверяет;
 * test — тестировщик проверяет работу
 */
export type TaskStepKind = "work" | "checks" | "review" | "fix" | "analysis" | "ux" | "design" | "test";

/** Роли команды кроме разработчика (он — исполнитель задачи). */
export type TeamRole = "analyst" | "designer" | "architect" | "tester";
export const TEAM_ROLES: TeamRole[] = ["analyst", "designer", "architect", "tester"];

/** Этап задачи команды, пока она running: кто сейчас работает. */
export type TeamStage = "analysis" | "ux" | "design" | "dev" | "testing";

export interface TeamMember {
  engine: EngineId;
  model?: ModelRef;
  effort?: string;
  /** сессия роли (создаётся, когда до неё дошло, и переиспользуется между кругами) */
  sessionId?: string;
}

export interface TaskStep {
  kind: TaskStepKind;
  status: "running" | "done" | "failed" | "skipped";
  /** сессия шага (у work/fix — сессия исполнителя, у review — своя) */
  sessionId?: string;
  model?: ModelRef;
  startedAt: number;
  finishedAt?: number;
  note?: string;
}

export interface TaskReport {
  /** итог исполнителя (его последний ответ) */
  summary: string;
  /** изменённые файлы в копии против основной ветки */
  files: Array<{ status: string; path: string }>;
  checks: "passed" | "failed" | "none";
  /** ok — замечаний нет; fixed — были и исправлены (следующее ревью чистое); remarks — остались; skipped — ревью не было */
  review: "ok" | "fixed" | "remarks" | "skipped";
  /** последнее ревью целиком (если было) */
  reviewText?: string;
  /** коммит в основной ветке после «Влить» */
  commit?: string;
  /** команда: passed — тестировщик всё принял; bugs — круги кончились, баги остались; skipped — тестировщика не было */
  test?: "passed" | "bugs" | "skipped";
  /** последний отчёт тестировщика целиком */
  testText?: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  /** что сделать — как написал пользователь */
  goal: string;
  /** папка проекта, как её выбрали */
  directory: string;
  status: TaskStatus;
  /** запустить не раньше этого времени (мс); нет — как дойдёт очередь */
  startAt?: number;
  createdAt: number;
  updatedAt: number;
  workerSessionId?: string;
  /** сессия ревью (переиспользуется между кругами) */
  reviewSessionId?: string;
  /** чем кончилась автопроверка последнего шага */
  checksResult?: "passed" | "failed";
  /** вердикт последнего ревью */
  reviewVerdict?: "ok" | "fixed" | "remarks";
  /** текст последнего ревью */
  reviewText?: string;
  /** копия проекта задачи (ветка) */
  worktree?: WorktreeInfo;
  /** движок исполнителя; у старых задач нет — значит claude */
  workerEngine?: EngineId;
  workerModel?: ModelRef;
  /** модель ревью (opencode); нет — без ревью */
  /** движок ревьюера; у старых задач нет — значит opencode */
  reviewEngine?: EngineId;
  /** уровень рассуждений исполнителя и ревьюера; нет — по умолчанию модели */
  workerEffort?: string;
  reviewEffort?: string;
  reviewModel?: ModelRef;
  steps: TaskStep[];
  /** сколько ревью уже было */
  reviews: number;
  report?: TaskReport;
  error?: string;
  /** агент задачи ждёт человека: подтверждение, вопрос или (у аналитика команды) ответ в чате — иначе задача молча стоит */
  asking?: { sessionId: string; kind: "permission" | "question" | "reply"; text: string; at: number };
  /** «team» — команда: аналитик → архитектор → одобрение → разработчик → тестировщик; нет — простая задача */
  mode?: "team";
  /** команда: кто сейчас работает (пока status running) */
  stage?: TeamStage;
  /** команда: аналитик, архитектор, тестировщик (разработчик — workerEngine/workerModel); тестировщика нет — без него */
  team?: Partial<Record<TeamRole, TeamMember>>;
  /** команда: спецификация (markdown) — последняя, что сдал аналитик и дополнили дизайнер и архитектор */
  spec?: string;
  /** команда: дизайнер — «auto» (если аналитик отметил UI: да) или «on» (всегда); нет — без дизайнера */
  designerMode?: "auto" | "on";
  /** команда: аналитик отметил, что задача меняет интерфейс (первая строка спецификации «UI: да/нет») */
  ui?: boolean;
  /** команда: кликабельный прототип дизайнера (самодостаточный HTML) */
  prototype?: string;
  /** команда: круги «архитектор вернул замечания» с последней правки пользователя */
  designRounds?: number;
  /** команда: последние замечания архитектора, если круги кончились без одобрения (решает пользователь) */
  designRemarks?: string;
  /** команда: круги тестировщика */
  testRounds?: number;
  testVerdict?: "passed" | "bugs";
  testText?: string;
}

export interface CreateTaskRequest {
  goal: string;
  /** движок исполнителя; не задан — Claude, если подключён, иначе opencode */
  workerEngine?: EngineId;
  /** движок ревьюера; не задан — opencode */
  reviewEngine?: EngineId;
  /** уровень рассуждений исполнителя и ревьюера; нет — по умолчанию модели */
  workerEffort?: string;
  reviewEffort?: string;
  directory: string;
  title?: string;
  workerModel?: ModelRef;
  /** модель ревью; null — без ревью; не задана — модель opencode по умолчанию */
  reviewModel?: ModelRef | null;
  /** запустить не раньше этого времени (мс) — например, ночью */
  startAt?: number;
  /** «team» — задача для команды (workerEngine/workerModel — разработчик) */
  mode?: "team";
  /** дизайнер команды: auto — если аналитик отметит, что задача про интерфейс (по умолчанию); on — всегда; off — без него */
  designer?: "auto" | "on" | "off";
  /** модели ролей команды; не заданы — умолчания; tester: null — без тестировщика */
  team?: Partial<Record<TeamRole, { engine?: EngineId; model?: ModelRef; effort?: string } | null>>;
}

/**
 * «Влить» в основную ветку, «Ещё круг» с комментарием, «Выбросить» изменения;
 * у команды в approval: «Одобрить» (spec — спецификация, поправленная руками) и «Править» (комментарий аналитику)
 */
export type TaskAction =
  | { action: "merge" }
  | { action: "more"; comment: string }
  | { action: "discard" }
  | { action: "approve"; spec?: string }
  | { action: "revise"; comment: string };

/** Расход токенов. tokens — новые токены (ввод + вывод + запись в кэш); чтение из кэша — отдельно. cost — $ как по API. */
export interface UsageTotals {
  tokens: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
  /** часть записей без цены (модель, которой нет в таблице цен) — cost занижен */
  costUnknown?: boolean;
}

/** Отчёт о расходе за период (локальные даты YYYY-MM-DD, включительно). */
export interface UsageReport {
  from: string;
  to: string;
  /** первый день, за который вообще есть записи */
  firstDay?: string;
  total: UsageTotals;
  days: Array<{ day: string } & UsageTotals>;
  models: Array<{ engine: EngineId; model: string } & UsageTotals>;
  /** по убыванию новых токенов; deleted — сессию удалили, расход остался */
  sessions: Array<{ sessionId: string; title: string; engine: EngineId; deleted?: boolean } & UsageTotals>;
}

/** Бот сессии в Telegram: пишешь ему — уходит агенту этой сессии, ответ и файлы приходят обратно. Токен наружу не отдаётся. */
export interface SessionBotInfo {
  configured: boolean;
  /** @имя бота */
  bot?: string;
  /** одноразовый код: «/start <код>» в личке боту подключает чат */
  code?: string;
  /** кто подключён */
  chats: Array<{ id: number; name: string }>;
  /** последняя ошибка связи с Telegram */
  error?: string;
}
export * from "./speech.ts";
export * from "./artifact.ts";


/** Голос на ПК (apps/hub/src/voice.ts, voice/main.py): слово-активатор → Whisper → Диспетчер → ответ вслух. */
export interface VoiceStatus {
  enabled: boolean;
  state: "off" | "starting" | "loading" | "listening" | "recording" | "thinking" | "speaking" | "restarting";
  /** почему нельзя включить */
  unavailable?: string;
  /** хвост лога сервиса */
  log: string[];
  /** микрофон (номер или часть имени); пусто — системный */
  device: string;
  /** пауза конца фразы, с */
  pause: number;
  /** слово-активатор в начале фразы («Крабик», «Джарвис»…) */
  wake: string;
}

/** Найденное поиском по всем чатам (`GET /api/search`). */
/** Что нашлось в долгой памяти (apps/hub/src/memory.ts). */
export interface MemoryHit {
  id: number;
  kind: "chat" | "diary" | "fact" | "place";
  /** diary, session:<id> */
  source: string;
  /** откуда понятными словами */
  where: string;
  role?: string;
  day: string;
  ts: number;
  text: string;
  score: number;
}

export interface MemoryRecall {
  /** дни, о которых спрашивают («вчера», «3 октября») */
  days: string[];
  diaries: Array<{ day: string; text: string }>;
  items: MemoryHit[];
}

/** Настройки «Память»: сколько помнит и чем. */
export interface MemoryInfo {
  items: number;
  withVector: number;
  diaries: number;
  facts: number;
  places: number;
  lastDiary?: string;
  writer: boolean;
  vectors: boolean;
  closedGroups: string[];
  enabled: boolean;
  days: Array<{ day: string; text: string }>;
}

/** Что знать постоянно: последний день и накопленное. */
export interface MemoryBrief {
  lastDay?: { day: string; text: string };
  facts: string[];
  places: string[];
}

export interface SearchHit {
  sessionId: string;
  title: string;
  messageId: string;
  role: string;
  ts: number;
  /** кусок текста, найденные слова в **…** */
  snippet: string;
}
