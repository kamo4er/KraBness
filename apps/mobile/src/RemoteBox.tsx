// Удалённый доступ через свой сервер (VPS): статус туннеля, проверка, вкл/выкл.
// Нет сервера — можно настроить отсюда: адрес, логин и пароль, дальше хаб сам (по ключу и вручную — в веб-UI на ПК).
import { useEffect, useState } from "react";
import { Switch, Text, TextInput, ToastAndroid, View } from "react-native";
import { t, type ProvisionStatus, type RemoteStatus } from "@kamharn/client";
import { client, useHub } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { Btn } from "./ui.tsx";
import { C, S, mono } from "./theme.ts";

const stateText = (st: RemoteStatus) =>
  !st.settings?.enabled ? t("выключен", "off") : st.state === "up" ? t("работает ✓", "working ✓") : st.state === "connecting" ? t("подключаюсь…", "connecting…") : t("нет связи", "no connection");

const urlText = (s: { url: string }) => s.url;
const okText = (x: { url: string; ms?: number }) => `${t("Хаб отвечает через сервер", "The hub answers through the server")}: ${x.url} (${x.ms} ${t("мс", "ms")}) ✓`;
const failText = (x: { note?: string }) => `${t("Сервер настроен, но снаружи хаб пока не отвечает", "The server is set up, but the hub doesn't answer from outside yet")}: ${x.note ?? ""}`;

export function RemoteBox() {
  const online = useHub().conn === "online";
  const [st, setSt] = useState<RemoteStatus>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (online) void client?.remoteStatus().then(setSt, () => {});
  }, [online]);
  if (!st) return null;
  const s = st.settings;
  if (!s) return <AutoSetup onDone={setSt} />;

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
        {t("Свой сервер", "Own server")}: {stateText(st)} · {urlText(s)}
      </Text>
      {st.error && st.state !== "up" && s.enabled ? <Text style={S.muted}>{st.error}</Text> : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Btn
          small
          title={t("Проверить", "Check")}
          busy={busy}
          onPress={() =>
            void run(async () => {
              const now = await client!.remoteStatus();
              setSt(now);
              const r = await client!.testRemote();
              ToastAndroid.show(okText({ ...(now.settings ?? s), ...r }), ToastAndroid.LONG);
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

/** Свой сервер ещё не настроен: хаб сделает всё сам по адресу, логину и паролю (пароль не сохраняется). */
function AutoSetup({ onDone }: { onDone: (s: RemoteStatus) => void }) {
  const [host, setHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [job, setJob] = useState<ProvisionStatus>();
  useEffect(() => {
    if (!job?.running) return;
    const timer = setInterval(() => {
      void client?.provisionStatus().then((j) => {
        setJob(j);
        if (!j.running && j.done) {
          // блок сменится статусом туннеля — итог показываем всплывашкой
          ToastAndroid.show(j.done.reachable ? okText(j.done) : failText(j.done), ToastAndroid.LONG);
          void client?.remoteStatus().then(onDone, () => {});
        }
      }, () => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.running]);
  const start = async () => {
    try {
      setJob(
        await client!.provisionServer({
          host,
          user,
          password,
          ...(sshPort ? { sshPort: Number(sshPort) } : {}),
        }),
      );
      setPassword("");
    } catch (e) {
      dialog(t("Не получилось", "Failed"), (e as Error).message);
    }
  };
  const running = !!job?.running;
  const input = (value: string, set: (v: string) => void, placeholder: string, extra: object = {}) => (
    <TextInput style={[S.input, { flex: 1 }]} value={value} onChangeText={set} placeholder={placeholder} placeholderTextColor={C.muted} editable={!running} autoCapitalize="none" autoCorrect={false} {...extra} />
  );
  return (
    <View style={{ gap: 8 }}>
      <Text style={S.muted}>
        {t(
          "Связь без Tailscale — через свой сервер (VPS с Ubuntu или Debian, свободные порты 80 и 443). Хаб один раз зайдёт по SSH, всё поставит и проверит. Пароль не сохраняется.",
          "Connecting without Tailscale — through your own server (a VPS with Ubuntu or Debian, free ports 80 and 443). The hub logs in over SSH once, installs everything and checks it. The password isn't stored.",
        )}
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {input(host, (v) => setHost(v.trim()), t("IP или домен сервера", "Server IP or domain"))}
        <View style={{ width: 80 }}>{input(sshPort, (v) => setSshPort(v.trim()), "22", { keyboardType: "number-pad" })}</View>
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {input(user, (v) => setUser(v.trim()), t("логин", "login"))}
        {input(password, setPassword, t("пароль", "password"), { secureTextEntry: true })}
      </View>
      <Btn kind="primary" title={running ? t("Настраиваю… (пара минут)", "Setting up… (a couple of minutes)") : t("Настроить сервер", "Set up the server")} busy={running} disabled={!host || !user || !password} onPress={() => void start()} />
      {job?.log.length ? <Text style={[S.pre, { fontFamily: mono }]}>{job.log.slice(-12).join("\n")}</Text> : null}
      {job?.error ? <Text style={S.error}>{job.error}</Text> : null}
    </View>
  );
}
