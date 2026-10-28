// Настройки: список разделов, по нажатию — страница раздела.
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, ToastAndroid, View } from "react-native";
import type { HubInfo, TelegramProxy, TelegramStatus } from "@kamharn/client";
import { client, saveQuickPrompts, unpair, useConn, useHub, useQuickPrompts } from "../store.ts";
import { UsagePage } from "../Usage.tsx";
import { back, go } from "../nav.ts";
import { APP_VERSION, APP_VERSION_CODE } from "../update.ts";
import { Btn, connLabel, ConnDot } from "../ui.tsx";
import { C, S } from "../theme.ts";
import { WakePanel } from "../WakePanel.tsx";
import { WakeSetupBox } from "../WakeSetupBox.tsx";
import { RemoteBox } from "../RemoteBox.tsx";
import { EngineSettings } from "../EngineSettings.tsx";
import { LangSwitch } from "../LangSwitch.tsx";
import { t, locale } from "@kamharn/client";
import { openScreen } from "../files.ts";
import { setKeepAlive, useKeepAliveSetting } from "../keepalive.ts";
import { dialog } from "../dialog.tsx";
import { firebaseBuilt, setNotifyMode, useNotifyMode } from "../notify.ts";
import { HubUpdateBox } from "../HubUpdate.tsx";

export type SettingsSection = "general" | "agents" | "connect" | "notify" | "computer" | "usage" | "updates";

/** разделы настроек — функцией: подписи на текущем языке */
const SECTIONS = (): { id: SettingsSection; icon: string; title: string; hint: string }[] => [
  { id: "general", icon: "⚙️", title: t("Общие", "General"), hint: t("Язык, быстрые кнопки", "Language, quick buttons") },
  { id: "agents", icon: "🤖", title: t("Агенты", "Agents"), hint: t("Движки, модели и провайдеры, MCP, скиллы", "Engines, models and providers, MCP, skills") },
  { id: "connect", icon: "🔗", title: t("Подключение", "Connection"), hint: t("Связь с хабом, свой сервер, отключение", "Hub connection, your own server, disconnecting") },
  { id: "notify", icon: "🔔", title: t("Уведомления", "Notifications"), hint: t("Способ уведомлений, связь в фоне, Telegram", "How to notify, staying connected, Telegram") },
  { id: "computer", icon: "🖥️", title: t("Компьютер", "Computer"), hint: t("Разбудить, усыпить, экран, перезапуск хаба", "Wake, sleep, screen, restarting the hub") },
  { id: "usage", icon: "📊", title: t("Расход токенов", "Token usage"), hint: t("День, неделя, месяц или свой период", "Day, week, month or your own period") },
  { id: "updates", icon: "⬆️", title: t("Обновления", "Updates"), hint: t("KraBness и это приложение", "KraBness and this app") },
];

