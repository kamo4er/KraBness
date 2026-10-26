// Задачи: хаб сам ведёт работу от цели до отчёта. Шаги — обычные сессии, поэтому чат, подтверждения и файлы работают как всегда.
//   исполнитель (claude, своя копия проекта) → автопроверка → ревью другой моделью → правки по ревью (до MAX_REVIEWS кругов)
//   → отчёт и решение пользователя: «Влить» / «Ещё круг» / «Выбросить».
// Состояние задач лежит в SQLite, поэтому переживает рестарт хаба; после старта незавершённые задачи подхватываются.
import { randomUUID } from "node:crypto";
import type { CreateTaskRequest, EngineId, EngineInfo, ModelRef, StoredEvent, TaskAction, TaskInfo, TaskStep, TaskStepKind } from "@kamharn/protocol";
import type { Db } from "./db.ts";
import type { ConfigStore } from "./config.ts";
import type { SessionManager } from "./sessions.ts";
import type { AutoCheck, CheckSettled } from "./checks.ts";
import { HttpError } from "./sessions.ts";
import { isLimitError } from "./autoresume.ts";
import { git, GitError, hasLinkedDeps } from "./worktree.ts";
import { reviewPrompt } from "./handoff.ts";
import { L } from "./lang.ts";

/** сколько кругов ревью делаем сами, дальше — к пользователю */
export const MAX_REVIEWS = 2;
const DIFF_MAX = 60_000;
/** ревью без замечаний отвечает этим словом первой строкой */
// \b после кириллицы не работает: границу слова JS считает по латинице
const CLEAN = /^\s*(ЧИСТО|CLEAN)[\s.!,:]*$/im;

/** Название задачи из цели: первое предложение, если короткое, иначе обрезка по слову. */
export function taskTitle(goal: string, max = 80): string {
  const line = goal.trim().split("\n")[0]!.trim();
  const sentence = /^(.{15,}?[.!?])(\s|$)/.exec(line)?.[1];
  if (sentence && sentence.length <= max) return sentence.replace(/\.$/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(—–-]+$/, "") + "…";
}

export function workPrompt(goal: string, linkedDeps = false): string {
  return [
    L("Задача:", "Task:"),
    goal,
    "",
    L(
      "Ты работаешь в отдельной копии проекта (своя ветка): меняй файлы смело, в основную ветку ничего не попадёт, пока это не решит пользователь. Коммитить не нужно.",
      "You're working in a separate copy of the project (its own branch): change files freely, nothing reaches the main branch until the user decides so. No need to commit.",
    ),
    ...(linkedDeps
      ? [
          L(
            "Зависимости (node_modules) подключены ссылками из основного проекта — не переустанавливай и не удаляй их: это заденет основной проект.",
            "Dependencies (node_modules) are linked from the main project — don't reinstall or delete them: that would affect the main project.",
          ),
        ]
      : []),
    L(
      "Когда закончишь, последним сообщением коротко напиши, что сделал и что стоит проверить руками.",
      "When you're done, your last message should briefly say what you did and what is worth checking by hand.",
    ),
  ].join("\n");
}

export function fixPrompt(review: string): string {
  return [
    L("Ревью твоих изменений другой моделью. Разберись по существу:", "A review of your changes by another model. Address it on the merits:"),
    L("реальные проблемы — исправь; то, с чем не согласен, — не меняй, но объясни почему.", "fix the real problems; where you disagree, don't change the code but explain why."),
    "",
    "<review>",
    review,
    "</review>",
  ].join("\n");
}

export function morePrompt(comment: string, review?: string): string {
  return [L("Пользователь посмотрел результат и просит доработать:", "The user looked at the result and asks for more work:"), comment, ...unseenReview(review)].join("\n");
}

/** Последнее ревью, которое исполнитель ещё не видел: круги кончились, и хаб не отдал его на правки. */
function unseenReview(review?: string): string[] {
  if (!review) return [];
  return [
    "",
    L("Последнее ревью другой моделью — его ты ещё не видел:", "The latest review by another model — you haven't seen it yet:"),
    L("реальные проблемы — исправь; то, с чем не согласен, — не меняй, но объясни почему.", "fix the real problems; where you disagree, don't change the code but explain why."),
    "<review>",
    review,
    "</review>",
  ];
}

