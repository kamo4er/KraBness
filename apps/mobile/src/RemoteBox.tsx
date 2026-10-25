// Удалённый доступ через свой сервер (VPS): статус туннеля, проверка, вкл/выкл.
// Настраивается в веб-UI на ПК (Настройки → Удалённый доступ): там команда для VPS с ключом хаба.
import { useEffect, useState } from "react";
import { Text, ToastAndroid, View } from "react-native";
import { t, type RemoteStatus } from "@kamharn/client";
import { client, useHub } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { Btn } from "./ui.tsx";
import { S } from "./theme.ts";

const stateText = (st: RemoteStatus) =>
  !st.settings?.enabled ? t("выключен", "off") : st.state === "up" ? t("работает ✓", "working ✓") : st.state === "connecting" ? t("подключаюсь…", "connecting…") : t("нет связи", "no connection");

export function RemoteBox() {
  const online = useHub().conn === "online";
  const [st, setSt] = useState<RemoteStatus>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (online) void client?.remoteStatus().then(setSt, () => {});
  }, [online]);
  if (!st) return null;
  const s = st.settings;
  if (!s)
    return <Text style={S.muted}>{t("Связь без Tailscale через свой сервер (VPS) настраивается в веб-интерфейсе на ПК: Настройки → Удалённый доступ.", "Connecting without Tailscale through your own server (VPS) is set up in the web UI on the PC: Settings → Remote access.")}</Text>;

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
  const toggle = () => run(async () => setSt(await client!.saveRemote({ ...s, enabled: !s.enabled })));
  return (
    <View style={{ gap: 6 }}>
      <Text style={S.muted}>
        {t("Свой сервер", "Own server")}: {stateText(st)} · {s.url}
      </Text>
      {st.error && st.state !== "up" && s.enabled ? <Text style={S.muted}>{st.error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn
          small
          title={t("Проверить", "Check")}
          busy={busy}
          onPress={() =>
            void run(async () => {
              setSt(await client!.remoteStatus());
              const r = await client!.testRemote();
              ToastAndroid.show(`${t("Хаб отвечает через сервер", "The hub answers through the server")}: ${r.ms} ${t("мс", "ms")} ✓`, ToastAndroid.LONG);
            })
          }
        />
        <Btn
          small
          title={s.enabled ? t("Выключить", "Turn off") : t("Включить", "Turn on")}
          onPress={() =>
            // выключить туннель, по которому сейчас и идёт связь, — потерять её
            s.enabled && client?.baseUrl === s.url
              ? dialog(t("Выключить свой сервер?", "Turn off the own server?"), t("Телефон сейчас подключён через него: связь пропадёт, пока не вернётся Tailscale.", "The phone is connected through it right now: the connection drops until Tailscale is back."), [
                  { text: t("Отмена", "Cancel"), style: "cancel" },
                  { text: t("Выключить", "Turn off"), style: "destructive", onPress: () => void toggle() },
                ])
              : void toggle()
          }
        />
      </View>
    </View>
  );
}
