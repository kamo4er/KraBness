// Задачи на телефоне: список, новая задача, отчёт и решение. Конвейер ведёт хаб, экран только показывает.
import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { t, type TaskInfo, type TaskStep, tn, defaultTaskModels, engineName, modelOptions, parseModelKey, type NewSessionPrefs } from "@kamharn/client";
import { client, useEngines, useHub } from "../store.ts";
import { back, go, replace } from "../nav.ts";
import { Markdown } from "../Parts.tsx";
import { Btn, ListSheet } from "../ui.tsx";
import { dialog } from "../dialog.tsx";
import { C, S, mono } from "../theme.ts";
import { FolderPicker } from "./NewSession.tsx";

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
function nextNight(now = new Date()): number {
  const d = new Date(now);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
const iconColor = (s: TaskInfo["status"]): string => (s === "ready" ? "#e3b341" : s === "merged" ? C.ok : s === "failed" ? C.err : s === "running" ? C.accent : C.muted);

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
              <Btn title={`${taskIcon(x.status)}  ${x.title}`} onPress={() => go({ page: "task", id: x.id })} />
              <Text style={S.muted}>
                {STATUS()[x.status]}
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
const last: { worker?: string; review?: string } = {};

function NewTask({ onDone }: { onDone: () => void }) {
  const engines = useEngines();
  const [goal, setGoal] = useState("");
  const [dir, setDir] = useState("");
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  const [worker, setWorker] = useState(last.worker ?? "");
  const [review, setReview] = useState(last.review ?? "");
  const [pick, setPick] = useState<"worker" | "review">();
  const [night, setNight] = useState(false);
  const [busy, setBusy] = useState(false);
  const options = modelOptions(engines);
  const defs = defaultTaskModels(engines, prefs);
  // выбранное пропало (движок выключили, модель убрали) — берём умолчание
  const workerKey = options.some((o) => o.key === worker) ? worker : (defs.worker ?? "");
  const reviewKey = review === "none" || options.some((o) => o.key === review) ? review : (defs.review ?? "none");
  const label = (key: string) => {
    const o = options.find((x) => x.key === key);
    return o ? `${engineName(o.engine)} · ${o.model.name || o.model.modelId}` : t("нет доступных моделей", "no models available");
  };
  // в листе модели сгруппированы по движкам: заголовок у первой модели движка
  const sheet = options.map((o, i) => ({
    value: o.key,
    label: o.model.name || o.model.modelId,
    ...(o.model.free ? { hint: t("бесплатная", "free") } : {}),
    ...(i === 0 || options[i - 1]!.engine !== o.engine ? { group: engineName(o.engine) } : {}),
  }));
  useEffect(() => void client?.roots().then((r) => setDir((d) => d || r[0] || "")), []);
  useEffect(() => void client?.newSessionPrefs().then(setPrefs, () => {}), []);

  const create = async () => {
    setBusy(true);
    try {
      const w = parseModelKey(workerKey);
      const r = parseModelKey(reviewKey);
      const task = await client!.createTask({
        goal,
        directory: dir,
        ...(w ? { workerEngine: w.engine, workerModel: w.model } : {}),
        ...(reviewKey === "none" ? { reviewModel: null } : r ? { reviewEngine: r.engine, reviewModel: r.model } : {}),
        ...(night ? { startAt: nextNight() } : {}),
      });
      replace({ page: "task", id: task.id });
      onDone();
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
    }
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
      <FolderPicker value={dir} onChange={setDir} />
      <Text style={S.h3}>{t("Исполнитель", "Worker")}</Text>
      <Btn title={label(workerKey)} disabled={!options.length} onPress={() => setPick("worker")} />
      <Text style={S.h3}>{t("Ревью", "Review")}</Text>
      <Btn title={reviewKey === "none" ? t("без ревью", "no review") : label(reviewKey)} onPress={() => setPick("review")} />
      {reviewKey !== "none" && reviewKey === workerKey ? <Text style={S.muted}>{t("Ревью той же моделью видит меньше: лучше выбрать другую.", "A review by the same model catches less: better pick another one.")}</Text> : null}
      <Text style={S.muted}>{t("Исполнитель работает в своей копии проекта. Ревью лучше отдать другой модели: она замечает то, что исполнитель пропустил. Замечания возвращаются исполнителю (до 2 кругов).", "The worker runs in its own copy of the project. Give the review to a different model: it catches what the worker missed. Its remarks go back to the worker (up to 2 rounds).")}</Text>
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
          title={pick === "worker" ? t("Кто делает задачу", "Who does the task") : t("Кто делает ревью", "Who reviews")}
          options={pick === "worker" ? sheet : [{ value: "none", label: t("без ревью", "no review") }, ...sheet]}
          value={pick === "worker" ? workerKey : reviewKey}
          onPick={(key) => {
            // ListSheet зовёт onClose раньше onPick — поэтому смотрим на ключ, а не на pick
            if (pick === "worker") setWorker((last.worker = key));
            else setReview((last.review = key));
          }}
          onClose={() => setPick(undefined)}
        />
      ) : null}
    </ScrollView>
  );
}

