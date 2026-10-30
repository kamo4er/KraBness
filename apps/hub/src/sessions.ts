// Сессии хаба: связывают сессию движка с журналом событий и подписчиками.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClaudeLimits,
  ClaudeTranscript,
  CreateSessionRequest,
  EngineId,
  EngineInfo,
  ModelRef,
  Part,
  PartDelta,
  PermissionMode,
  PermissionReply,
  QuestionAnswers,
  SessionEvent,
  SlashCommand,
  SessionInfo,
  StoredEvent,
  SessionGroup,
  WorktreeInfo,
  WorktreeStatus,
  UsageTotals,
} from "@kamharn/protocol";
import { publicSession, type Db, type SessionRow } from "./db.ts";
import type { Engine, PromptFile } from "./engines/types.ts";
import type { ConfigStore } from "./config.ts";
import { FILE_MARKER, type FileStore } from "./files.ts";
import { findTranscript, listTranscripts, transcriptHistory } from "./engines/claude-transcript.ts";
import { claudeCommands } from "./commands.ts";
import { handoffPrompt, reviewPrompt, sessionDigest } from "./handoff.ts";
import { gitInfo } from "./project.ts";
import { createWorktree, discardWorktree, GitError, mergeWorktree, removeWorktree, worktreeStatus } from "./worktree.ts";
import { dayOf, emptyTotals, totalsOf, type UsageRecord } from "./usage.ts";
import { L } from "./lang.ts";

/** Что клиенты KraBness умеют показывать — агенту, чтобы пользовался (на языке хаба, как и прочие промпты агенту). */
export const artifactsHint = (): string =>
  L(
    "Клиент KraBness показывает пользователю блок ```html с целой страницей как живую карточку прямо в чате — так можно показать 3D (three.js с CDN), графики, интерактивные демо. Пиши такую страницу самодостаточной, одним блоком. Диаграммы — блоком ```mermaid.",
    "The KraBness client shows a ```html block with a whole page to the user as a live card right in the chat: use it for 3D (three.js from a CDN), charts, interactive demos. Make such a page self-contained, in one block. Diagrams: a ```mermaid block.",
  );

type GroupPatch = { name?: string; icon?: string; prompt?: string; noUserRules?: boolean };

export interface HubEvents {
  limits: [ClaudeLimits];
  usage: [string];
  session: [SessionInfo];
  "session.deleted": [string];
  event: [StoredEvent];
  delta: [string, PartDelta];
  groups: [SessionGroup[]];
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class SessionManager extends EventEmitter<HubEvents> {
  private engines = new Map<EngineId, Engine>();
  /** движки, которые не запустились, и почему */
  private failedEngines = new Map<EngineId, string>();
  private byEngineSession = new Map<string, string>();
  /** части, которые ещё стримятся: sessionId → partId → {messageId, part} */
  private liveParts = new Map<string, Map<string, { messageId: string; part: Part }>>();
  /** requestId → deviceId, ответивший на запрос разрешения */
  private answeredBy = new Map<string, string>();

  /** когда карточка сессии последний раз уходила в общий список */
  private listBroadcastAt = new Map<string, number>();

  /** fileId уже показанных исходящих файлов (чтобы повторный upsert tool-части не дублировал файл) */
  private shownFiles = new Set<string>();
  /** сообщения хаба (автопроверка), для которых message.upserted уже отправлен */
  private hubMessages = new Set<string>();

  private claudeProjectsDir: string;
  private lastLimits?: ClaudeLimits;

  constructor(private db: Db, private config: ConfigStore, private files: FileStore, opts: { claudeProjectsDir?: string } = {}) {
    super();
    this.claudeProjectsDir = opts.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
    this.setMaxListeners(0);
  }

  /** Рабочая папка сессии по id сессии движка (для MCP-инструментов). */
  directoryOf(engine: EngineId, engineSessionId: string): string | undefined {
    const id = this.byEngineSession.get(key(engine, engineSessionId));
    return id ? this.db.getSession(id)?.directory : undefined;
  }

  async addEngine(engine: Engine): Promise<void> {
    try {
      await engine.start({
        event: (esid, ev) => this.onEngineEvent(engine.id, esid, ev),
        delta: (esid, d) => this.onEngineDelta(engine.id, esid, d),
        limits: (l) => this.setLimits(l),
        usage: (esid, u) => this.onEngineUsage(engine.id, esid, u),
      });
    } catch (e) {
      // в «Движках» и «Новой сессии» он виден с причиной (например, «не установлен: как поставить»), а не пропадает
      this.failedEngines.set(engine.id, (e as Error).message);
      throw e;
    }
    this.failedEngines.delete(engine.id);
    this.engines.set(engine.id, engine);
    for (const s of this.db.listSessions()) {
      if (s.engine !== engine.id) continue;
      this.byEngineSession.set(key(engine.id, s.engineSessionId), s.id);
      engine.attach(s.engineSessionId, { directory: s.directory, model: s.model, permissionMode: s.permissionMode, hasHistory: s.lastSeq > 0 });
      // после рестарта хаба сессия точно не «busy»
      if (s.status === "busy" || s.status === "retry") this.append(s.id, { type: "session.updated", patch: { status: "idle" } });
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.engines.values()].map((e) => e.stop().catch(() => {})));
  }

