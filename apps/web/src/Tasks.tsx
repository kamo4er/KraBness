// Задачи: хаб сам ведёт работу от цели до отчёта (исполнитель → проверки → ревью → правки), а в конце спрашивает решение.
import { useEffect, useState } from "react";
import { defaultTaskModels, engineName, modelOptions, optionReady, parseModelKey, t, type EngineInfo, type EngineModelOption, type NewSessionPrefs, type TaskInfo, type TaskStep, tn } from "@kamharn/client";
import { client, fmtTime, go, useEngines, useHub } from "./hub.ts";
import { FolderPicker } from "./NewSession.tsx";
import { EffortSelect } from "./Effort.tsx";
import { Markdown } from "./Parts.tsx";

const STATUS = (): Record<TaskInfo["status"], string> => ({
  queued: t("в очереди", "queued"),
  running: t("работает", "running"),
  waiting_limit: t("ждёт лимит", "waiting for the limit"),
  ready: t("готово, нужно решение", "ready, needs your decision"),
  merged: t("влито", "merged"),
  discarded: t("выброшено", "discarded"),
  failed: t("сломалось", "broke"),
});

const STEP = (): Record<TaskStep["kind"], string> => ({
  work: t("делает", "working"),
  checks: t("проверки", "checks"),
  review: t("ревью", "review"),
  fix: t("правит", "fixing"),
});

export const taskIcon = (s: TaskInfo["status"]): string => (s === "queued" ? "⋯" : s === "running" ? "▶" : s === "waiting_limit" ? "⏳" : s === "ready" ? "●" : s === "merged" ? "✓" : s === "failed" ? "✗" : "—");

/** Ближайшая ночь: сегодня 02:00, если ещё не наступило, иначе завтра. */
export function nextNight(now = new Date()): number {
  const d = new Date(now);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Список задач + форма новой. */
export function Tasks() {
  const { tasks } = useHub();
  const [open, setOpen] = useState(false);
  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "home" })}>
          ←
        </button>
        <h2>{t("Задачи", "Tasks")}</h2>
      </header>
      <div className="page__body">
        <p className="muted">
          {t(
            "Задача идёт сама: агент работает в отдельной копии проекта, хаб гоняет проверки и ревью другой моделью, а в конце показывает отчёт. В основную ветку ничего не попадёт без твоего решения.",
            "A task runs by itself: the agent works in a separate copy of the project, the hub runs checks and a review by another model, and shows a report at the end. Nothing reaches the main branch without your decision.",
          )}
        </p>
        <div className="row">
          {open ? null : (
            <button className="btn btn--primary" onClick={() => setOpen(true)}>
              {t("+ Новая задача", "+ New task")}
            </button>
          )}
          <Parallel />
        </div>
        {open ? <NewTask onDone={() => setOpen(false)} /> : null}
        <ul className="list">
          {tasks.map((x) => (
            <li key={x.id} className="list__row">
              <button className="tasks__item" onClick={() => go({ page: "task", id: x.id })}>
                <span className={`tasks__icon tasks__icon--${x.status}`}>{taskIcon(x.status)}</span>
                <span className="settings-list__text">
                  <b>{x.title}</b>
                  <span className="muted">
                    {x.asking ? <b className="tasks__asking">✋ {t("ждёт твоего ответа", "waiting for your answer")}</b> : STATUS()[x.status]}
                    {x.status === "queued" && x.startAt ? ` (${new Date(x.startAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})` : ""} · {fmtTime(x.updatedAt)}
                    {x.report?.files.length ? ` · ${t("файлов", "files")}: ${x.report.files.length}` : ""}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!tasks.length && <li className="muted">{t("Задач пока нет.", "No tasks yet.")}</li>}
        </ul>
      </div>
    </div>
  );
}

/** Сколько задач работает одновременно: остальные ждут очереди. */
function Parallel() {
  const [n, setN] = useState<number>();
  useEffect(() => void client.tasksParallel().then((r) => setN(r.parallel)), []);
  if (n === undefined) return null;
  return (
    <label className="row muted" title={t("Столько задач работают параллельно, каждая в своей копии проекта. Остальные ждут в очереди и стартуют, когда освободится место.", "This many tasks run in parallel, each in its own copy of the project. The rest wait in the queue and start when a slot frees up.")}>
      {t("Работают одновременно:", "Running at once:")}
      <select className="select" style={{ width: "auto" }} value={n} onChange={(e) => void client.setTasksParallel(Number(e.target.value)).then((r) => setN(r.parallel))}>
        {[1, 2, 3, 4, 5].map((x) => (
          <option key={x} value={x}>
            {tn(x, ["задача", "задачи", "задач"], ["task", "tasks"])}
          </option>
        ))}
      </select>
      <span>{t("остальные ждут очереди", "the rest wait in the queue")}</span>
    </label>
  );
}

