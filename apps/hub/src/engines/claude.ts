// Движок Claude Code: официальный немодифицированный `claude` CLI, залогиненный подпиской.
// Процесс на сессию: `claude -p --input-format stream-json --output-format stream-json`.
// Подтверждения действий идут через MCP-инструмент хаба (--permission-prompt-tool).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync, type ChildProcess } from "node:child_process";
import type { ClaudeAuthInfo, ClaudeLimits, EngineInfo, ModelInfo, ModelRef, Part, PermissionMode, PermissionReply, QuestionAnswers, QuestionItem } from "@kamharn/protocol";
import type { Engine, EngineSink, PromptFile } from "./types.ts";
import { killTree, spawn } from "../proc.ts";
import { L } from "../lang.ts";

export interface ClaudeOptions {
  bin?: string;
  defaultModel?: ModelRef;
  /** папка для служебных файлов (mcp-конфиги сессий) */
  dataDir: string;
  /** базовый URL MCP-сервера хаба, к нему добавляется /<engineSessionId> */
  mcpBaseUrl: () => string;
  /** свои MCP-серверы KamHarn (mcpServers для --mcp-config), читается при каждом запуске процесса */
  extraMcp?: () => Record<string, unknown>;
  /** дополнения для конкретной сессии (Диспетчеру — управление ПК): свои MCP-серверы и инструменты, разрешённые без вопросов */
  sessionExtras?: (engineSessionId: string) => { mcp?: Record<string, unknown>; allowedTools?: string[] } | undefined;
  /** состояние MCP-серверов из system/init */
  onMcpStatus?: (servers: unknown) => void;
  /** подключать ли MCP-серверы из пользовательских настроек Claude */
  userMcp?: boolean | (() => boolean);
  /** убивать простаивающий процесс через N мс (потом поднимется с --resume) */
  idleKillMs?: number;
  /** свой API-ключ Anthropic из настроек KraBness (вместо входа по подписке); читается при каждом запуске процесса */
  apiKey?: () => string | undefined;
  /** доп. аргументы claude (engines.claude.args в конфиге) */
  extraArgs?: string[];
  log?: (m: string) => void;
}

const MODELS: Array<{ id: string; name: string }> = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
];

/** какие инструкции не грузить сессиям группы «без моих правил»: ~/.claude/CLAUDE.md и ~/.claude/rules (проверено на 2.1.302) */
export const NO_USER_RULES = ["**/.claude/CLAUDE.md", "**/.claude/rules/**"];

/** уровни claude --effort (2.1.302: low, medium, high, xhigh, max; Haiku тоже принимает) */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const MODE: Record<PermissionMode, string> = { manual: "default", acceptEdits: "acceptEdits", auto: "auto" };
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, any>;

interface PendingPermission {
  resolve: (r: PermissionReply) => void;
  tool: string;
}

interface Sess {
  id: string;
  directory: string;
  model: ModelRef;
  permissionMode: PermissionMode;
  /** транскрипт уже существует → запускать с --resume */
  hasHistory: boolean;
  /** импортированная сессия Claude Code: первый запуск — форк этого транскрипта */
  forkFrom?: string;
  /** системный промпт группы, с которым запущен процесс (--append-system-prompt) */
  system?: string;
  /** уровень рассуждений, с которым запущен процесс (--effort) */
  effort?: string;
  /** запущен без глобальных правил пользователя (группа «не про код») */
  noUserRules?: boolean;
  /** modelUsage из прошлого result этого процесса: CLI отдаёт его накопительно, расход хода — разница */
  modelUsage?: Record<string, Json>;
  proc?: ChildProcess;
  buf: string;
  busy: boolean;
  /** текущее сообщение ассистента и индекс последнего начатого блока */
  msgId?: string;
  blockIndex: number;
  /** блоки thinking, по которым уже была дельта (пустые не показываем) */
  reasoningShown: Set<string>;
  messageCreated: Map<string, number>;
  tools: Map<string, { messageId: string; partId: string; tool: string; input?: unknown }>;
  pending: Map<string, PendingPermission>;
  questions: Map<string, (a: QuestionAnswers) => void>;
  alwaysAllow: Set<string>;
  /** в этом ходе CLI ответил authentication_failed — в result показать понятную ошибку */
  authFailed?: boolean;
  /** после compact_boundary следующим «user» придёт пересказ разговора */
  awaitSummary?: boolean;
  idleTimer?: NodeJS.Timeout;
  abortTimer?: NodeJS.Timeout;
}

