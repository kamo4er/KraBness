// Просмотр проекта сессии без агента: git-изменения и файлы (бесплатно по лимитам).
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { BackHandler, FlatList, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Directory, Paths } from "expo-file-system";
import { ApiError, isArtifactFile, type FileView, type FsEntry, type GitInfo, t } from "@kamharn/client";
import { client, fmtSize, useHub } from "../store.ts";
import { back, replace } from "../nav.ts";
import { download } from "../files.ts";
import { Markdown } from "../Parts.tsx";
import { ArtifactFull } from "../Artifact.tsx";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";
import { Terminal } from "./Terminal.tsx";
import { dialog } from "../dialog.tsx";
import { pickOpencodeModel } from "../modelPick.tsx";

export function Project({ id, file, line }: { id: string; file?: string; line?: number }) {
  const state = useHub();
  const info = state.sessions.find((s) => s.id === id);
  const [tab, setTab] = useState<"git" | "files" | "term">(file ? "files" : "git");
  if (!info) {
    return (
      <View style={[S.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text>
      </View>
    );
  }
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]} numberOfLines={1}>
          {info.title}
        </Text>
      </View>
      <View style={st.tabs}>
        {(["git", "files", "term"] as const).map((tb) => (
          <Pressable key={tb} onPress={() => setTab(tb)} style={[st.tab, tab === tb && st.tabOn]}>
            <Text style={{ color: tab === tb ? C.text : C.muted }}>{tb === "git" ? t("Изменения", "Changes") : tb === "files" ? t("Файлы", "Files") : t("Терминал", "Terminal")}</Text>
          </Pressable>
        ))}
      </View>
      {tab === "git" ? <Changes id={id} /> : tab === "files" ? <Files root={info.directory} initial={file} line={line} /> : <Terminal sessionId={id} />}
    </View>
  );
}

function diffColor(l: string): string | undefined {
  if (l.startsWith("diff --git")) return C.text;
  if (l.startsWith("@@")) return C.accent;
  if (l.startsWith("+") && !l.startsWith("+++")) return "#9fe0a8";
  if (l.startsWith("-") && !l.startsWith("---")) return "#f19999";
  return undefined;
}

