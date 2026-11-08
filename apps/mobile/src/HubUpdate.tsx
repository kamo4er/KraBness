// Обновление хаба (ПК) с GitHub: плашка в списке сессий и блок в настройках. Ставит сам хаб, телефон только нажимает кнопку.
// Обновление самого приложения — отдельно (update.ts): новый APK хаб раздаёт после своего обновления.
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { getLang, locale, t, type UpdateStatus } from "@kamharn/client";
import { client, recall, remember, useHub } from "./store.ts";
import { go } from "./nav.ts";
import { Btn } from "./ui.tsx";
import { C, S } from "./theme.ts";
import { dialog } from "./dialog.tsx";

const notesOf = (u: UpdateStatus) => (u.latest ? (getLang() === "ru" ? u.latest.notes.ru : u.latest.notes.en) : "");

const stateText = (u: UpdateStatus) =>
  u.state === "downloading"
    ? t("ПК скачивает обновление…", "The PC is downloading the update…")
    : u.state === "restarting"
      ? t("Устанавливаю. Хаб вернётся через пару минут, приложение переподключится само.", "Installing. The hub will be back in a couple of minutes, the app reconnects by itself.")
      : undefined;

const reasonText = (u: UpdateStatus) =>
  u.reason === "git"
    ? t("Хаб запущен из папки git: обновлять через git pull на ПК.", "The hub runs from a git folder: update with git pull on the PC.")
    : t("Хаб запущен вручную: обновление ставится, когда он работает под сторожем.", "The hub was started manually: updates install when it runs under the supervisor.");

function install() {
  dialog(t("Обновить хаб на ПК?", "Update the hub on the PC?"), t("Хаб скачает новую версию и перезапустится. Работающие агенты прервутся, история сохранится.", "The hub downloads the new version and restarts. Running agents will be interrupted, history is kept."), [
    { text: t("Отмена", "Cancel"), style: "cancel" },
    { text: t("Обновить", "Update"), onPress: () => void client?.installUpdate().catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message)) },
  ]);
}

/** Плашка в списке сессий; «×» прячет до следующей версии. */
export function HubUpdateBanner() {
  const { update } = useHub();
  const [dismissed, setDismissed] = useState(() => recall<string>("hubupdate.dismissed"));
  if (!update?.available || !update.latest) return null;
  const busy = stateText(update);
  if (!busy && dismissed === update.latest.version) return null;
  const v = update.latest.version;
  return (
    <Pressable style={st.banner} onPress={() => go({ page: "settings", section: "updates" })}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={S.text}>{t(`Вышел KraBness ${v} для ПК`, `KraBness ${v} for the PC is out`)}</Text>
        <Text style={S.muted} numberOfLines={busy ? 3 : 2}>
          {busy ?? notesOf(update).replace(/^- /gm, "• ")}
        </Text>
      </View>
      {busy ? null : (
        <>
          {update.canInstall ? <Btn small kind="primary" title={t("Обновить", "Update")} onPress={install} /> : null}
          <Btn small title="×" onPress={() => (remember("hubupdate.dismissed", v), setDismissed(v))} />
        </>
      )}
    </Pressable>
  );
}

/** Блок «Обновления» в настройках. */
export function HubUpdateBox() {
  const { update } = useHub();
  const [checking, setChecking] = useState(false);
  if (!update) return null;
  const busy = stateText(update);
  const when = (ts: number) => new Date(ts).toLocaleString(locale());
  const check = () => {
    setChecking(true);
    client
      ?.checkUpdate()
      .catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message))
      .finally(() => setChecking(false));
  };
  return (
    <View style={st.box}>
      <Text style={S.muted}>
        {t("Версия на ПК", "Version on the PC")} {update.current}
        {update.checkedAt ? ` · ${t("проверено", "checked")} ${when(update.checkedAt)}` : ""}
      </Text>
      {update.error ? <Text style={S.error}>{update.error}</Text> : null}
      {update.last && Date.now() - update.last.at < 7 * 86_400_000 ? (
        <Text style={update.last.ok ? S.muted : S.error}>
          {update.last.ok
            ? t(`Установлена ${update.last.version} (${when(update.last.at)}).`, `Installed ${update.last.version} (${when(update.last.at)}).`)
            : t(`Не встала ${update.last.version}: ${update.last.error ?? ""}. Вернул ${update.last.rolledBack ?? "прежнюю"}.`, `${update.last.version} didn't install: ${update.last.error ?? ""}. Restored ${update.last.rolledBack ?? "the previous one"}.`)}
        </Text>
      ) : null}
      {update.available && update.latest ? (
        <>
          <Text style={S.text}>{t(`Вышла версия ${update.latest.version}`, `Version ${update.latest.version} is out`)}</Text>
          {notesOf(update) ? <Text style={S.muted}>{notesOf(update).replace(/^- /gm, "• ")}</Text> : null}
          {busy ? <Text style={S.muted}>{busy}</Text> : update.canInstall ? <Btn kind="primary" title={t("Обновить хаб", "Update the hub")} onPress={install} /> : <Text style={S.muted}>{reasonText(update)}</Text>}
          <Btn small title={t("Открыть выпуск на GitHub", "Open the release on GitHub")} onPress={() => void Linking.openURL(update.latest!.url)} />
        </>
      ) : !update.error && update.checkedAt ? (
        <Text style={S.muted}>{t("Стоит последняя версия.", "You have the latest version.")}</Text>
      ) : null}
      <View style={st.row}>
        <Btn small title={checking || update.state === "checking" ? t("Проверяю…", "Checking…") : t("Проверить сейчас", "Check now")} busy={checking} onPress={check} />
        <Text style={[S.muted, { flex: 1, textAlign: "right" }]}>{t("Раз в сутки", "Daily")}</Text>
        <Switch value={update.auto} onValueChange={(v) => void client?.setUpdateAuto(v).catch((e: Error) => dialog(t("Не получилось", "Failed"), e.message))} />
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: 8, margin: 10, marginBottom: 0, padding: 12, borderRadius: 12, backgroundColor: "#16233a", borderWidth: 1, borderColor: C.accent },
  box: { backgroundColor: C.bg2, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
});
