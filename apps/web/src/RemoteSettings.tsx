// «Удалённый доступ через свой сервер»: хаб держит SSH-туннель на VPS, сервер раздаёт его по HTTPS (Caddy).
// Здесь: команда для VPS с ключом хаба, адрес сервера, статус туннеля и проверка снаружи.
import { useEffect, useState } from "react";
import { t, type RemoteStatus } from "@kamharn/client";
import { client } from "./hub.ts";

const sslip = (host: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `https://krab.${host.replace(/\./g, "-")}.sslip.io` : "");

export function stateText(st: RemoteStatus): string {
  if (!st.settings?.enabled) return t("выключен", "off");
  if (st.state === "up") return t("работает ✓", "working ✓");
  if (st.state === "connecting") return t("подключаюсь…", "connecting…");
  return t("нет связи", "no connection");
}

export function RemoteSettings() {
  const [st, setSt] = useState<RemoteStatus>();
  const [edit, setEdit] = useState(false);
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const load = (s: RemoteStatus) => {
    setSt(s);
    setHost(s.settings?.host ?? "");
    setUser(s.settings?.user ?? "");
    setSshPort(s.settings && s.settings.sshPort !== 22 ? String(s.settings.sshPort) : "");
    setUrl(s.settings && s.settings.url !== sslip(s.settings.host) ? s.settings.url : "");
  };
  useEffect(() => {
    void client.remoteStatus().then(load, (e: Error) => setError(e.message));
    // статус туннеля меняется сам (обрыв, переподключение) — подтягиваем, форму не трогаем
    const timer = setInterval(() => void client.remoteStatus().then(setSt, () => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  if (!st) return error ? <p className="error">{error}</p> : null;

  async function run(f: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    setMsg(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** после сохранения: ждём, пока туннель поднимется, и проверяем адрес снаружи */
  async function settle() {
    let s = await client.remoteStatus();
    for (let i = 0; i < 20 && s.state === "connecting"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await client.remoteStatus();
    }
    setSt(s);
    if (s.state !== "up") throw new Error(s.error ?? t("Туннель не поднялся", "The tunnel didn't come up"));
    const r = await client.testRemote();
    setMsg(`${t("Работает: телефон достучится до хаба по", "Works: the phone will reach the hub at")} ${s.settings!.url} (${r.ms} ${t("мс", "ms")}) ✓`);
  }
  const s = st.settings;
  const form = edit || !st.configured;

  return (
    <section>
      <h3>{t("Удалённый доступ через свой сервер", "Remote access via your own server")}</h3>
      <p className="muted">
        {t(
          "Если Tailscale с телефона не работает (VPN на ПК, мобильная сеть), хаб может ходить через твой VPS: ПК сам держит к нему исходящий SSH-туннель, а сервер раздаёт хаб по HTTPS. Вход по-прежнему только для сопряжённых устройств.",
          "If Tailscale doesn't work from the phone (a VPN on the PC, mobile data), the hub can go through your VPS: the PC keeps an outgoing SSH tunnel to it and the server serves the hub over HTTPS. Only paired devices can get in, as before.",
        )}
      </p>
      {s && !edit && (
        <>
          <p>
            {t("Туннель", "Tunnel")}: <b>{stateText(st)}</b> · <code>{s.url}</code> · {t("сервер", "server")} <code>{`${s.user}@${s.host}`}</code>
          </p>
          {st.error && st.state !== "up" && s.enabled && <p className="error">{st.error}</p>}
          <div className="row">
            <button className="btn" disabled={busy || !s.enabled} onClick={() => void run(settle)}>
              {busy ? t("Проверяю…", "Checking…") : t("Проверить", "Check")}
            </button>
            <button className="btn" disabled={busy} onClick={() => void run(async () => (load(await client.saveRemote({ ...s, enabled: !s.enabled })), s.enabled ? undefined : await settle()))}>
              {s.enabled ? t("Выключить", "Turn off") : t("Включить", "Turn on")}
            </button>
            <button className="btn" onClick={() => setEdit(true)}>
              {t("Изменить", "Edit")}
            </button>
            <button className="btn btn--danger" disabled={busy} onClick={() => confirm(t("Убрать удалённый доступ? Телефон будет подключаться только по Tailscale.", "Remove remote access? The phone will connect over Tailscale only.")) && void run(async () => load(await client.removeRemote()))}>
              {t("Убрать", "Remove")}
            </button>
          </div>
        </>
      )}
      {form && (
        <ol className="wake__steps">
          <li>
            {t("Нужен VPS с Ubuntu или Debian, на котором свободны порты 80 и 443. На нём под root выполни:", "You need a VPS with Ubuntu or Debian where ports 80 and 443 are free. Run on it as root:")}
            <pre className="pre wake__cmd">{st.setupCommand || st.error}</pre>
            <button className="btn btn--small" disabled={!st.setupCommand} onClick={() => void navigator.clipboard.writeText(st.setupCommand).then(() => setMsg(t("Скопировано", "Copied")))}>
              {t("Копировать", "Copy")}
            </button>{" "}
            <span className="muted">{t("Скрипт поставит Caddy (сертификат от Let's Encrypt) и пользователя krabtunnel: его ключу разрешён только этот туннель. В конце напишет адрес.", "The script installs Caddy (a Let's Encrypt certificate) and a krabtunnel user whose key may only open this tunnel. It prints the address at the end.")}</span>
          </li>
          <li>
            {t("Сервер:", "Server:")} <input className="input mono wake__url" placeholder={t("IP или домен VPS", "VPS IP or domain")} value={host} onChange={(e) => setHost(e.target.value.trim())} /> {t("пользователь", "user")}{" "}
            <input className="input mono" style={{ width: 130, display: "inline-block" }} placeholder="krabtunnel" value={user} onChange={(e) => setUser(e.target.value.trim())} /> {t("SSH-порт", "SSH port")}{" "}
            <input className="input mono" style={{ width: 70, display: "inline-block" }} placeholder="22" value={sshPort} onChange={(e) => setSshPort(e.target.value.trim())} />
          </li>
          <li>
            {t("Публичный адрес:", "Public address:")} <input className="input mono wake__token" placeholder={sslip(host) || "https://krab.example.com"} value={url} onChange={(e) => setUrl(e.target.value.trim())} />{" "}
            <span className="muted">{t("пусто — адрес на sslip.io по IP сервера", "empty — an sslip.io address from the server IP")}</span>
          </li>
        </ol>
      )}
      {form && (
        <div className="row">
          <button
            className="btn btn--primary"
            disabled={busy || !host || (!url && !sslip(host))}
            onClick={() =>
              void run(async () => {
                load(await client.saveRemote({ host, user, url, enabled: true, ...(sshPort ? { sshPort: Number(sshPort) } : {}), ...(s?.remotePort ? { remotePort: s.remotePort } : {}) }));
                setEdit(false);
                await settle();
              })
            }
          >
            {busy ? t("Подключаюсь…", "Connecting…") : t("Сохранить и подключить", "Save and connect")}
          </button>
          {edit && (
            <button className="btn" disabled={busy} onClick={() => (setEdit(false), load(st))}>
              {t("Отмена", "Cancel")}
            </button>
          )}
        </div>
      )}
      {st.configured && <p className="muted">{t("Новый адрес попадает в QR для подключения устройств, а уже подключённое приложение узнаёт его само, пока есть связь с хабом.", "The new address goes into the device connection QR, and an already paired app learns it by itself while it's connected to the hub.")}</p>}
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
