import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { t, type AppRelease, type DeviceInfo, type HubInfo, type TelegramProxy, type TelegramStatus } from "@kamharn/client";
import { client, fmtSize, fmtTime, go, saveQuickPrompts, useHub, useQuickPrompts } from "./hub.ts";
import { WakeSettings } from "./WakeSettings.tsx";
import { RemoteSettings } from "./RemoteSettings.tsx";
import { HubAddresses } from "./HubAddresses.tsx";
import { EngineSettings } from "./EngineSettings.tsx";
import { LangSwitch } from "./LangSwitch.tsx";
import { UpdateSettings } from "./Updates.tsx";
import { UsagePage } from "./Usage.tsx";

export type SettingsSection = "general" | "agents" | "connect" | "notify" | "computer" | "usage" | "updates";

/** разделы настроек — функцией: подписи на текущем языке */
export const SECTIONS = (): { id: SettingsSection; icon: string; title: string; hint: string }[] => [
  { id: "general", icon: "⚙️", title: t("Общие", "General"), hint: t("Язык, быстрые кнопки, разрешённые папки", "Language, quick buttons, allowed folders") },
  { id: "agents", icon: "🤖", title: t("Агенты", "Agents"), hint: t("Движки, модели и провайдеры, MCP, скиллы", "Engines, models and providers, MCP, skills") },
  { id: "connect", icon: "🔗", title: t("Подключение", "Connection"), hint: t("Устройства, адреса хаба, свой сервер", "Devices, hub addresses, your own server") },
  { id: "notify", icon: "🔔", title: t("Уведомления", "Notifications"), hint: t("Telegram-бот", "Telegram bot") },
  { id: "computer", icon: "🖥️", title: t("Компьютер", "Computer"), hint: t("Пробуждение ПК, перезапуск хаба, экран", "Waking the PC, restarting the hub, screen") },
  { id: "usage", icon: "📊", title: t("Расход токенов", "Token usage"), hint: t("За день, неделю, месяц или свой период; по моделям и сессиям", "By day, week, month or your own period; by model and session") },
  { id: "updates", icon: "⬆️", title: t("Обновления", "Updates"), hint: t("KraBness и Android-приложение", "KraBness and the Android app") },
];