  async enginesInfo(): Promise<EngineInfo[]> {
    const ok = await Promise.all([...this.engines.values()].map((e) => e.info()));
    const failed: EngineInfo[] = [...this.failedEngines].filter(([id]) => !this.engines.has(id)).map(([id, error]) => ({ id, available: false, error, models: [] }));
    return [...ok, ...failed];
  }

  private engine(id: EngineId): Engine {
    const e = this.engines.get(id);
    if (!e) throw new HttpError(400, L(`Движок ${id} не запущен`, `Engine ${id} is not running`));
    return e;
  }

  list(): SessionInfo[] {
    return this.db.listSessions().map(publicSession);
  }

  get(id: string): SessionRow {
    const s = this.db.getSession(id);
    if (!s) throw new HttpError(404, L(`Нет сессии ${id}`, `No session ${id}`));
    return s;
  }

  async create(req: CreateSessionRequest): Promise<SessionInfo> {
    let directory: string;
    try {
      directory = this.config.resolveAllowed(req.directory);
    } catch (e) {
      throw new HttpError(403, (e as Error).message);
    }
    const engine = this.engine(req.engine);
    const einfo = req.engine === "claude" || !req.model ? await engine.info() : undefined;
    // Claude Code стоит, но вход не выполнен — сразу понятная ошибка, а не «Not logged in» в чате
    if (einfo?.auth?.installed && !einfo.auth.loggedIn) throw new HttpError(409, einfo.error ?? L("Claude Code: вход не выполнен", "Claude Code: not signed in"));
    let model = req.model;
    if (!model && einfo) model = einfo.defaultModel ?? (einfo.models[0] ? { providerId: einfo.models[0].providerId, modelId: einfo.models[0].modelId } : undefined);
    if (!model) throw new HttpError(400, L(`У движка ${req.engine} нет доступных моделей`, `Engine ${req.engine} has no available models`));
    const permissionMode = req.permissionMode ?? "acceptEdits";
    const id = "ks_" + randomUUID().replace(/-/g, "").slice(0, 20);
    // отдельная ветка: агент работает в копии проекта рядом с ним
    let worktree: WorktreeInfo | undefined;
    if (req.worktree) {
      try {
        const w = await createWorktree(directory, req.title ?? "session", id);
        worktree = w.worktree;
        directory = this.config.resolveAllowed(w.directory);
      } catch (e) {
        if (worktree) await removeWorktree(worktree);
        throw new HttpError(e instanceof GitError ? 409 : 403, (e as Error).message);
      }
    }
    let engineSessionId: string;
    try {
      // шаг задачи в копии проекта: наружу (в основную папку и дальше) агент не ходит и не спрашивает об этом
      engineSessionId = await engine.createSession({ directory, model, permissionMode, title: req.title, ...(req.taskId && worktree ? { confined: true } : {}) });
    } catch (e) {
      if (worktree) await removeWorktree(worktree);
      throw e;
    }
    const now = Date.now();
    const row: SessionRow = {
      id,
      engine: req.engine,
      engineSessionId,
      directory,
      title: req.title ?? L("Новая сессия", "New session"),
      model,
      permissionMode,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      ...(worktree ? { worktree } : {}),
      ...(req.groupId && this.db.getGroup(req.groupId) ? { groupId: req.groupId } : {}),
      ...(req.taskId ? { taskId: req.taskId } : {}),
      ...(cleanEffort(req.effort) ? { effort: cleanEffort(req.effort) } : {}),
    };
    this.db.insertSession(row);
    this.byEngineSession.set(key(req.engine, engineSessionId), row.id);
    const info = publicSession(row);
    this.emit("session", info);
    return info;
  }

