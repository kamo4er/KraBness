// Свои диалоги вместо системного Alert (серый, кнопки капсом, не настраивается).
// dialog() принимает то же, что Alert.alert; вид выбирается сам:
//   меню (3+ кнопки)            → лист снизу со строками и иконками;
//   подтверждение (1–2 кнопки)  → карточка с нормальными кнопками, опасное действие красное;
//   без кнопок                  → карточка «Понятно».
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { C } from "./theme.ts";
import { t } from "@kamharn/client";

export interface DialogButton {
  text: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
  /** эмодзи слева в меню */
  icon?: string;
  /** подпись мелким под пунктом меню */
  hint?: string;
}

interface Req {
  title: string;
  message?: string;
  buttons: DialogButton[];
}

const queue: Req[] = [];
let wake: (() => void) | undefined;

export function dialog(title: string, message?: string, buttons?: DialogButton[], _options?: unknown): void {
  queue.push({ title, message: message || undefined, buttons: buttons?.length ? buttons : [{ text: t("Понятно", "OK"), style: "cancel" }] });
  wake?.();
}

/** Ставится один раз в корень приложения. */
export function DialogHost() {
  const [cur, setCur] = useState<Req>();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    wake = () => setCur((c) => c ?? queue.shift());
    wake();
    return () => void (wake = undefined);
  }, []);

  // закрыть и, если кнопка открывает следующий диалог, дать первому уйти
  const close = (b?: DialogButton) => {
    setCur(undefined);
    setTimeout(() => {
      b?.onPress?.();
      setTimeout(() => setCur((c) => c ?? queue.shift()), 50);
    }, 120);
  };
  if (!cur) return null;

  const cancel = cur.buttons.find((b) => b.style === "cancel");
  const actions = cur.buttons.filter((b) => b !== cancel);
  const menu = actions.length >= 2 || actions.some((b) => b.icon);

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => close(cancel)}>
      <Pressable style={[st.backdrop, menu ? st.bottom : st.center]} onPress={() => close(cancel)}>
        {menu ? (
          <Pressable style={[st.sheet, { paddingBottom: insets.bottom + 12 }]} onPress={() => {}}>
            <View style={st.handle} />
            <Text style={st.title}>{cur.title}</Text>
            {cur.message ? (
              <ScrollView style={{ maxHeight: 220 }}>
                <Text style={st.message}>{cur.message}</Text>
              </ScrollView>
            ) : null}
            <View style={{ marginTop: 6 }}>
              {actions.map((b) => (
                <Pressable key={b.text} style={({ pressed }) => [st.row, pressed && st.pressed]} onPress={() => close(b)}>
                  <View style={[st.icon, b.style === "destructive" && st.iconDanger]}>
                    <Text style={{ fontSize: 18 }}>{b.icon ?? "•"}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[st.rowText, b.style === "destructive" && { color: C.err }]}>{b.text}</Text>
                    {b.hint ? <Text style={st.hint}>{b.hint}</Text> : null}
                  </View>
                </Pressable>
              ))}
            </View>
            <Pressable style={({ pressed }) => [st.btn, st.btnGhost, { marginTop: 10 }, pressed && st.pressed]} onPress={() => close(cancel)}>
              <Text style={st.btnText}>{cancel?.text ?? t("Закрыть", "Close")}</Text>
            </Pressable>
          </Pressable>
        ) : (
          <Pressable style={st.card} onPress={() => {}}>
            <Text style={st.title}>{cur.title}</Text>
            {cur.message ? (
              <ScrollView style={{ maxHeight: 320 }}>
                <Text style={st.message}>{cur.message}</Text>
              </ScrollView>
            ) : null}
            <View style={st.buttons}>
              {cancel && actions.length ? (
                <Pressable style={({ pressed }) => [st.btn, st.btnGhost, { flex: 1 }, pressed && st.pressed]} onPress={() => close(cancel)}>
                  <Text style={st.btnText}>{cancel.text}</Text>
                </Pressable>
              ) : null}
              {(actions.length ? actions : [cancel!]).map((b) => (
                <Pressable
                  key={b.text}
                  style={({ pressed }) => [st.btn, { flex: 1 }, b.style === "destructive" ? st.btnDanger : st.btnPrimary, pressed && st.pressed]}
                  onPress={() => close(b)}
                >
                  <Text style={[st.btnText, { color: "#fff" }]}>{b.text}</Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        )}
      </Pressable>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)" },
  bottom: { justifyContent: "flex-end" },
  center: { justifyContent: "center", padding: 24 },
  sheet: { backgroundColor: C.bg2, borderTopLeftRadius: 22, borderTopRightRadius: 22, paddingHorizontal: 16, paddingTop: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  handle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: C.line, marginBottom: 12 },
  card: { backgroundColor: C.bg2, borderRadius: 20, padding: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: C.line },
  title: { color: C.text, fontSize: 18, fontWeight: "700", marginBottom: 6 },
  message: { color: C.muted, fontSize: 15, lineHeight: 21 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 10, paddingHorizontal: 4, borderRadius: 12 },
  pressed: { opacity: 0.7 },
  icon: { width: 42, height: 42, borderRadius: 13, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center" },
  iconDanger: { backgroundColor: "rgba(239,106,106,0.14)" },
  rowText: { color: C.text, fontSize: 16, fontWeight: "600" },
  hint: { color: C.muted, fontSize: 13, marginTop: 2 },
  buttons: { flexDirection: "row", gap: 10, marginTop: 18 },
  btn: { height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  btnGhost: { backgroundColor: C.bg3 },
  btnPrimary: { backgroundColor: C.accent },
  btnDanger: { backgroundColor: C.err },
  btnText: { color: C.text, fontSize: 15, fontWeight: "600" },
});
