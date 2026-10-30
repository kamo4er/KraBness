// Части сообщения: текст (упрощённый markdown), размышления, инструменты, файлы, запрос подтверждения.
import { createContext, memo, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, ToastAndroid, View } from "react-native";
import { isArtifactLang, parseFileRef, t, type FileRef, type Part, type PermissionReply, type PermissionRequest, type QuestionAnswers, type QuestionRequest } from "@kamharn/client";
import { client, fmtSize } from "./store.ts";
import { go } from "./nav.ts";
import { imageUri, openFile, saveFile, shareFile } from "./files.ts";
import { Btn } from "./ui.tsx";
import { C, S, mono } from "./theme.ts";
import { dialog } from "./dialog.tsx";
import { ArtifactCard, MermaidCard } from "./Artifact.tsx";

// ---------- markdown: блоки кода, заголовки, списки, `код`, **жирный** ----------

/** открыть файл по ссылке из ответа (даёт чат; в просмотре .md-файла ссылок на файлы нет) */
export const FileRefCtx = createContext<((ref: FileRef) => void) | undefined>(undefined);
type OpenRef = ((ref: FileRef) => void) | undefined;

/** [текст](адрес): без схемы — путь к файлу, http(s) — открыть в браузере */
function link(label: string, href: string, key: string, openRef: OpenRef): ReactNode {
  if (/^https?:\/\//i.test(href)) return <Text key={key} style={md.link} onPress={() => void Linking.openURL(href)}>{label}</Text>;
  const ref = openRef && !/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(href.replace(/^[A-Za-z]:/, "")) ? parseFileRef(/[\\/]/.test(href) ? href : `./${href}`) : undefined;
  return ref ? <Text key={key} style={md.link} onPress={() => openRef!(ref)}>{label}</Text> : label;
}

function inline(text: string, keyBase: string, openRef: OpenRef): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g).map((t, i) => {
    if (t.startsWith("`") && t.endsWith("`") && t.length > 1) {
      const code = t.slice(1, -1);
      const ref = openRef ? parseFileRef(code) : undefined;
      return ref ? <Text key={keyBase + i} style={[md.code, md.fileref]} onPress={() => openRef!(ref)}>{code}</Text> : <Text key={keyBase + i} style={md.code}>{code}</Text>;
    }
    // внутри жирного тоже бывает `код` (**`src/app.ts`**): разбираем его тем же способом
    if (t.startsWith("**") && t.endsWith("**") && t.length > 3) return <Text key={keyBase + i} style={md.bold}>{inline(t.slice(2, -2), `${keyBase}${i}b`, openRef)}</Text>;
    const l = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(t);
    if (l) return link(l[1]!, l[2]!, keyBase + i, openRef);
    return t;
  });
}

function TextBlock({ text, k }: { text: string; k: string }) {
  const openRef = useContext(FileRefCtx);
  const lines = text.replace(/^\n+|\n+$/g, "").split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) return <Text key={k + i} selectable style={[S.text, md.h]}>{inline(h[2]!, k + i, openRef)}</Text>;
        const li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
        if (li) {
          return (
            <Text key={k + i} selectable style={[S.text, { paddingLeft: 8 + li[1]!.length * 4 }]}>
              {/^\d/.test(li[2]!) ? li[2] : "•"} {inline(li[3]!, k + i, openRef)}
            </Text>
          );
        }
        return <Text key={k + i} selectable style={S.text}>{inline(line, k + i, openRef)}</Text>;
      })}
    </>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  // нечётное число ``` — блок кода ещё стримится, считаем его закрытым
  const chunks = text.split("```");
  return (
    <View style={md.wrap}>
      {chunks.map((chunk, i) => {
        if (i % 2 === 0) return chunk.trim() ? <TextBlock key={i} text={chunk} k={`t${i}`} /> : null;
        const lang = /^([\w+-]*)\n/.exec(chunk)?.[1];
        const code = chunk.replace(/^[\w+-]*\n/, "").replace(/\n$/, "");
        if (isArtifactLang(lang)) return <ArtifactCard key={i} source={code} />;
        if (lang?.toLowerCase() === "mermaid") return <MermaidCard key={i} source={code} />;
        return (
          <ScrollView key={i} horizontal style={md.pre} contentContainerStyle={{ padding: 8 }}>
            <Text selectable style={md.preText}>{code}</Text>
          </ScrollView>
        );
      })}
    </View>
  );
});

