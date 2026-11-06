// Чат сессии: стрим сообщений, инструменты, подтверждения, смена модели и режима, отправка и остановка.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, FlatList, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, ToastAndroid, View, type TextInputInstance } from "react-native";
import { limitView, resolveFileRef, sessionActions, sessionSummary, type FileRef, type ClaudeLimits, type ListeningPort, type MessageView, type PermissionMode, type SessionActionId, type SessionInfo, type SlashCommand, type FileHit, t, locale } from "@kamharn/client";
import { client, fmtSize, useEngines, useHub, useQuickPrompts } from "../store.ts";
import { loadChat } from "../cache.ts";
import { getDraft, getDraftFiles, setDraft, setDraftFiles } from "../drafts.ts";
import { sayMessage, speakable, toggleSpeak, useSpeaking } from "../speak.ts";
import { setTalk, talkPart, useTalk } from "../talk.ts";
import { pickFiles, pickPhotos, takePhoto, upload, type Picked } from "../files.ts";
import { useDictation, voiceAvailable } from "../voice.ts";
import { back, go, replace } from "../nav.ts";
import { MODES } from "./NewSession.tsx";
import { FileChip, FileRefCtx, PartView, PermissionCard, QuestionCard } from "../Parts.tsx";
import { Btn, ConnDot, EngineBadge, ListSheet } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";
import { dialog } from "../dialog.tsx";
import { pickOpencodeModel } from "../modelPick.tsx";
import { SessionUsage } from "../Usage.tsx";
import { MentionList, useMention } from "../mention.tsx";
import { CopyActions, copyableText } from "../copy.tsx";
import { ArtifactSendCtx, ArtifactVisibleCtx } from "../Artifact.tsx";

/** Автопроверка с телефона: включить с командами проекта (сохранёнными или предложенными), прогнать сейчас. Править команды удобнее в вебе. */
async function checksMenu(id: string, on: boolean): Promise<void> {
  const cfg = await client!.checks(id);
  const commands = cfg.commands.length ? cfg.commands : cfg.suggested;
  if (!commands.length) {
    dialog(t("Нет команд проверки", "No check commands"), t("Не нашёл тестов в проекте. Задай команды в вебе на ПК: ⋯ → Автопроверка в шапке чата.", "No tests found in the project. Set the commands in the web UI on the PC: ⋯ → Auto-check in the chat header."));
    return;
  }
  const save = async () => {
    if (!cfg.commands.length) await client!.setChecks(id, commands);
  };
  dialog(t("Автопроверка", "Auto-check"), `${commands.join("\n")}\n\n${cfg.commands.length ? "" : t("(предложены по файлам проекта)", "(suggested from the project files)")}`.trim(), [
    on
      ? { text: t("Выключить", "Turn off"), onPress: () => void client!.updateSession(id, { autoCheck: false }) }
      : { text: t("Включить", "Turn on"), onPress: () => void save().then(() => client!.updateSession(id, { autoCheck: true })) },
    { text: t("Проверить сейчас", "Check now"), onPress: () => void save().then(() => client!.runChecks(id)) },
    { text: t("Закрыть", "Close"), style: "cancel" },
  ]);
}