export function resolveClaudeBin(bin?: string): string {
  if (bin) return bin;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) {
    const p = join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(p)) return p;
  }
  // npm i -g @anthropic-ai/claude-code: в PATH только обёртки claude.cmd/.ps1, их spawn без оболочки не запустит — берём сам exe
  if (process.platform === "win32" && process.env.APPDATA) {
    const exe = join(process.env.APPDATA, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (existsSync(exe)) return exe;
  }
  return "claude";
}

export function toolTitle(tool: string, input: unknown): string {
  const i = (input ?? {}) as Json;
  if (tool === "AskUserQuestion" && Array.isArray(i.questions) && typeof i.questions[0]?.question === "string") return i.questions[0].question;
  const v = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.description ?? i.prompt;
  if (typeof v === "string") return v.length > 200 ? v.slice(0, 200) + "…" : v;
  const s = JSON.stringify(input ?? {});
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

/** rate_limit_event.rate_limit_info → проценты окон 5 часов и 7 дней (resetsAt в секундах). */
export function parseLimits(info: unknown, now = Date.now()): ClaudeLimits | undefined {
  const i = (info ?? {}) as Json;
  const w = (i.unifiedWindows ?? {}) as Json;
  const win = (x: Json | undefined) =>
    x && typeof x.utilization === "number" ? { utilization: x.utilization, resetsAt: Number(x.resetsAt) * 1000 } : undefined;
  const fiveHour = win(w.five_hour);
  const sevenDay = win(w.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), ...(i.status ? { status: String(i.status) } : {}), updatedAt: now };
}

/** Служебные абзацы, которые CLI добавляет к пересказу после сжатия (для модели, не для человека). */
const SUMMARY_NOISE = [/^This session is being continued/, /^If you need specific details from before compaction/, /^The messages after this summary/, /^Continue the conversation from where/, /^Summary:\s*$/];

/** Пересказ после /compact без служебных абзацев CLI; ничего не осталось — весь текст как есть. */
export function compactSummary(content: string): string {
  const kept = content
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((p) => p.replace(/^Summary:\s*\n/, "").trim())
    .filter((p) => p && !SUMMARY_NOISE.some((re) => re.test(p)));
  return (kept.length ? kept.join("\n\n") : content).trim();
}

function resultText(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) s = content.map((c: Json) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  else s = JSON.stringify(content ?? "");
  return s.length > 20_000 ? s.slice(0, 20_000) + L("\n…(обрезано)", "\n…(truncated)") : s;
}

export class ClaudeEngine implements Engine {
  readonly id = "claude" as const;
  private sink?: EngineSink;
  private sessions = new Map<string, Sess>();
  private bin: string;
  private log: (m: string) => void;
  private authCache?: { at: number; info: ClaudeAuthInfo & { error?: string } };
  /** скиллы из последнего system:init (встроенные и из плагинов) */
  private lastSkills: string[] = [];

  /** путь к claude CLI (окно входа на ПК) */
  get binPath(): string {
    return this.bin;
  }

  slashSkills(): string[] {
    return this.lastSkills;
  }

  constructor(private opts: ClaudeOptions) {
    this.bin = resolveClaudeBin(opts.bin);
    this.log = opts.log ?? ((m) => console.log(`[claude] ${m}`));
  }