/** Продолжить упавшую задачу: работа в копии цела, агент сам видит, что успел. */
export function resumeTaskPrompt(error: string | undefined, comment: string, review?: string): string {
  return [
    L("Работа над задачей оборвалась", "Work on the task was interrupted") + (error ? ` (${error.slice(0, 500)})` : "") + ".",
    L(
      "Всё, что ты успел сделать, на месте в этой копии проекта. Посмотри `git status` и `git diff`, доделай задачу и проверь.",
      "Everything you managed to do is still in this copy of the project. Look at `git status` and `git diff`, finish the task and check it.",
    ),
    ...(comment ? [L("Пользователь добавил:", "The user added:"), comment] : []),
    ...unseenReview(review),
  ].join("\n");
}

/** К промпту ревью — как ответить, если замечаний нет (иначе не отличить «всё хорошо» от разбора). */
export function reviewTaskPrompt(goal: string, diff: string, files: Array<{ status: string; path: string }>, truncated: boolean): string {
  return [
    `${L("Задача, которую решал автор:", "The task the author was solving:")} ${goal}`,
    "",
    reviewPrompt(diff, files, truncated),
    "",
    L("Если замечаний нет — ответь первой строкой ровно: ЧИСТО", "If you have no remarks, make the first line exactly: CLEAN"),
  ].join("\n");
}

/** Последний текст ассистента в сессии (итог для отчёта). */
export function lastAssistantText(events: StoredEvent[]): string {
  const roles = new Map<string, "user" | "assistant">();
  const texts = new Map<string, { messageId: string; text: string; order: number }>();
  let order = 0;
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "message.upserted") roles.set(ev.message.id, ev.message.role);
    if (ev.type === "part.upserted" && ev.part.type === "text") {
      const prev = texts.get(ev.part.id);
      texts.set(ev.part.id, { messageId: ev.messageId, text: ev.part.text, order: prev?.order ?? order++ });
    }
  }
  const mine = [...texts.values()].filter((t) => roles.get(t.messageId) === "assistant").sort((a, b) => a.order - b.order);
  return mine.at(-1)?.text.trim() ?? "";
}

export interface OrchestratorDeps {
  sessions: SessionManager;
  db: Db;
  /** настройки хаба (сколько задач одновременно) */
  config?: ConfigStore;
  autoCheck?: AutoCheck;
  notify: (sessionId: string, message: string) => void;
  log?: (m: string) => void;
  /** тесты подставляют свои git-команды */
  git?: (cwd: string, args: string[]) => Promise<string>;
}

export class Orchestrator {
  private listeners = new Set<(tasks: TaskInfo[]) => void>();
  /** задачи, чей исполнитель сейчас работает (чтобы idle без busy не принять за конец хода) */
  private busy = new Set<string>();
  private offSettled?: () => void;
  private closed = false;
  /** таймеры отложенного запуска */
  private timers = new Map<string, NodeJS.Timeout>();
  /** задачи, закончившиеся с последней сводки */
  private done = new Set<string>();
  /** по задаче сейчас идёт действие (влить/выбросить/ещё круг): второе действие получает 409, иначе вливание и выброс идут параллельно */
  private acting = new Set<string>();

  constructor(private d: OrchestratorDeps) {
    d.sessions.on("event", (e) => this.onEvent(e));
    this.offSettled = d.autoCheck?.onSettled((e) => this.onChecks(e));
  }

  // ---------- наружу ----------

