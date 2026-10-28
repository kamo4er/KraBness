// «@» в поле ввода (как в вебе — apps/web/src/Mention.tsx): список файлов и папок проекта, нажатие вставляет путь.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { applyMention, mentionAt, t, type FileHit } from "@kamharn/client";
import { client } from "./store.ts";
import { C, S, mono } from "./theme.ts";

export function useMention(sessionId: string, text: string, caret: number) {
  const at = mentionAt(text, caret);
  const query = at?.query;
  const [hits, setHits] = useState<FileHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query === undefined) return;
    let gone = false;
    setLoading(true);
    // не дёргаем хаб на каждую букву
    const timer = setTimeout(() => {
      client?.searchFiles(sessionId, query).then(
        (h) => !gone && (setHits(h), setLoading(false)),
        () => !gone && (setHits([]), setLoading(false)),
      );
    }, 150);
    return () => ((gone = true), clearTimeout(timer));
  }, [sessionId, query]);
  const open = at !== undefined;
  return { open, hits: open ? hits : [], loading: open && loading, apply: (h: FileHit) => applyMention(text, caret, h.path, h.dir) };
}

export function MentionList({ m, pick }: { m: ReturnType<typeof useMention>; pick: (h: FileHit) => void }) {
  if (!m.open || (!m.hits.length && !m.loading)) return null;
  return (
    <ScrollView style={st.list} keyboardShouldPersistTaps="always">
      {!m.hits.length ? <Text style={[S.muted, st.item]}>{t("ищу…", "searching…")}</Text> : null}
      {m.hits.map((h) => {
        const cut = h.path.lastIndexOf("/") + 1;
        return (
          <Pressable key={h.path} style={({ pressed }) => [st.item, pressed && { backgroundColor: C.bg3 }]} onPress={() => pick(h)}>
            <Text style={st.name} numberOfLines={1}>
              {h.dir ? "📁 " : "📄 "}
              {h.path.slice(cut)}
              {h.dir ? "/" : ""}
            </Text>
            {cut > 0 ? (
              <Text style={[S.muted, { fontFamily: mono, fontSize: 12 }]} numberOfLines={1} ellipsizeMode="head">
                {h.path.slice(0, cut)}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  list: { maxHeight: 260, marginHorizontal: 8, marginTop: 8, backgroundColor: C.bg, borderRadius: 10, borderWidth: 1, borderColor: C.line },
  item: { paddingHorizontal: 10, paddingVertical: 8, gap: 1 },
  name: { color: C.text, fontFamily: mono, fontSize: 14 },
});
