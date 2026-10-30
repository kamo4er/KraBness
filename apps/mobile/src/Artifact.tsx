// Живой артефакт: блок ```html из ответа агента — работающая страница в карточке чата и на весь экран;
// диаграммы ```mermaid. Страница живёт в своём WebView без моста (onMessage не задан): ей не видны ни токен,
// ни хаб, ни приложение. Сеть (CDN) доступна, переход по ссылке открывает браузер.
import { useEffect, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { artifactDocument, t } from "@kamharn/client";
import { copyText } from "./copy.tsx";
import { mermaidPage } from "./mermaidPage.ts";
import { Btn } from "./ui.tsx";
import { C, S, mono } from "./theme.ts";

/** пока агент дописывает ответ, блок растёт — запускаем, когда он не менялся столько */
const SETTLE_MS = 1200;

function useSettled(source: string): boolean {
  const [ready, setReady] = useState<string>();
  useEffect(() => {
    const timer = setTimeout(() => setReady(source), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [source]);
  return ready === source;
}

/** сама страница остаётся в WebView, ссылка наружу — в браузер */
function navigate(r: ShouldStartLoadRequest): boolean {
  if (/^(about|data|blob):/i.test(r.url)) return true;
  if (/^https?:/i.test(r.url)) void Linking.openURL(r.url);
  return false;
}

function Page({ html, nonce, style }: { html: string; nonce: number; style: object }) {
  return (
    <WebView
      key={nonce}
      style={style}
      source={{ html }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={navigate}
      javaScriptEnabled
      domStorageEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      geolocationEnabled={false}
      setSupportMultipleWindows={false}
      mixedContentMode="never"
      mediaPlaybackRequiresUserAction
      nestedScrollEnabled
      // карточка не прыгает белым, пока страница грузится
      containerStyle={{ backgroundColor: "#fff" }}
    />
  );
}

function Tools({ source, code, onCode, onRestart, onFull }: { source: string; code: boolean; onCode: () => void; onRestart: () => void; onFull?: () => void }) {
  return (
    <View style={st.tools}>
      {onFull ? <Btn small kind="ghost" title="⤢" onPress={onFull} /> : null}
      <Btn small kind="ghost" title="↻" onPress={onRestart} />
      <Btn small kind={code ? "primary" : "ghost"} title="</>" onPress={onCode} />
      <Btn small kind="ghost" title="⧉" onPress={() => void copyText(source)} />
    </View>
  );
}

function Code({ source, full }: { source: string; full?: boolean }) {
  return (
    <ScrollView style={full ? { flex: 1 } : st.codeBox} nestedScrollEnabled>
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={{ padding: 8 }}>
        <Text selectable style={st.codeText}>
          {source}
        </Text>
      </ScrollView>
    </ScrollView>
  );
}

/** Страница на весь экран (и для .html-файлов из просмотра проекта). */
export function ArtifactFull({ source, title, onClose }: { source: string; title?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [nonce, setNonce] = useState(0);
  const [code, setCode] = useState(false);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[st.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={st.bar}>
          <Btn small kind="ghost" title="✕" onPress={onClose} />
          <Text style={[S.muted, st.title]} numberOfLines={1}>
            {title ?? t("Живой результат", "Live result")}
          </Text>
          <Tools source={source} code={code} onCode={() => setCode(!code)} onRestart={() => setNonce(nonce + 1)} />
        </View>
        {code ? <Code source={source} full /> : <Page html={artifactDocument(source)} nonce={nonce} style={{ flex: 1 }} />}
      </View>
    </Modal>
  );
}

/** Карточка в ответе агента. */
export function ArtifactCard({ source }: { source: string }) {
  const live = useSettled(source);
  const [nonce, setNonce] = useState(0);
  const [code, setCode] = useState(false);
  const [full, setFull] = useState(false);
  return (
    <View style={st.card}>
      <View style={st.bar}>
        <Text style={[S.muted, st.title]} numberOfLines={1}>
          ✨ {t("Живой результат", "Live result")}
        </Text>
        <Tools source={source} code={code} onCode={() => setCode(!code)} onRestart={() => setNonce(nonce + 1)} onFull={() => setFull(true)} />
      </View>
      {code ? (
        <Code source={source} />
      ) : live ? (
        // в полноэкранном режиме карточку не держим: две копии тяжёлой 3D-сцены телефону ни к чему
        full ? (
          <View style={st.frame} />
        ) : (
          // в ленте страница только показывается: иначе WebView забирает свайп и чат не листается; играть — на весь экран
          <Pressable onPress={() => setFull(true)}>
            <View pointerEvents="none">
              <Page html={artifactDocument(source)} nonce={nonce} style={st.frame} />
            </View>
            <Text style={st.open}>⤢ {t("Нажми, чтобы открыть", "Tap to open")}</Text>
          </Pressable>
        )
      ) : (
        <Text style={[S.muted, st.wait]}>{t("Собираю…", "Assembling…")}</Text>
      )}
      {full ? <ArtifactFull source={source} onClose={() => setFull(false)} /> : null}
    </View>
  );
}

// ---------- mermaid: страница — mermaidPage.ts ----------

/** не нарисовалась за столько — считаем, что mermaid не загрузился (нет сети, старый WebView) */
const MERMAID_TIMEOUT_MS = 30_000;

/** Диаграмма ```mermaid; не нарисовалась — показываем исходник и причину. */
export function MermaidCard({ source }: { source: string }) {
  const live = useSettled(source);
  const [height, setHeight] = useState(0);
  const [error, setError] = useState<{ message: string; load: boolean }>();
  const [nonce, setNonce] = useState(0);
  const [full, setFull] = useState(false);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    setHeight(0);
    setError(undefined);
  }, [source, nonce]);
  useEffect(() => {
    if (!live || height || error) return;
    const timer = setTimeout(() => setError({ message: t("Нет ответа за 30 с", "No response in 30 s"), load: true }), MERMAID_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [live, height, error, source, nonce]);
  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data) as { h?: number; error?: string; load?: boolean };
      if (typeof m.h === "number") setHeight(Math.min(Math.max(m.h, 40), 2000));
      else if (typeof m.error === "string") setError({ message: m.error.slice(0, 300), load: !!m.load });
    } catch {
      // ничего, кроме высоты и ошибки, отсюда не ждём
    }
  };
  if (error) {
    return (
      <View style={st.card}>
        <View style={st.bar}>
          <Text style={[S.muted, st.title]}>
            {error.load ? t("Не удалось загрузить mermaid", "Couldn't load mermaid") : t("Ошибка в диаграмме", "Diagram error")}
          </Text>
          <Btn small kind="ghost" title="↻" onPress={() => setNonce(nonce + 1)} />
        </View>
        <Text style={[S.muted, { paddingHorizontal: 8, fontSize: 12 }]}>{error.message}</Text>
        <Code source={source} />
      </View>
    );
  }
  return (
    <View style={[st.card, { backgroundColor: "#111318" }]}>
      {live ? (
        // в ленте — по ширине экрана и без касаний (иначе WebView забирает свайп), крупно — на весь экран
        <Pressable onPress={() => setFull(true)} disabled={!height}>
          <View pointerEvents="none">
            <MermaidView key={nonce} source={source} fit onMessage={onMessage} style={{ height: height || 1 }} />
          </View>
        </Pressable>
      ) : null}
      {!live || !height ? <Text style={[S.muted, st.wait]}>{t("Рисую диаграмму…", "Drawing the diagram…")}</Text> : null}
      {full ? (
        <Modal visible animationType="slide" onRequestClose={() => setFull(false)}>
          <View style={[st.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <View style={st.bar}>
              <Btn small kind="ghost" title="✕" onPress={() => setFull(false)} />
              <Text style={[S.muted, st.title]} numberOfLines={1}>
                {t("Диаграмма", "Diagram")}
              </Text>
              <Btn small kind="ghost" title="⧉" onPress={() => void copyText(source)} />
            </View>
            <MermaidView source={source} fit={false} onMessage={() => {}} style={{ flex: 1 }} />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function MermaidView({ source, fit, onMessage, style }: { source: string; fit: boolean; onMessage: (e: WebViewMessageEvent) => void; style: object }) {
  return (
    <WebView
      style={[{ backgroundColor: "#111318" }, style]}
      source={{ html: mermaidPage(source, fit) }}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={navigate}
      // мост нужен только для высоты и ошибки
      onMessage={onMessage}
      allowFileAccess={false}
      domStorageEnabled={false}
      setSupportMultipleWindows={false}
      scrollEnabled={!fit}
      setBuiltInZoomControls={!fit}
      setDisplayZoomControls={false}
    />
  );
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.line, borderRadius: 10, overflow: "hidden", backgroundColor: C.bg2 },
  bar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.bg2 },
  title: { flex: 1, fontSize: 13 },
  tools: { flexDirection: "row", gap: 2 },
  frame: { height: 360, backgroundColor: "#fff" },
  wait: { padding: 16, textAlign: "center" },
  open: { position: "absolute", right: 8, bottom: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, overflow: "hidden", backgroundColor: "rgba(0,0,0,0.6)", color: "#fff", fontSize: 12 },
  screen: { flex: 1, backgroundColor: C.bg },
  codeBox: { maxHeight: 360, backgroundColor: "#0b0d11" },
  codeText: { fontFamily: mono, fontSize: 12, color: C.text, lineHeight: 17 },
});
