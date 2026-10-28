// Экран группы сессий: название, эмодзи, системный промпт для всех её сессий, удаление.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { client, useHub } from "../store.ts";
import { back } from "../nav.ts";
import { Btn } from "../ui.tsx";
import { C, S } from "../theme.ts";
import { dialog } from "../dialog.tsx";
import { t } from "@kamharn/client";

const ICONS = ["🛠", "🎮", "📱", "🌐", "🧠", "📊", "🎨", "🔬", "📝", "🏠"];

export function Group({ id }: { id: string }) {
  const state = useHub();
  const isNew = id === "new";
  const g = state.groups.find((x) => x.id === id);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noUserRules, setNoUserRules] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (g) (setName(g.name), setIcon(g.icon ?? ""), setPrompt(g.prompt ?? ""), setNoUserRules(!!g.noUserRules));
  }, [g?.id]);

  const fail = (e: Error) => (setBusy(false), dialog(t("Не получилось", "Failed"), e.message));
  const save = () => {
    setBusy(true);
    const done = () => back();
    if (isNew) void client?.createGroup({ name, icon, prompt, noUserRules }).then(done, fail);
    else void client?.updateGroup(id, { name, icon, prompt, noUserRules }).then(done, fail);
  };
  const remove = () =>
    dialog(t("Удалить группу?", "Delete the group?"), t(`«${g?.name}» пропадёт, сессии останутся без группы.`, `“${g?.name}” will be removed, its sessions stay ungrouped.`), [
      { text: t("Отмена", "Cancel"), style: "cancel" },
      { text: t("Удалить", "Delete"), style: "destructive", onPress: () => void client?.deleteGroup(id).then(() => back(), fail) },
    ]);

  if (!isNew && !g) {
    return (
      <View style={[S.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={S.muted}>{t("Группа не найдена", "Group not found")}</Text>
      </View>
    );
  }
  const count = state.sessions.filter((s) => s.groupId === id).length;
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={[S.h2, { flex: 1 }]} numberOfLines={1}>
          {isNew ? t("Новая группа", "New group") : `${g!.icon ?? ""} ${g!.name}`.trim()}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} keyboardShouldPersistTaps="handled">
        <Text style={S.h3}>{t("Название", "Name")}</Text>
        <TextInput style={S.input} value={name} onChangeText={setName} placeholder={t("например: Игры", "e.g. Games")} placeholderTextColor={C.muted} autoFocus={isNew} />
        <Text style={S.h3}>{t("Значок", "Icon")}</Text>
        <View style={st.icons}>
          {ICONS.map((i) => (
            <Pressable key={i} style={[st.icon, icon === i && st.iconOn]} onPress={() => setIcon(icon === i ? "" : i)}>
              <Text style={{ fontSize: 22 }}>{i}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={S.h3}>{t("Системный промпт", "System prompt")}</Text>
        <TextInput
          style={[S.input, { minHeight: 120, textAlignVertical: "top" }]}
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder={t("Добавляется к инструкциям агента во всех сессиях группы. Например: «Ты психолог-программист, помогаешь мне справиться с внутренней сингулярностью».", "Appended to the agent's instructions in every session of the group. E.g. “You are a senior game developer, keep answers short”.")}
          placeholderTextColor={C.muted}
        />
        <Text style={S.muted}>{t("Применяется ко всем сессиям группы со следующего сообщения — и к уже идущим, и к перенесённым в группу.", "Applies to all sessions of the group from the next message — running ones and ones moved into the group.")}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={[S.text, { fontWeight: "700" }]}>{t("Без моих глобальных правил", "Without my global rules")}</Text>
            <Text style={S.muted}>
              {t(
                "Claude не читает ~/.claude/CLAUDE.md и ~/.claude/rules: твои правила про код, обращение и стиль. Для чатов не про код (врач, дом). Нужное из них допиши в промпт выше.",
                "Claude skips ~/.claude/CLAUDE.md and ~/.claude/rules: your rules about coding, how to address you, style. For chats that aren't about code. Put what you need from them into the prompt above.",
              )}
            </Text>
          </View>
          <Switch value={noUserRules} onValueChange={setNoUserRules} />
        </View>
        <Btn kind="primary" title={isNew ? t("Создать группу", "Create group") : t("Сохранить", "Save")} busy={busy} disabled={!name.trim()} onPress={save} style={{ marginTop: 12 }} />
        {!isNew ? (
          <>
            <Btn kind="danger" title={t("Удалить группу", "Delete group")} onPress={remove} style={{ marginTop: 8 }} />
            <Text style={[S.muted, { textAlign: "center" }]}>{t("Сессий в группе", "Sessions in group")}: {count}</Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  icons: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  icon: { width: 46, height: 46, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg2, alignItems: "center", justifyContent: "center" },
  iconOn: { borderColor: C.accent, backgroundColor: C.bg3 },
});