export function Chat({ id }: { id: string }) {
  const state = useHub();
  const view = state.views[id];
  const info = state.sessions.find((s) => s.id === id) ?? view?.info;
  // тап по пути к файлу в ответе — просмотр проекта на этом файле (стабильная ссылка: иначе перерисуется весь markdown)
  const dir = info?.directory;
  const openRef = useCallback((r: FileRef) => dir && go({ page: "project", id, file: resolveFileRef(r, dir), ...(r.line ? { line: r.line } : {}) }), [id, dir]);
  // «Отправить агенту» у ошибки живой страницы — сообщением в эту сессию
  const sendToAgent = useCallback((text: string) => void client?.prompt(id, text).catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message)), [id]);
  const list = useRef<FlatList<MessageView>>(null);
  const [showDown, setShowDown] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  const matchesRef = useRef<number[]>([]);
  const [showOld, setShowOld] = useState(false);
  // какие сообщения на экране: живые страницы вне экрана WebView не держат (FlatList хочет постоянные колбэк и настройки)
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(new Set());
  // тот же набор — без нового Set: иначе каждый сдвиг ленты перерисовывал бы весь чат
  const onViewable = useRef(({ viewableItems }: { viewableItems: Array<{ key?: string }> }) => {
    const next = viewableItems.flatMap((v) => (v.key ? [v.key] : []));
    setOnScreen((cur) => (next.length === cur.size && next.every((k) => cur.has(k)) ? cur : new Set(next)));
  });
  const viewability = useRef({ itemVisiblePercentThreshold: 1 });
  // режим «Разговор»: агент закончил ход — начало ответа звучит вслух
  const talk = useTalk(id, info?.kind === "dispatcher");
  const wasBusy = useRef(false);
  useEffect(() => {
    const nowBusy = info?.status === "busy" || info?.status === "retry";
    if (wasBusy.current && !nowBusy && talk && view) {
      const last = [...view.messages].reverse().find((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && p.text.trim()));
      const md = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n") ?? "";
      const part = talkPart(md);
      if (last && part) sayMessage(last.info.id, part);
    }
    wasBusy.current = nowBusy;
  }, [info?.status]);
  const queryKey = search?.trim().toLowerCase() ?? "";
  // новый запрос — к самому свежему совпадению
  useEffect(() => {
    const first = matchesRef.current[0];
    if (first !== undefined) list.current?.scrollToIndex({ index: first, viewPosition: 0.5, animated: true });
  }, [queryKey]);

  useEffect(() => {
    // сначала то, что сохранено на телефоне: тогда хаб пришлёт только новое
    if (client && !client.state.views[id]) {
      const cached = loadChat(id);
      if (cached) client.hydrate(id, cached);
    }
    client?.openSession(id);
    return () => client?.closeSession(id);
  }, [id]);

  if (!info) {
    return (
      <View style={[S.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={S.muted}>{state.conn === "online" ? t("Сессия не найдена.", "Session not found.") : t("Загрузка…", "Loading…")}</Text>
        <Btn title={t("Назад", "Back")} onPress={back} style={{ marginTop: 12 }} />
      </View>
    );
  }

  const busy = info.status === "busy" || info.status === "retry";
  const all = (view?.messages ?? []).filter((m) => m.parts.length > 0);
  // после сжатия контекста ранние сообщения свёрнуты (агент их помнит только пересказом); поиск ищет по всем
  const cut = Math.max(0, all.findLastIndex((m) => m.parts.some((p) => p.type === "compaction")));
  const q = search?.trim().toLowerCase() ?? "";
  const messages = all.slice(showOld || q ? 0 : cut).reverse();
  // поиск: индексы найденных сообщений (0 — самое новое), hit — текущее
  const matches = q ? messages.flatMap((m, i) => (messageText(m).includes(q) ? [i] : [])) : [];
  matchesRef.current = matches;
  const current = matches.length ? matches[Math.min(hit, matches.length - 1)] : undefined;
  const highlightId = current !== undefined ? messages[current]?.info.id : undefined;

  const scrollTo = (index: number) => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  const goHit = (h: number) => {
    if (!matches.length) return;
    const next = (h + matches.length) % matches.length;
    setHit(next);
    scrollTo(matches[next]!);
  };

  return (
    // подъём над клавиатурой — общий, в App.tsx
    <FileRefCtx.Provider value={openRef}>
    <ArtifactSendCtx.Provider value={sendToAgent}>
    <View style={S.screen}>
      {search !== null ? (
        <View style={[S.head, st.searchBar]}>
          <Btn small kind="ghost" title="✕" onPress={() => (setSearch(null), setHit(0))} />
          <TextInput
            style={[S.input, { flex: 1, paddingVertical: 6 }]}
            autoFocus
            placeholder={t("Поиск в чате…", "Search in chat…")}
            placeholderTextColor={C.muted}
            value={search}
            onChangeText={(t) => {
              setSearch(t);
              setHit(0);
            }}
            onSubmitEditing={() => goHit(hit + 1)}
            returnKeyType="search"
          />
          <Text style={[S.muted, { minWidth: 44, textAlign: "center" }]}>{q ? (matches.length ? `${Math.min(hit, matches.length - 1) + 1}/${matches.length}` : "0") : ""}</Text>
          <Btn small title="↑" disabled={!matches.length} onPress={() => goHit(hit + 1)} />
          <Btn small title="↓" disabled={!matches.length} onPress={() => goHit(hit - 1)} />
        </View>
      ) : (
        <Header info={info} conn={state.conn} onSearch={() => setSearch("")} talk={talk} />
      )}
      {info.engine === "claude" ? <LimitBanner limits={state.limits} sessionId={id} /> : null}
      {info.resumeAt ? <ResumeBanner sessionId={id} at={info.resumeAt} /> : null}
      <View style={{ flex: 1 }}>
      {/* inverted: новое снизу, и список сам держится у низа при стриме и пачках событий */}
      <FlatList
        ref={list}
        inverted
        // пролистал вверх и читаешь — новые сообщения внизу не сдвигают текст; у самого низа — держимся низа
        maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 60 }}
        data={messages}
        keyExtractor={(m) => m.info.id}
        renderItem={({ item }) => (
          <ArtifactVisibleCtx.Provider value={onScreen.has(item.info.id)}>
            <Message m={item} highlight={item.info.id === highlightId} />
          </ArtifactVisibleCtx.Provider>
        )}
        extraData={onScreen}
        onViewableItemsChanged={onViewable.current}
        viewabilityConfig={viewability.current}
        contentContainerStyle={st.messages}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => setShowDown(e.nativeEvent.contentOffset.y > 400)}
        scrollEventThrottle={100}
        // высоты сообщений разные: прыгаем примерно, потом точно
        onScrollToIndexFailed={(f) => {
          list.current?.scrollToOffset({ offset: f.averageItemLength * f.index, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index: f.index, viewPosition: 0.5, animated: true }), 150);
        }}
        // inverted: подвал списка — наверху
        ListFooterComponent={
          cut > 0 && !showOld && !q ? (
            <Pressable onPress={() => setShowOld(true)} hitSlop={8} style={{ alignSelf: "center", paddingVertical: 10 }}>
              <Text style={{ color: C.accent }}>{t(`Показать ранние сообщения: ${cut}`, `Show earlier messages: ${cut}`)}</Text>
            </Pressable>
          ) : undefined
        }
        ListHeaderComponent={
          <View style={{ gap: 8 }}>
            {view?.errors.map((e, i) => (
              <Text key={i} style={st.error}>
                {e}
              </Text>
            ))}
            {busy ? <Text style={st.working}>{info.status === "retry" ? t("⟳ повторная попытка…", "⟳ retrying…") : t("⋯ работает", "⋯ working")}</Text> : null}
          </View>
        }
      />
      {showDown ? (
        <Pressable style={({ pressed }) => [st.down, pressed && { opacity: 0.7 }]} onPress={() => list.current?.scrollToOffset({ offset: 0, animated: true })}>
          <Text style={{ color: C.text, fontSize: 20 }}>↓</Text>
        </Pressable>
      ) : null}
      </View>
      {view?.permissions.map((p) => <PermissionCard key={p.id} sessionId={id} req={p} />)}
      {view?.questions.map((q) => <QuestionCard key={q.id} sessionId={id} req={q} />)}
      <Composer key={id} sessionId={id} busy={busy} slash={info.engine === "claude"} talk={talk} />
    </View>
    </ArtifactSendCtx.Provider>
    </FileRefCtx.Provider>
  );
}

