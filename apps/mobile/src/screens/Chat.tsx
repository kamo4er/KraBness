// Чат сессии: стрим сообщений, инструменты, подтверждения, смена модели и режима, отправка и остановка.
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, ToastAndroid, View, type TextInputInstance } from "react-native";
import { limitView, resolveFileRef, type FileRef, type ClaudeLimits, type ListeningPort, type MessageView, type PermissionMode, type SessionInfo, type SlashCommand, type FileHit, t, locale } from "@kamharn/client";
import { client, fmtSize, useEngines, useHub, useQuickPrompts } from "../store.ts";
import { loadChat } from "../cache.ts";
import { getDraft, getDraftFiles, setDraft, setDraftFiles } from "../drafts.ts";
import { speakable, toggleSpeak, useSpeaking } from "../speak.ts";
import { pickFiles, pickPhotos, takePhoto, upload, type Picked } from "../files.ts";
import { useDictation, voiceAvailable } from "../voice.ts";
import { back, go, replace } from "../nav.ts";
import { MODES } from "./NewSession.tsx";
import { FileChip, FileRefCtx, PartView, PermissionCard, QuestionCard } from "../Parts.tsx";
import { Btn, ConnDot, EngineBadge, Limits, ListSheet, Picker } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";
import { dialog } from "../dialog.tsx";
import { pickOpencodeModel } from "../modelPick.tsx";
import { EffortPicker } from "../effort.tsx";
import { SessionUsage } from "../Usage.tsx";
import { MentionList, useMention } from "../mention.tsx";

/** Автопроверка с телефона: включить с командами проекта (сохранёнными или предложенными), прогнать сейчас. Править команды удобнее в вебе. */
async function checksMenu(id: string, on: boolean): Promise<void> {
  const cfg = await client!.checks(id);
  const commands = cfg.commands.length ? cfg.commands : cfg.suggested;
  if (!commands.length) {
    dialog(t("Нет команд проверки", "No check commands"), t("Не нашёл тестов в проекте. Задай команды в вебе на ПК: кнопка ✓ в шапке чата.", "No tests found in the project. Set the commands in the web UI on the PC: the ✓ button in the chat header."));
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
  const list = useRef<FlatList<MessageView>>(null);
  const [showDown, setShowDown] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  const matchesRef = useRef<number[]>([]);
  const [showOld, setShowOld] = useState(false);
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
        <Header info={info} conn={state.conn} onSearch={() => setSearch("")} />
      )}
      {info.engine === "claude" || state.usage[info.id] ? (
        <View style={st.limitRow}>
          {info.engine === "claude" ? <Limits limits={state.limits} style={{ flex: 1 }} /> : <View style={{ flex: 1 }} />}
          <SessionUsage id={info.id} full />
          {info.engine === "claude" ? (
            <Pressable hitSlop={8} onPress={() => handoff(info.id)}>
              <Text style={{ color: C.accent, fontSize: 12 }}>→ opencode</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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
        renderItem={({ item }) => <Message m={item} highlight={item.info.id === highlightId} />}
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
      <Composer key={id} sessionId={id} busy={busy} slash={info.engine === "claude"} />
    </View>
    </FileRefCtx.Provider>
  );
}

function Header({ info, conn, onSearch }: { info: SessionInfo; conn: ReturnType<typeof useHub>["conn"]; onSearch: () => void }) {
  const engines = useEngines();
  const models = engines?.find((e) => e.id === info.engine)?.models ?? [];
  const key = (m: { providerId: string; modelId: string }) => `${m.providerId}/${m.modelId}`;
  const modelOptions = models.map((m, i) => ({
    value: key(m),
    label: m.name + (m.offline ? ` · ${t("не запущена", "not running")}` : m.free ? " · free" : ""),
    disabled: m.offline,
    ...(i === 0 || models[i - 1]!.providerId !== m.providerId ? { group: m.providerId } : {}),
  }));
  if (!models.some((m) => key(m) === key(info.model))) modelOptions.unshift({ value: key(info.model), label: info.model.modelId, disabled: false });

  const [preview, setPreview] = useState(false);
  const fail = (e: Error) => dialog(t("Не получилось", "Failed"), e.message);
  return (
    <View style={[S.head, st.head]}>
      <PreviewSheet sessionId={info.id} visible={preview} onClose={() => setPreview(false)} />
      <View style={st.headRow}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]} numberOfLines={1}>
          {info.title}
        </Text>
        <ConnDot conn={conn} />
        <Btn small kind="ghost" title="🔍" onPress={onSearch} />
        {info.worktree ? <Btn small kind="ghost" title="⎇" onPress={() => void worktreeMenu(info)} /> : null}
        <Btn small kind="ghost" title="📁" onPress={() => go({ page: "project", id: info.id })} />
        <Btn
          small
          kind="ghost"
          title="⋯"
          onPress={() =>
            dialog(info.title, undefined, [
              { text: t("Превью dev-сервера", "Dev server preview"), icon: "▶️", hint: t("открыть сайт или игру проекта в браузере", "open the project's site or game in the browser"), onPress: () => setPreview(true) },
              { text: t("Проект", "Project"), icon: "📁", hint: t("изменения, файлы, терминал", "changes, files, terminal"), onPress: () => go({ page: "project", id: info.id }) },
              { text: t("Бот в Telegram", "Telegram bot"), icon: "✈️", hint: t("писать этой сессии из Telegram, файлы туда-обратно", "talk to this session from Telegram, files both ways"), onPress: () => go({ page: "sessionBot", id: info.id }) },
              {
                text: info.autoCheck ? t("Автопроверка: вкл", "Auto-check: on") : t("Автопроверка: выкл", "Auto-check: off"),
                icon: "✅",
                hint: t("после хода агента — тесты и сборка, ошибки уходят агенту", "tests and build after each agent turn, failures go back to the agent"),
                onPress: () => void checksMenu(info.id, !!info.autoCheck).catch(fail),
              },
              {
                text: t("Сжать контекст", "Compact the context"),
                icon: "🗜",
                hint: t("агент перескажет разговор сам себе и освободит место", "the agent summarizes the conversation for itself and frees up space"),
                onPress: () =>
                  dialog(
                    t("Сжать контекст?", "Compact the context?"),
                    t("Агент заменит историю коротким пересказом: главное запомнит, мелкие подробности забудет. Ранние сообщения в чате свернутся.", "The agent replaces the history with a short summary: it keeps the essentials and forgets small details. Earlier messages in the chat get collapsed."),
                    [
                      { text: t("Отмена", "Cancel"), style: "cancel" },
                      { text: t("Сжать", "Compact"), onPress: () => void client?.compact(info.id).catch(fail) },
                    ],
                  ),
              },
              {
                text: t("Удалить сессию", "Delete session"),
                icon: "🗑",
                style: "destructive",
                onPress: () =>
                  dialog(t("Удалить сессию?", "Delete the session?"), t(`«${info.title}» пропадёт из KraBness, файлы в папке останутся.`, `“${info.title}” will be removed from KraBness, files in the folder stay.`), [
                    { text: t("Отмена", "Cancel"), style: "cancel" },
                    { text: t("Удалить", "Delete"), style: "destructive", onPress: () => void client?.deleteSession(info.id).then(back, fail) },
                  ]),
              },
              { text: t("Закрыть", "Close"), style: "cancel" },
            ], { cancelable: true })
          }
        />
      </View>
      <View style={st.headRow}>
        <EngineBadge engine={info.engine} />
        <Picker
          title={t("Модель", "Model")}
          style={{ flex: 1 }}
          value={key(info.model)}
          options={modelOptions}
          onChange={(v) => {
            const m = models.find((x) => key(x) === v);
            if (m) client?.updateSession(info.id, { model: { providerId: m.providerId, modelId: m.modelId } }).catch(fail);
          }}
        />
        <EffortPicker
          style={{ flex: 0.6 }}
          efforts={models.find((m) => key(m) === key(info.model))?.efforts ?? []}
          value={info.effort ?? ""}
          onChange={(v) => client?.updateSession(info.id, { effort: v }).catch(fail)}
        />
        <Picker
          title={t("Подтверждения", "Approvals")}
          style={{ flex: 1 }}
          value={info.permissionMode}
          options={MODES().map((m) => ({ value: m.id, label: m.label, hint: m.hint }))}
          onChange={(v) => client?.updateSession(info.id, { permissionMode: v as PermissionMode }).catch(fail)}
        />
      </View>
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

function Message({ m, highlight }: { m: MessageView; highlight?: boolean }) {
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
      <SpeakButton m={m} />
    </View>
  );
}

/** opencode получает список вложений в тексте — пользователю его показывать не нужно */
function stripAttachmentNote(text: string): string {
  return text.replace(/\n*\[(Вложения от пользователя|Attachments from the user): [^\]]*\]\s*$/, "");
}

