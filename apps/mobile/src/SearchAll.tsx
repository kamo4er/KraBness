// Поиск по всем чатам: строка вместо списка сессий, результаты — сессия, кто, когда и кусок текста с найденными словами.
import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { t, type SearchHit } from "@kamharn/client";
import { client } from "./store.ts";
import { go } from "./nav.ts";
import { Btn } from "./ui.tsx";
import { C, S } from "./theme.ts";

function when(ts: number): string {
  const d = new Date(ts);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, "0")} ${hm}`;
}

/** «**слово**» из сниппета хаба → жирный */
function Snippet({ text }: { text: string }) {
  return (
    <Text style={st.snip} numberOfLines={3}>
      {text
        .replace(/\s+/g, " ")
        .split(/\*\*(.+?)\*\*/g)
        .map((s, i) => (i % 2 ? <Text key={i} style={st.hit}>{s}</Text> : s))}
    </Text>
  );
}

export function SearchAll({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>();
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(undefined);
      return;
    }
    const my = ++seq.current;
    const timer = setTimeout(() => {
      client?.search(query, 30).then(
        (h) => my === seq.current && (setHits(h), setError(undefined)),
        (e: Error) => my === seq.current && setError(e.message),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <View style={{ flex: 1 }}>
      <View style={st.bar}>
        <TextInput
          style={[S.input, { flex: 1, paddingVertical: 8 }]}
          autoFocus
          placeholder={t("Поиск по всем чатам…", "Search all chats…")}
          placeholderTextColor={C.muted}
          value={q}
          onChangeText={setQ}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Btn small kind="ghost" title="✕" onPress={onClose} />
      </View>
      {error ? <Text style={[S.error, { paddingHorizontal: 16 }]}>{error}</Text> : null}
      <FlatList
        data={hits ?? []}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(h) => `${h.sessionId}|${h.messageId}|${h.snippet}`}
        ListEmptyComponent={
          <Text style={[S.muted, st.empty]}>
            {hits ? t("Ничего не нашлось", "Nothing found") : t("Слова ищутся по началу: «крабик» найдёт и «крабика».", "Words match by their beginning.")}
          </Text>
        }
        ItemSeparatorComponent={() => <View style={st.sep} />}
        renderItem={({ item: h }) => (
          <Pressable style={({ pressed }) => [st.row, pressed && { backgroundColor: C.bg2 }]} onPress={() => go({ page: "session", id: h.sessionId })}>
            <Text style={S.muted} numberOfLines={1}>
              <Text style={st.title}>{h.title}</Text> · {h.role === "user" ? t("ты", "you") : t("агент", "agent")} · {when(h.ts)}
            </Text>
            <Snippet text={h.snippet} />
          </Pressable>
        )}
      />
    </View>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  row: { paddingHorizontal: 16, paddingVertical: 10, gap: 4 },
  title: { color: C.text, fontWeight: "600" },
  snip: { color: C.text, fontSize: 14, lineHeight: 20 },
  hit: { color: "#ffd166", fontWeight: "700" },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: C.line, marginLeft: 16 },
  empty: { textAlign: "center", marginTop: 32, paddingHorizontal: 24 },
});