type ParamSheet = "model" | "effort" | "mode";

/**
 * Шапка чата: ←, название, связь и ⋯; ниже одна плашка «модель · рассуждение · подтверждения» во всю ширину,
 * под ней плашки включённого (ветка, автопроверка, разговор, бот). Пункты меню — общие с вебом (sessionActions).
 */
function Header({ info, conn, onSearch, talk }: { info: SessionInfo; conn: ReturnType<typeof useHub>["conn"]; onSearch: () => void; talk: boolean }) {
  const engines = useEngines();
  const { limits } = useHub();
  const models = engines?.find((e) => e.id === info.engine)?.models ?? [];
  const key = (m: { providerId: string; modelId: string }) => `${m.providerId}/${m.modelId}`;
  const modelOptions = models.map((m, i) => ({
    value: key(m),
    label: m.name + (m.offline ? ` · ${t("не запущена", "not running")}` : m.free ? " · free" : ""),
    disabled: m.offline,
    ...(i === 0 || models[i - 1]!.providerId !== m.providerId ? { group: m.providerId } : {}),
  }));
  if (!models.some((m) => key(m) === key(info.model))) modelOptions.unshift({ value: key(info.model), label: info.model.modelId, disabled: false });
  const efforts = models.find((m) => key(m) === key(info.model))?.efforts ?? [];
  // сохранённый уровень мог не подойти модели — тогда «по умолчанию»
  const effort = info.effort && efforts.includes(info.effort) ? info.effort : "";

  const [preview, setPreview] = useState(false);
  const [sheet, setSheet] = useState<ParamSheet>();
  const [bot, setBot] = useState<boolean>();
  // подключён ли бот в Telegram — для плашки; не ответил — просто без неё.
  // Экран чата пересоздаётся при возврате с экрана бота; заново — ещё и когда приложение снова на экране (бота могли подключить с ПК)
  useEffect(() => {
    let alive = true;
    const load = () =>
      client?.sessionBot(info.id).then(
        (b) => alive && setBot(b.configured),
        () => {},
      );
    void load();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void load());
    return () => {
      alive = false;
      sub.remove();
    };
  }, [info.id]);
  const fail = (e: Error) => dialog(t("Не получилось", "Failed"), e.message);
  const actions = sessionActions(info, { platform: "mobile", talk, bot });
  const pills = actions.filter((a) => a.pill);

  const act = (id: SessionActionId) => {
    if (id === "project") go({ page: "project", id: info.id });
    else if (id === "preview") setPreview(true);
    else if (id === "worktree") void worktreeMenu(info);
    else if (id === "checks") void checksMenu(info.id, !!info.autoCheck).catch(fail);
    else if (id === "talk") setTalk(info.id, !talk);
    else if (id === "bot") go({ page: "sessionBot", id: info.id });
    else if (id === "search") onSearch();
    else if (id === "compact")
      dialog(
        t("Сжать контекст?", "Compact the context?"),
        t("Агент заменит историю коротким пересказом: главное запомнит, мелкие подробности забудет. Ранние сообщения в чате свернутся.", "The agent replaces the history with a short summary: it keeps the essentials and forgets small details. Earlier messages in the chat get collapsed."),
        [
          { text: t("Отмена", "Cancel"), style: "cancel" },
          { text: t("Сжать", "Compact"), onPress: () => void client?.compact(info.id).catch(fail) },
        ],
      );
    else if (id === "delete")
      dialog(t("Удалить сессию?", "Delete the session?"), t(`«${info.title}» пропадёт из KraBness, файлы в папке останутся.`, `“${info.title}” will be removed from KraBness, files in the folder stay.`), [
        { text: t("Отмена", "Cancel"), style: "cancel" },
        { text: t("Удалить", "Delete"), style: "destructive", onPress: () => void client?.deleteSession(info.id).then(back, fail) },
      ]);
  };

  // плашки открывают своё; у «Разговора» открывать нечего — спрашиваем, а не выключаем молча
  const pill = (id: SessionActionId) =>
    id === "talk"
      ? dialog(t("Разговор включён", "Talk mode is on"), t("Выключил микрофон — сообщение ушло само, ответ звучит вслух.", "Mic off — the message is sent by itself, the answer is read aloud."), [
          { text: t("Оставить", "Keep"), style: "cancel" },
          { text: t("Выключить", "Turn off"), onPress: () => setTalk(info.id, false) },
        ])
      : act(id);

  const menu = () =>
    dialog(
      info.title,
      undefined,
      [
        ...actions.map((a) => ({
          text: a.on === undefined ? a.label : `${a.label}: ${a.on ? t("вкл", "on") : t("выкл", "off")}`,
          icon: a.icon,
          hint: a.hint,
          ...(a.danger ? { style: "destructive" as const } : {}),
          onPress: () => act(a.id),
        })),
        { text: t("Закрыть", "Close"), style: "cancel" as const },
      ],
      { cancelable: true },
    );

  const lv = info.engine === "claude" ? limitView(limits) : undefined;
  const params = () =>
    dialog(t("Параметры сессии", "Session settings"), lv ? `${t("Лимиты Claude", "Claude limits")}: ${t("5ч", "5h")} ${lv.fiveHour ?? "—"}% · ${t("неделя", "week")} ${lv.sevenDay ?? "—"}%` : undefined, [
      { text: t("Модель", "Model"), icon: "🧠", hint: modelOptions.find((o) => o.value === key(info.model))?.label ?? info.model.modelId, onPress: () => setSheet("model") },
      ...(efforts.length ? [{ text: t("Рассуждение", "Reasoning"), icon: "💭", hint: effort || "auto", onPress: () => setSheet("effort") }] : []),
      { text: t("Подтверждения", "Approvals"), icon: "🔒", hint: MODES().find((m) => m.id === info.permissionMode)?.label ?? info.permissionMode, onPress: () => setSheet("mode") },
      ...(info.engine === "claude" ? [{ text: t("Продолжить на бесплатной модели", "Continue on a free model"), icon: "→", hint: t("новая сессия opencode с выжимкой этой", "a new opencode session with a summary of this one"), onPress: () => handoff(info.id) }] : []),
      { text: t("Закрыть", "Close"), style: "cancel" as const },
    ]);

  return (
    <View style={[S.head, st.head]}>
      <PreviewSheet sessionId={info.id} visible={preview} onClose={() => setPreview(false)} />
      <ListSheet
        visible={sheet === "model"}
        title={t("Модель", "Model")}
        options={modelOptions}
        value={key(info.model)}
        onClose={() => setSheet(undefined)}
        onPick={(v) => {
          const m = models.find((x) => key(x) === v);
          if (m && v !== key(info.model)) client?.updateSession(info.id, { model: { providerId: m.providerId, modelId: m.modelId } }).catch(fail);
        }}
      />
      <ListSheet
        visible={sheet === "effort"}
        title={t("Сколько модель думает перед ответом", "How hard the model thinks before answering")}
        options={[{ value: "", label: "auto", hint: t("по умолчанию: как решит модель", "default: as the model decides") }, ...efforts.map((x) => ({ value: x, label: x }))]}
        value={effort}
        onClose={() => setSheet(undefined)}
        onPick={(v) => v !== effort && client?.updateSession(info.id, { effort: v }).catch(fail)}
      />
      <ListSheet
        visible={sheet === "mode"}
        title={t("Подтверждения", "Approvals")}
        options={MODES().map((m) => ({ value: m.id, label: m.label, hint: m.hint }))}
        value={info.permissionMode}
        onClose={() => setSheet(undefined)}
        onPick={(v) => v !== info.permissionMode && client?.updateSession(info.id, { permissionMode: v as PermissionMode }).catch(fail)}
      />
      <View style={st.headRow}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={S.h2} numberOfLines={1}>
            {info.title}
          </Text>
          <SessionUsage id={info.id} full />
        </View>
        <ConnDot conn={conn} />
        <Btn small kind="ghost" title="⋯" onPress={menu} />
      </View>
      <Pressable style={({ pressed }) => [st.paramChip, pressed && { opacity: 0.7 }]} onPress={params}>
        <EngineBadge engine={info.engine} />
        <Text style={st.paramChipText} numberOfLines={1}>
          {sessionSummary(info, models)}
        </Text>
        <Text style={st.paramChipCaret}>▾</Text>
      </Pressable>
      {pills.length ? (
        <View style={st.pills}>
          {pills.map((a) => (
            <Pressable key={a.id} style={({ pressed }) => [st.pill, pressed && { opacity: 0.7 }]} hitSlop={4} onPress={() => pill(a.id)}>
              <Text style={st.pillText} numberOfLines={1}>
                {a.pill}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Текст сообщения для поиска: реплики, ответы, заголовки инструментов, имена файлов. */
function messageText(m: MessageView): string {
  return m.parts
    .map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : p.type === "tool" ? `${p.tool} ${p.title ?? ""}` : p.type === "file" ? p.name : ""))
    .join("\n")
    .toLowerCase();
}

/** Пересказ разговора после сжатия: то, что агент помнит о ранних сообщениях. Свёрнут. */
function Summary({ m }: { m: MessageView }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={st.assistant}>
      <Pressable onPress={() => setOpen(!open)} hitSlop={8}>
        <Text style={S.muted}>
          {open ? "▾" : "▸"} {t("Что агент помнит о разговоре (пересказ)", "What the agent remembers of the conversation (summary)")}
        </Text>
      </Pressable>
      {open ? m.parts.map((p) => <PartView key={p.id} part={p} />) : null}
    </View>
  );
}

/** 🔊 — прочитать ответ вслух (только текст, без кода и путей); во время чтения — ⏹. */
function SpeakButton({ m }: { m: MessageView }) {
  const md = m.parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n\n");
  const on = useSpeaking(m.info.id);
  if (!speakable(md)) return null;
  return (
    <Pressable onPress={() => toggleSpeak(m.info.id, md)} hitSlop={8} style={st.speak}>
      <Text style={S.muted}>{on ? `⏹ ${t("стоп", "stop")}` : "🔊"}</Text>
    </Pressable>
  );
}

// memo: смена видимых сообщений и прочие обновления ленты не перерисовывают неизменившиеся
const Message = memo(function Message({ m, highlight }: { m: MessageView; highlight?: boolean }) {
  if (highlight) {
    return (
      <View style={st.hit}>
        <Message m={m} />
      </View>
    );
  }
  // отметка «контекст сжат» (у opencode она в сообщении пользователя) — во всю ширину, без пузыря
  const comp = m.parts.find((p) => p.type === "compaction");
  if (comp) return <PartView part={comp} />;
  if (m.info.summary) return <Summary m={m} />;
  if (m.info.role === "user") {
    return (
      <View style={st.userRow}>
        <View style={st.bubble}>
          {m.parts.map((p) =>
            p.type === "text" ? (
              <Text key={p.id} selectable style={[S.text, { color: "#fff" }]}>
                {stripAttachmentNote(p.text)}
              </Text>
            ) : p.type === "file" ? (
              <FileChip key={p.id} fileId={p.fileId} name={p.name} mime={p.mime} size={p.size} />
            ) : null,
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={st.assistant}>
      {m.parts.map((p) => (
        <PartView key={p.id} part={p} />
      ))}
      <View style={st.msgActions}>
        <SpeakButton m={m} />
        <CopyActions text={copyableText(m)} />
      </View>
    </View>
  );
});

/** opencode получает список вложений в тексте — пользователю его показывать не нужно */
function stripAttachmentNote(text: string): string {
  return text.replace(/\n*\[(Вложения от пользователя|Attachments from the user): [^\]]*\]\s*$/, "");
}

interface Pending extends Picked {
  key: string;
  fileId?: string;
  error?: string;
}

function Composer({ sessionId, busy, slash, talk }: { sessionId: string; busy: boolean; slash: boolean; talk: boolean }) {
  const [text, setText] = useState(() => getDraft(sessionId));
  const [files, setFiles] = useState<Pending[]>(() => getDraftFiles<Pending>(sessionId));
  useEffect(() => setDraft(sessionId, text), [sessionId, text]);
  // вложения в черновике — только загруженные: незагруженные потерялись бы вместе с экраном
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => setDraftFiles(sessionId, filesRef.current.filter((f) => f.fileId)), [sessionId]);
  const [sending, setSending] = useState(false);
  const quick = useQuickPrompts();
  // «Разговор»: отпустил кнопку — надиктованное уходит само
  const dictation = useDictation(text, setText, talk ? (said) => void send(said) : undefined);
  const [canVoice] = useState(voiceAvailable);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    if (slash) client?.commands(sessionId).then(setCommands, () => {});
  }, [sessionId, slash]);
  // меню «/»: пока набирается имя команды (без пробела)
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const slashMatches =
    slashQuery === undefined ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 12);
  const uploading = files.some((f) => !f.fileId && !f.error);
  const ready = files.flatMap((f) => (f.fileId ? [f.fileId] : []));
  // «@»: упоминание ищется перед курсором
  const input = useRef<TextInputInstance>(null);
  const [caret, setCaret] = useState(0);
  const mention = useMention(sessionId, text, caret);
  const pickMention = (h: FileHit) => {
    const r = mention.apply(h);
    setText(r.text);
    setCaret(r.caret);
    setTimeout(() => input.current?.setSelection(r.caret, r.caret), 0);
  };

  async function add(pick: () => Promise<Picked[]>) {
    let picked: Picked[];
    try {
      picked = await pick();
    } catch (e) {
      return dialog(t("Не получилось", "Failed"), (e as Error).message);
    }
    for (const p of picked) {
      const key = `${p.uri}-${Date.now()}-${Math.random()}`;
      setFiles((fs) => [...fs, { ...p, key }]);
      upload(sessionId, p).then(
        (up) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, fileId: up.fileId } : f))),
        (e: Error) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: e.message } : f))),
      );
    }
  }

  const attach = () =>
    dialog(t("Прикрепить", "Attach"), undefined, [
      { text: t("Файл", "File"), icon: "📄", hint: t("любой файл с телефона", "any file from the phone"), onPress: () => void add(pickFiles) },
      { text: t("Галерея", "Gallery"), icon: "🖼", hint: t("фото и скриншоты", "photos and screenshots"), onPress: () => void add(pickPhotos) },
      { text: t("Камера", "Camera"), icon: "📷", hint: t("сфотографировать сейчас", "take a photo now"), onPress: () => void add(takePhoto) },
    ], { cancelable: true });

  async function send(override?: string) {
    const body = override ?? text;
    if ((!body.trim() && !ready.length) || sending || uploading) return;
    setSending(true);
    try {
      await client!.prompt(sessionId, body, ready);
      setText("");
      setFiles([]);
    } catch (e) {
      dialog(t("Не отправилось", "Not sent"), (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={st.composerWrap}>
      {files.length ? (
        <View style={st.chips}>
          {files.map((f) => (
            <Pressable
              key={f.key}
              style={[st.chip, f.error ? { borderColor: C.err } : null]}
              onPress={() => (f.error ? dialog(f.name, f.error) : undefined)}
            >
              {f.fileId ? <Text>📎</Text> : f.error ? <Text>⚠</Text> : <ActivityIndicator size="small" color={C.text} />}
              <Text style={[S.muted, { maxWidth: 140 }]} numberOfLines={1}>
                {f.name}
              </Text>
              <Text style={S.muted}>{fmtSize(f.size)}</Text>
              <Pressable hitSlop={8} onPress={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                <Text style={{ color: C.text, fontSize: 16 }}>×</Text>
              </Pressable>
            </Pressable>
          ))}
        </View>
      ) : null}
      <MentionList m={mention} pick={pickMention} />
      {slashMatches.length ? (
        <ScrollView style={st.slash} keyboardShouldPersistTaps="always">
          {slashMatches.map((c) => (
            <Pressable key={c.name} style={({ pressed }) => [st.slashItem, pressed && { backgroundColor: C.bg3 }]} onPress={() => setText(`/${c.name} `)}>
              <Text style={st.slashName}>/{c.name}</Text>
              {c.description ? (
                <Text style={S.muted} numberOfLines={1}>
                  {c.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {quick.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={st.quick}>
          {quick.map((q) => (
            <Pressable
              key={q}
              disabled={sending || uploading}
              style={({ pressed }) => [st.quickBtn, pressed && { borderColor: C.accent }]}
              // пустое поле — отправляем сразу, иначе дописываем к набранному
              onPress={() => (text.trim() ? setText((t) => t.trimEnd() + " " + q) : void send(q))}
            >
              <Text style={{ color: C.text, fontSize: 13 }}>{q}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {talk && canVoice ? <Text style={st.talkHint}>🗣 {t("Разговор: нажми 🎤 и говори, нажми ⏹ — сообщение уйдёт само, ответ прочитаю вслух", "Talk mode: tap 🎤 and speak, tap ⏹ — the message is sent, the answer is read aloud")}</Text> : null}
      <View style={st.composer}>
        {/* «/» нужна, только чтобы начать команду — при наборе текста место отдаём полю */}
        {slash && commands.length && !text ? <Btn title="/" style={st.iconBtn} onPress={() => setText("/")} /> : null}
        <Btn title="📎" style={st.iconBtn} onPress={attach} />
        <TextInput
          ref={input}
          style={[S.input, st.input]}
          multiline
          onSelectionChange={(e) => setCaret(e.nativeEvent.selection.end)}
          placeholder={busy ? t("В очередь…", "Queue a message…") : t("Сообщение…", "Message…")}
          placeholderTextColor={C.muted}
          value={text}
          onChangeText={setText}
        />
        {busy ? <Btn kind="danger" title="■" style={st.iconBtn} onPress={() => void client?.abort(sessionId)} /> : null}
        {/* пусто — 🎤: нажал — пишет, нажал ⏹ — стоп (держать не нужно); есть текст — ➤, долгое нажатие — дописать голосом */}
        <Pressable
          disabled={sending || uploading}
          delayLongPress={350}
          onPress={() => {
            if (dictation.listening) dictation.stop();
            else if (text.trim() || ready.length) void send();
            else if (canVoice) void dictation.start();
          }}
          onLongPress={canVoice && !dictation.listening ? () => void dictation.start() : undefined}
          style={({ pressed }) => [st.send, dictation.listening && st.sendRec, (pressed || sending || uploading) && { opacity: 0.7 }]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={C.text} />
          ) : (
            <Text style={{ color: "#fff", fontSize: 18 }}>{dictation.listening ? "⏹" : text.trim() || ready.length || !canVoice ? "➤" : "🎤"}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: "column", alignItems: "stretch", gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  searchBar: { gap: 6, paddingHorizontal: 8, paddingVertical: 8 },
  hit: { borderWidth: 2, borderColor: C.warn, borderRadius: 12, padding: 6 },
  down: { position: "absolute", right: 14, bottom: 14, width: 44, height: 44, borderRadius: 22, backgroundColor: C.bg3, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center", elevation: 4 },
  send: { minWidth: 46, minHeight: 42, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 12, backgroundColor: C.accent },
  sendRec: { backgroundColor: C.err },
  headRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  paramChip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg3 },
  paramChipText: { flex: 1, color: C.text, fontSize: 13 },
  paramChipCaret: { color: C.muted, fontSize: 12 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, borderWidth: 1, borderColor: "rgba(34,197,94,0.35)", backgroundColor: "rgba(34,197,94,0.1)", maxWidth: "100%" },
  pillText: { color: C.ok, fontSize: 12 },
  messages: { padding: 12, gap: 14 },
  userRow: { flexDirection: "row", justifyContent: "flex-end" },
  bubble: { backgroundColor: C.accent2, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, borderBottomRightRadius: 4, maxWidth: "88%", gap: 6 },
  assistant: { gap: 8 },
  speak: { alignSelf: "flex-start", paddingVertical: 2 },
  talkHint: { color: C.muted, fontSize: 12, paddingHorizontal: 12, paddingTop: 4 },
  msgActions: { flexDirection: "row", alignItems: "center", gap: 18 },
  error: { color: C.err, backgroundColor: "#2a1518", padding: 10, borderRadius: 8 },
  working: { color: C.warn },
  composerWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg2 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 8 },
  iconBtn: { paddingHorizontal: 9, minWidth: 40 },
  quick: { gap: 6, paddingHorizontal: 8, paddingTop: 8 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, margin: 8, padding: 10, borderRadius: 10, backgroundColor: "#2a2416", borderWidth: 1, borderColor: "#5a4a20" },
  bannerDanger: { backgroundColor: "#2a1518", borderColor: "#5b2630" },
  slash: { maxHeight: 240, marginHorizontal: 8, marginTop: 8, backgroundColor: C.bg, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  slashItem: { paddingHorizontal: 10, paddingVertical: 8, gap: 1 },
  slashName: { color: C.accent, fontFamily: mono, fontSize: 14 },
  quickBtn: { backgroundColor: C.bg3, borderRadius: 999, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 8, paddingTop: 8 },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.bg3, borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 8, paddingVertical: 5 },
  input: { flex: 1, maxHeight: 180, minHeight: 42, paddingTop: 10 },
});

/** Продолжить в opencode: выбрать модель → новая сессия с выжимкой этой (эта остаётся как есть, но ждать сброса лимита перестаёт). */
function handoff(id: string): void {
  void pickOpencodeModel(t("Продолжить в opencode — модель", "Continue in opencode — model")).then((model) => {
    if (!model) return;
    client?.handoff(id, model).then(
      (s) => replace({ page: "session", id: s.id }),
      (e: Error) => dialog(t("Не получилось", "Failed"), e.message),
    );
  });
}

/** Отдельная ветка сессии: статус и «Влить» / «Выбросить» (Android даёт в диалоге максимум три кнопки). */
async function worktreeMenu(info: SessionInfo): Promise<void> {
  const wt = info.worktree!;
  const fail = (e: Error) => dialog(t("Не получилось", "Failed"), e.message);
  let st;
  try {
    st = await client!.worktreeStatus(info.id);
  } catch (e) {
    return fail(e as Error);
  }
  const changed = st.ahead + st.dirty;
  const files = st.files.slice(0, 8).join("\n") + (st.files.length > 8 ? "\n…" : "");
  const text = changed ? `${t(`Коммитов: ${st.ahead}, незакоммиченных файлов: ${st.dirty}`, `Commits: ${st.ahead}, uncommitted files: ${st.dirty}`)}${files ? "\n\n" + files : ""}` : t("Изменений нет — копия совпадает с основной веткой.", "No changes — the copy matches the main branch.");
  const busy = info.status === "busy" || info.status === "retry";
  dialog(`${wt.branch} → ${wt.base}`, busy ? text + "\n\n" + t("Агент работает — вливать можно, когда закончит.", "The agent is working — you can merge when it finishes.") : text, [
    { text: t("Закрыть", "Close"), style: "cancel" },
    ...(changed && !busy
      ? [
          {
            text: t("Выбросить", "Discard"),
            icon: "🗑",
            hint: t("вернуть копию к основной ветке", "reset the copy to the main branch"),
            style: "destructive" as const,
            onPress: () =>
              dialog(t("Выбросить изменения?", "Discard the changes?"), t(`Всё, что сделано в ${wt.branch} после последнего вливания, пропадёт.`, `Everything done in ${wt.branch} since the last merge will be lost.`), [
                { text: t("Отмена", "Cancel"), style: "cancel" },
                { text: t("Выбросить", "Discard"), style: "destructive", onPress: () => void client!.worktreeDiscard(info.id).then(() => ToastAndroid.show(t("Изменения выброшены", "Changes discarded"), ToastAndroid.SHORT), fail) },
              ]),
          },
          {
            text: `${t("Влить в", "Merge into")} ${wt.base}`,
            icon: "⤵️",
            hint: t("одним коммитом, сессия работает дальше", "as one commit, the session keeps working"),
            onPress: () =>
              void client!.worktreeMerge(info.id).then((r) => dialog(t("Влито", "Merged"), t(`Коммит ${r.commit} в ${wt.base}, файлов: ${r.files}`, `Commit ${r.commit} into ${wt.base}, files: ${r.files}`)), fail),
          },
        ]
      : []),
  ]);
}

/** Превью dev-сервера: порты на ПК → ссылка через Tailscale → браузер телефона. */
function PreviewSheet({ sessionId, visible, onClose }: { sessionId: string; visible: boolean; onClose: () => void }) {
  const [ports, setPorts] = useState<ListeningPort[]>();
  useEffect(() => {
    if (!visible) return;
    setPorts(undefined);
    client?.ports(sessionId).then(setPorts, () => setPorts([]));
  }, [visible, sessionId]);
  return (
    <ListSheet
      visible={visible}
      title={t("Превью dev-сервера", "Dev server preview")}
      empty={ports ? t("Не нашёл запущенных веб-серверов на ПК. Попроси агента запустить dev-сервер.", "No web servers running on the PC. Ask the agent to start a dev server.") : t("Ищу порты…", "Looking for ports…")}
      // у каждого порта второй вариант — с панелью замечаний по вёрстке (уйдут агенту этой сессии)
      options={(ports ?? []).flatMap((p) => [
        { value: String(p.port), label: `:${p.port} · ${p.process}`, hint: p.project ? t("этот проект", "this project") : p.command.slice(0, 80) },
        { value: `${p.port}:notes`, label: `   💬 :${p.port} ${t("с замечаниями", "with comments")}`, hint: t("тыкаешь в элементы, пишешь, что не так, — агенту", "tap elements, write what's wrong, send to the agent") },
      ])}
      onClose={onClose}
      onPick={(v) =>
        void client?.openPreview(Number(v.split(":")[0]), v.endsWith(":notes") ? sessionId : undefined).then(
          (r) => Linking.openURL(r.url),
          (e: Error) => dialog(t("Превью не открылось", "Preview didn't open"), e.message),
        )
      }
    />
  );
}

/** Упёрлись в лимит: хаб сам напишет «Продолжай» после сброса. */
function ResumeBanner({ sessionId, at }: { sessionId: string; at: number }) {
  return (
    <View style={st.banner}>
      <Text style={[S.text, { flex: 1, fontSize: 13 }]}>⏳ {t("Упёрлись в лимит Claude — продолжу сам в", "Hit the Claude limit — I'll continue by myself at")} {new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</Text>
      {/* простую часть можно не ждать: передать бесплатной модели (тогда Claude не проснётся — иначе двое правят одни файлы) */}
      <Btn small title={t("Не ждать", "Don't wait")} onPress={() => handoff(sessionId)} />
      <Btn small title={t("Не продолжать", "Don't continue")} onPress={() => void client?.updateSession(sessionId, { resumeAt: 0 })} />
    </View>
  );
}

/** Лимит Claude подходит к концу (≥80%) — предложить продолжить на бесплатной модели. */
function LimitBanner({ limits, sessionId }: { limits?: ClaudeLimits; sessionId: string }) {
  const v = limitView(limits);
  if (!v || v.level === "ok") return null;
  return (
    <View style={[st.banner, v.level === "danger" ? st.bannerDanger : null]}>
      <Text style={[S.text, { flex: 1, fontSize: 13 }]}>
        {t("Лимит Claude", "Claude limit")}: {t("5ч", "5h")} {v.fiveHour ?? "—"}% · {t("неделя", "week")} {v.sevenDay ?? "—"}%
      </Text>
      <Btn small title={t("На бесплатную", "Free model")} onPress={() => handoff(sessionId)} />
    </View>
  );
}