/** Без section — список разделов, с section — страница раздела. */
export function Settings({ section }: { section?: SettingsSection }) {
  const { deviceId } = useHub();
  const sec = SECTIONS().find((s) => s.id === section);
  if (!sec) {
    return (
      <div className="page">
        <header className="page__head">
          <button className="btn btn--icon back" onClick={() => go({ page: "home" })}>
            ←
          </button>
          <h2>{t("Настройки", "Settings")}</h2>
        </header>
        <div className="page__body">
          <ul className="settings-list">
            {SECTIONS().map((s) => (
              <li key={s.id}>
                <button className="settings-list__item" onClick={() => go({ page: "settings", section: s.id })}>
                  <span className="settings-list__icon">{s.icon}</span>
                  <span className="settings-list__text">
                    <b>{s.title}</b>
                    <span className="muted">{s.hint}</span>
                  </span>
                  <span className="settings-list__arrow">›</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <header className="page__head">
        {/* к списку разделов — видна и на широком экране (общая «назад» там скрыта) */}
        <button className="btn btn--icon" onClick={() => go({ page: "settings" })} title={t("Настройки", "Settings")}>
          ←
        </button>
        <h2>
          {sec.icon} {sec.title}
        </h2>
      </header>
      <div className="page__body">
        {sec.id === "general" ? (
          <>
            <LangSwitch />
            <QuickPrompts />
            <Roots />
          </>
        ) : sec.id === "agents" ? (
          <>
            <EngineSettings />
            <section>
              <h3>{t("Модели", "Models")}</h3>
              <p className="muted">{t("Подключить OpenAI (в т.ч. подписку ChatGPT), OpenRouter, DeepSeek, Gemini, Kimi, GLM и др. или свой сервер (LM Studio, Ollama).", "Connect OpenAI (including a ChatGPT subscription), OpenRouter, DeepSeek, Gemini, Kimi, GLM and more, or your own server (LM Studio, Ollama).")}</p>
              <button className="btn" onClick={() => go({ page: "providers" })}>
                {t("Модели и провайдеры →", "Models and providers →")}
              </button>
            </section>
            <section>
              <h3>{t("Инструменты агентов", "Agent tools")}</h3>
              <p className="muted">{t("MCP-серверы (браузер, базы, API) — для Claude и opencode. Скиллы — готовые инструкции и скрипты, их тоже видят оба движка.", "MCP servers (a browser, databases, APIs) — for Claude and opencode. Skills — ready-made instructions and scripts, both engines see them too.")}</p>
              <div className="row">
                <button className="btn" onClick={() => go({ page: "mcp" })}>
                  {t("MCP-серверы →", "MCP servers →")}
                </button>
                <button className="btn" onClick={() => go({ page: "skills" })}>
                  {t("Скиллы →", "Skills →")}
                </button>
              </div>
            </section>
          </>
        ) : sec.id === "connect" ? (
          <>
            <Devices local={deviceId === "local"} />
            <HubAddresses />
            <RemoteSettings />
          </>
        ) : sec.id === "notify" ? (
          <Telegram />
        ) : sec.id === "usage" ? (
          <UsagePage />
        ) : sec.id === "computer" ? (
          <>
            <WakeSettings />
            <HubSection />
          </>
        ) : (
          <>
            <UpdateSettings />
            <AppSection />
          </>
        )}
      </div>
    </div>
  );
}

function QuickPrompts() {
  const current = useQuickPrompts();
  const [text, setText] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const value = text ?? current.join("\n");

  async function save() {
    setError(undefined);
    try {
      const saved = await saveQuickPrompts(value.split("\n"));
      setText(saved.join("\n"));
      setMsg(t("Сохранено — кнопки уже на всех устройствах", "Saved — the buttons are already on all devices"));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <h3>{t("Быстрые кнопки", "Quick buttons")}</h3>
      <p className="muted">{t("Над полем ввода в чате. Одна кнопка — одна строка. Пустое поле — кнопка сразу отправляет текст, иначе дописывает его.", "Above the chat input. One button per line. If the input is empty the button sends the text right away, otherwise it appends it.")}</p>
      <textarea className="input" rows={5} value={value} onChange={(e) => (setText(e.target.value), setMsg(undefined))} />
      <div className="row">
        <button className="btn" onClick={() => void save()}>
          {t("Сохранить", "Save")}
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function AppSection() {
  const [release, setRelease] = useState<AppRelease | null>();
  useEffect(() => {
    client.appLatest().then(setRelease, () => setRelease(null));
  }, []);
  if (release === undefined) return null;
  return (
    <section>
      <h3>{t("Android-приложение", "Android app")}</h3>
      {release ? (
        <>
          <p className="muted">
            {t("Версия", "Version")} {release.version} · {fmtSize(release.size)} · {t("собрано", "built")} {fmtTime(release.builtAt)}. {t("Дальше приложение обновляется само.", "After that the app updates itself.")}
          </p>
          <a className="btn" href={client.appApkUrl()} download={release.file}>
            {t("Скачать APK", "Download APK")}
          </a>
        </>
      ) : (
        <p className="muted">{t("Сборка не опубликована: apps/mobile → npm run release.", "No build published: apps/mobile → npm run release.")}</p>
      )}
    </section>
  );
}

function HubSection() {
  const [info, setInfo] = useState<HubInfo>();
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void client.hubInfo().then(setInfo, () => {});
  }, []);

  async function restart() {
    if (!confirm(t("Перезапустить хаб? Работающие сейчас агенты прервутся, история сохранится.", "Restart the hub? Running agents will be interrupted, history is kept."))) return;
    setError(undefined);
    try {
      await client.restartHub();
      setMsg(t("Перезапускается — UI переподключится сам через несколько секунд.", "Restarting — the UI will reconnect by itself in a few seconds."));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <h3>{t("Хаб", "Hub")}</h3>
      {info && (
        <p className="muted">
          {t("Версия", "Version")} {info.version}
          {info.startedAt ? ` · ${t("запущен", "started")} ${fmtTime(info.startedAt)}` : ""} · {info.supervised ? t("под сторожем, перезапускается сам", "supervised, restarts by itself") : t("запущен вручную", "started manually")}
        </p>
      )}
      {info?.supervised ? (
        <button className="btn" onClick={() => void restart()}>
          {t("Перезапустить хаб", "Restart hub")}
        </button>
      ) : (
        <p className="muted">{t("Перезапуск из UI работает, когда хаб запущен через scripts\\hub-service.ps1 (автозапуск: scripts\\autostart.ps1).", "Restarting from the UI works when the hub runs via scripts\\hub-service.ps1 (autostart: scripts\\autostart.ps1).")}</p>
      )}
      {/* с телефона через браузер: что сейчас на экране ПК */}
      <button className="btn" onClick={() => window.open(client.screenUrl(), "_blank")}>
        {t("Экран ПК", "PC screen")}
      </button>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
      {/* AGPL (п. 13): пользователям по сети — ссылка на исходники */}
      <p className="muted">
        KraBness · {t("лицензия", "license")} AGPL-3.0 ·{" "}
        <a href="https://github.com/kamo4er/KraBness" target="_blank" rel="noreferrer">
          {t("исходный код", "source code")}
        </a>
      </p>
    </section>
  );
}

function Roots() {
  const [roots, setRoots] = useState<string[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    void client.roots().then(setRoots);
  }, []);
  const run = async (f: () => Promise<string[]>) => {
    setError(undefined);
    try {
      setRoots(await f());
      setPath("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <h3>{t("Разрешённые папки", "Allowed folders")}</h3>
      <p className="muted">{t("Агенты работают и отдают файлы только внутри этих папок.", "Agents work and share files only inside these folders.")}</p>
      <ul className="list">
        {roots.map((r) => (
          <li key={r} className="list__row">
            <span className="mono">{r}</span>
            <button className="btn btn--small btn--danger" onClick={() => void run(() => client.removeRoot(r))}>
              {t("Убрать", "Remove")}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (path.trim()) void run(() => client.addRoot(path.trim()));
        }}
      >
        <input className="input" placeholder="D:\Work" value={path} onChange={(e) => setPath(e.target.value)} />
        <button className="btn">{t("Добавить", "Add")}</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Devices({ local }: { local: boolean }) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [pair, setPair] = useState<{ code: string; expiresAt: number; qr: string; urls: string[] }>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const load = () => void client.devices().then(setDevices);
  useEffect(load, []);
  useEffect(() => {
    if (!pair) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      load(); // новое устройство появится, как только введут код
    }, 2000);
    return () => clearInterval(timer);
  }, [pair]);

  async function startPair() {
    setError(undefined);
    try {
      const [p, hub] = await Promise.all([client.pairStart(), client.hubInfo()]);
      // для телефона полезны только не-localhost адреса
      const urls = hub.urls.filter((u) => !/127\.0\.0\.1|localhost/.test(u));
      const payload = JSON.stringify({ kamharn: 1, urls, code: p.code });
      const qr = await QRCode.toDataURL(payload, { margin: 1, width: 260 });
      setPair({ ...p, qr, urls });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;

  return (
    <section>
      <h3>{t("Устройства", "Devices")}</h3>
      <ul className="list">
        {devices.map((d) => (
          <li key={d.id} className="list__row">
            <span>
              <b>{d.name}</b> <span className="muted">· {t("был", "seen")} {fmtTime(d.lastSeen)}</span>
              {d.push && <span className="muted"> · {t("пуши", "push")}</span>}
            </span>
            <button className="btn btn--small btn--danger" onClick={() => void client.removeDevice(d.id).then(load)}>
              {t("Отключить", "Disconnect")}
            </button>
          </li>
        ))}
        {!devices.length && <li className="muted">{t("Подключённых устройств нет.", "No connected devices.")}</li>}
      </ul>
      {local ? (
        <button className="btn btn--primary" onClick={() => void startPair()}>
          {t("Подключить устройство", "Connect a device")}
        </button>
      ) : (
        <p className="muted">{t("Подключать новые устройства можно только с самого ПК.", "New devices can only be connected from the PC itself.")}</p>
      )}
      {error && <p className="error">{error}</p>}
      {pair && left > 0 && (
        <div className="card pairbox">
          <img src={pair.qr} alt={t("QR для подключения", "Pairing QR")} width={260} height={260} />
          <div>
            <p>
              {t("Код:", "Code:")} <b className="code">{pair.code}</b> <span className="muted">({t("ещё", "valid")} {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")})</span>
            </p>
            <p className="muted">{t("В приложении KraBness отсканируй QR. Или открой в браузере телефона:", "Scan the QR in the KraBness app. Or open in the phone browser:")}</p>
            {pair.urls.length ? (
              pair.urls.map((u) => (
                <p key={u} className="mono">
                  {u}
                </p>
              ))
            ) : (
              <p className="error">{t("У хаба нет адреса для телефона: Tailscale на ПК не подключён, удалённый доступ через свой сервер не настроен (раздел ниже).", "The hub has no address for the phone: Tailscale on the PC isn't connected and remote access via your own server isn't set up (section below).")}</p>
            )}
            <p className="muted">{t("и введи код.", "and enter the code.")}</p>
          </div>
        </div>
      )}
      {pair && left === 0 && <p className="muted">{t("Код истёк — создай новый.", "The code expired — create a new one.")}</p>}
    </section>
  );
}

/** Телеграм-бот для уведомлений: токен от @BotFather → «/start код» боту → кнопки и ответы агенту из Telegram. */
function Telegram() {
  const [st, setSt] = useState<TelegramStatus>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const load = () => client.telegramStatus().then(setSt, () => {});
  useEffect(() => void load(), []);
  // ждём привязку чата
  useEffect(() => {
    if (!st?.configured || st.bound) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [st?.configured, st?.bound]);
  if (!st) return null;
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
  return (
    <section>
      <h3>{t("Уведомления в Telegram", "Telegram notifications")}</h3>
      {!st.configured ? (
        <>
          <p className="muted">
            {t("Бот присылает те же уведомления, что и пуши: кнопки «Разрешить/Отклонить», а ответ (reply) на уведомление уходит агенту. Firebase не нужен. Создай бота у", "The bot sends the same notifications as push: “Allow/Deny” buttons, and a reply to a notification goes to the agent. No Firebase needed. Create a bot with")}{" "}
            <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              @BotFather
            </a>{" "}
            {t("(/newbot) и вставь токен.", "(/newbot) and paste the token.")}
          </p>
          <div className="row">
            <input className="input" placeholder="123456:ABC…" value={token} onChange={(e) => setToken(e.target.value)} />
            <button
              className="btn btn--primary"
              disabled={busy || !token.trim()}
              onClick={() =>
                void run(async () => {
                  setSt(await client.setTelegramToken(token.trim()));
                  setToken("");
                })
              }
            >
              {t("Подключить", "Connect")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            {t("Бот", "Bot")} @{st.bot ?? "?"} · {st.bound ? t("чат привязан", "chat linked") : t("ждёт привязки", "waiting to be linked")}
          </p>
          {st.error && <p className="error">{st.error}</p>}
          {!st.bound && st.code && (
            <p>
              {t("Напиши боту:", "Send the bot:")} <code>/start {st.code}</code> ·{" "}
              <a href={`https://t.me/${st.bot}?start=${st.code}`} target="_blank" rel="noreferrer">
                {t("открыть бота", "open the bot")}
              </a>
            </p>
          )}
          <div className="row">
            {st.bound && (
              <button className="btn" disabled={busy} onClick={() => void run(async () => (await client.testTelegram(), setMsg(t("Отправил", "Sent"))))}>
                {t("Проверить", "Test")}
              </button>
            )}
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() => confirm(t("Отключить бота? Уведомления в Telegram приходить перестанут.", "Disconnect the bot? Telegram notifications will stop.")) && void run(async () => (await client.removeTelegram(), await load()))}
            >
              {t("Отключить", "Disconnect")}
            </button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <TelegramProxyForm st={st} onSaved={setSt} />
    </section>
  );
}

/** Прокси до Telegram (свой VPS) — там, где Telegram заблокирован. */
function TelegramProxyForm({ st, onSaved }: { st: TelegramStatus; onSaved: (s: TelegramStatus) => void }) {
  const px = st.proxy;
  const [on, setOn] = useState(!!px);
  const [type, setType] = useState<TelegramProxy["type"]>(px?.type ?? "socks5");
  const [host, setHost] = useState(px?.host ?? "");
  const [port, setPort] = useState(px ? String(px.port) : "");
  const [user, setUser] = useState(px?.username ?? "");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  async function save(proxy: TelegramProxy | null) {
    setBusy(true);
    setError(undefined);
    setMsg(undefined);
    try {
      const res = await client.setTelegramProxy(proxy);
      onSaved(res);
      setPass("");
      setMsg(!proxy ? t("Прокси выключен", "Proxy off") : res.configured ? t("Сохранено, Telegram через прокси отвечает", "Saved, Telegram answers through the proxy") : t("Сохранено — проверю, когда подключишь бота", "Saved — I'll check it when you connect the bot"));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="tgproxy">
      <label className="row">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.checked;
            setOn(v);
            // выключили сохранённый прокси — сразу проверяем связь напрямую; не вышло — галка остаётся
            if (!v && px) void save(null).then((ok) => ok || setOn(true));
          }}
        />
        {t("Через прокси (если Telegram заблокирован)", "Via a proxy (if Telegram is blocked)")}
      </label>
      {on && (
        <>
          <p className="muted">{t("Свой VPS с SOCKS5 или HTTP-прокси. Хаб проверит, что Telegram через него отвечает, и только тогда сохранит.", "Your own VPS with a SOCKS5 or HTTP proxy. The hub checks that Telegram answers through it and only then saves.")}</p>
          <div className="row">
            <select className="input" style={{ width: "auto" }} value={type} onChange={(e) => setType(e.target.value as TelegramProxy["type"])}>
              <option value="socks5">SOCKS5</option>
              <option value="http">HTTP</option>
            </select>
            <input className="input" placeholder={t("IP или домен", "IP or domain")} value={host} onChange={(e) => setHost(e.target.value)} />
            <input className="input" style={{ width: 110 }} placeholder={t("Порт", "Port")} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="row">
            <input className="input" placeholder={t("Логин (если есть)", "Login (if any)")} autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={px?.hasPassword && user === px.username ? t("Пароль: не менять", "Password: keep current") : t("Пароль", "Password")}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
            />
          </div>
          <div className="row">
            <button
              className="btn btn--primary"
              disabled={busy || !host.trim() || !port}
              onClick={() => void save({ type, host: host.trim(), port: Number(port), ...(user.trim() ? { username: user.trim(), ...(pass ? { password: pass } : {}) } : {}) })}
            >
              {busy ? t("Проверяю…", "Checking…") : t("Сохранить прокси", "Save proxy")}
            </button>
            {msg && <span className="muted">{msg}</span>}
          </div>
        </>
      )}
      {!on && msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
