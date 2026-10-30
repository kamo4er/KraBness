// Копирование ответов. Каждая строка и пункт ответа — свой <Text>, а Android выделяет только внутри одного,
// поэтому выделить кусок через пункты нельзя. Здесь — «Скопировать» весь ответ и «Выделить»: весь текст
// одним полем, в котором выделяется что угодно.
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TextInput, ToastAndroid, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { t, type MessageView } from "@kamharn/client";
import { Btn } from "./ui.tsx";
import { C, S } from "./theme.ts";

/** Текст сообщения целиком (markdown как есть): все текстовые части по порядку. */
export function copyableText(m: MessageView): string {
  return m.parts
    .map((p) => (p.type === "text" ? p.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
  ToastAndroid.show(t("Скопировано", "Copied"), ToastAndroid.SHORT);
}

/** Кнопки под ответом: скопировать всё и выделить кусок. */
export function CopyActions({ text }: { text: string }) {
  const [selecting, setSelecting] = useState(false);
  if (!text) return null;
  return (
    <>
      <Pressable onPress={() => void copyText(text)} hitSlop={8} style={st.action}>
        <Text style={S.muted}>⧉ {t("Скопировать", "Copy")}</Text>
      </Pressable>
      <Pressable onPress={() => setSelecting(true)} hitSlop={8} style={st.action}>
        <Text style={S.muted}>✂ {t("Выделить", "Select")}</Text>
      </Pressable>
      {selecting ? <SelectText text={text} onClose={() => setSelecting(false)} /> : null}
    </>
  );
}

/** Весь текст одним полем: выделение тянется через любые пункты, меню «Копировать» — системное. */
export function SelectText({ text, onClose }: { text: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[st.screen, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 8 }]}>
        <View style={st.head}>
          <Text style={[S.text, { flex: 1, fontWeight: "700" }]}>{t("Выдели нужное", "Select what you need")}</Text>
          <Btn small title={t("Скопировать всё", "Copy all")} onPress={() => void copyText(text)} />
          <Btn small kind="ghost" title="✕" onPress={onClose} />
        </View>
        <Text style={[S.muted, { paddingHorizontal: 12 }]}>
          {t("Удерживай слово, потяни за края выделения, потом «Копировать».", "Hold a word, drag the selection handles, then “Copy”.")}
        </Text>
        <TextInput
          style={st.text}
          value={text}
          multiline
          // поле, а не <Text>: только так выделение идёт через абзацы; клавиатура не нужна, правки не применяются
          showSoftInputOnFocus={false}
          onChangeText={() => {}}
          caretHidden
          textAlignVertical="top"
          scrollEnabled
          autoCorrect={false}
          spellCheck={false}
        />
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  action: { paddingVertical: 2 },
  screen: { flex: 1, backgroundColor: C.bg, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  text: { flex: 1, color: C.text, fontSize: 15, lineHeight: 22, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: C.bg2, marginHorizontal: 8, borderRadius: 10 },
});