const md = StyleSheet.create({
  wrap: { gap: 6 },
  code: { fontFamily: mono, fontSize: 13, backgroundColor: C.bg3, color: "#f0c674" },
  fileref: { textDecorationLine: "underline", textDecorationStyle: "dotted" },
  link: { color: C.accent, textDecorationLine: "underline" },
  bold: { fontWeight: "700" },
  h: { fontWeight: "700", fontSize: 16, marginTop: 4 },
  pre: { backgroundColor: "#0b0d11", borderRadius: 8, borderWidth: 1, borderColor: C.line },
  preText: { fontFamily: mono, fontSize: 12, color: C.text, lineHeight: 17 },
});

// ---------- части ----------

export function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "reasoning":
      return part.text ? <Reasoning text={part.text} /> : null;
    case "tool":
      return <ToolCard part={part} />;
    case "file":
      return <FileChip fileId={part.fileId} name={part.name} mime={part.mime} size={part.size} />;
    case "check":
      return <CheckCard part={part} />;
    case "compaction":
      return <CompactionMark part={part} />;
  }
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** Отметка в ленте: здесь контекст агента сжат, выше — то, что он помнит только пересказом. */
export function CompactionMark({ part }: { part: Extract<Part, { type: "compaction" }> }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 10 }}>
      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
      <Text style={[S.muted, { fontSize: 13, flexShrink: 1, textAlign: "center" }]}>
        {part.trigger === "auto" ? t("Контекст сжат автоматически", "Context compacted automatically") : t("Контекст сжат", "Context compacted")}
        {part.preTokens && part.postTokens ? ` · ${kTokens(part.preTokens)} → ${kTokens(part.postTokens)} ${t("токенов", "tokens")}` : ""}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: C.line }} />
    </View>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} hitSlop={8}>
        <Text style={S.muted}>{open ? "▾" : "▸"} {t("размышления", "thinking")}</Text>
      </Pressable>
      {open ? <Text selectable style={[S.muted, pt.reasoning]}>{text}</Text> : null}
    </View>
  );
}

const STATUS_ICON = { pending: "…", running: "⋯", completed: "✓", error: "✗" } as const;
const STATUS_COLOR = { pending: C.muted, running: C.warn, completed: C.ok, error: C.err } as const;

