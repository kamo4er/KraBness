// Задачи: хаб сам ведёт работу от цели до отчёта (исполнитель → проверки → ревью → правки), а в конце спрашивает решение.
import { useEffect, useState } from "react";
import { branchName, defaultTaskModels, engineName, fileKind, goalBeyondTitle, specForReading, notRepoError, modelOptions, optionReady, parseModelKey, t, type EngineInfo, type EngineModelOption, type NewSessionPrefs, type TaskInfo, type TaskStep, tn } from "@kamharn/client";
import { client, fmtTime, go, useEngines, useHub } from "./hub.ts";
import { FolderPicker } from "./NewSession.tsx";
import { EffortSelect } from "./Effort.tsx";
import { Markdown } from "./Parts.tsx";
import { ArtifactCard } from "./Artifact.tsx";

const STATUS = (): Record<TaskInfo["status"], string> => ({
  queued: t("в очереди", "queued"),
  running: t("работает", "running"),
  waiting_limit: t("ждёт лимит", "waiting for the limit"),
  approval: t("спецификация ждёт одобрения", "specification awaits approval"),
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
  analysis: t("аналитик", "analyst"),
  ux: t("дизайнер", "designer"),
  design: t("архитектор", "architect"),
  test: t("тестировщик", "tester"),
});

