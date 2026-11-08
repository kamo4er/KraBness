// Встроенный просмотр текстового файла из чата: markdown с разметкой, остальное — моноширинно.
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { client, fmtSize } from "../store.ts";
import { back } from "../nav.ts";
import { shareFile } from "../files.ts";
import { Markdown } from "../Parts.tsx";
import { Btn } from "../ui.tsx";
import { C, S, mono } from "../theme.ts";
import { t } from "@kamharn/client";

export function FileViewer({ fileId, name, mime, size }: { fileId: string; name: string; mime: string; size: number }) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetch(client!.fileUrl(fileId))
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setText, (e: Error) => setError(e.message));
  }, [fileId]);

  const md = /\.(md|markdown)$/i.test(name) || mime === "text/markdown";
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <View style={{ flex: 1 }}>
          <Text style={S.h2} numberOfLines={1}>
            {name}
          </Text>
          <Text style={S.muted}>{fmtSize(size)}</Text>
        </View>
        <Btn small title={t("Поделиться", "Share")} onPress={() => void shareFile({ fileId, name, mime, size })} />
      </View>
      {error ? <Text style={[S.error, { padding: 12 }]}>{error}</Text> : null}
      {text === undefined && !error ? <Text style={[S.muted, { padding: 12 }]}>{t("загрузка…", "loading…")}</Text> : null}
      {text !== undefined ? (
        <ScrollView contentContainerStyle={{ padding: 14 }}>
          {md ? (
            <Markdown text={text} />
          ) : (
            <ScrollView horizontal>
              <Text selectable style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, color: C.text }}>
                {text}
              </Text>
            </ScrollView>
          )}
        </ScrollView>
      ) : null}
    </View>
  );
}