  async prompt(id: string, text: string, fileIds: string[] = []): Promise<void> {
    const s = this.get(id);
    const files: PromptFile[] = fileIds.map((fid) => {
      const f = this.files.get(fid);
      if (!f || f.sessionId !== id || f.direction !== "in") throw new HttpError(400, L(`Нет вложения ${fid} в этой сессии`, `No attachment ${fid} in this session`));
      return { fileId: f.id, path: f.path, name: f.name, mime: f.mime, size: f.size };
    });
    if (!text.trim() && !files.length) throw new HttpError(400, L("Пустое сообщение", "Empty message"));
    await this.engine(s.engine).prompt(s.engineSessionId, { text, files, model: s.model, ...this.launchOpts(s) });
  }

  /** Что задаётся движку при запуске процесса: промпт и правила группы, уровень рассуждений. Всё — со следующего сообщения. */
  private launchOpts(s: SessionInfo): { system?: string; effort?: string; noUserRules?: boolean } {
    const g = s.groupId ? this.db.getGroup(s.groupId) : undefined;
    // подсказка про то, что клиенты умеют показывать, — перед промптом группы
    const system = [this.config.config.artifactsHint === false ? "" : artifactsHint(), g?.prompt ?? ""].filter(Boolean).join("\n\n");
    return { ...(system ? { system } : {}), ...(g?.noUserRules ? { noUserRules: true } : {}), ...(s.effort ? { effort: s.effort } : {}) };
  }

  /** Сжать контекст агента: история заменяется пересказом, в ленте появляется отметка «контекст сжат». */
  async compact(id: string): Promise<void> {
    const s = this.get(id);
    const engine = this.engine(s.engine);
    if (!engine.compact) throw new HttpError(400, L("Этот движок не умеет сжимать контекст", "This engine can't compact the context"));
    if (s.status === "busy" || s.status === "retry") throw new HttpError(409, L("Агент ещё работает — дождись или останови его", "The agent is still working — wait or stop it"));
    // всё, с чем запущен процесс: иначе claude решил бы, что оно сменилось, и перезапустился без него
    await engine.compact(s.engineSessionId, { model: s.model, ...this.launchOpts(s) });
  }

  /** Переименование, смена модели (со следующего сообщения) и режима подтверждений (сразу). */
  async update(id: string, patch: { title?: string; model?: ModelRef; permissionMode?: PermissionMode; resumeAt?: number; groupId?: string | null; autoCheck?: boolean; effort?: string }): Promise<SessionInfo> {
    const s = this.get(id);
    const p: Partial<Pick<SessionInfo, "title" | "model" | "permissionMode" | "resumeAt" | "groupId" | "autoCheck" | "effort">> = {};
    if (typeof patch.autoCheck === "boolean" && patch.autoCheck !== !!s.autoCheck) p.autoCheck = patch.autoCheck;
    // перенос в группу ("" или null — без группы)
    if (patch.groupId !== undefined) {
      const g = patch.groupId || "";
      if (g && !this.db.getGroup(g)) throw new HttpError(404, L("Нет такой группы", "No such group"));
      if (g !== (s.groupId ?? "")) p.groupId = g;
    }
    // из API — только отмена автопродолжения; назначает его хаб сам (autoresume.ts)
    if (patch.resumeAt === 0 && s.resumeAt) p.resumeAt = 0;
    if (typeof patch.title === "string" && patch.title.trim()) p.title = patch.title.trim().slice(0, 200);
    if (patch.model?.providerId && patch.model.modelId) p.model = { providerId: patch.model.providerId, modelId: patch.model.modelId };
    // уровень рассуждений: "" — по умолчанию модели. У другой модели свой набор уровней — при смене модели сбрасываем, если новый не задан
    const modelChanged = !!p.model && (p.model.providerId !== s.model.providerId || p.model.modelId !== s.model.modelId);
    const effort = patch.effort !== undefined ? cleanEffort(patch.effort) : modelChanged ? "" : undefined;
    if (effort !== undefined && effort !== (s.effort ?? "")) p.effort = effort;
    if (patch.permissionMode !== undefined) {
      if (!PERMISSION_MODES.includes(patch.permissionMode)) throw new HttpError(400, L(`Неизвестный режим ${patch.permissionMode}`, `Unknown mode ${patch.permissionMode}`));
      if (patch.permissionMode !== s.permissionMode) {
        await this.engine(s.engine).setPermissionMode(s.engineSessionId, patch.permissionMode);
        p.permissionMode = patch.permissionMode;
      }
    }
    if (Object.keys(p).length) this.append(id, { type: "session.updated", patch: p });
    return publicSession(this.get(id));
  }