export const taskIcon = (s: TaskInfo["status"]): string => (s === "queued" ? "⋯" : s === "running" ? "▶" : s === "waiting_limit" ? "⏳" : s === "approval" ? "✋" : s === "ready" ? "●" : s === "merged" ? "✓" : s === "failed" ? "✗" : "—");

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
                  <b>
                    {x.mode === "team" ? <span title={t("команда", "a team")}>👥 </span> : null}
                    {x.title}
                  </b>
                  <span className="muted">
                    {x.asking ? <b className="tasks__asking">✋ {t("ждёт твоего ответа", "waiting for your answer")}</b> : STATUS()[x.status]}
                    {!x.asking && x.mode === "team" && x.status === "running" && x.stage ? ` · ${STAGES().find((s) => s.key === x.stage)?.label.toLowerCase() ?? ""}` : ""}
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
  // команда: аналитик и архитектор по умолчанию — как разработчик (""), тестировщик — как ревью (другая модель)
  const [team, setTeam] = useState(() => localStorage.getItem("task.mode") === "team");
  const [analyst, setAnalyst] = useState(() => localStorage.getItem("task.analyst") ?? "");
  const [architect, setArchitect] = useState(() => localStorage.getItem("task.architect") ?? "");
  const [tester, setTester] = useState(() => localStorage.getItem("task.tester") ?? "");
  const [designerMode, setDesignerMode] = useState(() => (localStorage.getItem("task.designerMode") as "auto" | "on" | "off" | null) ?? "auto");
  const [designer, setDesigner] = useState(() => localStorage.getItem("task.designer") ?? "");
  const options = modelOptions(engines);
  const defs = defaultTaskModels(engines, prefs);
  // сохранённый выбор пропал (движок выключили, модель убрали) — берём умолчание
  const workerKey = optionReady(options, worker) ? worker : (defs.worker ?? "");
  const effortsOf = (key: string) => options.find((o) => o.key === key)?.model.efforts ?? [];
  const reviewKey = review === "none" || optionReady(options, review) ? review : (defs.review ?? "none");
  const sameKey = (v: string) => (optionReady(options, v) ? v : "");
  const testerKey = tester === "none" || optionReady(options, tester) ? tester : (defs.review ?? "none");
  const remember = (key: string, set: (v: string) => void) => (v: string) => (set(v), localStorage.setItem(key, v));
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
      // роль команды: своя модель или как у разработчика
      const member = (key: string) => {
        const m = parseModelKey(key || workerKey);
        return m ? { engine: m.engine, model: m.model } : undefined;
      };
      const tm = parseModelKey(testerKey);
      const task = await client.createTask({
        goal,
        directory: dir,
        ...(w ? { workerEngine: w.engine, workerModel: w.model, ...(we ? { workerEffort: we } : {}) } : {}),
        ...(team
          ? {
              mode: "team" as const,
              designer: designerMode,
              team: {
                analyst: member(sameKey(analyst)),
                ...(designerMode !== "off" ? { designer: member(sameKey(designer)) } : {}),
                architect: member(sameKey(architect)),
                tester: testerKey === "none" ? null : tm ? { engine: tm.engine, model: tm.model } : undefined,
              },
            }
          : reviewKey === "none"
            ? { reviewModel: null }
            : r
              ? { reviewEngine: r.engine, reviewModel: r.model, ...(re ? { reviewEffort: re } : {}) }
              : {}),
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

  // папка не в git: делаем репозиторий (файлы в ней войдут в первый коммит — переспрашиваем) и сразу запускаем
  const makeRepoAndStart = async () => {
    const files = await client.list(dir).catch(() => []);
    if (files.length && !confirm(t(`В папке уже есть файлы (${files.length}) — они войдут в первый коммит. Продолжить?`, `The folder already has files (${files.length}) — they go into the first commit. Continue?`))) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.gitInit(dir);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    await create();
  };

  return (
    <section>
      <h3>{t("Новая задача", "New task")}</h3>
      <textarea className="input" rows={4} placeholder={t("Что сделать? Например: добавь экспорт списка в CSV и тест на него", "What to do? For example: add CSV export for the list and a test for it")} value={goal} onChange={(e) => setGoal(e.target.value)} autoFocus />
      <h3>{t("Проект", "Project")}</h3>
      <FolderPicker value={dir} onChange={setDir} git />
      <h3>{t("Кто делает", "Who does it")}</h3>
      <div className="row tasks__mode">
        <label className="row">
          <input type="radio" checked={!team} onChange={() => (setTeam(false), localStorage.setItem("task.mode", "simple"))} />
          {t("Один агент", "One agent")}
        </label>
        <label className="row">
          <input type="radio" checked={team} onChange={() => (setTeam(true), localStorage.setItem("task.mode", "team"))} />
          {t("Команда", "A team")}
        </label>
      </div>
      {team && (
        <p className="muted">
          {t(
            "Аналитик расспросит тебя и напишет спецификацию, дизайнер нарисует интерфейс и кликабельный прототип (если задача про него), архитектор проверит, ты одобришь — потом разработчик делает, а тестировщик проверяет по критериям и возвращает баги. Дольше и дороже одного агента, зато ошибка в понимании ловится до кода.",
            "The analyst asks you questions and writes a specification, the designer draws the interface and a clickable prototype (if the task is about it), the architect checks it, you approve it — then the developer builds and the tester checks against the criteria and sends bugs back. Slower and pricier than one agent, but a misunderstanding is caught before any code.",
          )}
        </p>
      )}
      <h3>{team ? t("Разработчик", "Developer") : t("Исполнитель", "Worker")}</h3>
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
      {team ? (
        <div className="tasks__roles">
          <label>
            {t("Аналитик", "Analyst")}
            <select className="select" value={sameKey(analyst)} onFocus={refresh} onChange={(e) => remember("task.analyst", setAnalyst)(e.target.value)}>
              <option value="">{t("как у разработчика", "same as the developer")}</option>
              <ModelGroups options={options} />
            </select>
          </label>
          <label>
            {t("Дизайнер", "Designer")}
            <select className="select" value={designerMode} onChange={(e) => remember("task.designerMode", (v) => setDesignerMode(v as "auto" | "on" | "off"))(e.target.value)}>
              <option value="auto">{t("если задача про интерфейс (решит аналитик)", "if the task is about the interface (the analyst decides)")}</option>
              <option value="on">{t("всегда", "always")}</option>
              <option value="off">{t("без дизайнера", "no designer")}</option>
            </select>
            {designerMode !== "off" && (
              <select className="select" value={sameKey(designer)} onFocus={refresh} onChange={(e) => remember("task.designer", setDesigner)(e.target.value)}>
                <option value="">{t("как у разработчика", "same as the developer")}</option>
                <ModelGroups options={options} />
              </select>
            )}
          </label>
          <label>
            {t("Архитектор", "Architect")}
            <select className="select" value={sameKey(architect)} onFocus={refresh} onChange={(e) => remember("task.architect", setArchitect)(e.target.value)}>
              <option value="">{t("как у разработчика", "same as the developer")}</option>
              <ModelGroups options={options} />
            </select>
          </label>
          <label>
            {t("Тестировщик", "Tester")}
            <select className="select" value={testerKey} onFocus={refresh} onChange={(e) => remember("task.tester", setTester)(e.target.value)}>
              <option value="none">{t("без тестировщика", "no tester")}</option>
              <ModelGroups options={options} />
            </select>
          </label>
          {testerKey !== "none" && testerKey === workerKey ? <p className="muted">{t("Тестировщик той же моделью видит меньше: лучше выбрать другую.", "A tester on the same model catches less: better pick another one.")}</p> : null}
        </div>
      ) : (
        <>
          <h3>{t("Ревью", "Review")}</h3>
          <select className="select" value={reviewKey} onFocus={refresh} onChange={(e) => pickReview(e.target.value)}>
            <option value="none">{t("без ревью", "no review")}</option>
            <ModelGroups options={options} />
          </select>
          {reviewKey !== "none" && <EffortSelect efforts={effortsOf(reviewKey)} value={reviewEffort} onChange={(v) => (setReviewEffort(v), localStorage.setItem("task.reviewEffort", v))} />}
          {reviewKey !== "none" && reviewKey === workerKey ? <p className="muted">{t("Ревью той же моделью видит меньше: лучше выбрать другую.", "A review by the same model catches less: better pick another one.")}</p> : null}
        </>
      )}
      <label className="row">
        <input type="checkbox" checked={night} onChange={() => setNight(!night)} />
        {t("Запустить ночью (в 02:00)", "Start at night (02:00)")}
      </label>
      {!team && <p className="muted">{t("Исполнитель работает в своей копии проекта. Ревью лучше отдать другой модели: она замечает то, что исполнитель пропустил. Замечания возвращаются исполнителю (до 2 кругов).", "The worker runs in its own copy of the project. Give the review to a different model: it catches what the worker missed. Its remarks go back to the worker (up to 2 rounds).")}</p>}
      <div className="row">
        <button className="btn btn--primary" disabled={busy || !goal.trim() || !dir || !workerKey} onClick={() => void create()}>
          {busy ? t("Запускаю…", "Starting…") : t("Запустить", "Start")}
        </button>
        <button className="btn" disabled={busy} onClick={onDone}>
          {t("Отмена", "Cancel")}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {error && notRepoError(error) && (
        <div className="row">
          <button className="btn btn--primary btn--small" disabled={busy} onClick={() => void makeRepoAndStart()}>
            {t("Сделать папку git-репозиторием и запустить", "Make the folder a git repository and start")}
          </button>
          <span className="muted">{t("первый коммит — из того, что уже лежит в папке", "the first commit holds what's already in the folder")}</span>
        </div>
      )}
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

/** Этапы команды по порядку; ✋ — где решаешь ты. */
const STAGES = (): Array<{ key: string; label: string }> => [
  { key: "analysis", label: t("Аналитик", "Analyst") },
  { key: "ux", label: t("Дизайнер", "Designer") },
  { key: "design", label: t("Архитектор", "Architect") },
  { key: "approval", label: `✋ ${t("Одобрение", "Approval")}` },
  { key: "dev", label: t("Разработчик", "Developer") },
  { key: "testing", label: t("Тестировщик", "Tester") },
  { key: "ready", label: `✋ ${t("Решение", "Decision")}` },
];

/** Где сейчас задача команды (ключ из STAGES). */
function teamNow(task: TaskInfo): string | undefined {
  if (task.status === "approval") return "approval";
  if (task.status === "ready" || task.status === "merged") return "ready";
  if (task.status === "running" || task.status === "waiting_limit" || task.status === "failed") return task.stage ?? "dev";
  return undefined;
}

/** Дизайнер в задаче и задача про интерфейс (в «авто» — пока аналитик не сказал «нет»). */
const designerTakesPart = (task: TaskInfo) => !!task.team?.designer && (task.designerMode === "on" || task.ui !== false);

function TeamRibbon({ task }: { task: TaskInfo }) {
  const all = STAGES();
  const now = teamNow(task);
  const at = now ? all.findIndex((s) => s.key === now) : -1;
  return (
    <ol className="team-ribbon">
      {all.map((s, i) =>
        (s.key === "testing" && !task.team?.tester) || (s.key === "ux" && !designerTakesPart(task)) ? null : (
          <li key={s.key} className={i < at ? "team-ribbon__done" : i === at ? (task.status === "failed" ? "team-ribbon__failed" : "team-ribbon__now") : ""}>
            {s.label}
          </li>
        ),
      )}
    </ol>
  );
}

/** Спецификация ждёт тебя: прочитать, поправить руками, одобрить или вернуть аналитику. */
function SpecApproval({ task, busy, act }: { task: TaskInfo; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(task.spec ?? "");
  const [note, setNote] = useState("");
  const analyst = task.team?.analyst?.sessionId;
  const edited = edit && text.trim() !== (task.spec ?? "").trim();
  return (
    <section className="tasks__approval">
      <h3>{t("Спецификация — нужно твоё решение", "Specification — your decision is needed")}</h3>
      {task.designRemarks && (
        <div className="tasks__askbox">
          <b>{t("Архитектор так и не одобрил. Его последние замечания:", "The architect never approved. Their latest remarks:")}</b>
          <Markdown text={task.designRemarks} />
        </div>
      )}
      {edit ? (
        <textarea className="input mono tasks__specedit" rows={18} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="tasks__spec">
          <Markdown text={specForReading(task.spec ?? "")} />
        </div>
      )}
      {task.prototype && (
        <div className="tasks__proto">
          <p className="muted">{t("Прототип дизайнера — понажимай, это макет с выдуманными данными:", "The designer's prototype — click around, it's a mock-up with made-up data:")}</p>
          <ArtifactCard source={task.prototype} title={t("Прототип", "Prototype")} autoRun />
        </div>
      )}
      <div className="row">
        <button className="btn btn--primary" disabled={busy || (edit && !text.trim())} onClick={() => act(() => client.taskAction(task.id, edited ? { action: "approve", spec: text } : { action: "approve" }))}>
          {edited ? t("Сохранить и одобрить", "Save and approve") : t("Одобрить — в разработку", "Approve — start development")}
        </button>
        <button className="btn" disabled={busy} onClick={() => (setText(task.spec ?? ""), setEdit(!edit))}>
          {edit ? t("Отменить правку", "Cancel editing") : t("Поправить руками", "Edit by hand")}
        </button>
        <button className="btn btn--danger" disabled={busy} onClick={() => confirm(t("Выбросить задачу?", "Discard the task?")) && act(() => client.taskAction(task.id, { action: "discard" }))}>
          {t("Выбросить", "Discard")}
        </button>
      </div>
      <p>{t("Или вернуть аналитику с комментарием:", "Or send it back to the analyst with a comment:")}</p>
      <div className="row">
        <input className="input" value={note} placeholder={t("что поправить", "what to change")} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" disabled={busy || !note.trim()} onClick={() => act(async () => (await client.taskAction(task.id, { action: "revise", comment: note }), setNote("")))}>
          {t("Вернуть аналитику", "Send back")}
        </button>
      </div>
      {analyst && (
        <button className="btn btn--small" onClick={() => go({ page: "session", id: analyst })}>
          {t("обсудить с аналитиком в чате", "discuss with the analyst in the chat")}
        </button>
      )}
    </section>
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
            {task.worktree ? <span className="muted"> · {t("ветка", "branch")} <code title={task.worktree.branch}>{branchName(task.worktree.branch)}</code></span> : null}
          </p>
          {task.mode === "team" && <TeamRibbon task={task} />}
          {/* цель целиком — только если заголовок её обрезал: иначе тот же текст дважды */}
          {goalBeyondTitle(task) && <pre className="pre task__goal">{task.goal}</pre>}
          {task.error && <p className="error">{task.error}</p>}
          {task.asking && (
            <div className="tasks__askbox">
              <b>
                ✋{" "}
                {task.asking.kind === "permission"
                  ? t("Агент ждёт твоего разрешения", "The agent is waiting for your permission")
                  : task.asking.kind === "reply"
                    ? t("Аналитик задал вопросы — ответь в его чате", "The analyst has questions — answer in their chat")
                    : t("Агент задал вопрос", "The agent asked a question")}
              </b>
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

        {task.status === "approval" ? (
          <SpecApproval key={task.spec} task={task} busy={busy} act={act} />
        ) : task.spec ? (
          <details className="tasks__specbox">
            <summary>{t("Спецификация", "Specification")}</summary>
            <Markdown text={specForReading(task.spec)} />
            {task.prototype && <ArtifactCard source={task.prototype} title={t("Прототип", "Prototype")} autoRun />}
          </details>
        ) : null}

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
                {/* название сессии шага — тот же текст задачи, поэтому кнопка без него */}
                {s.sessionId && (
                  <button className="btn btn--small" title={title(s.sessionId)} onClick={() => go({ page: "session", id: s.sessionId! })}>
                    {t("открыть чат", "open chat")}
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
              {task.mode === "team" ? (
                <>
                  {t("тестировщик", "tester")}:{" "}
                  {r.test === "passed" ? t("принял ✓", "accepted ✓") : r.test === "bugs" ? t("остались проблемы ✗", "problems left ✗") : t("не было", "none")}
                  {task.testRounds ? ` (${tn(task.testRounds, ["круг", "круга", "кругов"], ["round", "rounds"])})` : ""}
                </>
              ) : (
                <>
                  {t("ревью", "review")}: {r.review === "ok" ? t("замечаний нет", "no remarks") : r.review === "fixed" ? t("замечания исправлены", "remarks fixed") : r.review === "remarks" ? t("остались замечания", "remarks left") : t("не делали", "skipped")}
                </>
              )}
              {r.commit ? ` · ${t("коммит", "commit")} ${r.commit}` : ""}
            </p>
            {r.summary && <Markdown text={r.summary} />}
            {r.files.length > 0 && (
              <>
                <p className="muted">{t("Изменённые файлы", "Changed files")}:</p>
                <ul className="gitfiles">
                  {r.files.map((f) => (
                    <li key={f.path}>
                      <span className={`gitstat gitstat--${fileKind(f.status)}`}>{f.status}</span> <span className="mono">{f.path}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {r.review === "remarks" && r.reviewText && (
              <details>
                <summary className="muted">{t("Замечания ревью", "Review remarks")}</summary>
                <Markdown text={r.reviewText} />
              </details>
            )}
            {r.testText && (
              <details open={r.test === "bugs"}>
                <summary className="muted">{t("Отчёт тестировщика", "Tester's report")}</summary>
                <Markdown text={r.testText} />
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
