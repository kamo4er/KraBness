// Задачи на телефоне: список, новая задача, отчёт и решение. Конвейер ведёт хаб, экран только показывает.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { t, type TaskInfo, type TaskStep, tn, branchName, defaultTaskModels, fileKind, goalBeyondTitle, specForReading, notRepoError, engineName, modelOptions, optionReady, parseModelKey, type NewSessionPrefs, type EngineInfo, type TeamRole } from "@kamharn/client";
import { client, useEngines, useHub } from "../store.ts";
import { back, go, replace } from "../nav.ts";
import { Markdown } from "../Parts.tsx";
import { ArtifactCard } from "../Artifact.tsx";
import { Btn, ListSheet } from "../ui.tsx";
import { EffortPicker } from "../effort.tsx";
import { dialog } from "../dialog.tsx";
import { C, S, mono } from "../theme.ts";
import { FolderPicker } from "./NewSession.tsx";

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
function nextNight(now = new Date()): number {
  const d = new Date(now);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const iconColor = (s: TaskInfo["status"]): string => (s === "ready" || s === "approval" ? "#e3b341" : s === "merged" ? C.ok : s === "failed" ? C.err : s === "running" ? C.accent : C.muted);
const FILE_COLOR = { new: C.ok, del: C.err, mod: C.warn } as const;

export function Tasks() {
  const { tasks } = useHub();
  const [adding, setAdding] = useState(false);
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h1, { flex: 1 }]}>{t("Задачи", "Tasks")}</Text>
        <Btn small kind="primary" title={t("+ Задача", "+ Task")} onPress={() => setAdding(true)} />
      </View>
      {adding ? (
        <NewTask onDone={() => setAdding(false)} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
          <Text style={S.muted}>
            {t(
              "Задача идёт сама: агент работает в отдельной копии проекта, хаб гоняет проверки и ревью другой моделью. В основную ветку ничего не попадёт без твоего решения.",
              "A task runs by itself: the agent works in a separate copy of the project, the hub runs checks and a review by another model. Nothing reaches the main branch without your decision.",
            )}
          </Text>
          <Parallel />
          {tasks.map((x) => (
            <View key={x.id} style={{ gap: 2 }}>
              <Btn title={`${taskIcon(x.status)}  ${x.mode === "team" ? "👥 " : ""}${x.title}`} onPress={() => go({ page: "task", id: x.id })} />
              <Text style={S.muted}>
                {x.asking ? <Text style={{ color: C.warn ?? "#e3b341", fontWeight: "600" }}>✋ {t("ждёт твоего ответа", "waiting for your answer")}</Text> : STATUS()[x.status]}
                {!x.asking && x.mode === "team" && x.status === "running" && x.stage ? ` · ${STAGES().find((s) => s.key === x.stage)?.label.toLowerCase() ?? ""}` : ""}
                {x.status === "queued" && x.startAt ? ` (${new Date(x.startAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})` : ""}
                {x.report?.files.length ? ` · ${t("файлов", "files")}: ${x.report.files.length}` : ""}
              </Text>
            </View>
          ))}
          {!tasks.length ? <Text style={S.muted}>{t("Задач пока нет.", "No tasks yet.")}</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}

/** Сколько задач работает одновременно: остальные ждут очереди. */
function Parallel() {
  const [n, setN] = useState<number>();
  const [pick, setPick] = useState(false);
  const { conn } = useHub();
  // хаб был недоступен — загрузим заново, когда связь вернётся
  useEffect(() => {
    if (conn === "online" && n === undefined) client?.tasksParallel().then((r) => setN(r.parallel), () => {});
  }, [conn, n]);
  if (n === undefined) return null;
  const set = (v: number) =>
    client
      ?.setTasksParallel(v)
      .then((r) => setN(r.parallel))
      .catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message));
  return (
    <>
      <Btn small title={`${t("Работают одновременно", "Running at once")}: ${tn(n, ["задача", "задачи", "задач"], ["task", "tasks"])}`} onPress={() => setPick(true)} style={{ alignSelf: "flex-start" }} />
      {pick ? (
        <ListSheet
          visible
          title={t("Столько задач работают параллельно, каждая в своей копии проекта. Остальные ждут в очереди и стартуют, когда освободится место.", "This many tasks run in parallel, each in its own copy of the project. The rest wait in the queue and start when a slot frees up.")}
          options={[1, 2, 3, 4, 5].map((x) => ({ value: String(x), label: tn(x, ["задача", "задачи", "задач"], ["task", "tasks"]) }))}
          value={String(n)}
          onPick={(v) => Number(v) !== n && set(Number(v))}
          onClose={() => setPick(false)}
        />
      ) : null}
    </>
  );
}