  async start(sink: EngineSink): Promise<void> {
    this.sink = sink;
    mkdirSync(join(this.opts.dataDir, "claude-mcp"), { recursive: true });
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) this.killProc(s);
  }

  /** Окружение процессов claude: без метки VS Code, свой API-ключ из настроек (если задан). */
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDE_CODE_ENTRYPOINT") env[k] = v;
    // ожидание ответа на запрос разрешения может длиться долго
    env.MCP_TOOL_TIMEOUT = String(24 * 3600_000);
    const key = this.opts.apiKey?.();
    if (key) env.ANTHROPIC_API_KEY = key;
    return env;
  }

  /** Вход в Claude Code (`claude auth status --json`), кэш на минуту; force — спросить заново. */
  /** Разовый вопрос модели без инструментов и истории (ask_model Диспетчера): пересказать, классифицировать, переформулировать. */
  ask(prompt: string, model: string, timeoutMs = 120_000): Promise<string> {
    const args = ["-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--no-session-persistence"];
    return new Promise((resolve, reject) => {
      const p = spawn(this.bin, args, { env: this.childEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error(L("Модель не ответила вовремя", "The model didn't answer in time")));
      }, timeoutMs);
      p.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
      p.stderr?.on("data", (d: Buffer) => (err += d.toString("utf8")));
      p.on("error", (e) => (clearTimeout(timer), reject(e)));
      p.on("close", () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out) as { result?: string; is_error?: boolean };
          if (j.is_error) return reject(new Error(j.result || err.trim() || "claude error"));
          resolve(String(j.result ?? "").trim());
        } catch {
          reject(new Error(err.trim().slice(0, 300) || out.trim().slice(0, 300) || "claude: no answer"));
        }
      });
      // текст — через stdin: в аргументах Windows режет длинное и кавычки
      p.stdin?.end(prompt);
    });
  }

  authInfo(force = false): ClaudeAuthInfo & { error?: string } {
    if (!force && this.authCache && Date.now() - this.authCache.at < 60_000) return this.authCache.info;
    const apiKey = !!this.opts.apiKey?.();
    const r = spawnSync(this.bin, ["auth", "status", "--json"], { encoding: "utf8", timeout: 15_000, windowsHide: true, env: this.childEnv() });
    let info: ClaudeAuthInfo & { error?: string };
    if (r.error) {
      const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
      info = {
        installed: !missing,
        loggedIn: false,
        apiKey,
        error: missing ? L("Claude Code не установлен: npm i -g @anthropic-ai/claude-code", "Claude Code isn't installed: npm i -g @anthropic-ai/claude-code") : r.error.message,
      };
    } else {
      try {
        const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; email?: string; apiKeySource?: string };
        const loggedIn = j.loggedIn === true;
        const method = !loggedIn ? undefined : apiKey && j.apiKeySource === "ANTHROPIC_API_KEY" ? "apiKey" : j.authMethod === "claude.ai" ? "subscription" : "other";
        info = {
          installed: true,
          loggedIn,
          ...(method ? { method } : {}),
          ...(j.subscriptionType ? { subscription: j.subscriptionType } : {}),
          ...(j.email ? { email: j.email } : {}),
          apiKey,
          ...(loggedIn ? {} : { error: L("Claude Code: вход не выполнен (Настройки → Движки → Войти)", "Claude Code: not signed in (Settings → Engines → Sign in)") }),
        };
      } catch {
        info = { installed: true, loggedIn: false, apiKey, error: (r.stderr || r.stdout || "").trim().slice(0, 200) };
      }
    }
    this.authCache = { at: Date.now(), info };
    return info;
  }

  async info(): Promise<EngineInfo> {
    const { error, ...auth } = this.authInfo();
    const models: ModelInfo[] = MODELS.map((m) => ({ engine: "claude", providerId: "anthropic", modelId: m.id, name: m.name, tools: true, efforts: EFFORTS }));
    return {
      id: "claude",
      available: auth.installed && auth.loggedIn,
      ...(error ? { error } : {}),
      models,
      defaultModel: this.opts.defaultModel ?? { providerId: "anthropic", modelId: "claude-opus-5-5" },
      auth,
    };
  }

  async createSession(o: { directory: string; model: ModelRef; permissionMode: PermissionMode; forkFrom?: string }): Promise<string> {
    const id = randomUUID();
    const s = this.newSess(id, o.directory, o.model, o.permissionMode, false);
    this.sessions.set(id, s);
    if (o.forkFrom) {
      s.forkFrom = o.forkFrom;
      this.saveForks();
    }
    return id;
  }

  attach(engineSessionId: string, o: { directory: string; model: ModelRef; permissionMode: PermissionMode; hasHistory?: boolean }): void {
    const s = this.newSess(engineSessionId, o.directory, o.model, o.permissionMode, o.hasHistory ?? true);
    const from = this.loadForks()[engineSessionId];
    if (from) s.forkFrom = from;
    this.sessions.set(engineSessionId, s);
  }

  // ---------- форки сессий Claude Code (импорт): источник живёт в файле до первого запуска ----------

  private get forksFile(): string {
    return join(this.opts.dataDir, "claude-forks.json");
  }

  private loadForks(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.forksFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveForks(): void {
    const forks: Record<string, string> = {};
    for (const s of this.sessions.values()) if (s.forkFrom) forks[s.id] = s.forkFrom;
    // сессии, ещё не поднятые после рестарта, тоже сохраняем
    for (const [id, from] of Object.entries(this.loadForks())) if (!this.sessions.has(id)) forks[id] = from;
    writeFileSync(this.forksFile, JSON.stringify(forks, null, 1));
  }

  private newSess(id: string, directory: string, model: ModelRef, permissionMode: PermissionMode, hasHistory: boolean): Sess {
    return {
      id, directory, model, permissionMode, hasHistory,
      buf: "", busy: false, blockIndex: 0,
      reasoningShown: new Set(), messageCreated: new Map(), tools: new Map(),
      pending: new Map(), questions: new Map(), alwaysAllow: new Set(),
    };
  }

  private sess(id: string): Sess {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`claude: ${L("неизвестная сессия", "unknown session")} ${id}`);
    return s;
  }

  /** Аргументы запуска claude для сессии (отдельно — чтобы проверять в тестах без настоящего CLI). */
  procArgs(s: Sess, mcpFile: string): string[] {
    return [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", s.model.modelId,
      "--permission-mode", MODE[s.permissionMode],
      "--mcp-config", mcpFile,
      ...((typeof this.opts.userMcp === "function" ? this.opts.userMcp() : this.opts.userMcp) ? [] : ["--strict-mcp-config"]),
      "--permission-prompt-tool", "mcp__kamharn__approve",
      // инструменты самого хаба (файл пользователю, у Диспетчера — управление сессиями) не спрашиваем: опасное они отсекают сами
      "--allowedTools", ["mcp__kamharn", ...(this.opts.sessionExtras?.(s.id)?.allowedTools ?? [])].join(","),
      ...(s.system ? ["--append-system-prompt", s.system] : []),
      ...(s.effort ? ["--effort", s.effort] : []),
      // глобальные правила пользователя (обращение, «план → проверка», коммиты) — про код; чату не про код они мешают
      ...(s.noUserRules ? ["--settings", JSON.stringify({ claudeMdExcludes: NO_USER_RULES })] : []),
      ...(this.opts.extraArgs ?? []),
      // импорт из Claude Code: продолжаем копию, исходный транскрипт (его может держать VS Code) не трогаем
      ...(s.forkFrom ? ["--resume", s.forkFrom, "--fork-session", "--session-id", s.id] : s.hasHistory ? ["--resume", s.id] : ["--session-id", s.id]),
    ];
  }

  private ensureProc(s: Sess): ChildProcess {
    if (s.proc && s.proc.exitCode === null) return s.proc;
    const mcpFile = join(this.opts.dataDir, "claude-mcp", `${s.id}.json`);
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { ...this.opts.extraMcp?.(), ...this.opts.sessionExtras?.(s.id)?.mcp, kamharn: { type: "http", url: `${this.opts.mcpBaseUrl()}/${s.id}` } } }));
    const args = this.procArgs(s, mcpFile);
    this.log(`${L("старт процесса", "starting process")} ${s.id.slice(0, 8)} (${s.forkFrom ? "fork " + s.forkFrom.slice(0, 8) : s.hasHistory ? "resume" : "new"}, ${s.model.modelId})`);
    const proc = spawn(this.bin, args, {
      cwd: s.directory,
      // CLAUDE_CODE_ENTRYPOINT от VS Code (хаб запущен из его терминала) пометил бы наши сессии как «из VS Code»
      env: this.childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    s.proc = proc;
    s.buf = "";
    // новый процесс — накопительные счётчики CLI начинаются с нуля
    s.modelUsage = undefined;
    s.hasHistory = true;
    proc.stdout?.on("data", (d: Buffer) => this.onStdout(s, d));
    proc.stderr?.on("data", (d: Buffer) => this.log(`stderr ${s.id.slice(0, 8)}: ${d.toString().trim().slice(0, 500)}`));
    proc.on("error", (e) => {
      this.log(`${L("ошибка процесса", "process error")}: ${e.message}`);
      // claude не найден: процесс не стартовал, exit может и не прийти — снимаем «работает» сами
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || s.proc !== proc) return;
      s.proc = undefined;
      this.authCache = undefined;
      this.rejectPending(s);
      if (s.busy) {
        s.busy = false;
        this.sink?.event(s.id, { type: "error", message: L("Claude Code не установлен на ПК: npm i -g @anthropic-ai/claude-code", "Claude Code isn't installed on the PC: npm i -g @anthropic-ai/claude-code") });
        this.sink?.event(s.id, { type: "session.updated", patch: { status: "idle" } });
      }
    });
    proc.on("exit", (code) => {
      if (s.proc !== proc) return;
      s.proc = undefined;
      this.rejectPending(s);
      if (s.busy) {
        s.busy = false;
        this.sink?.event(s.id, { type: "error", message: L(`Процесс Claude завершился (код ${code})`, `The Claude process exited (code ${code})`) });
        this.sink?.event(s.id, { type: "session.updated", patch: { status: "idle" } });
      }
    });
    return proc;
  }

