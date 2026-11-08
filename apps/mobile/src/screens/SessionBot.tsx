// Бот сессии в Telegram (как в вебе — SessionBot.tsx): токен от @BotFather → бот привязан к сессии;
// люди подключаются ссылкой t.me/<бот>?start=<код> — на телефоне она открывает Telegram сразу с кодом.
import { useEffect, useState } from "react";
import { Linking, ScrollView, Text, TextInput, View } from "react-native";
import { t, type SessionBotInfo } from "@kamharn/client";
import { client, useHub } from "../store.ts";
import { back } from "../nav.ts";
import { Btn } from "../ui.tsx";
import { C, S } from "../theme.ts";
import { dialog } from "../dialog.tsx";

export function SessionBot({ id }: { id: string }) {
  const title = useHub().sessions.find((s) => s.id === id)?.title ?? "";
  const [info, setInfo] = useState<SessionBotInfo>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  /** человек, которого переименовываем: имя прямо в строке */
  const [edit, setEdit] = useState<{ chat: number; name: string }>();
  useEffect(() => void client?.sessionBot(id).then(setInfo, (e: Error) => setMsg(e.message)), [id]);
  const run = (f: () => Promise<SessionBotInfo>) => {
    setBusy(true);
    setMsg(undefined);
    void f()
      .then(setInfo, (e: Error) => setMsg(e.message))
      .finally(() => setBusy(false));
  };
  const link = info?.bot && info.code ? `https://t.me/${info.bot}?start=${info.code}` : undefined;
  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={S.h1} numberOfLines={1}>
          ✈ {title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
        {!info ? (
          <Text style={S.muted}>{msg ?? t("загрузка…", "loading…")}</Text>
        ) : !info.configured ? (
          <>
            <Text style={S.text}>
              {t(
                "Свой Telegram-бот для этой сессии: пишешь ему — уходит агенту, файлы ложатся в папку сессии, ответ и файлы от агента приходят в Telegram.",
                "Your own Telegram bot for this session: write to it — it goes to the agent, files land in the session folder, the answer and files from the agent come to Telegram.",
              )}
            </Text>
            <Text style={S.muted}>{t("1. В Telegram открой @BotFather → /newbot, придумай имя.\n2. Скопируй токен и вставь сюда.", "1. In Telegram open @BotFather → /newbot, pick a name.\n2. Copy the token and paste it here.")}</Text>
            <Btn title={t("Открыть @BotFather", "Open @BotFather")} onPress={() => void Linking.openURL("https://t.me/BotFather")} />
            <TextInput style={[S.input, { fontFamily: "monospace" }]} value={token} onChangeText={setToken} placeholder="123456789:AA…" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} />
            <Btn kind="primary" title={busy ? t("Проверяю…", "Checking…") : t("Подключить бота", "Connect the bot")} busy={busy} disabled={!token.trim()} onPress={() => run(() => client!.setSessionBot(id, token))} />
          </>
        ) : (
          <>
            <Text style={S.h3}>
              {t("Бот", "Bot")}: {info.bot ? `@${info.bot}` : "…"}
            </Text>
            {info.error ? <Text style={S.error}>{info.error}</Text> : null}
            {link ? (
              <>
                <Btn kind="primary" title={t("Подключить себя: открыть бота", "Connect myself: open the bot")} onPress={() => void Linking.openURL(link)} />
                <Text style={S.muted}>
                  {t(`Для другого человека — отправь ему ссылку (код одноразовый):\n${link}`, `For someone else — send them the link (the code is single-use):\n${link}`)}
                </Text>
              </>
            ) : info.code ? (
              // имени бота ещё нет (нет связи с Telegram) — без ссылки, но код нужен
              <Text style={S.text} selectable>
                {t(`Подключить человека: написать боту /start ${info.code} (код одноразовый)`, `Connect someone: write to the bot /start ${info.code} (single-use code)`)}
              </Text>
            ) : null}
            <Text style={S.h3}>{t("Кто подключён", "Who is connected")}</Text>
            {info.chats.length ? (
              info.chats.map((c) => (
                <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {edit?.chat === c.id ? (
                    <>
                      <TextInput style={[S.input, { flex: 1 }]} value={edit.name} onChangeText={(name) => setEdit({ chat: c.id, name })} autoFocus maxLength={40} />
                      <Btn
                        small
                        kind="primary"
                        title="✓"
                        disabled={!edit.name.trim()}
                        onPress={() => {
                          setEdit(undefined);
                          if (edit.name.trim() !== c.name) run(() => client!.renameSessionBotChat(id, c.id, edit.name));
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <Text style={[S.text, { flex: 1 }]}>{c.name}</Text>
                      <Btn small kind="ghost" title="✎" onPress={() => setEdit({ chat: c.id, name: c.name })} />
                    </>
                  )}
                  <Btn
                    small
                    kind="ghost"
                    title="✕"
                    onPress={() =>
                      dialog(t(`Отключить ${c.name}?`, `Disconnect ${c.name}?`), undefined, [
                        { text: t("Отмена", "Cancel"), style: "cancel" },
                        { text: t("Отключить", "Disconnect"), style: "destructive", onPress: () => run(() => client!.unlinkSessionBotChat(id, c.id)) },
                      ])
                    }
                  />
                </View>
              ))
            ) : (
              <Text style={S.muted}>{t("пока никого", "nobody yet")}</Text>
            )}
            {info.chats.length ? (
              <Text style={S.muted}>
                {t(
                  "Агент видит, кто пишет (по имени, ✎ — поменять). Ответ приходит только тому, кто спросил; написанное в KraBness в Telegram не уходит.",
                  "The agent sees who is writing (by name, ✎ to change). The answer goes only to whoever asked; what you write in KraBness doesn't go to Telegram.",
                )}
              </Text>
            ) : null}
            <Btn title={t("Новый код", "New code")} busy={busy} onPress={() => run(() => client!.sessionBotCode(id))} />
            <Btn
              kind="danger"
              title={t("Отвязать бота", "Unlink the bot")}
              busy={busy}
              onPress={() =>
                dialog(t("Отвязать бота?", "Unlink the bot?"), t("Подключённые люди отвалятся.", "Connected people will be dropped."), [
                  { text: t("Отмена", "Cancel"), style: "cancel" },
                  { text: t("Отвязать", "Unlink"), style: "destructive", onPress: () => run(() => client!.removeSessionBot(id)) },
                ])
              }
            />
          </>
        )}
        {info && msg ? <Text style={S.error}>{msg}</Text> : null}
      </ScrollView>
    </View>
  );
}