  onChange(cb: (tasks: TaskInfo[]) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  list(): TaskInfo[] {
    return this.d.db.listTasks();
  }

  get(id: string): TaskInfo {
    const t = this.d.db.getTask(id);
    if (!t) throw new HttpError(404, L("Нет такой задачи", "No such task"));
    return t;
  }

  async create(req: CreateTaskRequest): Promise<TaskInfo> {
    const goal = String(req.goal ?? "").trim();
    if (!goal) throw new HttpError(400, L("Опиши, что сделать", "Describe what to do"));
    if (goal.length > 20_000) throw new HttpError(400, L("Слишком длинное описание", "The description is too long"));
    const now = Date.now();
    const title = String(req.title ?? "").trim().slice(0, 80) || taskTitle(goal);
    const task: TaskInfo = {
      id: `tk_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title,
      goal,
      directory: req.directory,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      steps: [],
      reviews: 0,
      ...(req.startAt && req.startAt > now ? { startAt: req.startAt } : {}),
    };
    await this.pickEngines(task, req);
    // задача работает в отдельной ветке — без git она упала бы на старте; скажем сразу, в форме
    if (!(await git(req.directory, ["rev-parse", "--show-toplevel"]).then(() => true, () => false)))
      throw new HttpError(409, L("Папка не в git-репозитории: задаче нужна своя ветка. Выбери папку проекта с git.", "The folder isn't a git repository: a task needs its own branch. Pick a project folder with git."));
    this.save(task);
    // очередь: больше заданного числа задач одновременно не запускаем (каждая занимает агента и копию проекта)
    await this.pump();
    return this.get(task.id);
  }

/**
   * Кто делает и кто ревьюит. Ничего не зашито: у кого нет Claude — всё идёт на opencode.
   * По умолчанию исполнитель — Claude, если он подключён (сильнее в коде), иначе opencode;
   * ревьюер — opencode (бесплатные модели есть у всех), без него — движок исполнителя.
   * Модель — выбранная, иначе из настройки «Движки», иначе модель движка по умолчанию.
   */
  private async pickEngines(task: TaskInfo, req: CreateTaskRequest): Promise<void> {
    for (const e of [req.workerEngine, req.reviewEngine])
      if (e !== undefined && e !== "claude" && e !== "opencode") throw new HttpError(400, L(`Неизвестный движок: ${e}`, `Unknown engine: ${e}`));
    const engines = await this.d.sessions.enginesInfo().catch(() => [] as EngineInfo[]);
    const info = (e: EngineId) => engines.find((x) => x.id === e);
    const usable = (e: EngineId) => {
      const i = info(e);
      return !!i?.available && !(i.auth?.installed && !i.auth.loggedIn);
    };
    const name = (e: EngineId) => (e === "claude" ? "Claude Code" : "opencode");
    const unusable = (e: EngineId) =>
      new HttpError(409, info(e)?.error ?? L(`${name(e)} сейчас недоступен — выбери другую модель`, `${name(e)} isn't available right now — pick another model`));
    const modelFor = (e: EngineId): ModelRef | undefined => this.d.config?.config.newSession?.models?.[e] ?? info(e)?.defaultModel;

    const worker: EngineId = req.workerEngine ?? (usable("claude") ? "claude" : "opencode");
    if (!usable(worker)) throw unusable(worker);
    task.workerEngine = worker;
    const wm = req.workerModel ?? modelFor(worker);
    if (wm) task.workerModel = wm;
    if (req.workerEffort) task.workerEffort = req.workerEffort;

    if (req.reviewModel === null) return; // без ревью
    const reviewer: EngineId = req.reviewEngine ?? (usable("opencode") ? "opencode" : worker);
    if (!usable(reviewer)) throw unusable(reviewer);
    task.reviewEngine = reviewer;
    const rm = req.reviewModel ?? modelFor(reviewer);
    if (rm) task.reviewModel = rm;
    if (req.reviewEffort) task.reviewEffort = req.reviewEffort;
  }

  /** Сколько задач работает одновременно (config.tasks.parallel, 1…5). */
  private get parallel(): number {
    const n = Number(this.d.config?.config.tasks?.parallel ?? 2);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 2;
  }

  /** Запустить очередные задачи, если есть место и подошло их время. */
  private async pump(): Promise<void> {
    if (this.closed) return;
    const all = this.list();
    const active = all.filter((t) => t.status === "running" || t.status === "waiting_limit").length;
    const now = Date.now();
    // по очереди создания: кто раньше поставлен, тот раньше пойдёт
    const queued = all.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    let free = this.parallel - active;
    for (const t of queued) {
      if (t.startAt && t.startAt > now) {
        this.arm(t.id, t.startAt);
        continue;
      }
      if (free <= 0) break;
      free--;
      await this.launch(t.id);
    }
    this.maybeSummary();
  }

  /** Таймер отложенного запуска (переживает рестарт: время лежит в задаче). */
  private arm(id: string, at: number): void {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pump();
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Создать исполнителя и отправить ему цель. */
  private async launch(id: string): Promise<void> {
    let task = this.get(id);
    if (task.status !== "queued") return;
    try {
      const worker = await this.d.sessions.create({
        engine: task.workerEngine ?? "claude",
        directory: task.directory,
        worktree: true,
        permissionMode: "auto",
        title: task.title,
        taskId: task.id,
        ...(task.workerModel ? { model: task.workerModel } : {}),
        ...(task.workerEffort ? { effort: task.workerEffort } : {}),
      });
      task = this.get(id);
      // задачу могли остановить, пока создавалась копия
      if (task.status !== "queued") {
        try {
          this.d.sessions.delete(worker.id);
        } catch {
          /* уже удалена */
        }
        return;
      }
      task.workerSessionId = worker.id;
      task.workerModel = worker.model;
      if (worker.worktree) task.worktree = worker.worktree;
      task.status = "running";
      this.step(task, "work", worker.id, worker.model);
      this.save(task);
      this.busy.add(task.id);
      if (this.d.autoCheck?.commands(worker).length) await this.d.sessions.update(worker.id, { autoCheck: true });
      // могли остановить, пока мы ждали: остановка уже порвала сессию и откатила копию
      if (!this.running(task.id)) return;
      await this.d.sessions.prompt(worker.id, workPrompt(task.goal, !!worker.worktree && hasLinkedDeps(worker.worktree.path)));
      this.d.log?.(`[task] ${L("начал", "started")}: ${task.title}`);
    } catch (e) {
      const cur = this.d.db.getTask(id);
      if (cur) this.fail(cur, (e as Error).message);
    }
  }

  /** Когда работа кончилась и очередь пуста — одна сводка на всё (ночной прогон). */
  private maybeSummary(): void {
    const all = this.list();
    if (all.some((t) => t.status === "running" || t.status === "waiting_limit" || t.status === "queued")) return;
    if (this.done.size < 2) return;
    const mine = all.filter((t) => this.done.has(t.id));
    const ready = mine.filter((t) => t.status === "ready").length;
    const failed = mine.filter((t) => t.status === "failed").length;
    const sid = mine.find((t) => t.workerSessionId)?.workerSessionId;
    this.done.clear();
    if (!sid) return;
    this.d.notify(
      sid,
      L(`Задачи закончились: готово ${ready}, сломалось ${failed}`, `Tasks finished: ${ready} ready, ${failed} broke`),
    );
  }

  async act(id: string, a: TaskAction): Promise<TaskInfo> {
    if (this.acting.has(id)) throw new HttpError(409, L("Задача уже обрабатывается", "The task is already being handled"));
    this.acting.add(id);
    try {
      return await this.actNow(id, a);
    } finally {
      this.acting.delete(id);
    }
  }

  private async actNow(id: string, a: TaskAction): Promise<TaskInfo> {
    const t = this.get(id);
    if (a.action === "merge") {
      if (t.status !== "ready") throw new HttpError(409, L("Задача ещё не готова", "The task isn't ready yet"));
      if (!t.workerSessionId) throw new HttpError(409, L("У задачи нет сессии исполнителя", "The task has no worker session"));
      const r = await this.d.sessions.mergeWorktree(t.workerSessionId);
      t.status = "merged";
      t.report = { ...(t.report ?? this.emptyReport()), commit: r.commit };
      this.save(t);
      await this.pump();
      return t;
    }
    if (a.action === "discard") {
      // влитую задачу выбрасывать нельзя: в истории должно остаться, что её влили
      if (!["running", "waiting_limit", "queued", "ready", "failed"].includes(t.status))
        throw new HttpError(409, L("Выбросить можно только задачу в работе, в очереди, ожидающую лимита, готовую или упавшую", "Discard is only for a running, queued, waiting, ready, or failed task"));
      // Сначала закрываем задачу: события от остановленных сессий не должны её двигать
      // (idle от abort приходит асинхронно, пока мы ещё катим откат).
      const timer = this.timers.get(t.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(t.id);
      this.busy.delete(t.id);
      const step = t.steps.at(-1);
      if (step && step.status === "running") {
        step.status = "skipped";
        step.finishedAt = Date.now();
        step.note = L("остановлено", "stopped");
      }
      t.status = "discarded";
      this.save(t);

      for (const sid of this.sessionIds(t)) {
        const s = this.session(sid);
        if (!s) continue;
        // проверки не должны прислать «почини» остановленному агенту
        if (sid === t.workerSessionId && s.autoCheck) await this.d.sessions.update(sid, { autoCheck: false }).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
        await this.d.sessions.abort(sid).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
        if (s.resumeAt) this.d.sessions.setResumeAt(sid, 0);
      }
      // откат, когда агент точно перестал писать: у Claude abort — запрос прерывания, процесс умирает не сразу
      if (t.workerSessionId) {
        await this.waitStopped(t.workerSessionId);
        if (t.worktree) await this.d.sessions.discardWorktree(t.workerSessionId).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
      }
      await this.pump();
      return this.get(t.id);
    }
    const comment = String(a.comment ?? "").trim();
    // ещё круг — у готовой задачи (тогда нужен комментарий) или у упавшей (продолжить с того места, где оборвалась)
    const failed = t.status === "failed";
    if (t.status !== "ready" && !failed)
      throw new HttpError(409, t.status === "running" ? L("Задача ещё работает", "The task is still running") : L("Ещё круг — только у готовой или упавшей задачи", "One more round is only for a ready or failed task"));
    if (!comment && !failed) throw new HttpError(400, L("Напиши, что доработать", "Say what to improve"));
    if (!t.workerSessionId) throw new HttpError(409, L("У задачи нет сессии исполнителя", "The task has no worker session"));
    const error = t.error;
    // замечания последнего ревью исполнителю не уходили (кончились круги) — отдаём сейчас, иначе «доделай по ревью» ему не о чем
    const review = t.reviewVerdict === "remarks" && t.reviewText ? t.reviewText : undefined;
    delete t.reviewVerdict;
    // круги ревью считаем заново: это новая порция работы
    t.reviews = 0;
    t.status = "running";
    delete t.error;
    this.step(t, failed ? "work" : "fix", t.workerSessionId, t.workerModel);
    this.save(t);
    this.busy.add(t.id);
    await this.d.sessions.prompt(t.workerSessionId, failed ? resumeTaskPrompt(error, comment, review) : morePrompt(comment, review));
    return this.get(id);
  }

  /** Удалить задачу вместе с её сессиями (копия проекта убирается вместе с сессией исполнителя). */
  async remove(id: string): Promise<void> {
    const t = this.get(id);
    for (const sid of this.sessionIds(t)) {
      try {
        this.d.sessions.delete(sid);
      } catch {
        /* сессии уже нет */
      }
    }
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.d.db.deleteTask(id);
    this.done.delete(id);
    this.emit();
    await this.pump();
  }

  /** После старта хаба: подхватить незавершённые задачи. */
  start(): void {
    for (const t of this.list()) {
      if (t.status !== "running" && t.status !== "waiting_limit") continue;
      const s = t.workerSessionId && this.session(t.workerSessionId);
      if (!s) {
        this.fail(t, L("Сессия исполнителя пропала", "The worker session is gone"));
        continue;
      }
      if (s.status === "busy" || s.status === "retry") {
        this.busy.add(t.id);
        continue;
      }
      if (s.resumeAt) {
        t.status = "waiting_limit";
        this.save(t);
        continue;
      }
      // шаг закончился, пока хаб лежал: продолжаем с того места, где остановились
      this.d.log?.(`[task] ${L("продолжаю после рестарта", "continuing after a restart")}: ${t.title}`);
      void this.advance(t.id);
    }
    // очередь и отложенные запуски тоже переживают рестарт
    void this.pump();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.offSettled?.();
    this.listeners.clear();
    this.acting.clear();
  }

  // ---------- события ----------

  private onEvent(e: StoredEvent): void {
    const t = this.byWorker(e.sessionId) ?? this.byReview(e.sessionId);
    if (!t || this.closed) return;
    const ev = e.event;
    // агент ждёт человека — помечаем задачу, иначе она молча «работает»
    if (ev.type === "permission.asked" || ev.type === "question.asked") {
      const text = ev.type === "permission.asked" ? `${ev.request.tool}: ${ev.request.title}` : (ev.request.questions[0]?.question ?? "");
      t.asking = { sessionId: e.sessionId, kind: ev.type === "permission.asked" ? "permission" : "question", text: text.slice(0, 300), at: Date.now() };
      this.save(t);
      return;
    }
    if (ev.type === "permission.resolved" || ev.type === "question.resolved") {
      if (t.asking?.sessionId === e.sessionId) {
        delete t.asking;
        this.save(t);
      }
      return;
    }
    if (ev.type === "error" && !isLimitError(ev.message)) {
      if (t.status === "running" || t.status === "waiting_limit") this.fail(t, ev.message);
      return;
    }
    if (ev.type !== "session.updated") return;
    const isWorker = t.workerSessionId === e.sessionId;
    if (ev.patch.resumeAt !== undefined && isWorker) {
      // упёрлись в лимит Claude: ждём сброса, автопродолжение само напишет «Продолжай»
      if (ev.patch.resumeAt && t.status === "running") {
        t.status = "waiting_limit";
        this.save(t);
      } else if (!ev.patch.resumeAt && t.status === "waiting_limit") {
        t.status = "running";
        this.save(t);
      }
      return;
    }
    if (ev.patch.status === "busy" || ev.patch.status === "retry") {
      this.busy.add(t.id);
      return;
    }
    if (ev.patch.status !== "idle" || !this.busy.delete(t.id)) return;
    if (t.status !== "running") return;
    if (isWorker) {
      // с автопроверкой ждём не idle, а конца круга проверок (она ещё может вернуть агенту ошибку)
      if (this.d.autoCheck?.active(e.sessionId)) return;
      void this.advance(t.id);
    } else {
      void this.afterReview(t.id);
    }
  }

  private onChecks(e: CheckSettled): void {
    const t = this.byWorker(e.sessionId);
    if (!t || this.closed || t.status !== "running" || e.sentFix) return;
    const step = t.steps.at(-1);
    if (step) step.note = e.status === "passed" ? L("проверки прошли", "checks passed") : L("проверки не прошли", "checks failed");
    void this.advance(t.id, e.status === "passed" ? "passed" : "failed");
  }

  // ---------- конвейер ----------

  /** Шаг исполнителя закончился: решаем, что дальше — ревью или отчёт. */
  private async advance(id: string, checks?: "passed" | "failed"): Promise<void> {
    let t: TaskInfo;
    try {
      t = this.get(id);
    } catch {
      return;
    }
    this.finishStep(t);
    if (checks) t.checksResult = checks;
    try {
      if (!t.reviewModel || t.reviews >= MAX_REVIEWS) return await this.ready(t);
      const diff = await this.diff(t);
      if (!this.running(t.id)) return;
      if (!diff.diff.trim()) return await this.ready(t);
      await this.review(t, diff);
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  private async review(t: TaskInfo, d: { diff: string; files: Array<{ status: string; path: string }>; truncated: boolean }): Promise<void> {
    let sid = t.reviewSessionId;
    if (sid && !this.session(sid)) sid = undefined;
    if (!sid) {
      const s = await this.d.sessions.create({
        engine: t.reviewEngine ?? "opencode",
        directory: this.workerDir(t),
        permissionMode: "manual",
        title: L(`Ревью: ${t.title}`, `Review: ${t.title}`).slice(0, 200),
        taskId: t.id,
        ...(t.reviewModel ? { model: t.reviewModel } : {}),
        ...(t.reviewEffort ? { effort: t.reviewEffort } : {}),
      });
      sid = s.id;
      if (!this.running(t.id)) {
        // остановили, пока создавалась сессия ревью — её и копию убирает уже остановка
        try {
          this.d.sessions.delete(sid);
        } catch {
          /* уже удалена */
        }
        return;
      }
      t.reviewSessionId = sid;
      t.reviewModel = s.model;
    }
    this.step(t, "review", sid, t.reviewModel);
    this.save(t);
    this.busy.add(t.id);
    if (!this.running(t.id)) return;
    await this.d.sessions.prompt(sid, reviewTaskPrompt(t.goal, d.diff, d.files, d.truncated));
  }

  /** Ревью ответило: чисто — отчёт, есть замечания — отдаём исполнителю (пока есть круги). */
  private async afterReview(id: string): Promise<void> {
    let t: TaskInfo;
    try {
      t = this.get(id);
    } catch {
      return;
    }
    this.finishStep(t);
    t.reviews++;
    const text = t.reviewSessionId ? lastAssistantText(this.d.sessions.eventsAfter(t.reviewSessionId, 0)) : "";
    t.reviewText = text;
    try {
      if (!text || CLEAN.test(text)) {
        t.reviewVerdict = t.reviews > 1 ? "fixed" : "ok";
        return await this.ready(t);
      }
      if (t.reviews >= MAX_REVIEWS || !t.workerSessionId) {
        t.reviewVerdict = "remarks";
        return await this.ready(t);
      }
      this.step(t, "fix", t.workerSessionId, t.workerModel);
      this.save(t);
      this.busy.add(t.id);
      if (!this.running(t.id)) return;
      await this.d.sessions.prompt(t.workerSessionId, fixPrompt(text));
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  /** Готово: собрать отчёт и позвать пользователя. */
  private async ready(t: TaskInfo): Promise<void> {
    if (!this.running(t.id)) return;
    const files = await this.files(t);
    if (!this.running(t.id)) return;
    const summary = t.workerSessionId ? lastAssistantText(this.d.sessions.eventsAfter(t.workerSessionId, 0)) : "";
    t.report = {
      summary,
      files,
      checks: t.checksResult ?? "none",
      review: t.reviewVerdict ?? (t.reviewModel ? "skipped" : "skipped"),
      ...(t.reviewText ? { reviewText: t.reviewText } : {}),
    };
    t.status = "ready";
    this.done.add(t.id);
    this.save(t);
    const what = files.length ? L(`файлов изменено: ${files.length}`, `files changed: ${files.length}`) : L("файлы не менялись", "no files changed");
    if (t.workerSessionId) this.d.notify(t.workerSessionId, L(`Задача готова: ${t.title} (${what})`, `Task ready: ${t.title} (${what})`));
    this.d.log?.(`[task] ${L("готово", "ready")}: ${t.title}`);
    await this.pump();
  }

  // ---------- мелочи ----------

  private emptyReport(): NonNullable<TaskInfo["report"]> {
    return { summary: "", files: [], checks: "none", review: "skipped" };
  }

  private workerDir(t: TaskInfo): string {
    const s = t.workerSessionId && this.session(t.workerSessionId);
    return s ? s.directory : t.directory;
  }

  /** Что наработано в копии проекта: индексируем всё (копия наша) и сравниваем с основной веткой. */
  private async diff(t: TaskInfo): Promise<{ diff: string; files: Array<{ status: string; path: string }>; truncated: boolean }> {
    const g = this.d.git ?? git;
    const wt = t.worktree;
    if (!wt) return { diff: "", files: [], truncated: false };
    // новые файлы иначе не попадут в дифф; .gitignore (node_modules) при этом не трогаем
    await g(wt.path, ["add", "-A"]).catch(() => "");
    const from = await this.forkPoint(t);
    const diff = await g(wt.path, ["diff", "--no-color", from]).catch((e: GitError) => {
      this.d.log?.(`[task] diff: ${e.message}`);
      return "";
    });
    return { diff: diff.slice(0, DIFF_MAX), files: await this.files(t), truncated: diff.length > DIFF_MAX };
  }

/**
   * Откуда считать работу задачи: коммит, от которого ответвилась копия (merge-base), а не текущая основная ветка.
   * Основная могла уйти вперёд, пока задача работала, — тогда дифф от неё показал бы чужие коммиты как «удалённые» задачей.
   */
  private async forkPoint(t: TaskInfo): Promise<string> {
    const wt = t.worktree!;
    const g = this.d.git ?? git;
    return (await g(wt.path, ["merge-base", wt.base, "HEAD"]).catch(() => "")).trim() || wt.base;
  }

  private async files(t: TaskInfo): Promise<Array<{ status: string; path: string }>> {
    const g = this.d.git ?? git;
    const wt = t.worktree;
    if (!wt) return [];
    const out = await g(wt.path, ["diff", "--name-status", await this.forkPoint(t)]).catch(() => "");
    return out
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status: (status ?? "").trim(), path: rest.join("\t").trim() };
      })
      .filter((f) => f.path);
  }

  private step(t: TaskInfo, kind: TaskStepKind, sessionId?: string, model?: ModelRef): void {
    this.finishStep(t);
    const s: TaskStep = { kind, status: "running", startedAt: Date.now(), ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}) };
    t.steps.push(s);
    if (t.steps.length > 40) t.steps.splice(0, t.steps.length - 40);
  }

  private finishStep(t: TaskInfo): void {
    const s = t.steps.at(-1);
    if (s && s.status === "running") {
      s.status = "done";
      s.finishedAt = Date.now();
    }
  }

  private fail(t: TaskInfo, message: string): void {
    const cur = this.d.db.getTask(t.id);
    // остановленную (или уже влитую) задачу ошибкой не перекрашиваем. Статус — из базы, а данные — текущие:
    // в t уже могут быть несохранённые итоги шага (текст ревью, круги), их не теряем
    if (!cur || !["running", "waiting_limit", "queued"].includes(cur.status)) return;
    this.finishStep(t);
    const s = t.steps.at(-1);
    if (s) s.status = "failed";
    t.status = "failed";
    t.error = message.slice(0, 2000);
    this.done.add(t.id);
    this.save(t);
    if (t.workerSessionId) this.d.notify(t.workerSessionId, L(`Задача сломалась: ${t.title}`, `The task broke: ${t.title}`));
    this.d.log?.(`[task] ${L("ошибка", "error")} «${t.title}»: ${message}`);
    void this.pump();
  }

  private sessionIds(t: TaskInfo): string[] {
    return [t.workerSessionId, t.reviewSessionId].filter((x): x is string => !!x);
  }

  private session(id: string) {
    try {
      return this.d.sessions.get(id);
    } catch {
      return undefined;
    }
  }

  /** Задача ещё в работе: её могли остановить, пока мы ждали git или движок. Объект не перечитываем — на нём уже есть правки шага. */
  private running(id: string): boolean {
    const t = this.d.db.getTask(id);
    return !!t && t.status === "running";
  }

  /** Ждём, что движок перестал писать (у Claude abort — запрос прерывания, idle приходит позже). */
  private async waitStopped(id: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = this.session(id);
      if (!s || (s.status !== "busy" && s.status !== "retry")) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private byWorker(sessionId: string): TaskInfo | undefined {
    return this.list().find((t) => t.workerSessionId === sessionId);
  }

  private byReview(sessionId: string): TaskInfo | undefined {
    return this.list().find((t) => t.reviewSessionId === sessionId);
  }

  private save(t: TaskInfo): void {
    // задачу могли остановить, пока мы ждали git или движок — устаревший объект не должен затереть остановку
    const cur = this.d.db.getTask(t.id);
    if (cur && cur.status === "discarded" && t.status !== "discarded") return;
    // задача больше не работает — и ждать от человека нечего
    if (t.status !== "running" && t.status !== "waiting_limit") delete t.asking;
    t.updatedAt = Date.now();
    this.d.db.saveTask(t);
    this.emit();
  }

  private emit(): void {
    const tasks = this.list();
    for (const cb of this.listeners) {
      try {
        cb(tasks);
      } catch (e) {
        this.d.log?.(`[task] ${(e as Error).message}`);
      }
    }
  }
}