/** Без section — список разделов, с section — страница раздела («назад» возвращает к списку: он ниже в стеке). */
export function Settings({ section }: { section?: SettingsSection }) {
  const conn = useConn();
  const state = useHub();
  const [info, setInfo] = useState<HubInfo>();
  useEffect(() => {
    if (state.conn === "online") void client?.hubInfo().then(setInfo, () => {});
  }, [state.conn]);
  const sec = SECTIONS().find((x) => x.id === section);

  if (!sec)
    return (
      <View style={S.screen}>
        <View style={S.head}>
          <Btn small kind="ghost" title="←" onPress={back} />
          <Text style={S.h1}>{t("Настройки", "Settings")}</Text>
        </View>
        <ScrollView contentContainerStyle={[st.body, { gap: 8 }]}>
          {SECTIONS().map((x) => (
            <Pressable key={x.id} style={({ pressed }) => [st.item, pressed && { opacity: 0.7 }]} onPress={() => go({ page: "settings", section: x.id })}>
              <Text style={st.itemIcon}>{x.icon}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <View style={st.row}>
                  <Text style={[S.text, { fontWeight: "700" }]}>{x.title}</Text>
                  {x.id === "connect" ? <ConnDot conn={state.conn} /> : null}
                </View>
                <Text style={S.muted}>{x.hint}</Text>
              </View>
              <Text style={st.itemArrow}>›</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );

  return (
    <View style={S.screen}>
      <View style={S.head}>
        <Btn small kind="ghost" title="←" onPress={back} />
        <Text style={S.h1}>
          {sec.icon} {sec.title}
        </Text>
      </View>
      <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
        {sec.id === "general" ? (
          <>
            <Text style={S.h3}>{t("Язык / Language", "Language / Язык")}</Text>
            <View style={st.box}>
              <LangSwitch />
            </View>
            <QuickPromptsEditor />
          </>
        ) : sec.id === "agents" ? (
          <>
            <Text style={S.h3}>{t("Движки", "Engines")}</Text>
            <View style={st.box}>
              <EngineSettings />
            </View>

            <Text style={S.h3}>{t("Модели", "Models")}</Text>
            <View style={st.box}>
              <Text style={S.muted}>{t("OpenAI (и подписка ChatGPT), OpenRouter, DeepSeek, Gemini, Kimi, GLM и др. или свой сервер (LM Studio, Ollama).", "OpenAI (and a ChatGPT subscription), OpenRouter, DeepSeek, Gemini, Kimi, GLM and more, or your own server (LM Studio, Ollama).")}</Text>
              <Btn title={t("Модели и провайдеры →", "Models and providers →")} onPress={() => go({ page: "providers" })} />
            </View>

            <Text style={S.h3}>{t("Инструменты агентов", "Agent tools")}</Text>
            <View style={st.box}>
              <Text style={S.muted}>{t("MCP-серверы (браузер, базы, API) и скиллы — готовые инструкции и скрипты. Работают и в Claude, и в opencode.", "MCP servers (a browser, databases, APIs) and skills — ready-made instructions and scripts. They work in both Claude and opencode.")}</Text>
              <View style={st.row}>
                <Btn title={t("MCP-серверы →", "MCP servers →")} style={{ flex: 1 }} onPress={() => go({ page: "mcp" })} />
                <Btn title={t("Скиллы →", "Skills →")} style={{ flex: 1 }} onPress={() => go({ page: "skills" })} />
              </View>
            </View>
          </>
        ) : sec.id === "connect" ? (
          <>
            <Text style={S.h3}>{t("Хаб", "Hub")}</Text>
            <View style={st.box}>
              <View style={st.row}>
                <ConnDot conn={state.conn} />
                <Text style={S.text}>{connLabel(state.conn)}</Text>
              </View>
              <Text style={S.muted}>{t("Сейчас", "Now")}: {client?.baseUrl}</Text>
              <Text style={S.muted}>{t("Известные адреса", "Known addresses")}: {conn?.urls.join(", ")}</Text>
              <RemoteBox />
              <Btn small title={t("Переподключиться", "Reconnect")} onPress={() => client?.reconnectNow()} style={{ alignSelf: "flex-start" }} />
            </View>

            <Text style={S.h3}>{t("Это устройство", "This device")}</Text>
            <View style={st.box}>
              <Text style={S.muted}>ID: {conn?.deviceId}</Text>
              <Text style={S.muted}>{t("Отключить можно и с ПК: веб-UI → Настройки → Подключение → Устройства.", "You can also disconnect from the PC: web UI → Settings → Connection → Devices.")}</Text>
              <Btn
                kind="danger"
                title={t("Отключиться от хаба", "Disconnect from the hub")}
                onPress={() =>
                  dialog(t("Отключиться?", "Disconnect?"), t("Токен удалится с телефона. Для нового подключения понадобится QR с ПК.", "The token will be removed from the phone. You'll need the QR from the PC to connect again."), [
                    { text: t("Отмена", "Cancel"), style: "cancel" },
                    { text: t("Отключиться", "Disconnect"), style: "destructive", onPress: unpair },
                  ])
                }
              />
            </View>
          </>
        ) : sec.id === "notify" ? (
          <>
            <View style={st.box}>
              <NotifyModeRow />
            </View>
            <View style={[st.box, { marginTop: 12 }]}>
              <KeepAliveRow />
            </View>
            <TelegramBox />
          </>
        ) : sec.id === "usage" ? (
          <UsagePage />
        ) : sec.id === "computer" ? (
          <>
            <View style={st.box}>
              <WakePanel />
              {state.conn === "online" ? (
                <Btn title={t("Экран ПК", "PC screen")} onPress={() => openScreen().catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message))} />
              ) : null}
              {info?.canSleep ? (
                <Btn
                  title={t("Усыпить ПК", "Put PC to sleep")}
                  onPress={() =>
                    dialog(t("Усыпить ПК?", "Put the PC to sleep?"), t("Через 20 секунд ПК уснёт. Работающие агенты остановятся, пока он спит. Разбудить можно отсюда же.", "The PC goes to sleep in 20 seconds. Running agents pause while it sleeps. You can wake it from here."), [
                      { text: t("Отмена", "Cancel"), style: "cancel" },
                      {
                        text: t("Усыпить", "Sleep"),
                        onPress: () =>
                          client?.sleepPc(20).then(
                            () => ToastAndroid.show(t("ПК уснёт через 20 с", "The PC sleeps in 20 s"), ToastAndroid.LONG),
                            (e: Error) => dialog(t("Не получилось", "Failed"), e.message),
                          ),
                      },
                    ])
                  }
                />
              ) : null}
              <WakeSetupBox />
            </View>

            <Text style={S.h3}>{t("Хаб", "Hub")}</Text>
            <View style={st.box}>
              {info ? (
                <Text style={S.muted}>
                  {t("Версия", "Version")} {info.version}
                  {info.startedAt ? ` · ${t("запущен", "started")} ${new Date(info.startedAt).toLocaleString(locale())}` : ""}
                </Text>
              ) : null}
              {info?.supervised ? (
                <Btn
                  title={t("Перезапустить хаб", "Restart hub")}
                  onPress={() =>
                    dialog(t("Перезапустить хаб?", "Restart the hub?"), t("Работающие сейчас агенты прервутся, история сохранится.", "Running agents will be interrupted, history is kept."), [
                      { text: t("Отмена", "Cancel"), style: "cancel" },
                      {
                        text: t("Перезапустить", "Restart"),
                        onPress: () =>
                          client?.restartHub().then(
                            () => ToastAndroid.show(t("Хаб перезапускается, переподключусь сам", "The hub is restarting, I'll reconnect by myself"), ToastAndroid.LONG),
                            (e: Error) => dialog(t("Не получилось", "Failed"), e.message),
                          ),
                      },
                    ])
                  }
                />
              ) : null}
              {info && !info.supervised ? <Text style={S.muted}>{t("Хаб запущен вручную — перезапуск из приложения недоступен.", "The hub was started manually — it can't be restarted from the app.")}</Text> : null}
            </View>
          </>
        ) : (
          <>
            <HubUpdateBox />
            <Text style={S.h3}>{t("Приложение", "App")}</Text>
            <View style={st.box}>
              <Text style={S.muted}>
                {t("Приложение", "App")} {APP_VERSION} ({t("сборка", "build")} {APP_VERSION_CODE})
              </Text>
              {/* AGPL (п. 13): пользователям по сети — ссылка на исходники */}
              <Text style={S.muted} onPress={() => void Linking.openURL("https://github.com/kamo4er/KraBness")}>
                KraBness · {t("лицензия", "license")} AGPL-3.0 · <Text style={{ color: C.accent }}>{t("исходный код", "source code")}</Text>
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  body: { padding: 16 },
  box: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  item: { flexDirection: "row", alignItems: "center", gap: 14, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg2 },
  itemIcon: { fontSize: 22, width: 28, textAlign: "center" },
  itemArrow: { fontSize: 24, color: C.muted },
});

/** «Держать связь в фоне»: сервис с постоянным уведомлением, Android не замораживает приложение. */
function KeepAliveRow() {
  const on = useKeepAliveSetting();
  return (
    <>
      <View style={[st.row, { justifyContent: "space-between" }]}>
        <Text style={[S.text, { flex: 1 }]}>{t("Держать связь в фоне", "Stay connected in background")}</Text>
        <Switch value={on} onValueChange={setKeepAlive} />
      </View>
      <Text style={S.muted}>
        {t(
          "Свёрнутое приложение остаётся на связи с ПК: чат обновляется, возвращение мгновенное. В шторке висит тихое уведомление «KraBness на связи», батарея тратится чуть больше.",
          "A minimized app stays connected to the PC: the chat keeps updating, coming back is instant. A silent “KraBness is connected” notification stays in the shade, battery use is a bit higher.",
        )}{" "}
        {firebaseBuilt
          ? t("Пуши Firebase приходят и без этого, а уведомлениям «из приложения» он нужен.", "Firebase push works without it, but in-app notifications need it.")
          : t("Без этого свёрнутое приложение не получит уведомлений.", "Without it a minimized app won't get notifications.")}
      </Text>
    </>
  );
}

function QuickPromptsEditor() {
  const current = useQuickPrompts();
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const value = text ?? current.join("\n");
  return (
    <>
      <Text style={S.h3}>{t("Быстрые кнопки", "Quick buttons")}</Text>
      <View style={st.box}>
        <Text style={S.muted}>{t("Над полем ввода в чате, одна кнопка — одна строка. Пустое поле — кнопка сразу отправляет текст.", "Above the chat input, one button per line. If the input is empty the button sends the text right away.")}</Text>
        <TextInput style={[S.input, { minHeight: 110, textAlignVertical: "top" }]} multiline value={value} onChangeText={setText} />
        <Btn
          small
          title={t("Сохранить", "Save")}
          busy={busy}
          style={{ alignSelf: "flex-start" }}
          onPress={async () => {
            setBusy(true);
            try {
              setText((await saveQuickPrompts(value.split("\n"))).join("\n"));
              ToastAndroid.show(t("Сохранено", "Saved"), ToastAndroid.SHORT);
            } catch (e) {
              dialog(t("Не получилось", "Failed"), (e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </View>
    </>
  );
}

/** Откуда приходят уведомления: Firebase или само приложение (по WebSocket от хаба). */
function NotifyModeRow() {
  const mode = useNotifyMode();
  const keep = useKeepAliveSetting();
  const pick = (m: "fcm" | "app") => void setNotifyMode(m).catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message));
  if (!firebaseBuilt)
    return (
      <>
        <Text style={S.muted}>
          {t(
            "Хаб присылает уведомления по связи, приложение показывает их само. Работает, пока приложение на связи с ПК. Чтобы уведомления приходили, даже когда Android выгрузил приложение, подключи Telegram ниже.",
            "The hub sends notifications over the connection and the app shows them itself. Works while the app is connected to the PC. To get notifications even when Android has closed the app, connect Telegram below.",
          )}
        </Text>
        {!keep ? <Text style={[S.muted, { color: C.warn }]}>{t("Включи «Держать связь в фоне» ниже — иначе свёрнутое приложение уведомлений не получит.", "Turn on “Stay connected in background” below — otherwise a minimized app won't get notifications.")}</Text> : null}
      </>
    );
  return (
    <>
      <View style={st.row}>
        <Btn small kind={mode === "fcm" ? "primary" : "default"} title="Firebase" style={{ flex: 1 }} onPress={() => pick("fcm")} />
        <Btn small kind={mode === "app" ? "primary" : "default"} title={t("Из приложения", "In-app")} style={{ flex: 1 }} onPress={() => pick("app")} />
      </View>
      <Text style={S.muted}>
        {mode === "fcm"
          ? t("Пуши через Firebase: приходят, даже если приложение выгружено. Нужен свой проект Firebase у хаба.", "Push via Firebase: arrives even when the app is closed. The hub needs its own Firebase project.")
          : t("Хаб присылает уведомления по связи, приложение показывает их само — Firebase не нужен. Работает, пока приложение на связи с ПК.", "The hub sends notifications over the connection and the app shows them itself — no Firebase needed. Works while the app is connected to the PC.")}
      </Text>
      {mode === "app" && !keep ? <Text style={[S.muted, { color: C.warn }]}>{t("Включи «Держать связь в фоне» ниже — иначе свёрнутое приложение уведомлений не получит.", "Turn on “Stay connected in background” below — otherwise a minimized app won't get notifications.")}</Text> : null}
    </>
  );
}

/** Телеграм-бот: токен от @BotFather → код → «/start код» боту. Кнопки «Разрешить/Отклонить», реплай — сообщение агенту. */
function TelegramBox() {
  const [st0, setSt] = useState<TelegramStatus>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => client?.telegramStatus().then(setSt, () => {});
  useEffect(() => void load(), []);
  // ждём привязку чата — проверяем раз в 3 с
  useEffect(() => {
    if (!st0?.configured || st0.bound) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [st0?.configured, st0?.bound]);
  if (!st0) return null;
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Text style={S.h3}>Telegram</Text>
      <View style={st.box}>
        {!st0.configured ? (
          <>
            <Text style={S.muted}>
              {t("Уведомления в Telegram-бота: кнопки «Разрешить/Отклонить», а ответ (reply) на уведомление уходит агенту. Создай бота у @BotFather (/newbot) и вставь его токен.", "Notifications to a Telegram bot: “Allow/Deny” buttons, and a reply to a notification goes to the agent. Create a bot with @BotFather (/newbot) and paste its token.")}
            </Text>
            <Btn small title={t("Открыть @BotFather", "Open @BotFather")} style={{ alignSelf: "flex-start" }} onPress={() => void Linking.openURL("https://t.me/BotFather")} />
            <TextInput style={S.input} placeholder="123456:ABC…" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} value={token} onChangeText={setToken} />
            <Btn
              title={t("Подключить", "Connect")}
              kind="primary"
              busy={busy}
              disabled={!token.trim()}
              onPress={() =>
                run(async () => {
                  setSt(await client!.setTelegramToken(token.trim()));
                  setToken("");
                })
              }
            />
          </>
        ) : (
          <>
            <Text style={S.text}>{t("Бот", "Bot")} @{st0.bot ?? "?"} · {st0.bound ? t("чат привязан", "chat linked") : t("ждёт привязки", "waiting to be linked")}</Text>
            {st0.error ? <Text style={[S.muted, { color: C.err }]}>{st0.error}</Text> : null}
            {!st0.bound && st0.code ? (
              <>
                <Text style={S.muted}>{t("Напиши боту в Telegram:", "Send the bot in Telegram:")}</Text>
                <Text selectable style={[S.text, { fontSize: 20, fontWeight: "700" }]}>/start {st0.code}</Text>
                <Btn small title={t("Открыть бота", "Open the bot")} style={{ alignSelf: "flex-start" }} onPress={() => void Linking.openURL(`https://t.me/${st0.bot}?start=${st0.code}`)} />
              </>
            ) : null}
            <View style={st.row}>
              {st0.bound ? <Btn small title={t("Проверить", "Test")} busy={busy} onPress={() => run(async () => (await client!.testTelegram(), ToastAndroid.show(t("Отправил", "Sent"), ToastAndroid.SHORT)))} /> : null}
              <Btn
                small
                kind="danger"
                title={t("Отключить", "Disconnect")}
                onPress={() =>
                  dialog(t("Отключить бота?", "Disconnect the bot?"), t("Уведомления в Telegram приходить перестанут. Сам бот в Telegram останется.", "Telegram notifications will stop. The bot itself stays in Telegram."), [
                    { text: t("Отмена", "Cancel"), style: "cancel" },
                    { text: t("Отключить", "Disconnect"), style: "destructive", onPress: () => void run(async () => (await client!.removeTelegram(), await load())) },
                  ])
                }
              />
            </View>
          </>
        )}
        <TelegramProxyForm status={st0} onSaved={setSt} />
      </View>
    </>
  );
}

/** Прокси до Telegram (свой VPS) — там, где Telegram заблокирован. */
function TelegramProxyForm({ status, onSaved }: { status: TelegramStatus; onSaved: (s: TelegramStatus) => void }) {
  const px = status.proxy;
  const [on, setOn] = useState(!!px);
  const [type, setType] = useState<TelegramProxy["type"]>(px?.type ?? "socks5");
  const [host, setHost] = useState(px?.host ?? "");
  const [port, setPort] = useState(px ? String(px.port) : "");
  const [user, setUser] = useState(px?.username ?? "");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (proxy: TelegramProxy | null): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await client!.setTelegramProxy(proxy);
      onSaved(res);
      setPass("");
      ToastAndroid.show(!proxy ? t("Прокси выключен", "Proxy off") : res.configured ? t("Сохранено, Telegram через прокси отвечает", "Saved, Telegram answers through the proxy") : t("Сохранено — проверю, когда подключишь бота", "Saved — I'll check it when you connect the bot"), ToastAndroid.LONG);
      return true;
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={st2.proxy}>
      <View style={[st.row, { justifyContent: "space-between" }]}>
        <Text style={[S.text, { flex: 1 }]}>{t("Через прокси", "Via a proxy")}</Text>
        <Switch
          value={on}
          disabled={busy}
          onValueChange={(v) => {
            setOn(v);
            // выключили сохранённый прокси — сразу проверяем связь напрямую; не вышло — остаётся включённым
            if (!v && px) void save(null).then((ok) => ok || setOn(true));
          }}
        />
      </View>
      <Text style={S.muted}>{t("Если Telegram заблокирован: свой VPS с SOCKS5 или HTTP-прокси. Хаб сохранит, только если Telegram через него отвечает.", "If Telegram is blocked: your own VPS with a SOCKS5 or HTTP proxy. The hub saves it only if Telegram answers through it.")}</Text>
      {on ? (
        <>
          <View style={st.row}>
            <Btn small kind={type === "socks5" ? "primary" : "default"} title="SOCKS5" style={{ flex: 1 }} onPress={() => setType("socks5")} />
            <Btn small kind={type === "http" ? "primary" : "default"} title="HTTP" style={{ flex: 1 }} onPress={() => setType("http")} />
          </View>
          <View style={st.row}>
            <TextInput style={[S.input, { flex: 1 }]} placeholder={t("IP или домен", "IP or domain")} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" value={host} onChangeText={setHost} />
            <TextInput style={[S.input, { width: 90 }]} placeholder={t("Порт", "Port")} placeholderTextColor={C.muted} keyboardType="number-pad" value={port} onChangeText={(t) => setPort(t.replace(/[^0-9]/g, ""))} />
          </View>
          <TextInput style={S.input} placeholder={t("Логин (если есть)", "Login (if any)")} placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} value={user} onChangeText={setUser} />
          <TextInput
            style={S.input}
            placeholder={px?.hasPassword && user === px.username ? t("Пароль: не менять", "Password: keep current") : t("Пароль", "Password")}
            placeholderTextColor={C.muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={pass}
            onChangeText={setPass}
          />
          <Btn
            kind="primary"
            title={busy ? t("Проверяю…", "Checking…") : t("Сохранить прокси", "Save proxy")}
            busy={busy}
            disabled={!host.trim() || !port}
            onPress={() => void save({ type, host: host.trim(), port: Number(port), ...(user.trim() ? { username: user.trim(), ...(pass ? { password: pass } : {}) } : {}) })}
          />
        </>
      ) : null}
    </View>
  );
}

const st2 = StyleSheet.create({
  proxy: { borderTopWidth: 1, borderTopColor: C.line, marginTop: 4, paddingTop: 10, gap: 8 },
});
