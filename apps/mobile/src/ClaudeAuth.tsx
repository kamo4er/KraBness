// Вход в Claude Code на ПК (в «Движках»): статус, окно входа открывается на ПК, свой API-ключ Anthropic.
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { t, type ClaudeAuthInfo } from "@kamharn/client";
import { client } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { Btn } from "./ui.tsx";
import { C, S } from "./theme.ts";

type Auth = ClaudeAuthInfo & { error?: string };

function authText(a: Auth): string {
  if (!a.installed) return a.error ?? t("Claude Code не установлен на ПК", "Claude Code isn't installed on the PC");
  if (!a.loggedIn) return t("Вход не выполнен", "Not signed in");
  const who = a.email ? ` (${a.email})` : "";
  if (a.method === "apiKey") return t("Работает по API-ключу из KraBness, оплата по расходу", "Runs on the API key saved in KraBness, pay as you go");
  if (a.method === "subscription") return t(`Вход выполнен: подписка ${a.subscription ?? "Claude"}${who}`, `Signed in: ${a.subscription ?? "Claude"} subscription${who}`);
  return t(`Вход выполнен${who}`, `Signed in${who}`);
}

export function ClaudeAuthBox({ initial }: { initial: Auth }) {
  const [a, setA] = useState<Auth>(initial);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(initial.apiKey);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);

  // после «Войти» статус обновляется сам, пока человек входит в браузере на ПК (до 5 минут)
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + 5 * 60_000;
    const timer = setInterval(() => {
      void client?.claudeAuth().then((s) => {
        setA(s);
        if (s.loggedIn || Date.now() > until) setWaiting(false);
      }, () => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [waiting]);

  const run = async (f: () => Promise<Auth | void>) => {
    setBusy(true);
    try {
      const r = await f();
      if (r) setA(r);
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={[S.text, { color: a.loggedIn ? C.text : C.warn }]}>{authText(a)}</Text>
      {a.installed ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {a.method !== "apiKey" ? (
            <Btn
              small
              kind={a.loggedIn ? "default" : "primary"}
              busy={busy}
              title={a.loggedIn ? t("Войти другим аккаунтом", "Another account") : t("Войти на ПК", "Sign in on the PC")}
              onPress={() => void run(async () => (await client?.claudeLogin(), setWaiting(true)))}
            />
          ) : null}
          <Btn small title={t("Проверить", "Check")} busy={busy} onPress={() => void run(async () => client?.claudeAuth())} />
          {!showKey ? <Btn small title={t("API-ключ…", "API key…")} onPress={() => setShowKey(true)} /> : null}
        </View>
      ) : null}
      {waiting ? (
        <Text style={S.muted}>
          {t(
            "На ПК открылось окно входа: выбери подписку Claude или Anthropic Console и подтверди в браузере на ПК. Статус обновится сам.",
            "A sign-in window opened on the PC: choose your Claude subscription or Anthropic Console and confirm in the browser on the PC. The status updates by itself.",
          )}
        </Text>
      ) : null}
      {a.installed && showKey ? (
        <View style={{ gap: 6 }}>
          <Text style={S.muted}>
            {t(
              "Свой API-ключ Anthropic, без подписки: оплата по расходу. Пока ключ сохранён, Claude Code работает по нему. Ключ хранится только на ПК.",
              "Your own Anthropic API key, no subscription: pay as you go. While the key is saved, Claude Code uses it. The key stays on the PC.",
            )}
          </Text>
          {a.apiKey ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[S.text, { flex: 1 }]}>{t("Ключ сохранён", "Key saved")}</Text>
              <Btn small title={t("Убрать", "Remove")} busy={busy} onPress={() => void run(async () => client?.removeClaudeKey())} />
            </View>
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput style={[S.input, { flex: 1 }]} value={key} onChangeText={setKey} placeholder="sk-ant-…" placeholderTextColor={C.muted} secureTextEntry autoCapitalize="none" autoCorrect={false} />
              <Btn small kind="primary" title={t("Сохранить", "Save")} busy={busy} disabled={!key.trim()} onPress={() => void run(async () => { const r = await client?.setClaudeKey(key); setKey(""); return r; })} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}