function Changes({ id }: { id: string }) {
  const [git, setGit] = useState<GitInfo>();
  const [error, setError] = useState<string>();
  const load = () => {
    setError(undefined);
    client?.git(id).then(setGit, (e: Error) => setError(e.message));
  };
  useEffect(load, [id]);
  if (error) return <Text style={[S.error, st.pad]}>{error}</Text>;
  if (!git) return <Text style={[S.muted, st.pad]}>{t("загрузка…", "loading…")}</Text>;
  if (!git.repo) return <Text style={[S.muted, st.pad]}>{t("Папка сессии не в git-репозитории.", "The session folder is not a git repository.")}</Text>;
  const lines = git.diff ? git.diff.split("\n") : [];
  return (
    <FlatList
      data={lines}
      keyExtractor={(_, i) => String(i)}
      initialNumToRender={60}
      ListHeaderComponent={
        <View style={{ gap: 6, padding: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[S.muted, { flex: 1 }]}>
              {t("Ветка", "Branch")} <Text style={{ color: C.text, fontWeight: "700" }}>{git.branch ?? "?"}</Text> ·{" "}
              {git.files.length ? `${t("изменено файлов", "files changed")}: ${git.files.length}` : t("изменений нет", "no changes")}
            </Text>
            <Btn small title={t("Обновить", "Refresh")} onPress={load} />
            {git.diff ? (
              <Btn
                small
                title={t("Ревью", "Review")}
                onPress={() =>
                  void pickOpencodeModel(t("Ревью изменений — модель", "Review changes — model")).then(
                    (model) =>
                      model &&
                      client?.review(id, model).then(
                        (s) => replace({ page: "session", id: s.id }),
                        (e: Error) => dialog(t("Не получилось", "Failed"), e.message),
                      ),
                  )
                }
              />
            ) : null}
          </View>
          {git.files.map((f) => (
            <Text key={f.path} style={{ fontFamily: mono, fontSize: 12, color: C.text }} numberOfLines={1}>
              <Text style={{ color: f.status === "??" ? C.ok : f.status.includes("D") ? C.err : C.warn }}>{f.status === "??" ? "new" : f.status.padEnd(3)}</Text> {f.path}
            </Text>
          ))}
          {git.truncated ? <Text style={S.muted}>{t("Дифф обрезан — слишком большой.", "The diff is truncated — too large.")}</Text> : null}
        </View>
      }
      renderItem={({ item }) => (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text style={[st.diffLine, { color: diffColor(item) ?? C.muted }, item.startsWith("diff --git") && { fontWeight: "700", marginTop: 8 }]}>{item || " "}</Text>
        </ScrollView>
      )}
    />
  );
}

/** initial — файл (или папка) по ссылке из чата, line — строка, к которой прокрутить */
function Files({ root, initial, line }: { root: string; initial?: string; line?: number }) {
  const [cwd, setCwd] = useState(root);
  const [entries, setEntries] = useState<FsEntry[]>();
  const [file, setFile] = useState<FileView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // .html-файл, запущенный живой страницей
  const [running, setRunning] = useState(false);
  // подсвеченная строка — только у файла, открытого по ссылке; codeY — где в прокрутке начинается текст
  const [hl, setHl] = useState<number>();
  const scroller = useRef<ComponentRef<typeof ScrollView>>(null);
  const codeY = useRef(0);

  useEffect(() => {
    if (!initial || !client) return;
    client.readFile(initial).then(
      (f) => {
        setFile(f);
        setCwd(f.path.replace(/[\\/][^\\/]+$/, ""));
        if (line) setHl(line);
      },
      // не файл — может, папка: показываем её список
      (e: Error) => client!.list(initial).then(() => setCwd(initial), () => setError(`${initial}: ${e.message}`)),
    );
  }, [initial, line]);
  // правка руками: draft — текст в поле (undefined — просмотр)
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const dirty = draft !== undefined && draft !== file?.text;

  const leave = (then: () => void) =>
    dirty
      ? dialog(t("Выйти без сохранения?", "Leave without saving?"), t("Правки в файле пропадут.", "Your edits will be lost."), [
          { text: t("Остаться", "Stay"), style: "cancel" },
          { text: t("Выйти", "Leave"), style: "destructive", onPress: then },
        ])
      : then();

  // системное «назад» при несохранённой правке — сначала спросить (наш обработчик зарегистрирован позже — вызывается первым)
  useEffect(() => {
    if (!dirty) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => (leave(() => setDraft(undefined)), true));
    return () => sub.remove();
  }, [dirty]);

  async function save() {
    if (!file?.sha256 || draft === undefined) return;
    setSaving(true);
    try {
      setFile(await client!.writeFile(file.path, draft, file.sha256));
      setDraft(undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409)
        dialog(t("Файл изменился", "The file changed"), (e as Error).message, [
          { text: t("Оставить мои правки", "Keep my edits"), style: "cancel" },
          {
            text: t("Загрузить заново", "Reload"),
            style: "destructive",
            onPress: () => void client!.readFile(file.path).then((f) => (setFile(f), setDraft(undefined)), (err: Error) => dialog(t("Не открылось", "Couldn't open"), err.message)),
          },
        ]);
      else dialog(t("Не сохранилось", "Not saved"), (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    setError(undefined);
    setEntries(undefined);
    client?.list(cwd).then(setEntries, (e: Error) => setError(e.message));
  }, [cwd]);

  async function open(e: FsEntry) {
    if (e.dir) return setCwd(e.path);
    setHl(undefined);
    try {
      setFile(await client!.readFile(e.path));
    } catch (err) {
      dialog(t("Не открылось", "Couldn't open"), (err as Error).message);
    }
  }

  /** двоичный файл (pdf, apk…) — скачать и отдать системе */
  async function openBinary(f: FileView) {
    setBusy(true);
    try {
      const name = f.path.split(/[\\/]/).pop()!;
      const local = await download(client!.rawUrl(f.path), new Directory(Paths.cache, "kamharn-project"), name, f.size);
      await local.preview({ mimeType: f.mime, title: name });
    } catch (err) {
      dialog(t("Не открылось", "Couldn't open"), (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (file) {
    const name = file.path.split(/[\\/]/).pop()!;
    return (
      // handled: при открытой клавиатуре первый тап по «Сохранить» иначе только прячет клавиатуру
      <ScrollView ref={scroller} contentContainerStyle={{ padding: 12, gap: 10 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Btn small title={t("← к списку", "← back to list")} onPress={() => leave(() => (setDraft(undefined), setFile(undefined), setHl(undefined), setRunning(false)))} />
          <Text style={[S.muted, { flex: 1, fontFamily: mono }]} numberOfLines={1}>
            {name}
            {dirty ? " •" : ""}
            {draft === undefined ? ` · ${fmtSize(file.size)}` : ""}
          </Text>
          {draft === undefined ? (
            <>
              {/* соседние .js и .css по относительным путям не подтянутся — для страниц «всё в одном файле» */}
              {isArtifactFile(file.path) && !file.binary && file.text !== undefined ? (
                <Btn small kind="primary" title={`▶ ${t("Запустить", "Run")}`} onPress={() => setRunning(true)} />
              ) : null}
              {file.sha256 ? <Btn small title={t("Изменить", "Edit")} onPress={() => setDraft(file.text ?? "")} /> : null}
            </>
          ) : (
            <>
              <Btn small kind="primary" title={t("Сохранить", "Save")} busy={saving} disabled={!dirty} onPress={() => void save()} />
              <Btn small title={t("Отмена", "Cancel")} disabled={saving} onPress={() => leave(() => setDraft(undefined))} />
            </>
          )}
        </View>
        {draft !== undefined ? (
          <TextInput
            style={st.edit}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
          />
        ) : file.binary ? (
          file.mime.startsWith("image/") && file.mime !== "image/svg+xml" ? (
            <Image source={{ uri: client!.rawUrl(file.path) }} style={{ width: "100%", aspectRatio: 1 }} resizeMode="contain" />
          ) : (
            <View style={{ gap: 8 }}>
              <Text style={S.muted}>{t("Двоичный файл", "Binary file")} ({file.mime}).</Text>
              <Btn title={t("Открыть", "Open")} busy={busy} onPress={() => void openBinary(file)} style={{ alignSelf: "flex-start" }} />
            </View>
          )
        ) : hl ? (
          // ссылка на строку: текст построчно (без переноса — высота строки постоянная), нужная подсвечена
          <ScrollView
            horizontal
            onLayout={(e) => {
              codeY.current = e.nativeEvent.layout.y;
              scroller.current?.scrollTo({ y: Math.max(0, codeY.current + (hl - 1) * CODE_LINE - 200), animated: false });
            }}
          >
            <View>
              {(file.text ?? "").split(/\r?\n/).map((l, i) => (
                <Text key={i} selectable style={[st.code, i + 1 === hl && st.hl]}>
                  {l || " "}
                </Text>
              ))}
            </View>
          </ScrollView>
        ) : file.mime === "text/markdown" ? (
          <Markdown text={file.text ?? ""} />
        ) : (
          <ScrollView horizontal>
            <Text selectable style={st.code}>
              {file.text}
            </Text>
          </ScrollView>
        )}
        {file.truncated ? <Text style={S.muted}>{t("Показано начало файла.", "Showing the beginning of the file.")}</Text> : null}
        {running && file.text !== undefined ? <ArtifactFull source={file.text} title={name} onClose={() => setRunning(false)} /> : null}
      </ScrollView>
    );
  }

  const up = cwd.length > root.length ? cwd.replace(/[\\/][^\\/]+$/, "") : undefined;
  return (
    <View style={{ flex: 1 }}>
      <View style={st.bar}>
        <Btn small title="⌂" onPress={() => setCwd(root)} />
        <Btn small title="↑" disabled={!up} onPress={() => up && setCwd(up)} />
        <Text style={[S.muted, { flex: 1 }]} numberOfLines={1}>
          {cwd.slice(root.length) || "\\"}
        </Text>
      </View>
      {error ? <Text style={[S.error, st.pad]}>{error}</Text> : null}
      <FlatList
        data={entries ?? []}
        keyExtractor={(e) => e.path}
        renderItem={({ item }) => (
          <Pressable style={({ pressed }) => [st.entry, pressed && { backgroundColor: C.bg2 }]} onPress={() => void open(item)}>
            <Text style={S.text} numberOfLines={1}>
              {item.dir ? "📁" : "📄"} {item.name}
            </Text>
            {!item.dir && item.size !== undefined ? <Text style={S.muted}>{fmtSize(item.size)}</Text> : null}
          </Pressable>
        )}
        ListEmptyComponent={<Text style={[S.muted, st.pad]}>{entries ? t("Пусто", "Empty") : t("загрузка…", "loading…")}</Text>}
      />
    </View>
  );
}

/** высота строки кода: по ней прокручиваем к строке из ссылки */
const CODE_LINE = 17;

const st = StyleSheet.create({
  tabs: { flexDirection: "row", gap: 4, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line, backgroundColor: C.bg2 },
  tab: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabOn: { borderBottomColor: C.accent },
  pad: { padding: 12 },
  diffLine: { fontFamily: mono, fontSize: 12, lineHeight: 17, paddingHorizontal: 12 },
  bar: { flexDirection: "row", alignItems: "center", gap: 6, padding: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  entry: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  code: { fontFamily: mono, fontSize: 12, lineHeight: CODE_LINE, color: C.text },
  hl: { backgroundColor: "rgba(255, 196, 0, 0.22)" },
  edit: { fontFamily: mono, fontSize: 13, lineHeight: 18, color: C.text, backgroundColor: C.bg2, borderRadius: 8, borderWidth: 1, borderColor: C.line, padding: 10, minHeight: 400 },
});