export function Task({ id }: { id: string }) {
  const { tasks, sessions } = useHub();
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
  const title = (sid?: string) => sessions.find((s) => s.id === sid)?.title ?? t("открыть", "open");
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
        <Text style={[S.muted, { fontFamily: mono }]}>{task.directory}</Text>
        <Text style={S.text}>{task.goal}</Text>
        {task.error ? <Text style={S.error}>{task.error}</Text> : null}

        <Text style={S.h3}>{t("Шаги", "Steps")}</Text>
        {task.steps.map((s, i) => (
          <View key={i} style={{ gap: 4 }}>
            <Text style={S.text}>
              {s.status === "running" ? "…" : s.status === "failed" ? "✗" : "✓"} {STEP()[s.kind]}
              {s.model ? <Text style={S.muted}> · {s.model.modelId}</Text> : null}
              {s.note ? <Text style={S.muted}> · {s.note}</Text> : null}
            </Text>
            {s.sessionId ? <Btn small title={`${t("чат", "chat")}: ${title(s.sessionId)}`} onPress={() => go({ page: "session", id: s.sessionId! })} /> : null}
          </View>
        ))}

        {r ? (
          <>
            <Text style={S.h3}>{t("Отчёт", "Report")}</Text>
            <Text style={S.muted}>
              {t("Проверки", "Checks")}: {r.checks === "passed" ? t("прошли ✓", "passed ✓") : r.checks === "failed" ? t("не прошли ✗", "failed ✗") : t("не настроены", "not configured")} · {t("ревью", "review")}:{" "}
              {r.review === "ok" ? t("замечаний нет", "no remarks") : r.review === "fixed" ? t("замечания исправлены", "remarks fixed") : r.review === "remarks" ? t("остались замечания", "remarks left") : t("не делали", "skipped")}
              {r.commit ? ` · ${t("коммит", "commit")} ${r.commit}` : ""}
            </Text>
            {r.summary ? <Markdown text={r.summary} /> : null}
            {r.files.length ? <Text style={[S.muted, { fontFamily: mono }]}>{r.files.map((f) => `${f.status}  ${f.path}`).join("\n")}</Text> : null}
            {r.review === "remarks" && r.reviewText ? (
              <>
                <Text style={S.h3}>{t("Замечания ревью", "Review remarks")}</Text>
                <Markdown text={r.reviewText} />
              </>
            ) : null}
          </>
        ) : null}

        {task.status === "ready" ? (
          <>
            <Text style={S.h3}>{t("Решение", "Decision")}</Text>
            <Btn kind="primary" title={t("Влить в основную ветку", "Merge into the main branch")} busy={busy} onPress={() => act(() => client!.taskAction(task.id, { action: "merge" }))} />
            <TextInput style={S.input} value={comment} onChangeText={setComment} placeholder={t("что доработать", "what to improve")} placeholderTextColor={C.muted} />
            <Btn title={t("Ещё круг", "One more round")} disabled={!comment.trim()} busy={busy} onPress={() => act(async () => (await client!.taskAction(task.id, { action: "more", comment }), setComment("")))} />
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