function NewTask({ onDone }: { onDone: () => void }) {
  const loaded = useEngines();
  // сервер локальной модели могли запустить, пока форма открыта, — перечитываем при открытии выбора
  const [fresh, setFresh] = useState<EngineInfo[]>();
  const engines = fresh ?? loaded;
  const refresh = () => void client.engines().then(setFresh, () => {});
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState("");
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  // последний выбор запоминаем: обычно задачи даёшь одной и той же паре моделей
  const [worker, setWorker] = useState(() => localStorage.getItem("task.worker") ?? "");
  const [review, setReview] = useState(() => localStorage.getItem("task.review") ?? "");
  const [night, setNight] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [workerEffort, setWorkerEffort] = useState(() => localStorage.getItem("task.workerEffort") ?? "");
  const [reviewEffort, setReviewEffort] = useState(() => localStorage.getItem("task.reviewEffort") ?? "");
  const options = modelOptions(engines);
  const defs = defaultTaskModels(engines, prefs);
  // сохранённый выбор пропал (движок выключили, модель убрали) — берём умолчание
  const workerKey = optionReady(options, worker) ? worker : (defs.worker ?? "");
  const effortsOf = (key: string) => options.find((o) => o.key === key)?.model.efforts ?? [];
  const reviewKey = review === "none" || optionReady(options, review) ? review : (defs.review ?? "none");
  useEffect(() => void client.roots().then((r) => setDir((d) => d || r[0] || "")), []);
  useEffect(() => void client.newSessionPrefs().then(setPrefs, () => {}), []);
  const pickWorker = (v: string) => {
    setWorker(v);
    localStorage.setItem("task.worker", v);
  };
  const pickReview = (v: string) => {
    setReview(v);
    localStorage.setItem("task.review", v);
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const w = parseModelKey(workerKey);
      const r = parseModelKey(reviewKey);
      const we = effortsOf(workerKey).includes(workerEffort) ? workerEffort : "";
      const re = effortsOf(reviewKey).includes(reviewEffort) ? reviewEffort : "";
      const task = await client.createTask({
        goal,
        directory: dir,
        ...(w ? { workerEngine: w.engine, workerModel: w.model, ...(we ? { workerEffort: we } : {}) } : {}),
        ...(reviewKey === "none" ? { reviewModel: null } : r ? { reviewEngine: r.engine, reviewModel: r.model, ...(re ? { reviewEffort: re } : {}) } : {}),
        ...(night ? { startAt: nextNight() } : {}),
      });
      go({ page: "task", id: task.id });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>{t("Новая задача", "New task")}</h3>
      <textarea className="input" rows={4} placeholder={t("Что сделать? Например: добавь экспорт списка в CSV и тест на него", "What to do? For example: add CSV export for the list and a test for it")} value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />
      <h3>{t("Проект", "Project")}</h3>
      <FolderPicker value={dir} onChange={setDir} />
      <h3>{t("Исполнитель", "Worker")}</h3>
      {options.length ? (
        <select className="select" value={workerKey} onFocus={refresh} onChange={(e) => pickWorker(e.target.value)}>
          <ModelGroups options={options} />
        </select>
      ) : null}
      {options.length ? (
        <EffortSelect efforts={effortsOf(workerKey)} value={workerEffort} onChange={(v) => (setWorkerEffort(v), localStorage.setItem("task.workerEffort", v))} />
      ) : (
        <p className="error">{t("Нет ни одного доступного движка: запусти opencode или войди в Claude Code.", "No engine is available: start opencode or sign in to Claude Code.")}</p>
      )}
      <h3>{t("Ревью", "Review")}</h3>
      <select className="select" value={reviewKey} onFocus={refresh} onChange={(e) => pickReview(e.target.value)}>
        <option value="none">{t("без ревью", "no review")}</option>
        <ModelGroups options={options} />
      </select>
      {reviewKey !== "none" && <EffortSelect efforts={effortsOf(reviewKey)} value={reviewEffort} onChange={(v) => (setReviewEffort(v), localStorage.setItem("task.reviewEffort", v))} />}
      {reviewKey !== "none" && reviewKey === workerKey ? <p className="muted">{t("Ревью той же моделью видит меньше: лучше выбрать другую.", "A review by the same model catches less: better pick another one.")}</p> : null}
      <label className="row">
        <input type="checkbox" checked={night} onChange={() => setNight(!night)} />
        {t("Запустить ночью (в 02:00)", "Start at night (02:00)")}
      </label>
      <p className="muted">{t("Исполнитель работает в своей копии проекта. Ревью лучше отдать другой модели: она замечает то, что исполнитель пропустил. Замечания возвращаются исполнителю (до 2 кругов).", "The worker runs in its own copy of the project. Give the review to a different model: it catches what the worker missed. Its remarks go back to the worker (up to 2 rounds).")}</p>
      <div className="row">
        <button className="btn btn--primary" disabled={busy || !goal.trim() || !dir || !workerKey} onClick={() => void create()}>
          {busy ? t("Запускаю…", "Starting…") : t("Запустить", "Start")}
        </button>
        <button className="btn" disabled={busy} onClick={onDone}>
          {t("Отмена", "Cancel")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Модели, сгруппированные по движкам. */
function ModelGroups({ options }: { options: EngineModelOption[] }) {
  const engines = [...new Set(options.map((o) => o.engine))];
  return (
    <>
      {engines.map((e) => (
        <optgroup key={e} label={engineName(e)}>
          {options
            .filter((o) => o.engine === e)
            .map((o) => (
              <option key={o.key} value={o.key} disabled={o.model.offline}>
                {o.model.name || o.model.modelId} {o.model.offline ? t("(не в сети: запусти сервер модели)", "(offline: start the model server)") : o.model.free ? t("(бесплатная)", "(free)") : ""}
              </option>
            ))}
        </optgroup>
      ))}
    </>
  );
}

/** Одна задача: шаги, отчёт и решение. */
export function Task({ id }: { id: string }) {
  const { tasks, sessions } = useHub();
  const task = tasks.find((x) => x.id === id);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!task) return <div className="empty">{t("Задача не найдена.", "Task not found.")}</div>;
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    void f()
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const title = (sid?: string) => sessions.find((s) => s.id === sid)?.title ?? "";
  const r = task.report;
  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "tasks" })}>
          ←
        </button>
        <h2>
          <span className={`tasks__icon tasks__icon--${task.status}`}>{taskIcon(task.status)}</span> {task.title}
        </h2>
      </header>
      <div className="page__body">
        <section>
          <p>
            <b>{STATUS()[task.status]}</b> · <span className="mono muted">{task.directory}</span>
            {task.worktree ? <span className="muted"> · {t("ветка", "branch")} <code>{task.worktree.branch}</code></span> : null}
          </p>
          <pre className="pre task__goal">{task.goal}</pre>
          {task.error && <p className="error">{task.error}</p>}
          {task.asking && (
            <div className="tasks__askbox">
              <b>✋ {task.asking.kind === "permission" ? t("Агент ждёт твоего разрешения", "The agent is waiting for your permission") : t("Агент задал вопрос", "The agent asked a question")}</b>
              {task.asking.text && <pre className="pre">{task.asking.text}</pre>}
              <p className="muted">{t("Пока не ответишь, задача стоит.", "The task is on hold until you answer.")}</p>
              <button className="btn btn--primary btn--small" onClick={() => go({ page: "session", id: task.asking!.sessionId })}>
                {t("Открыть чат и ответить", "Open the chat and answer")}
              </button>
            </div>
          )}
          {(task.status === "running" || task.status === "waiting_limit" || task.status === "queued") && (
            <div className="row">
              <button
                className="btn btn--danger"
                disabled={busy}
                onClick={() =>
                  confirm(t("Остановить задачу? Агент прекратится, изменения в копии выбросятся. Чат останется.", "Stop the task? The agent stops and the changes in the copy are discarded. The chat stays.")) &&
                  act(() => client.taskAction(task.id, { action: "discard" }))
                }
              >
                {t("Остановить", "Stop")}
              </button>
              <span className="muted">{t("агент прекратится, копия откатится, чат останется", "the agent stops, the copy is rolled back, the chat stays")}</span>
            </div>
          )}
        </section>

        <section>
          <h3>{t("Шаги", "Steps")}</h3>
          <ul className="list">
            {task.steps.map((s, i) => (
              <li key={i} className="list__row">
                <span>
                  {s.status === "running" ? <span className="spinner" /> : s.status === "failed" ? "✗" : "✓"} {STEP()[s.kind]}
                  {s.model ? <span className="muted"> · {s.model.modelId}</span> : null}
                  {s.note ? <span className="muted"> · {s.note}</span> : null}
                </span>
                {s.sessionId && (
                  <button className="btn btn--small" onClick={() => go({ page: "session", id: s.sessionId! })}>
                    {t("чат", "chat")}: {title(s.sessionId) || t("открыть", "open")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {r && (
          <section>
            <h3>{t("Отчёт", "Report")}</h3>
            <p className="muted">
              {t("Проверки", "Checks")}: {r.checks === "passed" ? t("прошли ✓", "passed ✓") : r.checks === "failed" ? t("не прошли ✗", "failed ✗") : t("не настроены", "not configured")} ·{" "}
              {t("ревью", "review")}: {r.review === "ok" ? t("замечаний нет", "no remarks") : r.review === "fixed" ? t("замечания исправлены", "remarks fixed") : r.review === "remarks" ? t("остались замечания", "remarks left") : t("не делали", "skipped")}
              {r.commit ? ` · ${t("коммит", "commit")} ${r.commit}` : ""}
            </p>
            {r.summary && <Markdown text={r.summary} />}
            {r.files.length > 0 && (
              <>
                <p className="muted">{t("Изменённые файлы", "Changed files")}:</p>
                <pre className="pre">{r.files.map((f) => `${f.status}\t${f.path}`).join("\n")}</pre>
              </>
            )}
            {r.review === "remarks" && r.reviewText && (
              <details>
                <summary className="muted">{t("Замечания ревью", "Review remarks")}</summary>
                <Markdown text={r.reviewText} />
              </details>
            )}
          </section>
        )}

        {(task.status === "ready" || task.status === "failed") && (
          <section>
            <h3>{t("Решение", "Decision")}</h3>
            {task.status === "failed" && <p className="muted">{t("Задача оборвалась, но всё, что агент успел, лежит в копии проекта. Можно продолжить с того же места: агент сам посмотрит, что сделано.", "The task was interrupted, but everything the agent managed to do is in the project copy. You can continue from there: the agent will look at what's done.")}</p>}
            <div className="row">
              {task.status === "ready" ? (
                <button className="btn btn--primary" disabled={busy} onClick={() => act(() => client.taskAction(task.id, { action: "merge" }))}>
                  {t("Влить в основную ветку", "Merge into the main branch")}
                </button>
              ) : (
                <button className="btn btn--primary" disabled={busy} onClick={() => act(async () => (await client.taskAction(task.id, { action: "more", comment }), setComment("")))}>
                  {t("Продолжить", "Continue")}
                </button>
              )}
              <button className="btn btn--danger" disabled={busy} onClick={() => confirm(t("Выбросить всё, что сделала задача?", "Discard everything the task did?")) && act(() => client.taskAction(task.id, { action: "discard" }))}>
                {t("Выбросить", "Discard")}
              </button>
            </div>
            {task.status === "ready" ? (
              <>
                <p>{t("Или попросить доработать:", "Or ask for more work:")}</p>
                <div className="row">
                  <input className="input" value={comment} placeholder={t("что доработать", "what to improve")} onChange={(e) => setComment(e.target.value)} />
                  <button className="btn" disabled={busy || !comment.trim()} onClick={() => act(async () => (await client.taskAction(task.id, { action: "more", comment }), setComment("")))}>
                    {t("Ещё круг", "One more round")}
                  </button>
                </div>
              </>
            ) : (
              <input className="input" value={comment} placeholder={t("подсказка агенту (не обязательно)", "a hint for the agent (optional)")} onChange={(e) => setComment(e.target.value)} />
            )}
          </section>
        )}

        <section>
          <button
            className="btn btn--danger btn--small"
            disabled={busy}
            onClick={() =>
              confirm(t("Удалить задачу? Её сессии и копия проекта будут удалены.", "Delete the task? Its sessions and the project copy will be removed.")) &&
              act(async () => {
                await client.deleteTask(task.id);
                go({ page: "tasks" });
              })
            }
          >
            {t("Удалить задачу", "Delete the task")}
          </button>
        </section>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
