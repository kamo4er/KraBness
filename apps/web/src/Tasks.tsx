// Задачи: хаб сам ведёт работу от цели до отчёта (исполнитель → проверки → ревью → правки), а в конце спрашивает решение.
import { useEffect, useState } from "react";
import { defaultTaskModels, engineName, modelOptions, parseModelKey, t, type EngineModelOption, type NewSessionPrefs, type TaskInfo, type TaskStep, tn } from "@kamharn/client";
import { client, fmtTime, go, useEngines, useHub } from "./hub.ts";
import { FolderPicker } from "./NewSession.tsx";
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
                    {STATUS()[x.status]}
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
  const engines = useEngines();
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState("");
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  // последний выбор запоминаем: обычно задачи даёшь одной и той же паре моделей
  const [worker, setWorker] = useState(() => localStorage.getItem("task.worker") ?? "");
  const [review, setReview] = useState(() => localStorage.getItem("task.review") ?? "");
  const [night, setNight] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const options = modelOptions(engines);
  const defs = defaultTaskModels(engines, prefs);
  // сохранённый выбор пропал (движок выключили, модель убрали) — берём умолчание
  const workerKey = options.some((o) => o.key === worker) ? worker : (defs.worker ?? "");
  const reviewKey = review === "none" || options.some((o) => o.key === review) ? review : (defs.review ?? "none");
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
      const task = await client.createTask({
        goal,
        directory: dir,
        ...(w ? { workerEngine: w.engine, workerModel: w.model } : {}),
        ...(reviewKey === "none" ? { reviewModel: null } : r ? { reviewEngine: r.engine, reviewModel: r.model } : {}),
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
        <select className="select" value={workerKey} onChange={(e) => pickWorker(e.target.value)}>
          <ModelGroups options={options} />
        </select>
      ) : (
        <p className="error">{t("Нет ни одного доступного движка: запусти opencode или войди в Claude Code.", "No engine is available: start opencode or sign in to Claude Code.")}</p>
      )}
      <h3>{t("Ревью", "Review")}</h3>
      <select className="select" value={reviewKey} onChange={(e) => pickReview(e.target.value)}>
        <option value="none">{t("без ревью", "no review")}</option>
        <ModelGroups options={options} />
      </select>
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
              <option key={o.key} value={o.key}>
                {o.model.name || o.model.modelId} {o.model.free ? t("(бесплатная)", "(free)") : ""}
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

        {task.status === "ready" && (
          <section>
            <h3>{t("Решение", "Decision")}</h3>
            <div className="row">
              <button className="btn btn--primary" disabled={busy} onClick={() => act(() => client.taskAction(task.id, { action: "merge" }))}>
                {t("Влить в основную ветку", "Merge into the main branch")}
              </button>
              <button className="btn btn--danger" disabled={busy} onClick={() => confirm(t("Выбросить всё, что сделала задача?", "Discard everything the task did?")) && act(() => client.taskAction(task.id, { action: "discard" }))}>
                {t("Выбросить", "Discard")}
              </button>
            </div>
            <p>{t("Или попросить доработать:", "Or ask for more work:")}</p>
            <div className="row">
              <input className="input" value={comment} placeholder={t("что доработать", "what to improve")} onChange={(e) => setComment(e.target.value)} />
              <button className="btn" disabled={busy || !comment.trim()} onClick={() => act(async () => (await client.taskAction(task.id, { action: "more", comment }), setComment("")))}>
                {t("Ещё круг", "One more round")}
              </button>
            </div>
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