/** Последний выбор моделей — до перезапуска приложения. */
const last: { worker?: string; review?: string; workerEffort?: string; reviewEffort?: string; team?: boolean; analyst?: string; architect?: string; tester?: string; designer?: string; designerMode?: "auto" | "on" } = {};

type Pick = "worker" | "review" | TeamRole;

function NewTask({ onDone }: { onDone: () => void }) {
  const loaded = useEngines();
  // сервер локальной модели могли запустить, пока форма открыта, — перечитываем при открытии выбора
  const [fresh, setFresh] = useState<EngineInfo[]>();
  const engines = fresh ?? loaded;
  const open = (which: Pick) => {
    setPick(which);
    void client?.engines().then(setFresh, () => {});
  };
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState("");
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  const [worker, setWorker] = useState(last.worker ?? "");
  const [review, setReview] = useState(last.review ?? "");
  const [pick, setPick] = useState<Pick>();
  // команда: аналитик и архитектор по умолчанию — как разработчик (""), тестировщик — как ревью (другая модель)
  const [team, setTeam] = useState(last.team ?? false);
  const [analyst, setAnalyst] = useState(last.analyst ?? "");
  const [architect, setArchitect] = useState(last.architect ?? "");
  const [tester, setTester] = useState(last.tester ?? "");
  // дизайнер: "off" — без него, "" — как у разработчика, иначе своя модель; режим — только если задача про интерфейс или всегда
  const [designer, setDesigner] = useState(last.designer ?? "");
  const [designerMode, setDesignerMode] = useState<"auto" | "on">(last.designerMode ?? "auto");
  const [workerEffort, setWorkerEffort] = useState(last.workerEffort ?? "");
  const [reviewEffort, setReviewEffort] = useState(last.reviewEffort ?? "");
  const [night, setNight] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = modelOptions(engines);
  const defs = defaultTaskModels(engines, prefs);
  // выбранное пропало (движок выключили, модель убрали) — берём умолчание
  const workerKey = optionReady(options, worker) ? worker : (defs.worker ?? "");
  const reviewKey = review === "none" || optionReady(options, review) ? review : (defs.review ?? "none");
  const effortsOf = (k: string) => options.find((o) => o.key === k)?.model.efforts ?? [];
  const sameKey = (v: string) => (optionReady(options, v) ? v : "");
  const testerKey = tester === "none" || optionReady(options, tester) ? tester : (defs.review ?? "none");
  const label = (key: string) => {
    const o = options.find((x) => x.key === key);
    return o ? `${engineName(o.engine)} · ${o.model.name || o.model.modelId}` : t("нет доступных моделей", "no models available");
  };
  // в листе модели сгруппированы по движкам: заголовок у первой модели движка
  const sheet = options.map((o, i) => ({
    value: o.key,
    label: o.model.name || o.model.modelId,
    ...(o.model.offline ? { disabled: true, hint: t("не в сети: запусти сервер модели", "offline: start the model server") } : o.model.free ? { hint: t("бесплатная", "free") } : {}),
    ...(i === 0 || options[i - 1]!.engine !== o.engine ? { group: engineName(o.engine) } : {}),
  }));
  useEffect(() => void client?.roots().then((r) => setDir((d) => d || r[0] || "")), []);
  useEffect(() => void client?.newSessionPrefs().then(setPrefs, () => {}), []);

  const create = async () => {
    setBusy(true);
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
      const task = await client!.createTask({
        goal,
        directory: dir,
        ...(w ? { workerEngine: w.engine, workerModel: w.model, ...(we ? { workerEffort: we } : {}) } : {}),
        ...(team
          ? {
              mode: "team" as const,
              designer: designer === "off" ? ("off" as const) : designerMode,
              team: {
                analyst: member(sameKey(analyst)),
                ...(designer !== "off" ? { designer: member(sameKey(designer)) } : {}),
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
      replace({ page: "task", id: task.id });
      onDone();
    } catch (e) {
      const message = (e as Error).message;
      // папка не в git — предлагаем сделать репозиторий и сразу запустить
      if (notRepoError(message))
        dialog(t("Папка не в git", "The folder isn't in git"), t("Задаче нужна своя ветка. Сделать папку git-репозиторием? Первый коммит — из того, что уже в ней лежит.", "A task needs its own branch. Make the folder a git repository? The first commit holds what's already in it."), [
          { text: t("Отмена", "Cancel"), style: "cancel" },
          { text: t("Сделать и запустить", "Make it and start"), onPress: () => void makeRepoAndStart() },
        ]);
      else dialog(t("Не получилось", "Failed"), message);
    } finally {
      setBusy(false);
    }
  };

  const makeRepoAndStart = async () => {
    setBusy(true);
    try {
      await client!.gitInit(dir);
    } catch (e) {
      setBusy(false);
      return dialog(t("Не получилось", "Failed"), (e as Error).message);
    }
    await create();
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} keyboardShouldPersistTaps="handled">
      <Text style={S.h3}>{t("Что сделать", "What to do")}</Text>
      <TextInput
        style={[S.input, { minHeight: 90, textAlignVertical: "top" }]}
        value={goal}
        onChangeText={setGoal}
        multiline
        autoFocus
        placeholder={t("например: добавь экспорт списка в CSV и тест", "for example: add CSV export for the list and a test")}
        placeholderTextColor={C.muted}
      />
      <Text style={S.h3}>{t("Проект", "Project")}</Text>
      <FolderPicker value={dir} onChange={setDir} git />
      <Text style={S.h3}>{t("Кто делает", "Who does it")}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn kind={team ? "default" : "primary"} title={t("Один агент", "One agent")} onPress={() => setTeam((last.team = false))} style={{ flex: 1 }} />
        <Btn kind={team ? "primary" : "default"} title={`👥 ${t("Команда", "A team")}`} onPress={() => setTeam((last.team = true))} style={{ flex: 1 }} />
      </View>
      {team ? (
        <Text style={S.muted}>
          {t(
            "Аналитик расспросит тебя и напишет спецификацию, дизайнер нарисует интерфейс и кликабельный прототип (если задача про него), архитектор проверит, ты одобришь — потом разработчик делает, а тестировщик проверяет по критериям и возвращает баги. Дольше и дороже одного агента, зато ошибка в понимании ловится до кода.",
            "The analyst asks you questions and writes a specification, the designer draws the interface and a clickable prototype (if the task is about it), the architect checks it, you approve it — then the developer builds and the tester checks against the criteria and sends bugs back. Slower and pricier than one agent, but a misunderstanding is caught before any code.",
          )}
        </Text>
      ) : null}
      <Text style={S.h3}>{team ? t("Разработчик", "Developer") : t("Исполнитель", "Worker")}</Text>
      <Btn title={label(workerKey)} disabled={!options.length} onPress={() => open("worker")} />
      <EffortPicker efforts={effortsOf(workerKey)} value={workerEffort} onChange={(v) => setWorkerEffort((last.workerEffort = v))} />
      {team ? (
        <>
          <Text style={S.h3}>{t("Роли", "Roles")}</Text>
          <Btn title={`${t("Аналитик", "Analyst")}: ${sameKey(analyst) ? label(sameKey(analyst)) : t("как у разработчика", "same as the developer")}`} onPress={() => open("analyst")} />
          <Btn title={`${t("Дизайнер", "Designer")}: ${designer === "off" ? t("без дизайнера", "no designer") : sameKey(designer) ? label(sameKey(designer)) : t("как у разработчика", "same as the developer")}`} onPress={() => open("designer")} />
          {designer !== "off" ? (
            <Btn
              small
              kind="ghost"
              title={designerMode === "auto" ? t("дизайнер — только если задача про интерфейс (решит аналитик)", "designer — only if the task is about the interface (the analyst decides)") : t("дизайнер — всегда", "designer — always")}
              onPress={() => setDesignerMode((last.designerMode = designerMode === "auto" ? "on" : "auto"))}
            />
          ) : null}
          <Btn title={`${t("Архитектор", "Architect")}: ${sameKey(architect) ? label(sameKey(architect)) : t("как у разработчика", "same as the developer")}`} onPress={() => open("architect")} />
          <Btn title={`${t("Тестировщик", "Tester")}: ${testerKey === "none" ? t("без тестировщика", "no tester") : label(testerKey)}`} onPress={() => open("tester")} />
          {testerKey !== "none" && testerKey === workerKey ? <Text style={S.muted}>{t("Тестировщик той же моделью видит меньше: лучше выбрать другую.", "A tester on the same model catches less: better pick another one.")}</Text> : null}
        </>
      ) : (
        <>
          <Text style={S.h3}>{t("Ревью", "Review")}</Text>
          <Btn title={reviewKey === "none" ? t("без ревью", "no review") : label(reviewKey)} onPress={() => open("review")} />
          {reviewKey !== "none" ? <EffortPicker efforts={effortsOf(reviewKey)} value={reviewEffort} onChange={(v) => setReviewEffort((last.reviewEffort = v))} /> : null}
          {reviewKey !== "none" && reviewKey === workerKey ? <Text style={S.muted}>{t("Ревью той же моделью видит меньше: лучше выбрать другую.", "A review by the same model catches less: better pick another one.")}</Text> : null}
          <Text style={S.muted}>{t("Исполнитель работает в своей копии проекта. Ревью лучше отдать другой модели: она замечает то, что исполнитель пропустил. Замечания возвращаются исполнителю (до 2 кругов).", "The worker runs in its own copy of the project. Give the review to a different model: it catches what the worker missed. Its remarks go back to the worker (up to 2 rounds).")}</Text>
        </>
      )}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Switch value={night} onValueChange={setNight} />
        <Text style={S.text}>{t("Запустить ночью (в 02:00)", "Start at night (02:00)")}</Text>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn kind="primary" title={busy ? t("Запускаю…", "Starting…") : t("Запустить", "Start")} busy={busy} disabled={!goal.trim() || !dir || !workerKey} onPress={() => void create()} style={{ flex: 1 }} />
        <Btn title={t("Отмена", "Cancel")} onPress={onDone} />
      </View>
      {pick ? (
        <ListSheet
          visible
          title={
            pick === "worker"
              ? t("Кто делает задачу", "Who does the task")
              : pick === "review"
                ? t("Кто делает ревью", "Who reviews")
                : pick === "analyst"
                  ? t("Аналитик", "Analyst")
                  : pick === "designer"
                    ? t("Дизайнер", "Designer")
                  : pick === "architect"
                    ? t("Архитектор", "Architect")
                    : t("Тестировщик", "Tester")
          }
          options={
            pick === "worker"
              ? sheet
              : pick === "review"
                ? [{ value: "none", label: t("без ревью", "no review") }, ...sheet]
                : pick === "tester"
                  ? [{ value: "none", label: t("без тестировщика", "no tester") }, ...sheet]
                  : pick === "designer"
                    ? [{ value: "off", label: t("без дизайнера", "no designer") }, { value: "", label: t("как у разработчика", "same as the developer") }, ...sheet]
                  : [{ value: "", label: t("как у разработчика", "same as the developer") }, ...sheet]
          }
          value={pick === "worker" ? workerKey : pick === "review" ? reviewKey : pick === "tester" ? testerKey : pick === "designer" ? (designer === "off" ? "off" : sameKey(designer)) : sameKey(pick === "analyst" ? analyst : architect)}
          onPick={(key) => {
            // ListSheet зовёт onClose раньше onPick — поэтому значение pick здесь ещё прежнее (замкнуто в рендере)
            if (pick === "worker") setWorker((last.worker = key));
            else if (pick === "review") setReview((last.review = key));
            else if (pick === "analyst") setAnalyst((last.analyst = key));
            else if (pick === "designer") setDesigner((last.designer = key));
            else if (pick === "architect") setArchitect((last.architect = key));
            else setTester((last.tester = key));
          }}
          onClose={() => setPick(undefined)}
        />
      ) : null}
    </ScrollView>
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
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
      {all.map((s, i) => {
        if ((s.key === "testing" && !task.team?.tester) || (s.key === "ux" && !designerTakesPart(task))) return null;
        const color = i < at ? C.ok : i === at ? (task.status === "failed" ? C.err : C.text) : C.muted;
        return (
          <Text key={s.key} style={{ color, fontSize: 13, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: i === at ? (task.status === "failed" ? C.err : C.accent) : C.line }}>
            {s.label}
          </Text>
        );
      })}
    </View>
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
    <View style={{ gap: 10 }}>
      <Text style={S.h3}>{t("Спецификация — нужно твоё решение", "Specification — your decision is needed")}</Text>
      {task.designRemarks ? (
        <View style={{ borderWidth: 1, borderColor: C.warn ?? "#e3b341", borderRadius: 10, padding: 10, gap: 6 }}>
          <Text style={[S.text, { fontWeight: "600" }]}>{t("Архитектор так и не одобрил. Его последние замечания:", "The architect never approved. Their latest remarks:")}</Text>
          <Markdown text={task.designRemarks} />
        </View>
      ) : null}
      {edit ? (
        <TextInput style={[S.input, { minHeight: 260, textAlignVertical: "top", fontFamily: mono, fontSize: 13 }]} value={text} onChangeText={setText} multiline />
      ) : (
        <View style={{ borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 4 }}>
          <Markdown text={specForReading(task.spec ?? "")} />
        </View>
      )}
      {task.prototype ? (
        <>
          <Text style={S.muted}>{t("Прототип дизайнера — нажми, чтобы открыть и понажимать: это макет с выдуманными данными.", "The designer's prototype — tap to open and click around: it's a mock-up with made-up data.")}</Text>
          <ArtifactCard source={task.prototype} title={t("Прототип", "Prototype")} autoRun />
        </>
      ) : null}
      <Btn
        kind="primary"
        title={edited ? t("Сохранить и одобрить", "Save and approve") : t("Одобрить — в разработку", "Approve — start development")}
        busy={busy}
        disabled={edit && !text.trim()}
        onPress={() => act(() => client!.taskAction(task.id, edited ? { action: "approve", spec: text } : { action: "approve" }))}
      />
      <Btn title={edit ? t("Отменить правку", "Cancel editing") : t("Поправить руками", "Edit by hand")} onPress={() => (setText(task.spec ?? ""), setEdit(!edit))} />
      <Text style={S.muted}>{t("Или вернуть аналитику с комментарием:", "Or send it back to the analyst with a comment:")}</Text>
      <TextInput style={S.input} value={note} onChangeText={setNote} placeholder={t("что поправить", "what to change")} placeholderTextColor={C.muted} />
      <Btn title={t("Вернуть аналитику", "Send back")} disabled={!note.trim()} busy={busy} onPress={() => act(async () => (await client!.taskAction(task.id, { action: "revise", comment: note }), setNote("")))} />
      {analyst ? <Btn small kind="ghost" title={t("обсудить с аналитиком в чате", "discuss with the analyst in the chat")} onPress={() => go({ page: "session", id: analyst })} /> : null}
      <Btn
        kind="danger"
        title={t("Выбросить", "Discard")}
        busy={busy}
        onPress={() =>
          dialog(t("Выбросить задачу?", "Discard the task?"), t("Спецификация и копия проекта пропадут.", "The specification and the project copy will be gone."), [
            { text: t("Отмена", "Cancel"), style: "cancel" },
            { text: t("Выбросить", "Discard"), style: "destructive", onPress: () => act(() => client!.taskAction(task.id, { action: "discard" })) },
          ])
        }
      />
    </View>
  );
}

/** Спецификация после одобрения — свёрнута. */
function SpecBox({ spec, prototype }: { spec: string; prototype?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => setOpen(!open)} hitSlop={6}>
        <Text style={S.muted}>
          {open ? "▾" : "▸"} {t("Спецификация", "Specification")}
        </Text>
      </Pressable>
      {open ? <Markdown text={specForReading(spec)} /> : null}
      {open && prototype ? <ArtifactCard source={prototype} title={t("Прототип", "Prototype")} autoRun /> : null}
    </View>
  );
}

export function Task({ id }: { id: string }) {
  const { tasks } = useHub();
  const task = tasks.find((x) => x.id === id);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  if (!task)
    return (
      <View style={[S.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={S.muted}>{t("Задача не найдена.", "Task not found.")}</Text>
        <Btn title={t("Назад", "Back")} onPress={back} style={{ marginTop: 12 }} />
      </View>
    );
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    void f()
      .catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message))
      .finally(() => setBusy(false));
  };
  const r = task.report;
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]} numberOfLines={1}>
          <Text style={{ color: iconColor(task.status) }}>{taskIcon(task.status)}</Text> {task.title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        <Text style={S.text}>{STATUS()[task.status]}</Text>
        <Text style={[S.muted, { fontFamily: mono }]}>
          {task.directory}
          {task.worktree ? `  ⎇ ${branchName(task.worktree.branch)}` : ""}
        </Text>
        {task.mode === "team" ? <TeamRibbon task={task} /> : null}
        {/* цель целиком — только если заголовок её обрезал: иначе тот же текст дважды */}
        {goalBeyondTitle(task) ? <Text style={S.text}>{task.goal}</Text> : null}
        {task.error ? <Text style={S.error}>{task.error}</Text> : null}
        {task.asking ? (
          <View style={{ borderWidth: 1, borderColor: C.warn ?? "#e3b341", borderRadius: 10, padding: 10, gap: 6 }}>
            <Text style={[S.text, { fontWeight: "600" }]}>
              ✋{" "}
              {task.asking.kind === "permission"
                ? t("Агент ждёт твоего разрешения", "The agent is waiting for your permission")
                : task.asking.kind === "reply"
                  ? t("Аналитик задал вопросы — ответь в его чате", "The analyst has questions — answer in their chat")
                  : t("Агент задал вопрос", "The agent asked a question")}
            </Text>
            {task.asking.text ? <Text style={[S.muted, { fontFamily: "monospace" }]}>{task.asking.text}</Text> : null}
            <Text style={S.muted}>{t("Пока не ответишь, задача стоит.", "The task is on hold until you answer.")}</Text>
            <Btn kind="primary" title={t("Открыть чат и ответить", "Open the chat and answer")} onPress={() => go({ page: "session", id: task.asking!.sessionId })} />
          </View>
        ) : null}

        {task.status === "running" || task.status === "waiting_limit" || task.status === "queued" ? (
          <Btn
            kind="danger"
            title={t("Остановить", "Stop")}
            busy={busy}
            onPress={() =>
              dialog(t("Остановить задачу?", "Stop the task?"), t("Агент прекратится, изменения в копии выбросятся. Чат останется.", "The agent stops and the changes in the copy are discarded. The chat stays."), [
                { text: t("Отмена", "Cancel"), style: "cancel" },
                { text: t("Остановить", "Stop"), style: "destructive", onPress: () => act(() => client!.taskAction(task.id, { action: "discard" })) },
              ])
            }
          />
        ) : null}

        {task.status === "approval" ? <SpecApproval key={task.spec} task={task} busy={busy} act={act} /> : task.spec ? <SpecBox spec={task.spec} prototype={task.prototype} /> : null}

        <Text style={S.h3}>{t("Шаги", "Steps")}</Text>
        {task.steps.map((s, i) => (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[S.text, { flex: 1 }]}>
              {s.status === "running" ? "…" : s.status === "failed" ? "✗" : "✓"} {STEP()[s.kind]}
              {s.model ? <Text style={S.muted}> · {s.model.modelId}</Text> : null}
              {s.note ? <Text style={S.muted}> · {s.note}</Text> : null}
            </Text>
            {/* название сессии шага — тот же текст задачи, поэтому кнопка без него */}
            {s.sessionId ? <Btn small title={t("открыть чат", "open chat")} onPress={() => go({ page: "session", id: s.sessionId! })} /> : null}
          </View>
        ))}

        {r ? (
          <>
            <Text style={S.h3}>{t("Отчёт", "Report")}</Text>
            <Text style={S.muted}>
              {t("Проверки", "Checks")}: {r.checks === "passed" ? t("прошли ✓", "passed ✓") : r.checks === "failed" ? t("не прошли ✗", "failed ✗") : t("не настроены", "not configured")} ·{" "}
              {task.mode === "team"
                ? `${t("тестировщик", "tester")}: ${r.test === "passed" ? t("принял ✓", "accepted ✓") : r.test === "bugs" ? t("остались проблемы ✗", "problems left ✗") : t("не было", "none")}${task.testRounds ? ` (${tn(task.testRounds, ["круг", "круга", "кругов"], ["round", "rounds"])})` : ""}`
                : `${t("ревью", "review")}: ${r.review === "ok" ? t("замечаний нет", "no remarks") : r.review === "fixed" ? t("замечания исправлены", "remarks fixed") : r.review === "remarks" ? t("остались замечания", "remarks left") : t("не делали", "skipped")}`}
              {r.commit ? ` · ${t("коммит", "commit")} ${r.commit}` : ""}
            </Text>
            {r.summary ? <Markdown text={r.summary} /> : null}
            {r.files.map((f) => (
              <Text key={f.path} style={[S.muted, { fontFamily: mono }]}>
                <Text style={{ color: FILE_COLOR[fileKind(f.status)] }}>{f.status.padEnd(2)}</Text> {f.path}
              </Text>
            ))}
            {r.review === "remarks" && r.reviewText ? (
              <>
                <Text style={S.h3}>{t("Замечания ревью", "Review remarks")}</Text>
                <Markdown text={r.reviewText} />
              </>
            ) : null}
            {r.testText ? (
              <>
                <Text style={S.h3}>{t("Отчёт тестировщика", "Tester's report")}</Text>
                <Markdown text={r.testText} />
              </>
            ) : null}
          </>
        ) : null}

        {task.status === "ready" || task.status === "failed" ? (
          <>
            <Text style={S.h3}>{t("Решение", "Decision")}</Text>
            {task.status === "ready" ? (
              <>
                <Btn kind="primary" title={t("Влить в основную ветку", "Merge into the main branch")} busy={busy} onPress={() => act(() => client!.taskAction(task.id, { action: "merge" }))} />
                <TextInput style={S.input} value={comment} onChangeText={setComment} placeholder={t("что доработать", "what to improve")} placeholderTextColor={C.muted} />
                <Btn title={t("Ещё круг", "One more round")} disabled={!comment.trim()} busy={busy} onPress={() => act(async () => (await client!.taskAction(task.id, { action: "more", comment }), setComment("")))} />
              </>
            ) : (
              <>
                <Text style={S.muted}>{t("Задача оборвалась, но всё, что агент успел, лежит в копии проекта. Можно продолжить с того же места.", "The task was interrupted, but everything the agent managed to do is in the project copy. You can continue from there.")}</Text>
                <TextInput style={S.input} value={comment} onChangeText={setComment} placeholder={t("подсказка агенту (не обязательно)", "a hint for the agent (optional)")} placeholderTextColor={C.muted} />
                <Btn kind="primary" title={t("Продолжить", "Continue")} busy={busy} onPress={() => act(async () => (await client!.taskAction(task.id, { action: "more", comment }), setComment("")))} />
              </>
            )}
            <Btn
              kind="danger"
              title={t("Выбросить", "Discard")}
              busy={busy}
              onPress={() =>
                dialog(t("Выбросить?", "Discard?"), t("Всё, что сделала задача, пропадёт.", "Everything the task did will be gone."), [
                  { text: t("Отмена", "Cancel"), style: "cancel" },
                  { text: t("Выбросить", "Discard"), style: "destructive", onPress: () => act(() => client!.taskAction(task.id, { action: "discard" })) },
                ])
              }
            />
          </>
        ) : null}

        <Btn
          kind="danger"
          title={t("Удалить задачу", "Delete the task")}
          busy={busy}
          onPress={() =>
            dialog(t("Удалить задачу?", "Delete the task?"), t("Её сессии и копия проекта будут удалены.", "Its sessions and the project copy will be removed."), [
              { text: t("Отмена", "Cancel"), style: "cancel" },
              { text: t("Удалить", "Delete"), style: "destructive", onPress: () => act(async () => (await client!.deleteTask(task.id), back())) },
            ])
          }
        />
      </ScrollView>
    </View>
  );
}