/**
   * Расход хода из result. usage там за ход, а modelUsage (токены и costUSD по моделям) — накопительно за жизнь
   * процесса (проверено на 2.1.302), поэтому берём разницу с прошлым result; так видны и субагенты на других моделях.
   */
  private usageOf(s: Sess, j: Json): void {
    const mu = j.modelUsage as Record<string, Json> | undefined;
    const n = (v: unknown) => Number(v) || 0;
    const turn = j.uuid ? String(j.uuid) : randomUUID();
    if (mu && Object.keys(mu).length) {
      const prev = s.modelUsage ?? {};
      for (const [model, u] of Object.entries(mu)) {
        const p = prev[model] ?? {};
        const d = {
          input: n(u.inputTokens) - n(p.inputTokens),
          output: n(u.outputTokens) - n(p.outputTokens),
          cacheWrite: n(u.cacheCreationInputTokens) - n(p.cacheCreationInputTokens),
          cacheRead: n(u.cacheReadInputTokens) - n(p.cacheReadInputTokens),
          cost: n(u.costUSD) - n(p.costUSD),
        };
        if (d.input + d.output + d.cacheWrite + d.cacheRead <= 0) continue;
        this.sink?.usage?.(s.id, { key: `claude:${s.id}:${turn}:${model}`, model, ...d });
      }
      s.modelUsage = mu;
      return;
    }
    // старый CLI без modelUsage: только токены хода, цены не знаем
    const u = j.usage as Json | undefined;
    if (!u) return;
    const r = { input: n(u.input_tokens), output: n(u.output_tokens), cacheWrite: n(u.cache_creation_input_tokens), cacheRead: n(u.cache_read_input_tokens) };
    if (r.input + r.output + r.cacheWrite + r.cacheRead > 0) this.sink?.usage?.(s.id, { key: `claude:${s.id}:${turn}`, model: s.model.modelId, ...r });
  }

  private killProc(s: Sess): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.abortTimer) clearTimeout(s.abortTimer);
    const p = s.proc;
    s.proc = undefined;
    if (p) {
      p.stdin?.end();
      killTree(p);
    }
    this.rejectPending(s);
  }

  private rejectPending(s: Sess): void {
    for (const p of s.pending.values()) p.resolve("reject");
    s.pending.clear();
    for (const q of s.questions.values()) q(null);
    s.questions.clear();
  }

  /** /compact в режиме -p работает (проверено на 2.1.302): compact_boundary, затем пересказ, память сохраняется. */
  // system и прочее, с чем запущен процесс: без них prompt() решил бы, что они сменились, и перезапустил процесс без них
  async compact(engineSessionId: string, o: { model: ModelRef; system?: string; effort?: string; noUserRules?: boolean }): Promise<void> {
    await this.prompt(engineSessionId, { ...o, text: "/compact", files: [] });
  }

  async prompt(engineSessionId: string, o: { text: string; files: PromptFile[]; model: ModelRef; system?: string; effort?: string; noUserRules?: boolean }): Promise<void> {
    const s = this.sess(engineSessionId);
    if (s.model.modelId !== o.model.modelId) {
      // смена модели: перезапускаем процесс, транскрипт продолжится с --resume
      s.model = o.model;
      if (s.proc && !s.busy) this.killProc(s);
    }
    // промпт группы задаётся при запуске процесса — сменился (или сессию перенесли в другую группу) → перезапуск
    if ((s.system ?? "") !== (o.system ?? "")) {
      s.system = o.system || undefined;
      if (s.proc && !s.busy) this.killProc(s);
    }
    // уровень рассуждений тоже задаётся при запуске (--effort): сменился → перезапуск с --resume
    if ((s.effort ?? "") !== (o.effort ?? "")) {
      s.effort = o.effort || undefined;
      if (s.proc && !s.busy) this.killProc(s);
    }
    if (!!s.noUserRules !== !!o.noUserRules) {
      s.noUserRules = o.noUserRules || undefined;
      if (s.proc && !s.busy) this.killProc(s);
    }
    const proc = this.ensureProc(s);
    if (s.idleTimer) clearTimeout(s.idleTimer);

    const content: Json[] = [];
    let text = o.text;
    const others = o.files.filter((f) => !f.mime.startsWith("image/") || f.size > 5 * 1024 * 1024);
    if (others.length) text += `\n\n[${L("Вложения от пользователя", "Attachments from the user")}: ${others.map((f) => f.path).join(", ")}]`;
    if (text.trim()) content.push({ type: "text", text });
    for (const f of o.files) {
      if (!f.mime.startsWith("image/") || f.size > 5 * 1024 * 1024) continue;
      content.push({ type: "image", source: { type: "base64", media_type: f.mime, data: readFileSync(f.path).toString("base64") } });
    }

    // сообщение пользователя показываем сами: claude его не повторяет
    const mid = "u_" + randomUUID().replace(/-/g, "").slice(0, 16);
    this.sink?.event(s.id, { type: "message.upserted", message: { id: mid, role: "user", createdAt: Date.now() } });
    this.sink?.event(s.id, { type: "part.upserted", messageId: mid, part: { type: "text", id: `${mid}:t`, text: o.text } });
    for (const f of o.files) {
      this.sink?.event(s.id, {
        type: "part.upserted",
        messageId: mid,
        part: { type: "file", id: `${mid}:${f.fileId}`, fileId: f.fileId, name: f.name, mime: f.mime, size: f.size },
      });
    }
    if (!s.busy) {
      s.busy = true;
      this.sink?.event(s.id, { type: "session.updated", patch: { status: "busy" } });
    }
    proc.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }

  async abort(engineSessionId: string): Promise<void> {
    const s = this.sess(engineSessionId);
    if (!s.proc || !s.busy) return;
    this.rejectPending(s);
    s.proc.stdin?.write(JSON.stringify({ type: "control_request", request_id: "int_" + Date.now(), request: { subtype: "interrupt" } }) + "\n");
    // если claude не завершил ход сам — убиваем процесс, следующий промпт поднимет его с --resume
    s.abortTimer = setTimeout(() => {
      if (s.busy) {
        this.killProc(s);
        s.busy = false;
        this.sink?.event(s.id, { type: "session.updated", patch: { status: "idle" } });
      }
    }, 8000);
  }

  /** Погасить простаивающие процессы: следующее сообщение поднимет их с новыми настройками (--resume). */
  restartIdle(): void {
    for (const s of this.sessions.values()) if (s.proc && !s.busy) this.killProc(s);
  }

  forget(engineSessionId: string): void {
    const s = this.sessions.get(engineSessionId);
    if (!s) return;
    this.killProc(s);
    this.sessions.delete(engineSessionId);
  }

  // ---------- разрешения (вызывается MCP-инструментом approve) ----------

  async requestPermission(engineSessionId: string, tool: string, input: unknown): Promise<PermissionReply> {
    const s = this.sess(engineSessionId);
    if (s.alwaysAllow.has(tool)) return "always";
    const id = "cp_" + randomUUID().replace(/-/g, "").slice(0, 16);
    const reply = await new Promise<PermissionReply>((resolve) => {
      s.pending.set(id, { resolve, tool });
      this.sink?.event(s.id, {
        type: "permission.asked",
        request: { id, tool, title: toolTitle(tool, input), detail: input, canAlways: true },
      });
    });
    s.pending.delete(id);
    if (reply === "always") s.alwaysAllow.add(tool);
    this.sink?.event(s.id, { type: "permission.resolved", id, reply });
    return reply;
  }

  async replyPermission(engineSessionId: string, requestId: string, reply: PermissionReply): Promise<void> {
    const s = this.sess(engineSessionId);
    const p = s.pending.get(requestId);
    if (!p) throw new Error(L(`Нет ожидающего запроса ${requestId}`, `No pending request ${requestId}`));
    p.resolve(reply);
  }

  // ---------- вопросы (AskUserQuestion приходит в approve как запрос разрешения) ----------

  /** Показывает вопросы пользователю и возвращает решение для --permission-prompt-tool. */
  async answerQuestion(engineSessionId: string, input: unknown): Promise<Json> {
    const s = this.sess(engineSessionId);
    const raw = ((input ?? {}) as Json).questions;
    const items: QuestionItem[] = (Array.isArray(raw) ? raw : []).map((q: Json) => ({
      question: String(q.question ?? ""),
      ...(q.header ? { header: String(q.header) } : {}),
      options: (Array.isArray(q.options) ? q.options : []).map((o: Json) => ({ label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}) })),
      multiple: !!q.multiSelect,
      // у AskUserQuestion всегда можно ответить своим текстом («Other»)
      custom: true,
    }));
    const id = "cq_" + randomUUID().replace(/-/g, "").slice(0, 16);
    const answers = await new Promise<QuestionAnswers>((resolve) => {
      s.questions.set(id, resolve);
      this.sink?.event(s.id, { type: "question.asked", request: { id, questions: items } });
    });
    s.questions.delete(id);
    this.sink?.event(s.id, { type: "question.resolved", id, answers });
    if (!answers) return { behavior: "deny", message: L("Пользователь не стал отвечать на вопрос.", "The user chose not to answer the question.") };
    // формат SDK: { текст вопроса: выбранная метка }, несколько меток — через запятую
    const map = Object.fromEntries(items.map((q, i) => [q.question, (answers[i] ?? []).join(", ")]));
    return { behavior: "allow", updatedInput: { ...(input as Json), answers: map } };
  }

  async replyQuestion(engineSessionId: string, requestId: string, answers: QuestionAnswers): Promise<void> {
    const s = this.sess(engineSessionId);
    const q = s.questions.get(requestId);
    if (!q) throw new Error(L(`Нет ожидающего вопроса ${requestId}`, `No pending question ${requestId}`));
    q(answers);
  }

  async setPermissionMode(engineSessionId: string, mode: PermissionMode): Promise<void> {
    const s = this.sess(engineSessionId);
    s.permissionMode = mode;
    // живому процессу — командой; иначе режим подхватится при следующем запуске
    if (s.proc && s.proc.exitCode === null) {
      s.proc.stdin?.write(
        JSON.stringify({ type: "control_request", request_id: "mode_" + Date.now(), request: { subtype: "set_permission_mode", mode: MODE[mode] } }) + "\n",
      );
    }
    for (const p of s.pending.values()) {
      if (mode === "auto" || (mode === "acceptEdits" && EDIT_TOOLS.has(p.tool))) p.resolve("once");
    }
  }

  // ---------- разбор stream-json ----------

  private onStdout(s: Sess, d: Buffer): void {
    s.buf += d.toString();
    let i: number;
    while ((i = s.buf.indexOf("\n")) >= 0) {
      const line = s.buf.slice(0, i).trim();
      s.buf = s.buf.slice(i + 1);
      if (!line) continue;
      let j: Json;
      try {
        j = JSON.parse(line);
      } catch {
        this.log(`${L("не JSON", "not JSON")}: ${line.slice(0, 200)}`);
        continue;
      }
      try {
        this.handle(s.id, j);
      } catch (e) {
        this.log(`${L("ошибка разбора", "parse error")} ${j.type}: ${(e as Error).message}`);
      }
    }
  }

  private part(sid: string, messageId: string, part: Part): void {
    this.sink?.event(sid, { type: "part.upserted", messageId, part });
  }

  private ensureMessage(s: Sess, msgId: string, model?: string): void {
    if (s.messageCreated.has(msgId)) return;
    const createdAt = Date.now();
    s.messageCreated.set(msgId, createdAt);
    this.sink?.event(s.id, {
      type: "message.upserted",
      message: { id: msgId, role: "assistant", createdAt, ...(model ? { model: { providerId: "anthropic", modelId: model } } : {}) },
    });
  }

  /** Публичный ради тестов на записанных событиях. */
  handle(sid: string, j: Json): void {
    const s = this.sess(sid);
    // внутренности субагентов не показываем (видно сам вызов Task/Agent)
    if (j.parent_tool_use_id) return;

    switch (j.type) {
      case "stream_event": {
        const ev = j.event as Json;
        if (ev.type === "message_start") {
          s.msgId = ev.message.id;
          s.blockIndex = 0;
          this.ensureMessage(s, ev.message.id, ev.message.model);
        } else if (ev.type === "content_block_start" && s.msgId) {
          s.blockIndex = ev.index;
          const partId = `${s.msgId}:${ev.index}`;
          const b = ev.content_block as Json;
          if (b.type === "text") this.part(sid, s.msgId, { type: "text", id: partId, text: b.text ?? "" });
          else if (b.type === "tool_use") {
            s.tools.set(b.id, { messageId: s.msgId, partId, tool: b.name });
            this.part(sid, s.msgId, { type: "tool", id: partId, tool: b.name, status: "pending" });
          }
        } else if (ev.type === "content_block_delta" && s.msgId) {
          const partId = `${s.msgId}:${ev.index}`;
          const dl = ev.delta as Json;
          if (dl.type === "text_delta") this.sink?.delta(sid, { messageId: s.msgId, partId, field: "text", delta: dl.text });
          else if (dl.type === "thinking_delta" && dl.thinking) {
            if (!s.reasoningShown.has(partId)) {
              s.reasoningShown.add(partId);
              this.part(sid, s.msgId, { type: "reasoning", id: partId, text: "" });
            }
            this.sink?.delta(sid, { messageId: s.msgId, partId, field: "text", delta: dl.thinking });
          }
        }
        break;
      }
      case "assistant": {
        const msg = j.message as Json;
        // нет входа или ключ не подошёл: CLI присылает это репликой «Not logged in · Please run /login» — показываем ошибкой
        if (j.error === "authentication_failed") {
          s.authFailed = true;
          this.authCache = undefined;
          break;
        }
        this.ensureMessage(s, msg.id, msg.model);
        for (const b of (msg.content ?? []) as Json[]) {
          if (b.type === "tool_use") {
            const t: { messageId: string; partId: string; tool: string; input?: unknown } =
              s.tools.get(b.id) ?? { messageId: msg.id, partId: `${msg.id}:${b.id}`, tool: b.name };
            t.input = b.input;
            s.tools.set(b.id, t);
            this.part(sid, t.messageId, { type: "tool", id: t.partId, tool: b.name, status: "running", title: toolTitle(b.name, b.input), input: b.input });
          } else if (b.type === "text") {
            this.part(sid, msg.id, { type: "text", id: `${msg.id}:${s.msgId === msg.id ? s.blockIndex : 0}`, text: b.text ?? "" });
          } else if (b.type === "thinking" && b.thinking) {
            const partId = `${msg.id}:${s.msgId === msg.id ? s.blockIndex : 0}`;
            s.reasoningShown.add(partId);
            this.part(sid, msg.id, { type: "reasoning", id: partId, text: b.thinking });
          }
        }
        break;
      }
      case "user": {
        const content = j.message?.content;
        // после сжатия CLI присылает пересказ разговора репликой пользователя — показываем его свёрнутым сообщением
        if (s.awaitSummary && typeof content === "string" && /continued from a previous conversation/.test(content)) {
          s.awaitSummary = false;
          const id = `summary:${j.uuid ?? randomUUID()}`;
          this.sink?.event(sid, { type: "message.upserted", message: { id, role: "assistant", createdAt: Date.now(), summary: true } });
          this.part(sid, id, { type: "text", id: `${id}:t`, text: compactSummary(content) });
          break;
        }
        if (!Array.isArray(content)) break;
        for (const b of content as Json[]) {
          if (b.type !== "tool_result") continue;
          const t = s.tools.get(b.tool_use_id);
          if (!t) continue;
          const out = resultText(b.content);
          this.part(sid, t.messageId, {
            type: "tool",
            id: t.partId,
            tool: t.tool,
            status: b.is_error ? "error" : "completed",
            title: toolTitle(t.tool, t.input),
            ...(t.input !== undefined ? { input: t.input } : {}),
            ...(b.is_error ? { error: out } : { output: out }),
          });
        }
        break;
      }
      case "rate_limit_event": {
        const l = parseLimits(j.rate_limit_info);
        if (l) this.sink?.limits?.(l);
        break;
      }
      case "system":
        if (j.subtype === "api_retry") this.sink?.event(sid, { type: "session.updated", patch: { status: "retry" } });
        // контекст сжат: /compact или сам CLI, когда кончалось место
        if (j.subtype === "compact_boundary") {
          const meta = (j.compact_metadata ?? {}) as Json;
          const id = `compact:${j.uuid ?? randomUUID()}`;
          this.sink?.event(sid, { type: "message.upserted", message: { id, role: "assistant", createdAt: Date.now() } });
          this.part(sid, id, {
            type: "compaction",
            id: `${id}:c`,
            trigger: meta.trigger === "auto" ? "auto" : "manual",
            ...(typeof meta.pre_tokens === "number" ? { preTokens: meta.pre_tokens } : {}),
            ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
          });
          s.awaitSummary = true;
        }
        if (j.subtype === "init" && Array.isArray(j.skills)) this.lastSkills = j.skills.filter((x: unknown) => typeof x === "string");
        if (j.subtype === "init") this.opts.onMcpStatus?.(j.mcp_servers);
        // форк создан — дальше обычный --resume своего id
        if (j.subtype === "init" && s.forkFrom && j.session_id === s.id) {
          s.forkFrom = undefined;
          this.saveForks();
        }
        break;
      case "result": {
        if (s.abortTimer) clearTimeout(s.abortTimer);
        if (s.authFailed) {
          s.authFailed = false;
          this.sink?.event(sid, {
            type: "error",
            message: L(
              "Claude Code: вход не выполнен или API-ключ не подошёл. Войди в Настройках → Движки → Claude Code.",
              "Claude Code: not signed in, or the API key didn't work. Sign in at Settings → Engines → Claude Code.",
            ),
          });
        } else if (j.is_error || (j.subtype && j.subtype !== "success")) {
          const msg = typeof j.result === "string" && j.result ? j.result : Array.isArray(j.errors) ? j.errors.join("; ") : String(j.subtype);
          this.sink?.event(sid, { type: "error", message: msg });
        }
        this.usageOf(s, j);
        s.busy = false;
        this.sink?.event(sid, { type: "session.updated", patch: { status: "idle" } });
        const idle = this.opts.idleKillMs ?? 20 * 60_000;
        if (idle > 0) {
          if (s.idleTimer) clearTimeout(s.idleTimer);
          s.idleTimer = setTimeout(() => {
            if (!s.busy) {
              this.log(`${L("гашу простаивающий процесс", "stopping idle process")} ${s.id.slice(0, 8)}`);
              this.killProc(s);
            }
          }, idle);
        }
        break;
      }
    }
  }
}
