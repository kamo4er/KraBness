// Новая сессия: движок, модель, папка (навигация по разрешённым), режим подтверждений.
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { ago, baseName, type ClaudeTranscript, type EngineId, type FsEntry, type ModelRef, type NewSessionPrefs, type PermissionMode, t } from "@kamharn/client";
import { client, recall, remember, useEngines, useHub } from "../store.ts";
import { EffortPicker, effortKey } from "../effort.tsx";
import { back, replace } from "../nav.ts";
import { Btn, Picker } from "../ui.tsx";
import { C, S } from "../theme.ts";

/** режимы подтверждений — функцией: подписи на текущем языке */
export const MODES = (): Array<{ id: PermissionMode; label: string; hint: string }> => [
  { id: "manual", label: t("Спрашивать всё", "Ask everything"), hint: t("и команды, и правки файлов", "both commands and file edits") },
  { id: "acceptEdits", label: t("Правки без вопросов", "Edits without asking"), hint: t("спрашивать только команды", "ask only for commands") },
  { id: "auto", label: t("Автономно", "Autonomous"), hint: t("без вопросов (claude: классификатор безопасности)", "no questions (claude: safety classifier)") },
];

const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

export function NewSession({ group: initialGroup }: { group?: string }) {
  const engines = useEngines();
  const { groups, sessions } = useHub();
  // новая сессия в группе: движок, модель, папка и режим — как у последней сессии группы
  const [tpl] = useState(() => (initialGroup ? sessions.find((s) => s.groupId === initialGroup) : undefined));
  const [group, setGroup] = useState(initialGroup ?? "");
  // движки и выбор по умолчанию — из настроек хаба («Настройки → Движки»), а не «последний выбранный»
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  const [engine, setEngine] = useState<EngineId | undefined>(() => tpl?.engine);
  useEffect(() => {
    void client?.newSessionPrefs().then(
      (p) => (setPrefs(p), setEngine((e) => (e && p.engines.includes(e) ? e : p.engine))),
      () => setEngine((e) => e ?? "opencode"),
    );
  }, []);
  const [model, setModel] = useState<string>();
  const [dir, setDir] = useState<string | undefined>(() => (tpl ? (tpl.worktree?.repo ?? tpl.directory) : recall<string>("dir")));
  const [mode, setMode] = useState<PermissionMode>(() => tpl?.permissionMode ?? recall<PermissionMode>("mode") ?? "acceptEdits");
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const info = engines?.find((e) => e.id === engine);
  const models = info?.models ?? [];
  // уровень рассуждений — свой у каждой модели, помним последний выбор для модели
  const efforts = models.find((m) => key(m) === model)?.efforts ?? [];
  const [effort, setEffort] = useState("");
  useEffect(() => setEffort((model && recall<string>(effortKey(model))) || ""), [model]);

  // модель: как у группы → из настроек → последняя для движка → дефолт движка → первая рабочая
  useEffect(() => {
    if (!info || !engine) return;
    const online = (k?: string) => !!k && models.some((m) => key(m) === k && !m.offline);
    const group = tpl && tpl.engine === engine ? key(tpl.model) : undefined;
    const pref = prefs?.models[engine] && key(prefs.models[engine]!);
    const last = recall<string>(`model.${engine}`);
    const def = info.defaultModel && key(info.defaultModel);
    const first = models.find((m) => !m.offline);
    setModel([group, pref, last, def].find((k) => online(k)) ?? (first && key(first)) ?? undefined);
  }, [info, engine, prefs]);

  useEffect(() => {
    if (!dir) void client?.roots().then((r) => r[0] && setDir((d) => d ?? r[0]));
  }, []);

  const missing = !engines ? "" : !info?.available ? t("Движок недоступен", "Engine unavailable") : !model ? t("Нет доступной модели", "No model available") : !dir ? t("Выбери папку", "Pick a folder") : "";

  async function create() {
    if (!dir || !model || !engine) return;
    setBusy(true);
    setError(undefined);
    const [providerId, ...rest] = model.split("/");
    try {
      const s = await client!.createSession({
        engine,
        directory: dir,
        model: { providerId: providerId!, modelId: rest.join("/") },
        permissionMode: mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(branch ? { worktree: true } : {}),
        ...(group ? { groupId: group } : {}),
        ...(effort && efforts.includes(effort) ? { effort } : {}),
      });
      remember(`model.${engine}`, model);
      remember(effortKey(model), effort);
      remember("dir", dir);
      remember("mode", mode);
      replace({ page: "session", id: s.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={S.h1}>{t("Новая сессия", "New session")}</Text>
      </View>
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        <Text style={S.h3}>{t("Движок", "Engine")}</Text>
        {!engines ? <Text style={S.muted}>{t("загрузка…", "loading…")}</Text> : null}
        <View style={st.cards}>
          {engines?.filter((e) => !prefs || prefs.engines.includes(e.id)).map((e) => (
            <Card key={e.id} on={engine === e.id} disabled={!e.available} onPress={() => setEngine(e.id)}
              title={e.id === "claude" ? "Claude Code" : "opencode"}
              hint={e.available ? (e.id === "claude" ? t("подписка Claude", "Claude subscription") : t("локальные и другие модели", "local and other models")) : e.error ?? t("недоступен", "unavailable")} />
          ))}
        </View>

        <Text style={S.h3}>{t("Модель", "Model")}</Text>
        <Picker
          title={t("Модель", "Model")}
          value={model}
          placeholder="—"
          options={models.map((m, i) => ({
            value: key(m),
            label: m.name + (m.offline ? ` · ${t("не запущена", "not running")}` : m.free ? " · free" : ""),
            disabled: m.offline,
            ...(i === 0 || models[i - 1]!.providerId !== m.providerId ? { group: m.providerId } : {}),
          }))}
          onChange={setModel}
          style={st.picker}
        />
        <EffortPicker efforts={efforts} value={effort} onChange={setEffort} style={[st.picker, { marginTop: 8 }]} />

        <Text style={S.h3}>{t("Папка", "Folder")}</Text>
        <FolderPicker value={dir} onChange={setDir} />

        <Text style={S.h3}>{t("Подтверждения", "Approvals")}</Text>
        <View style={st.cards}>
          {MODES().map((m) => (
            <Card key={m.id} on={mode === m.id} onPress={() => setMode(m.id)} title={m.label} hint={m.hint} />
          ))}
        </View>

        {groups.length ? (
          <>
            <Text style={S.h3}>{t("Группа", "Group")}</Text>
            <Picker
              title={t("Группа", "Group")}
              value={group}
              options={[{ value: "", label: t("Без группы", "No group") }, ...groups.map((g) => ({ value: g.id, label: `${g.icon ?? "📁"} ${g.name}`, ...(g.prompt ? { hint: t("свой системный промпт", "custom system prompt") } : {}) }))]}
              onChange={setGroup}
            />
          </>
        ) : null}

        <Text style={S.h3}>{t("Название (необязательно)", "Title (optional)")}</Text>
        <TextInput style={S.input} value={title} onChangeText={setTitle} placeholder={t("например: разбор логов", "e.g. log analysis")} placeholderTextColor={C.muted} />

        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 16 }}>
          <View style={{ flex: 1 }}>
            <Text style={[S.text, { fontWeight: "700" }]}>{t("В отдельной ветке", "In a separate branch")}</Text>
            <Text style={S.muted}>{t("Агент работает в своей копии проекта и не мешает другим сессиям. Потом «Влить» одним коммитом или «Выбросить».", "The agent works in its own copy of the project and doesn't disturb other sessions. Later “Merge” as one commit or “Discard”.")}</Text>
          </View>
          <Switch value={branch} onValueChange={setBranch} />
        </View>

        {error ? <Text style={S.error}>{error}</Text> : null}
        <Btn kind="primary" title={t("Создать", "Create")} busy={busy} disabled={!!missing || !engines} onPress={() => void create()} style={st.create} />
        {missing ? <Text style={[S.muted, { textAlign: "center" }]}>{missing}</Text> : null}

        <ImportClaude />
      </ScrollView>
    </View>
  );
}

function Card(props: { on: boolean; disabled?: boolean; onPress: () => void; title: string; hint: string }) {
  return (
    <Pressable onPress={props.disabled ? undefined : props.onPress} style={[st.card, props.on && st.cardOn, props.disabled && { opacity: 0.45 }]}>
      <Text style={[S.text, { fontWeight: "700" }]}>{props.title}</Text>
      <Text style={S.muted}>{props.hint}</Text>
    </Pressable>
  );
}

/** Продолжить в KamHarn сессию, начатую в Claude Code (терминал, VS Code). */
function ImportClaude() {
  const [list, setList] = useState<ClaudeTranscript[]>();
  const [hidden, setHidden] = useState<ClaudeTranscript[]>();
  const [showHidden, setShowHidden] = useState(false);
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const load = () => {
    client?.claudeTranscripts().then(setList, () => setList([]));
    client?.claudeTranscripts(true).then(setHidden, () => setHidden([]));
  };
  useEffect(load, []);

  const q = query.trim().toLowerCase();
  const found = useMemo(() => (list ?? []).filter((x) => !q || x.title.toLowerCase().includes(q) || baseName(x.directory).toLowerCase().includes(q)), [list, q]);
  // развёрнуто или поиск — по проектам; иначе 5 последних
  const groups = useMemo(() => {
    const m = new Map<string, ClaudeTranscript[]>();
    for (const x of found) m.set(baseName(x.directory), [...(m.get(baseName(x.directory)) ?? []), x]);
    return [...m.entries()];
  }, [found]);
  if (!list?.length && !hidden?.length) return null;
  const grouped = all || !!q;

  async function open(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      const s = await client!.importClaude(id);
      replace({ page: "session", id: s.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  }

  const hide = (id: string, h: boolean) =>
    client!.hideTranscript(id, h).then(load, (e: Error) => setError(e.message));

  const row = (tr: ClaudeTranscript, isHidden = false) => (
    <View key={tr.id} style={[st.card, { gap: 6 }]}>
      <Text style={[S.text, { fontWeight: "600" }]} numberOfLines={2}>
        {tr.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        {!grouped || isHidden ? <Text style={st.proj}>{baseName(tr.directory)}</Text> : null}
        <Text style={[S.muted, { flex: 1 }]} numberOfLines={1}>
          {tr.source === "vscode" ? "VS Code" : tr.source === "cli" ? t("терминал", "terminal") : "Claude Code"} · {ago(tr.updatedAt)}
        </Text>
        {isHidden ? (
          <Btn small title={t("Вернуть", "Restore")} onPress={() => void hide(tr.id, false)} />
        ) : (
          <>
            <Btn small kind="ghost" title={t("Скрыть", "Hide")} onPress={() => void hide(tr.id, true)} />
            <Btn small title={t("Продолжить", "Continue")} busy={busy === tr.id} disabled={!!busy} onPress={() => void open(tr.id)} />
          </>
        )}
      </View>
    </View>
  );

  return (
    <>
      <Text style={S.h3}>{t("Или продолжить сессию Claude Code", "Or continue a Claude Code session")}</Text>
      <Text style={[S.muted, { marginBottom: 8 }]}>{t("Из VS Code или терминала. Откроется копия с историей — исходная сессия не меняется. «Скрыть» убирает только отсюда.", "From VS Code or the terminal. A copy with the history opens — the original session isn't changed. “Hide” only removes it from here.")}</Text>
      {(list?.length ?? 0) > 5 ? (
        <TextInput style={[S.input, { marginBottom: 8 }]} placeholder={t("Поиск по тексту или проекту", "Search by text or project")} placeholderTextColor={C.muted} value={query} onChangeText={setQuery} />
      ) : null}
      {grouped ? (
        groups.map(([proj, items]) => (
          <View key={proj} style={{ marginBottom: 6 }}>
            <Text style={st.groupHead}>
              {proj} <Text style={S.muted}>· {items.length}</Text>
            </Text>
            <View style={st.cards}>{items.map((x) => row(x))}</View>
          </View>
        ))
      ) : (
        <View style={st.cards}>{found.slice(0, 5).map((x) => row(x))}</View>
      )}
      {q && !found.length ? <Text style={S.muted}>{t("Ничего не нашлось.", "Nothing found.")}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        {!q && (list?.length ?? 0) > 5 ? <Btn small title={all ? t("Свернуть", "Collapse") : `${t("Показать все", "Show all")} (${list!.length})`} onPress={() => setAll(!all)} /> : null}
        {(hidden?.length ?? 0) > 0 ? <Btn small kind="ghost" title={showHidden ? t("Убрать скрытые", "Hide hidden") : `${t("Скрытые", "Hidden")} (${hidden!.length})`} onPress={() => setShowHidden(!showHidden)} /> : null}
      </View>
      {showHidden && hidden ? <View style={[st.cards, { marginTop: 8, opacity: 0.75 }]}>{hidden.map((x) => row(x, true))}</View> : null}
      {error ? <Text style={S.error}>{error}</Text> : null}
    </>
  );
}

export function FolderPicker({ value, onChange }: { value?: string; onChange: (p: string) => void }) {
  const [cwd, setCwd] = useState<string | undefined>(value);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void client?.roots().then(setRoots);
  }, []);

  useEffect(() => {
    setError(undefined);
    client
      ?.list(cwd)
      .then((es) => setEntries(es.filter((e) => e.dir)))
      .catch((e) => {
        setError((e as Error).message);
        setCwd(undefined);
      });
  }, [cwd]);

  const root = roots.find((r) => cwd && cwd.toLowerCase().startsWith(r.toLowerCase()));
  const up = cwd && root && cwd.length > root.length ? cwd.replace(/[\\/][^\\/]+$/, "") : undefined;

  return (
    <View style={st.folders}>
      <View style={st.folderBar}>
        <Btn small title="⌂" onPress={() => setCwd(undefined)} />
        {cwd ? <Btn small title="↑" disabled={!up} onPress={() => up && setCwd(up)} /> : null}
        <Text style={[S.muted, { flex: 1 }]} numberOfLines={2}>
          {cwd ?? t("Разрешённые папки", "Allowed folders")}
        </Text>
        {cwd ? <Btn small kind={value === cwd ? "primary" : "default"} title={value === cwd ? "✓" : t("Выбрать", "Select")} onPress={() => onChange(cwd)} /> : null}
      </View>
      {error ? <Text style={S.error}>{error}</Text> : null}
      {entries.map((e) => (
        <View key={e.path} style={st.folderRow}>
          <Pressable style={{ flex: 1, paddingVertical: 10 }} onPress={() => setCwd(e.path)}>
            <Text style={[S.text, value === e.path && { color: C.accent }]} numberOfLines={1}>
              📁 {cwd ? e.name : e.path}
            </Text>
          </Pressable>
          <Btn small kind={value === e.path ? "primary" : "default"} title={value === e.path ? "✓" : t("Выбрать", "Select")} onPress={() => onChange(e.path)} />
        </View>
      ))}
      {!entries.length && !error ? <Text style={[S.muted, { padding: 10 }]}>{t("Подпапок нет", "No subfolders")}</Text> : null}
      {value ? <Text style={[S.muted, { padding: 8 }]}>{t("Выбрано", "Selected")}: {value}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  proj: { color: C.text, backgroundColor: C.bg3, borderRadius: 4, paddingHorizontal: 6, fontSize: 12, overflow: "hidden" },
  groupHead: { color: C.text, fontWeight: "600", fontSize: 13, marginBottom: 4, marginLeft: 2 },
  body: { padding: 16, paddingBottom: 40 },
  cards: { gap: 8 },
  card: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 12, gap: 2 },
  cardOn: { borderColor: C.accent, backgroundColor: "#16233a" },
  picker: { minHeight: 44 },
  folders: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line, overflow: "hidden" },
  folderBar: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  folderRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  create: { marginTop: 24, minHeight: 50 },
});