interface Pending extends Picked {
  key: string;
  fileId?: string;
  error?: string;
}

function Composer({ sessionId, busy, slash }: { sessionId: string; busy: boolean; slash: boolean }) {
  const [text, setText] = useState(() => getDraft(sessionId));
  const [files, setFiles] = useState<Pending[]>(() => getDraftFiles<Pending>(sessionId));
  useEffect(() => setDraft(sessionId, text), [sessionId, text]);
  // вложения в черновике — только загруженные: незагруженные потерялись бы вместе с экраном
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => setDraftFiles(sessionId, filesRef.current.filter((f) => f.fileId)), [sessionId]);
  const [sending, setSending] = useState(false);
  const quick = useQuickPrompts();
  const dictation = useDictation(text, setText);
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
        {/* как в Telegram: пусто — 🎤 (держи и говори), есть текст — ➤ (долгое нажатие — дописать голосом) */}
        <Pressable
          disabled={sending || uploading}
          delayLongPress={250}
          onPress={() => {
            if (text.trim() || ready.length) void send();
            else if (canVoice) ToastAndroid.show(t("Удерживай кнопку и говори", "Hold the button and speak"), ToastAndroid.SHORT);
          }}
          onLongPress={canVoice ? () => void dictation.hold() : undefined}
          onPressOut={dictation.release}
          style={({ pressed }) => [st.send, dictation.listening && st.sendRec, (pressed || sending || uploading) && { opacity: 0.7 }]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={C.text} />
          ) : (
            <Text style={{ color: "#fff", fontSize: 18 }}>{dictation.listening ? "●" : text.trim() || ready.length || !canVoice ? "➤" : "🎤"}</Text>
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
  messages: { padding: 12, gap: 14 },
  userRow: { flexDirection: "row", justifyContent: "flex-end" },
  bubble: { backgroundColor: C.accent2, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, borderBottomRightRadius: 4, maxWidth: "88%", gap: 6 },
  assistant: { gap: 8 },
  speak: { alignSelf: "flex-start", paddingVertical: 2 },
  error: { color: C.err, backgroundColor: "#2a1518", padding: 10, borderRadius: 8 },
  working: { color: C.warn },
  composerWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line, backgroundColor: C.bg2 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 8 },
  iconBtn: { paddingHorizontal: 9, minWidth: 40 },
  quick: { gap: 6, paddingHorizontal: 8, paddingTop: 8 },
  limitRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 4, backgroundColor: C.bg2 },
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