function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const input = (part.input ?? {}) as Record<string, unknown>;
  return (
    <View style={pt.tool}>
      <Pressable style={pt.toolHead} onPress={() => setOpen(!open)}>
        <Text style={[pt.toolStatus, { color: STATUS_COLOR[part.status] }]}>{STATUS_ICON[part.status]}</Text>
        <Text style={pt.toolName}>{part.tool}</Text>
        <Text style={pt.toolTitle} numberOfLines={1}>
          {part.title ?? ""}
        </Text>
      </Pressable>
      {open ? (
        <View style={pt.toolBody}>
          <ToolInput tool={part.tool} input={input} />
          {part.output ? <Pre text={part.output} /> : null}
          {part.error ? <Pre text={part.error} color={C.err} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ${t("мс", "ms")}` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} ${t("с", "s")}`);

/** Автопроверка хаба: команды проекта после хода агента. Упавшая раскрыта сразу. */
function CheckCard({ part }: { part: Extract<Part, { type: "check" }> }) {
  const failed = part.results.find((r) => r.code !== 0);
  const [open, setOpen] = useState<boolean>();
  const shown = open ?? part.status === "failed";
  const total = part.results.reduce((a, r) => a + r.ms, 0);
  const color = part.status === "passed" ? C.ok : part.status === "failed" ? C.err : C.muted;
  const title =
    part.status === "running"
      ? t("идёт…", "running…")
      : part.status === "passed"
        ? `${t("прошли", "passed")} · ${fmtMs(total)}`
        : part.status === "failed" && failed
          ? `${t("упало", "failed")}: ${failed.command}`
          : t("остановлена", "stopped");
  return (
    <View style={pt.tool}>
      <Pressable style={pt.toolHead} onPress={() => setOpen(!shown)}>
        {part.status === "running" ? <ActivityIndicator size="small" color={C.muted} /> : <Text style={[pt.toolStatus, { color }]}>{part.status === "passed" ? "✓" : part.status === "failed" ? "✗" : "■"}</Text>}
        <Text style={pt.toolName}>{t("автопроверка", "auto-check")}</Text>
        <Text style={pt.toolTitle} numberOfLines={1}>
          {title}
        </Text>
      </Pressable>
      {part.note ? <Text style={[S.muted, { paddingHorizontal: 10, paddingBottom: 6 }]}>{part.note}</Text> : null}
      {shown ? (
        <View style={pt.toolBody}>
          {part.results.map((r, i) => (
            <View key={i} style={{ gap: 4 }}>
              <Text style={{ fontFamily: mono, fontSize: 12, color: r.code === 0 ? C.ok : C.err }}>
                {r.code === 0 ? "✓" : "✗"} {r.command} <Text style={S.muted}>· {fmtMs(r.ms)}</Text>
              </Text>
              {r.code !== 0 && r.output ? <Pre text={r.output} color={C.err} /> : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Pre({ text, color }: { text: string; color?: string }) {
  const shown = text.length > 6000 ? text.slice(0, 6000) + "\n…" : text;
  return (
    <ScrollView horizontal style={pt.pre} contentContainerStyle={{ padding: 8 }}>
      <Text selectable style={[md.preText, color ? { color } : null]}>{shown}</Text>
    </ScrollView>
  );
}

/** Для правок — дифф, для команд — сама команда, иначе JSON входа. */
export function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const oldS = (input.old_string ?? input.oldString) as string | undefined;
  const newS = (input.new_string ?? input.newString) as string | undefined;
  const file = String(input.file_path ?? input.filePath ?? "");
  if (typeof oldS === "string" && typeof newS === "string") {
    return (
      <View style={pt.diff}>
        <Text style={pt.diffFile}>{file}</Text>
        <ScrollView horizontal contentContainerStyle={{ padding: 6 }}>
          <View>
            {oldS.split("\n").map((l, i) => (
              <Text key={`o${i}`} style={[md.preText, pt.del]}>- {l}</Text>
            ))}
            {newS.split("\n").map((l, i) => (
              <Text key={`n${i}`} style={[md.preText, pt.add]}>+ {l}</Text>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }
  if (/^write$/i.test(tool) && typeof input.content === "string") {
    return (
      <View style={pt.diff}>
        <Text style={pt.diffFile}>{file}</Text>
        <Pre text={input.content} />
      </View>
    );
  }
  if (typeof input.command === "string") return <Pre text={"$ " + input.command} color="#9fe0a8" />;
  if (!Object.keys(input).length) return null;
  return <Pre text={JSON.stringify(input, null, 2)} />;
}

/** Файл в чате: превью картинки, по нажатию — открыть / поделиться / сохранить. */
export function FileChip({ fileId, name, mime, size }: { fileId: string; name: string; mime: string; size: number }) {
  const isImage = mime.startsWith("image/") && mime !== "image/heic";
  const [thumb, setThumb] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>();
  const ref = { fileId, name, mime, size };

  useEffect(() => {
    if (!isImage || size > 15 * 1024 * 1024) return;
    let alive = true;
    imageUri(ref).then((u) => alive && setThumb(u), () => {});
    return () => {
      alive = false;
    };
  }, [fileId]);

  const run = (f: () => Promise<unknown>) => async () => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
      setProgress(undefined);
    }
  };
  const menu = () =>
    dialog(name, fmtSize(size), [
      {
        text: t("Открыть", "Open"),
        icon: "📂",
        // текст и код — во встроенном просмотрщике, остальное — системой
        onPress: isTextFile(name, mime, size) ? () => go({ page: "file", fileId, name, mime, size }) : run(() => openFile(ref, setProgress)),
      },
      { text: t("Поделиться", "Share"), icon: "📤", hint: t("в Telegram, почту и т.п.", "to Telegram, email, etc."), onPress: run(() => shareFile(ref, setProgress)) },
      { text: t("Сохранить", "Save"), icon: "💾", hint: t("в папку на телефоне", "to a folder on the phone"), onPress: run(async () => (await saveFile(ref, setProgress)) && ToastAndroid.show(t("Сохранено", "Saved"), ToastAndroid.SHORT)) },
    ], { cancelable: true });

  const icon = isImage ? "🖼" : mime === "application/pdf" ? "📕" : "📄";
  return (
    <Pressable onPress={menu} style={{ gap: 6, alignSelf: "flex-start", maxWidth: "100%" }}>
      {thumb ? <Image source={{ uri: thumb }} style={pt.thumb} resizeMode="cover" /> : null}
      <View style={pt.file}>
        <Text style={{ fontSize: 18 }}>{icon}</Text>
        <Text style={[S.text, { flexShrink: 1 }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={S.muted}>{fmtSize(size)}</Text>
        {busy && progress !== undefined && progress < 1 ? <Text style={S.muted}>{Math.round(progress * 100)}%</Text> : null}
        {busy ? <ActivityIndicator size="small" color={C.text} /> : <Text style={S.muted}>⋯</Text>}
      </View>
    </Pressable>
  );
}

export function PermissionCard({ sessionId, req }: { sessionId: string; req: PermissionRequest }) {
  const [busy, setBusy] = useState<PermissionReply>();
  const [error, setError] = useState<string>();
  const answer = async (reply: PermissionReply) => {
    setBusy(reply);
    setError(undefined);
    try {
      await client!.reply(sessionId, req.id, reply);
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  };
  const detail = (req.detail && typeof req.detail === "object" ? req.detail : {}) as Record<string, unknown>;
  return (
    <View style={pt.perm}>
      <Text style={S.text}>
        <Text style={{ fontWeight: "700", color: C.warn }}>{t("Разрешить?", "Allow?")} </Text>
        <Text style={pt.toolName}>{req.tool}</Text>
      </Text>
      <View style={{ maxHeight: 220 }}>
        <ScrollView>{Object.keys(detail).length ? <ToolInput tool={req.tool} input={detail} /> : <Text style={md.code}>{req.title}</Text>}</ScrollView>
      </View>
      {error ? <Text style={S.error}>{error}</Text> : null}
      <View style={pt.permActions}>
        <Btn kind="primary" title={t("Разрешить", "Allow")} busy={busy === "once"} disabled={!!busy} onPress={() => void answer("once")} style={{ flex: 1 }} />
        {req.canAlways ? <Btn title={t("Всегда", "Always")} busy={busy === "always"} disabled={!!busy} onPress={() => void answer("always")} /> : null}
        <Btn kind="danger" title={t("Нет", "Deny")} busy={busy === "reject"} disabled={!!busy} onPress={() => void answer("reject")} />
      </View>
    </View>
  );
}

const pt = StyleSheet.create({
  reasoning: { marginTop: 4, fontStyle: "italic", lineHeight: 18 },
  tool: { backgroundColor: C.bg2, borderRadius: 10, borderWidth: 1, borderColor: C.line, overflow: "hidden" },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingVertical: 8 },
  toolStatus: { width: 14, textAlign: "center", fontWeight: "700" },
  toolName: { color: C.accent, fontFamily: mono, fontSize: 13, fontWeight: "700" },
  toolTitle: { color: C.muted, fontFamily: mono, fontSize: 12, flex: 1 },
  toolBody: { padding: 8, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  pre: { backgroundColor: "#0b0d11", borderRadius: 6, maxHeight: 320 },
  diff: { backgroundColor: "#0b0d11", borderRadius: 6, overflow: "hidden" },
  diffFile: { color: C.muted, fontFamily: mono, fontSize: 11, paddingHorizontal: 8, paddingTop: 6 },
  del: { color: "#f19999", backgroundColor: "rgba(239,68,68,.12)" },
  add: { color: "#9fe0a8", backgroundColor: "rgba(34,197,94,.12)" },
  thumb: { width: 220, height: 160, borderRadius: 10, backgroundColor: C.bg3 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.bg3, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, alignSelf: "flex-start", maxWidth: "100%" },
  perm: { margin: 8, padding: 12, gap: 8, borderRadius: 12, backgroundColor: "#2a2312", borderWidth: 1, borderColor: "#5c4a1a" },
  permActions: { flexDirection: "row", gap: 8 },
  question: { backgroundColor: "#172238", borderColor: "#2f4a7a" },
  option: { backgroundColor: C.bg2, borderRadius: 10, borderWidth: 1, borderColor: C.line, padding: 10, gap: 2 },
  optionOn: { borderColor: C.accent, backgroundColor: "#16233a" },
});

/** Вопрос агента: варианты (один или несколько) и свой ответ, если разрешён. */
export function QuestionCard({ sessionId, req }: { sessionId: string; req: QuestionRequest }) {
  const [picked, setPicked] = useState<string[][]>(() => req.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const answers = req.questions.map((_, i) => [...picked[i]!, ...(custom[i]!.trim() ? [custom[i]!.trim()] : [])]);
  const ready = answers.every((a) => a.length > 0);

  const toggle = (qi: number, label: string, multiple?: boolean) =>
    setPicked((p) => p.map((sel, i) => (i !== qi ? sel : multiple ? (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]) : [label])));

  const send = async (a: QuestionAnswers) => {
    setBusy(true);
    setError(undefined);
    try {
      await client!.answer(sessionId, req.id, a);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <View style={[pt.perm, pt.question]}>
      <View style={{ maxHeight: 360 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
          {req.questions.map((q, qi) => (
            <View key={qi} style={{ gap: 6 }}>
              <Text style={S.text}>
                {q.header ? <Text style={{ color: C.accent, fontWeight: "700" }}>{q.header} · </Text> : null}
                <Text style={{ fontWeight: "700" }}>{q.question}</Text>
                {q.multiple ? <Text style={S.muted}> ({t("можно несколько", "multiple allowed")})</Text> : null}
              </Text>
              {q.options.map((o) => {
                const on = picked[qi]!.includes(o.label);
                return (
                  <Pressable key={o.label} disabled={busy} onPress={() => toggle(qi, o.label, q.multiple)} style={[pt.option, on && pt.optionOn]}>
                    <Text style={[S.text, { fontWeight: "600" }]}>
                      {q.multiple ? (on ? "☑ " : "☐ ") : on ? "◉ " : "○ "}
                      {o.label}
                    </Text>
                    {o.description ? <Text style={S.muted}>{o.description}</Text> : null}
                  </Pressable>
                );
              })}
              {q.custom ? (
                <TextInput
                  style={S.input}
                  placeholder={t("Свой ответ…", "Your own answer…")}
                  placeholderTextColor={C.muted}
                  editable={!busy}
                  value={custom[qi]}
                  onChangeText={(v) => {
                    setCustom((c) => c.map((x, i) => (i === qi ? v : x)));
                    // свой текст в одиночном выборе заменяет вариант
                    if (v.trim() && !q.multiple) setPicked((p) => p.map((sel, i) => (i === qi ? [] : sel)));
                  }}
                />
              ) : null}
            </View>
          ))}
        </ScrollView>
      </View>
      {error ? <Text style={S.error}>{error}</Text> : null}
      <View style={pt.permActions}>
        <Btn kind="primary" title={t("Ответить", "Answer")} disabled={!ready || busy} busy={busy} onPress={() => void send(answers)} style={{ flex: 1 }} />
        <Btn title={t("Не отвечать", "Skip")} disabled={busy} onPress={() => void send(null)} />
      </View>
    </View>
  );
}

const TEXT_EXT = /\.(md|markdown|txt|log|json|jsonc|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|sh|bash|ps1|bat|cmd|sql|gradle|properties|lock)$/i;

/** Можно ли показать файл как текст прямо в приложении (до 2 МБ). */
export function isTextFile(name: string, mime: string, size: number): boolean {
  if (size > 2 * 1024 * 1024) return false;
  return mime.startsWith("text/") || /json|xml|javascript|typescript|yaml|x-sh/.test(mime) || TEXT_EXT.test(name);
}
