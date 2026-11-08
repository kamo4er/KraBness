// Настройка пробуждения ПК в приложении: какая сетевая карта, адрес будильника, токен, проверка.
// Подробная инструкция и скачивание wake.py — в веб-UI на ПК (Настройки → Пробуждение ПК).
import { useEffect, useState } from "react";
import { Text, TextInput, ToastAndroid, View } from "react-native";
import { t, type WakeSetup } from "@kamharn/client";
import { client, useHub } from "./store.ts";
import { syncWake } from "./wake.ts";
import { dialog } from "./dialog.tsx";
import { Btn } from "./ui.tsx";
import { C, S, mono } from "./theme.ts";

export function WakeSetupBox() {
  const online = useHub().conn === "online";
  const [st, setSt] = useState<WakeSetup>();
  const [edit, setEdit] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [nic, setNic] = useState("");
  const [busy, setBusy] = useState(false);
  const load = (s: WakeSetup) => {
    setSt(s);
    setUrl(s.url ?? "");
    setToken("");
    setNic(s.mac && s.broadcast ? `${s.mac}|${s.broadcast}` : s.nics[0] ? `${s.nics[0].mac}|${s.nics[0].broadcast}` : "");
  };
  useEffect(() => {
    if (online) void client?.wakeSetup().then(load, () => {});
  }, [online]);
  if (!st) return <Text style={S.muted}>{t("Разбудить спящий ПК можно через «будильник» в домашней сети — настраивается, пока ПК на связи.", "A sleeping PC can be woken through a “relay” in your home network — set it up while the PC is online.")}</Text>;

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
  const test = async () => {
    const r = await client!.testWake();
    ToastAndroid.show(r.pc === "online" ? t("Будильник отвечает и видит ПК ✓", "The relay answers and sees the PC ✓") : t("Будильник отвечает, но ПК не видит", "The relay answers but doesn't see the PC"), ToastAndroid.LONG);
  };

  if (st.configured && !edit)
    return (
      <View style={{ gap: 6 }}>
        <Text style={S.muted}>
          {t("Пробуждение: будильник", "Wake-up: relay")} {st.url} · {t("карта", "card")} {st.mac}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Btn small title={t("Проверить", "Check")} busy={busy} onPress={() => void run(test)} />
          <Btn small title={t("Изменить", "Edit")} onPress={() => setEdit(true)} />
          <Btn
            small
            kind="danger"
            title={t("Убрать", "Remove")}
            onPress={() =>
              dialog(t("Убрать пробуждение?", "Remove wake-up?"), t("Кнопка «Разбудить ПК» пропадёт.", "The “Wake PC” button will disappear."), [
                { text: t("Отмена", "Cancel"), style: "cancel" },
                { text: t("Убрать", "Remove"), style: "destructive", onPress: () => void run(async () => (load(await client!.removeWake()), await syncWake())) },
              ])
            }
          />
        </View>
      </View>
    );

  const [mac, broadcast] = nic.split("|");
  const input = { placeholderTextColor: C.muted, autoCapitalize: "none" as const, autoCorrect: false };
  return (
    <View style={{ gap: 8 }}>
      <Text style={S.muted}>
        {t(
          "Спящий ПК недоступен по сети — будит его «будильник»: скрипт wake.py на устройстве, которое всегда включено и стоит в той же домашней сети (NAS, Raspberry Pi). Скачать его и пошаговая инструкция — в веб-UI на ПК: Настройки → Пробуждение ПК. Wake-on-LAN должен быть включён в BIOS и у сетевой карты.",
          "A sleeping PC can't be reached over the network — a “relay” wakes it: the wake.py script on an always-on device in the same home network (NAS, Raspberry Pi). Download it and step-by-step instructions — in the web UI on the PC: Settings → Wake the PC. Wake-on-LAN must be enabled in BIOS and on the network card.",
        )}
      </Text>
      <Text style={S.text}>{t("Сетевая карта ПК", "PC network card")}</Text>
      {st.nics.length ? (
        st.nics.map((n) => (
          <Btn
            key={n.mac + n.broadcast}
            small
            kind={nic === `${n.mac}|${n.broadcast}` ? "primary" : "default"}
            title={`${n.name} · ${n.mac}`}
            onPress={() => setNic(`${n.mac}|${n.broadcast}`)}
          />
        ))
      ) : (
        <Text style={S.error}>{t("Не нашёл карту с адресом в домашней сети.", "No card with a home-network address found.")}</Text>
      )}
      <Text style={S.text}>{t("Токен (тот же — в файл token рядом с wake.py)", "Token (the same one goes into the token file next to wake.py)")}</Text>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <TextInput style={[S.input, { flex: 1, fontFamily: mono, fontSize: 12 }]} placeholder={st.hasToken ? t("не менять", "keep current") : t("16+ символов", "16+ characters")} value={token} onChangeText={(t) => setToken(t.trim())} {...input} />
        <Btn small title={t("Новый", "New")} onPress={() => void run(async () => setToken((await client!.newWakeToken()).token))} />
      </View>
      <TextInput style={[S.input, { fontFamily: mono }]} placeholder={t("Адрес будильника: http://100.x.y.z:7421", "Relay address: http://100.x.y.z:7421")} keyboardType="url" value={url} onChangeText={(t) => setUrl(t.trim())} {...input} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn
          kind="primary"
          title={t("Сохранить и проверить", "Save and check")}
          busy={busy}
          disabled={!url || !mac || (!token && !st.hasToken)}
          style={{ flex: 1 }}
          onPress={() =>
            void run(async () => {
              load(await client!.saveWake({ url, ...(token ? { token } : {}), mac: mac!, broadcast: broadcast! }));
              setEdit(false);
              await syncWake();
              await test().catch((e: Error) => dialog(t("Сохранено, но проверка не прошла", "Saved, but the check failed"), e.message));
            })
          }
        />
        {edit ? <Btn title={t("Отмена", "Cancel")} disabled={busy} onPress={() => (setEdit(false), load(st))} /> : null}
      </View>
    </View>
  );
}