  /** Запись самого хаба в ленту сессии (автопроверка): сообщение создаётся при первой части, повторная часть с тем же id — обновление. */
  hubPart(sessionId: string, messageId: string, part: Part, createdAt = Date.now()): void {
    this.get(sessionId);
    if (!this.hubMessages.has(messageId)) {
      this.hubMessages.add(messageId);
      this.append(sessionId, { type: "message.upserted", message: { id: messageId, role: "assistant", createdAt } });
    }
    this.append(sessionId, { type: "part.upserted", messageId, part });
  }

/** Расход токенов от движка: запись в базу и сигнал клиентам (итог сессии). */
  private onEngineUsage(engine: EngineId, esid: string, u: UsageRecord): void {
    const id = this.byEngineSession.get(key(engine, esid));
    if (!id) return;
    const ts = u.ts ?? Date.now();
    this.db.putUsage({ ...u, sessionId: id, engine, ts, day: dayOf(ts) });
    this.emit("usage", id);
  }

  /** Итоги расхода: по одной сессии или по всем. */
  usageTotals(): Record<string, UsageTotals> {
    return Object.fromEntries(this.db.usageBySession().map((r) => [String(r.session_id), totalsOf(r)]));
  }

  sessionUsage(id: string): UsageTotals {
    const r = this.db.usageBySession(id)[0];
    return r ? totalsOf(r) : emptyTotals();
  }

  /** где лежат транскрипты Claude Code */
  get projectsDir(): string {
    return this.claudeProjectsDir;
  }

  /** id сессии в движке (для расхода задним числом). */
  engineSessionIdOf(id: string): string | undefined {
    return this.db.getSession(id)?.engineSessionId;
  }

  /** Автопродолжение после лимита: когда сессия сама продолжит (0 — не ждёт). */
  setResumeAt(id: string, at: number): void {
    if ((this.get(id).resumeAt ?? 0) === at) return;
    this.append(id, { type: "session.updated", patch: { resumeAt: at } });
  }

  async abort(id: string): Promise<void> {
    const s = this.get(id);
    await this.engine(s.engine).abort(s.engineSessionId);
  }

  async replyPermission(id: string, requestId: string, reply: PermissionReply, by?: string): Promise<void> {
    const s = this.get(id);
    // движок сам пришлёт resolved; запоминаем заранее, кто ответил (SSE может обогнать HTTP-ответ)
    if (by) this.answeredBy.set(requestId, by);
    try {
      await this.engine(s.engine).replyPermission(s.engineSessionId, requestId, reply);
    } catch (e) {
      this.answeredBy.delete(requestId);
      throw e;
    }
  }

  /** Меню «/» для сессии: скиллы и команды Claude (для opencode пока пусто). */
  commands(id: string): SlashCommand[] {
    const s = this.get(id);
    if (s.engine !== "claude") return [];
    return claudeCommands(s.directory, homedir(), this.engines.get("claude")?.slashSkills?.() ?? []);
  }

  // ---------- экономия лимитов: работа на бесплатной модели ----------

  /** Продолжить сессию в opencode: новая сессия в той же папке, первым сообщением — выжимка. model — какой моделью (иначе по умолчанию). */
  async handoff(id: string, model?: ModelRef): Promise<SessionInfo> {
    const s = this.get(id);
    const digest = sessionDigest(publicSession(s), this.db.eventsAfter(id, 0));
    // работу продолжают в той же папке: пусть Claude не просыпается после лимита и не правит те же файлы
    if (s.resumeAt) this.setResumeAt(id, 0);
    const ns = await this.create({ engine: "opencode", directory: s.directory, permissionMode: s.permissionMode, title: `→ ${s.title}`.slice(0, 200), ...(model ? { model } : {}), ...(s.groupId ? { groupId: s.groupId } : {}) });
    await this.prompt(ns.id, handoffPrompt(digest));
    return ns;
  }

