// «Удалённый доступ через свой сервер»: хаб держит SSH-туннель на VPS, сервер раздаёт его по HTTPS (Caddy).
// Здесь: команда для VPS с ключом хаба, адрес сервера, статус туннеля и проверка снаружи.
import { useEffect, useRef, useState } from "react";
import { t, type ProvisionStatus, type RemoteStatus } from "@kamharn/client";
import { client } from "./hub.ts";

const sslip = (host: string) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `https://krab.${host.replace(/\./g, "-")}.sslip.io` : "");

export function stateText(st: RemoteStatus): string {
  if (!st.settings?.enabled) return t("выключен", "off");
  if (st.state === "up") return t("работает ✓", "working ✓");
  if (st.state === "connecting") return t("подключаюсь…", "connecting…");
  return t("нет связи", "no connection");
}

const okText = (x: { url: string; ms?: number }) => `${t("Работает: телефон достучится до хаба по", "Works: the phone will reach the hub at")} ${x.url} (${x.ms} ${t("мс", "ms")}) ✓`;
const failText = (x: { note?: string }) => `${t("Сервер настроен, но снаружи хаб пока не отвечает", "The server is set up, but the hub doesn't answer from outside yet")}: ${x.note ?? ""}. ${t("Проверь, что порты 80 и 443 открыты и в панели хостинга, и нажми «Проверить» через минуту.", "Make sure ports 80 and 443 are open in the hosting panel too, and press Check in a minute.")}`;
const urlText = (s: { url: string }) => s.url;

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
  const [autoRun, setAutoRun] = useState(false);
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
    setMsg(okText({ ...s.settings!, ...r }));
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
            {t("Туннель", "Tunnel")}: <b>{stateText(st)}</b> · <code>{urlText(s)}</code> · {t("сервер", "server")} <code>{`${s.user}@${s.host}`}</code>
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
      {/* пока идёт настройка, форму держим: хаб посреди неё уже сохраняет адрес, и раздел решил бы, что всё настроено */}
      {(form || autoRun) && (
        <AutoSetup
          onStart={() => setAutoRun(true)}
          onDone={(s, j) => {
            setAutoRun(false);
            if (!j.done) return;
            load(s);
            setEdit(false);
            // форма закрывается — итог остаётся в строке статуса раздела
            if (j.done.reachable) setMsg(`${okText(j.done)} · ${t("ключ сервера", "server key")} ${j.done.hostKey}`);
            else {
              setMsg(`${t("Ключ сервера", "Server key")}: ${j.done.hostKey}`);
              setError(failText(j.done));
            }
          }}
        />
      )}
      {edit && (
        <button className="btn btn--small" onClick={() => (setEdit(false), load(st))}>
          {t("Отмена", "Cancel")}
        </button>
      )}
      {form && (
        <details className="remote__manual">
          <summary>{t("Или вручную: команда для сервера и адрес", "Or by hand: a command for the server and the address")}</summary>
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
        </details>
      )}
      {st.configured && <p className="muted">{t("Новый адрес попадает в QR для подключения устройств, а уже подключённое приложение узнаёт его само, пока есть связь с хабом.", "The new address goes into the device connection QR, and an already paired app learns it by itself while it's connected to the hub.")}</p>}
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** Пусть хаб настроит сервер сам: адрес, логин и пароль (или ключ) — дальше SSH, скрипт, туннель и проверка. */
function AutoSetup({ onStart, onDone }: { onStart: () => void; onDone: (s: RemoteStatus, job: ProvisionStatus) => void }) {
  const [host, setHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [useKey, setUseKey] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [job, setJob] = useState<ProvisionStatus>();
  const [error, setError] = useState<string>();
  const logEnd = useRef<HTMLPreElement>(null);

  // идёт настройка — журнал раз в секунду; закончилась — подтянуть новый статус туннеля
  useEffect(() => {
    if (!job?.running) return;
    const timer = setInterval(() => {
      void client.provisionStatus().then((j) => {
        setJob(j);
        // закончилась: настроено — родитель закрывает форму и показывает итог; ошибка — форма остаётся с журналом
        if (!j.running) void client.remoteStatus().then((s) => onDone(s, j), () => {});
      }, () => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.running]);
  useEffect(() => void (logEnd.current && (logEnd.current.scrollTop = logEnd.current.scrollHeight)), [job?.log.length]);

  const start = async () => {
    setError(undefined);
    try {
      setJob(
        await client.provisionServer({
          host,
          user,
          ...(sshPort ? { sshPort: Number(sshPort) } : {}),
          ...(useKey ? { privateKey } : { password }),
        }),
      );
      // пароль дальше не нужен — не держим его в форме
      setPassword("");
      onStart();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const running = !!job?.running;
  return (
    <div className="remote__auto">
      <p>
        <b>{t("Проще всего — пусть хаб настроит сервер сам.", "The easiest way: let the hub set the server up.")}</b>{" "}
        <span className="muted">
          {t(
            "Нужен VPS с Ubuntu или Debian и свободными портами 80 и 443. Хаб один раз зайдёт по SSH, поставит Caddy и пользователя для туннеля, подключится и проверит связь. Пароль нигде не сохраняется.",
            "You need a VPS with Ubuntu or Debian and free ports 80 and 443. The hub logs in over SSH once, installs Caddy and a tunnel user, connects and checks the link. The password isn't stored anywhere.",
          )}
        </span>
      </p>
      <div className="remote__fields">
        <label>
          {t("Сервер", "Server")}
          <input className="input mono" placeholder={t("IP или домен", "IP or domain")} value={host} disabled={running} onChange={(e) => setHost(e.target.value.trim())} />
        </label>
        <label>
          {t("SSH-порт", "SSH port")}
          <input className="input mono" placeholder="22" value={sshPort} disabled={running} onChange={(e) => setSshPort(e.target.value.trim())} />
        </label>
        <label>
          {t("Логин", "Login")}
          <input className="input mono" value={user} disabled={running} onChange={(e) => setUser(e.target.value.trim())} />
        </label>
        {!useKey && (
          <label>
            {t("Пароль", "Password")}
            <input className="input mono" type="password" autoComplete="off" value={password} disabled={running} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
      </div>
      <label className="row">
        <input type="checkbox" checked={useKey} disabled={running} onChange={() => setUseKey(!useKey)} />
        {t("Вход по ключу, а не паролю", "Log in with a key, not a password")}
      </label>
      {useKey && <textarea className="input mono" rows={4} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={privateKey} disabled={running} onChange={(e) => setPrivateKey(e.target.value)} />}
      <div className="row">
        <button className="btn btn--primary" disabled={running || !host || !user || (useKey ? !privateKey.trim() : !password)} onClick={() => void start()}>
          {running ? t("Настраиваю…", "Setting up…") : t("Настроить сервер", "Set up the server")}
        </button>
        {running && <span className="muted">{t("на свежем сервере — пара минут", "a couple of minutes on a fresh server")}</span>}
      </div>
      {job && job.log.length > 0 && (
        <pre className="pre remote__log" ref={logEnd}>
          {job.log.join("\n")}
        </pre>
      )}
      {job?.done && (
        <p className={job.done.reachable ? "" : "error"}>
          {job.done.reachable ? okText(job.done) : failText(job.done)}
        </p>
      )}
      {job?.done && <p className="muted">{t("Ключ сервера", "Server key")}: <code>{job.done.hostKey}</code></p>}
      {(error || job?.error) && <p className="error">{error ?? job?.error}</p>}
    </div>
  );
}
