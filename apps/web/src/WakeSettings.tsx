// «Пробуждение ПК»: будильник (scripts/nas-wake/wake.py) на постоянно включённом устройстве в домашней сети
// шлёт Wake-on-LAN по команде приложения. Здесь: какая сетевая карта, адрес будильника, токен, проверка.
import { useEffect, useState } from "react";
import { t, type WakeSetup } from "@kamharn/client";
import { client } from "./hub.ts";

export function WakeSettings() {
  const [st, setSt] = useState<WakeSetup>();
  const [edit, setEdit] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [nic, setNic] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [error, setError] = useState<string>();
  const load = (s: WakeSetup) => {
    setSt(s);
    setUrl(s.url ?? "");
    setToken("");
    const cur = s.mac && s.broadcast ? `${s.mac}|${s.broadcast}` : "";
    setNic(cur || (s.nics[0] ? `${s.nics[0].mac}|${s.nics[0].broadcast}` : ""));
  };
  useEffect(() => void client.wakeSetup().then(load, (e: Error) => setError(e.message)), []);
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
  const [mac, broadcast] = nic.split("|");
  // текущая карта могла пропасть из списка (например, Wi-Fi сейчас выключен) — оставляем её в выборе
  const nics = st.mac && !st.nics.some((n) => n.mac === st.mac) ? [{ name: t("сохранённая", "saved"), mac: st.mac, address: "", broadcast: st.broadcast ?? "" }, ...st.nics] : st.nics;
  const form = edit || !st.configured;

  return (
    <section>
      <h3>{t("Пробуждение ПК", "Wake the PC")}</h3>
      {st.configured && !edit ? (
        <>
          <p>
            {t("Настроено: будильник", "Set up: relay")} <code>{st.url}</code> · {t("сетевая карта", "network card")} <code>{st.mac}</code>
          </p>
          <p className="muted">{t("Кнопка «Разбудить ПК» — в приложении на телефоне (на экране «нет связи» и в настройках).", "The “Wake PC” button is in the phone app (on the “offline” screen and in settings).")}</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void run(async () => setMsg((await client.testWake()).pc === "online" ? t("Будильник отвечает и видит ПК ✓", "The relay answers and sees the PC ✓") : t("Будильник отвечает, но ПК не видит — проверь адрес хаба", "The relay answers but doesn't see the PC — check the hub address")))}>
              {busy ? t("Проверяю…", "Checking…") : t("Проверить", "Check")}
            </button>
            <button className="btn" onClick={() => setEdit(true)}>
              {t("Изменить", "Edit")}
            </button>
            <button className="btn btn--danger" disabled={busy} onClick={() => confirm(t("Убрать пробуждение? Кнопка «Разбудить ПК» в приложении пропадёт.", "Remove wake-up? The “Wake PC” button will disappear from the app.")) && void run(async () => load(await client.removeWake()))}>
              {t("Убрать", "Remove")}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">
          {t(
            "Спящий ПК недоступен по сети, поэтому будит его «будильник» — маленький скрипт на устройстве, которое всегда включено и стоит в той же домашней сети (NAS, Raspberry Pi, роутер с Python 3). Телефон зовёт его через Tailscale, а он шлёт ПК сигнал Wake-on-LAN.",
            "A sleeping PC can't be reached over the network, so a “relay” wakes it — a tiny script on an always-on device in the same home network (NAS, Raspberry Pi, a router with Python 3). The phone calls it over Tailscale and it sends the PC a Wake-on-LAN signal.",
          )}
        </p>
      )}
      {form && (
        <ol className="wake__steps">
          <li>
            {t("Включи Wake-on-LAN: в BIOS (Wake on LAN / Power On By PCI-E) и в Windows — Диспетчер устройств → сетевая карта → «Дополнительно»:", "Enable Wake-on-LAN: in BIOS (Wake on LAN / Power On By PCI-E) and in Windows — Device Manager → network card → “Advanced”:")}{" "}
            <i>Wake on Magic Packet</i> = {t("Вкл", "Enabled")},{" "}
            {t("«Управление электропитанием»: разрешить выводить компьютер из ждущего режима.", "“Power Management”: allow this device to wake the computer.")}
          </li>
          <li>
            {t("Сетевая карта ПК:", "PC network card:")}{" "}
            {nics.length ? (
              <select className="select" style={{ width: "auto" }} value={nic} onChange={(e) => setNic(e.target.value)}>
                {nics.map((n) => (
                  <option key={n.mac + n.broadcast} value={`${n.mac}|${n.broadcast}`}>
                    {n.name} · {n.mac}
                    {n.address ? ` · ${n.address}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="error">{t("не нашёл карту с адресом в домашней сети — ПК подключён кабелем или по Wi-Fi?", "no card with a home-network address found — is the PC connected by cable or Wi-Fi?")}</span>
            )}{" "}
            <span className="muted">{t("(лучше кабель: по Wi-Fi Wake-on-LAN работает редко)", "(cable is better: Wake-on-LAN rarely works over Wi-Fi)")}</span>
          </li>
          <li>
            {t("Токен:", "Token:")}{" "}
            <input className="input mono wake__token" placeholder={st.hasToken ? t("не менять", "keep current") : t("16+ символов", "16+ characters")} value={token} onChange={(e) => setToken(e.target.value.trim())} />{" "}
            <button className="btn btn--small" disabled={busy} onClick={() => void run(async () => setToken((await client.newWakeToken()).token))}>
              {t("Сгенерировать", "Generate")}
            </button>
          </li>
          <li>
            {t("На устройстве с Tailscale:", "On the device with Tailscale:")} <a href={client.wakeScriptUrl()}>{t("скачай wake.py", "download wake.py")}</a>, {t("положи рядом файл", "put a file")} <code>token</code> {t("с токеном и запусти:", "with the token next to it and run:")}
            <pre className="pre wake__cmd">
              {`echo ${token || t("<токен>", "<token>")} > token\npython3 wake.py --bind ${t("<IP этого устройства в Tailscale>", "<this device's Tailscale IP>")}`}
            </pre>
            <span className="muted">{t("Нужен Python 3.8+, больше ничего. Автозапуск — в README, раздел «Пробуждение ПК».", "Needs Python 3.8+, nothing else. Autostart — see README, “Waking the PC”.")}</span>
          </li>
          <li>
            {t("Адрес будильника:", "Relay address:")}{" "}
            <input className="input mono wake__url" placeholder="http://100.x.y.z:7421" value={url} onChange={(e) => setUrl(e.target.value.trim())} />
          </li>
        </ol>
      )}
      {form && (
        <div className="row">
          <button
            className="btn btn--primary"
            disabled={busy || !url || !mac || (!token && !st.hasToken)}
            onClick={() =>
              void run(async () => {
                load(await client.saveWake({ url, ...(token ? { token } : {}), mac: mac!, broadcast: broadcast! }));
                setEdit(false);
                const note = await client.testWake().then(
                  (r) => (r.pc === "online" ? t("Сохранено, будильник отвечает ✓", "Saved, the relay answers ✓") : t("Сохранено. Будильник отвечает, но ПК не видит", "Saved. The relay answers but doesn't see the PC")),
                  (e: Error) => `${t("Сохранено, но проверка не прошла", "Saved, but the check failed")}: ${e.message}`,
                );
                setMsg(note);
              })
            }
          >
            {busy ? t("Сохраняю…", "Saving…") : t("Сохранить и проверить", "Save and check")}
          </button>
          {edit && (
            <button className="btn" disabled={busy} onClick={() => (setEdit(false), load(st))}>
              {t("Отмена", "Cancel")}
            </button>
          )}
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