  /** Ревью незакоммиченных изменений папки сессии бесплатной моделью (дифф — прямо в промпте). */
  async review(id: string, model?: ModelRef): Promise<SessionInfo> {
    const s = this.get(id);
    const g = await gitInfo(s.directory, 60_000);
    if (!g.repo) throw new HttpError(400, L("Папка сессии не в git-репозитории", "The session folder is not in a git repository"));
    if (!g.diff.trim()) throw new HttpError(400, g.files.length ? L("Изменены только новые файлы (их нет в git diff) — сначала git add", "Only new files changed (they aren't in git diff) — git add them first") : L("Незакоммиченных изменений нет", "No uncommitted changes"));
    const ns = await this.create({ engine: "opencode", directory: s.directory, permissionMode: "manual", title: L(`Ревью: ${s.title}`, `Review: ${s.title}`).slice(0, 200), ...(model ? { model } : {}), ...(s.groupId ? { groupId: s.groupId } : {}) });
    await this.prompt(ns.id, reviewPrompt(g.diff, g.files, g.truncated));
    return ns;
  }

  // ---------- MCP-серверы пользователя в сессиях Claude ----------

  /** Включены ли MCP из настроек Claude и какие они (имена из ~/.claude.json). */
  claudeMcp(): { enabled: boolean; servers: string[] } {
    let servers: string[] = [];
    try {
      const j = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
      servers = Object.keys(j.mcpServers ?? {});
    } catch {
      /* нет файла */
    }
    return { enabled: this.config.config.engines.claude.userMcp ?? false, servers };
  }

  setClaudeMcp(enabled: boolean): { enabled: boolean; servers: string[] } {
    this.config.setClaudeUserMcp(enabled);
    this.engines.get("claude")?.restartIdle?.();
    return this.claudeMcp();
  }

  // ---------- лимиты подписки Claude ----------

  private get limitsFile(): string {
    return join(this.config.config.dataDir, "claude-limits.json");
  }

  /** Последние известные лимиты (переживают рестарт хаба). */
  get limits(): ClaudeLimits | undefined {
    if (this.lastLimits) return this.lastLimits;
    try {
      return (this.lastLimits = JSON.parse(readFileSync(this.limitsFile, "utf8")) as ClaudeLimits);
    } catch {
      return undefined;
    }
  }

  private setLimits(l: ClaudeLimits): void {
    this.lastLimits = l;
    try {
      mkdirSync(this.config.config.dataDir, { recursive: true });
      writeFileSync(this.limitsFile, JSON.stringify(l));
    } catch {
      /* не критично */
    }
    this.emit("limits", l);
  }

  // ---------- импорт сессий Claude Code ----------

  private allowedDir = (cwd: string): string | undefined => {
    try {
      return this.config.resolveAllowed(cwd);
    } catch {
      return undefined;
    }
  };

  /** импортированные сессии Claude Code: id сессии KamHarn → id исходного транскрипта */
  private get importsFile(): string {
    return join(this.config.config.dataDir, "claude-imports.json");
  }

  private imports(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.importsFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private saveImports(m: Record<string, string>): void {
    mkdirSync(this.config.config.dataDir, { recursive: true });
    writeFileSync(this.importsFile, JSON.stringify(m, null, 1));
  }

  /** скрытые из списка сессии Claude Code (сами файлы Claude не трогаем — в VS Code они остаются) */
  private get hiddenFile(): string {
    return join(this.config.config.dataDir, "claude-hidden.json");
  }

  private hiddenTranscripts(): Set<string> {
    try {
      return new Set(JSON.parse(readFileSync(this.hiddenFile, "utf8")) as string[]);
    } catch {
      return new Set();
    }
  }

  /** Скрыть сессию Claude Code из списка «продолжить» или вернуть её. */
  hideTranscript(id: string, hidden: boolean): void {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, L("Неверный id сессии", "Invalid session id"));
    const h = this.hiddenTranscripts();
    if (hidden) h.add(id);
    else h.delete(id);
    mkdirSync(this.config.config.dataDir, { recursive: true });
    writeFileSync(this.hiddenFile, JSON.stringify([...h]));
  }

  /** Сессии Claude Code из разрешённых папок, которых ещё нет в KamHarn (ни своих, ни импортированных); hidden — только скрытые. */
  claudeTranscripts(hidden = false): ClaudeTranscript[] {
    const known = new Set(this.db.listSessions().filter((s) => s.engine === "claude").map((s) => s.engineSessionId));
    for (const [sid, tid] of Object.entries(this.imports())) if (this.db.getSession(sid)) known.add(tid);
    const h = this.hiddenTranscripts();
    if (hidden) return h.size ? listTranscripts(this.claudeProjectsDir, this.allowedDir, known, 200, h) : [];
    for (const id of h) known.add(id);
    return listTranscripts(this.claudeProjectsDir, this.allowedDir, known);
  }

  /** Продолжить сессию Claude Code в KamHarn: история переносится в журнал, движок работает с копией (форк). */
  async importClaude(transcriptId: string): Promise<SessionInfo> {
    const t = findTranscript(this.claudeProjectsDir, transcriptId);
    if (!t) throw new HttpError(404, L(`Нет сессии Claude Code ${transcriptId}`, `No Claude Code session ${transcriptId}`));
    const imports = this.imports();
    const existing = Object.entries(imports).find(([sid, tid]) => tid === transcriptId && this.db.getSession(sid));
    if (existing) throw new HttpError(409, L(`Эта сессия уже открыта в KraBness: «${this.db.getSession(existing[0])!.title}»`, `This session is already open in KraBness: “${this.db.getSession(existing[0])!.title}”`));
    const directory = t.cwd && this.allowedDir(t.cwd);
    if (!directory) throw new HttpError(403, `${L("Папка сессии вне разрешённых", "The session folder is outside the allowed ones")}: ${t.cwd ?? L("неизвестна", "unknown")}`);
    const engine = this.engine("claude");
    const hist = transcriptHistory(t.path);
    const info = await engine.info();
    const model = hist.model ? { providerId: "anthropic", modelId: hist.model } : (info.defaultModel ?? { providerId: "anthropic", modelId: "claude-opus-5-5" });
    const permissionMode: PermissionMode = "acceptEdits";
    const engineSessionId = await engine.createSession({ directory, model, permissionMode, forkFrom: transcriptId });
    const now = Date.now();
    const row: SessionRow = {
      id: "ks_" + randomUUID().replace(/-/g, "").slice(0, 20),
      engine: "claude",
      engineSessionId,
      directory,
      title: "↪ " + (t.title ?? L("Сессия Claude Code", "Claude Code session")).replace(/\s+/g, " ").slice(0, 80),
      model,
      permissionMode,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
    this.db.insertSession(row);
    this.byEngineSession.set(key("claude", engineSessionId), row.id);
    this.saveImports({ ...imports, [row.id]: transcriptId });
    if (hist.skipped) {
      const first = hist.events.find((e) => e.type === "message.upserted");
      const at = first?.type === "message.upserted" ? first.message.createdAt - 1 : now;
      this.append(row.id, { type: "message.upserted", message: { id: "import_note", role: "assistant", createdAt: at } });
      this.append(row.id, { type: "part.upserted", messageId: "import_note", part: { type: "text", id: "import_note:t", text: L(`_Ранние сообщения (${hist.skipped}) не перенесены — показаны последние._`, `_Earlier messages (${hist.skipped}) were not carried over — showing the latest._`) } });
    }
    for (const ev of hist.events) this.append(row.id, ev);
    const s = publicSession(this.get(row.id));
    this.emit("session", s);
    return s;
  }

  async replyQuestion(id: string, requestId: string, answers: QuestionAnswers, by?: string): Promise<void> {
    const s = this.get(id);
    if (answers !== null && !(Array.isArray(answers) && answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string")))) {
      throw new HttpError(400, L("answers: массив ответов по вопросам (массивы строк) или null", "answers: an array of answers per question (string arrays) or null"));
    }
    if (by) this.answeredBy.set(requestId, by);
    try {
      await this.engine(s.engine).replyQuestion(s.engineSessionId, requestId, answers);
    } catch (e) {
      this.answeredBy.delete(requestId);
      throw e;
    }
  }

  delete(id: string): void {
    const s = this.get(id);
    this.engines.get(s.engine)?.forget(s.engineSessionId);
    this.db.deleteSession(id);
    this.byEngineSession.delete(key(s.engine, s.engineSessionId));
    this.liveParts.delete(id);
    this.listBroadcastAt.delete(id);
    const imports = this.imports();
    if (imports[id]) {
      delete imports[id];
      this.saveImports(imports);
    }
    this.emit("session.deleted", id);
    // копию удаляем чуть позже: процесс агента только что погашен и может ещё держать папку
    const wt = s.worktree;
    if (wt) setTimeout(() => void removeWorktree(wt), 3000);
  }

  // ---------- отдельная ветка сессии ----------

  // ---------- группы сессий ----------

  groups(): SessionGroup[] {
    return this.db.listGroups();
  }

  private cleanGroup(patch: GroupPatch): GroupPatch {
    const out: GroupPatch = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim().slice(0, 60);
      if (!name) throw new HttpError(400, L("Пустое название группы", "Empty group name"));
      out.name = name;
    }
    if (patch.icon !== undefined) out.icon = [...String(patch.icon).trim()].slice(0, 4).join("");
    // промпт уходит в командную строку claude — ограничиваем разумно
    if (patch.prompt !== undefined) out.prompt = String(patch.prompt).trim().slice(0, 8000);
    if (patch.noUserRules !== undefined) out.noUserRules = patch.noUserRules === true;
    return out;
  }

  createGroup(patch: GroupPatch & { name: string }): SessionGroup {
    const c = this.cleanGroup(patch);
    if (!c.name) throw new HttpError(400, L("Пустое название группы", "Empty group name"));
    const sort = Math.max(0, ...this.db.listGroups().map((g) => g.sort)) + 1;
    const g: SessionGroup = { id: "g_" + randomUUID().replace(/-/g, "").slice(0, 12), name: c.name, sort, ...(c.icon ? { icon: c.icon } : {}), ...(c.prompt ? { prompt: c.prompt } : {}), ...(c.noUserRules ? { noUserRules: true } : {}) };
    this.db.saveGroup(g);
    this.emit("groups", this.groups());
    return g;
  }

  updateGroup(id: string, patch: GroupPatch & { sort?: number }): SessionGroup {
    const g = this.db.getGroup(id);
    if (!g) throw new HttpError(404, L("Нет такой группы", "No such group"));
    const c = this.cleanGroup(patch);
    const next: SessionGroup = { ...g, ...(c.name ? { name: c.name } : {}), sort: Number.isFinite(patch.sort) ? Number(patch.sort) : g.sort };
    if (c.icon !== undefined) next.icon = c.icon || undefined;
    if (c.prompt !== undefined) next.prompt = c.prompt || undefined;
    if (c.noUserRules !== undefined) next.noUserRules = c.noUserRules || undefined;
    this.db.saveGroup(next);
    this.emit("groups", this.groups());
    return next;
  }

  deleteGroup(id: string): void {
    if (!this.db.getGroup(id)) throw new HttpError(404, L("Нет такой группы", "No such group"));
    // сессии остаются, просто без группы — клиенты узнают через событие сессии
    for (const sid of this.db.deleteGroup(id)) this.append(sid, { type: "session.updated", patch: { groupId: "" } });
    this.emit("groups", this.groups());
  }

  private worktreeOf(id: string, idle = false): { s: SessionRow; wt: WorktreeInfo } {
    const s = this.get(id);
    if (!s.worktree) throw new HttpError(400, L("Сессия работает не в отдельной ветке", "The session doesn't run in a separate branch"));
    if (idle && (s.status === "busy" || s.status === "retry")) throw new HttpError(409, L("Агент ещё работает — дождись или останови его", "The agent is still working — wait or stop it"));
    return { s, wt: s.worktree };
  }

  async worktreeStatus(id: string): Promise<WorktreeStatus> {
    try {
      return await worktreeStatus(this.worktreeOf(id).wt);
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(409, (e as Error).message);
    }
  }

  async mergeWorktree(id: string): Promise<{ commit: string; files: number }> {
    const { s, wt } = this.worktreeOf(id, true);
    try {
      return await mergeWorktree(wt, s.title);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  async discardWorktree(id: string): Promise<void> {
    const { wt } = this.worktreeOf(id, true);
    try {
      await discardWorktree(wt);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  }

  eventsAfter(id: string, after: number): StoredEvent[] {
    this.get(id);
    return this.db.eventsAfter(id, after);
  }

  /** Текущее состояние стримящихся частей (для снапшота подписчику). */
  liveSnapshot(id: string): Array<{ messageId: string; part: Part }> {
    return [...(this.liveParts.get(id)?.values() ?? [])].map((x) => ({ messageId: x.messageId, part: { ...x.part } }));
  }

  private append(sessionId: string, event: SessionEvent): StoredEvent {
    const stored = this.db.appendEvent(sessionId, event);
    if (event.type === "session.updated") this.db.updateSession(sessionId, event.patch);
    this.emit("event", stored);
    // карточку в общем списке (время, порядок) обновляем и во время работы, но не на каждую часть
    const last = this.listBroadcastAt.get(sessionId) ?? 0;
    if (event.type === "session.updated" || stored.ts - last >= SESSION_LIST_THROTTLE_MS) {
      this.listBroadcastAt.set(sessionId, stored.ts);
      const s = this.db.getSession(sessionId);
      if (s) this.emit("session", publicSession(s));
    }
    return stored;
  }

  private onEngineEvent(engine: EngineId, engineSessionId: string, ev: SessionEvent): void {
    const id = this.byEngineSession.get(key(engine, engineSessionId));
    if (!id) return;
    if (ev.type === "part.upserted") this.trackLive(id, ev.messageId, ev.part);
    if (ev.type === "session.updated" && ev.patch.status === "idle") this.liveParts.delete(id);
    if (ev.type === "permission.resolved" || ev.type === "question.resolved") {
      const by = this.answeredBy.get(ev.id);
      this.answeredBy.delete(ev.id);
      if (by) ev = { ...ev, by };
    }
    this.append(id, ev);
    if (ev.type === "part.upserted") this.attachOutgoingFile(id, ev.messageId, ev.part);
  }

  /** Инструмент send_file_to_user вернул маркер файла — показываем файл частью того же сообщения. */
  private attachOutgoingFile(sessionId: string, messageId: string, part: Part): void {
    if (part.type !== "tool" || part.status !== "completed" || !/send_file_to_user$/.test(part.tool)) return;
    const m = new RegExp(`${FILE_MARKER}(kf_[a-z0-9]+)`).exec(part.output ?? "");
    if (!m || this.shownFiles.has(m[1]!)) return;
    const f = this.files.get(m[1]!);
    if (!f) return;
    this.shownFiles.add(f.id);
    this.append(sessionId, {
      type: "part.upserted",
      messageId,
      part: { type: "file", id: `${part.id}:file`, fileId: f.id, name: f.name, mime: f.mime, size: f.size },
    });
  }

  private onEngineDelta(engine: EngineId, engineSessionId: string, d: PartDelta): void {
    const id = this.byEngineSession.get(key(engine, engineSessionId));
    if (!id) return;
    const live = this.liveParts.get(id)?.get(d.partId);
    if (live && (live.part.type === "text" || live.part.type === "reasoning")) live.part.text += d.delta;
    else this.trackLive(id, d.messageId, { type: "text", id: d.partId, text: d.delta });
    this.emit("delta", id, d);
  }

  private trackLive(sessionId: string, messageId: string, part: Part): void {
    let m = this.liveParts.get(sessionId);
    if (!m) this.liveParts.set(sessionId, (m = new Map()));
    if (part.type === "text" || part.type === "reasoning") m.set(part.id, { messageId, part: { ...part } });
  }
}

const key = (engine: EngineId, esid: string) => `${engine}:${esid}`;
const PERMISSION_MODES: PermissionMode[] = ["manual", "acceptEdits", "auto"];
export const SESSION_LIST_THROTTLE_MS = 15_000;

/** Уровень рассуждений из запроса: короткое слово (low, high, xhigh…), иначе "" — по умолчанию модели. */
function cleanEffort(v: unknown): string {
  return typeof v === "string" && /^[a-z0-9_-]{1,20}$/i.test(v.trim()) ? v.trim() : "";
}
