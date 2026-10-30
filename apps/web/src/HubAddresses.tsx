// «Адреса хаба»: все адреса, по которым телефон ищет хаб (они же в QR), с проверкой каждого,
// и свои адреса за обратным прокси (NAS, роутер с белым IP) — publicUrls в конфиге.
import { useEffect, useState } from "react";
import { t } from "@kamharn/client";
import { client } from "./hub.ts";

type Check = { ok: true; ms: number } | { ok: false; error: string } | "busy";

function kind(u: string, own: string[]): string {
  const h = new URL(u).hostname;
  if (own.includes(u)) return t("свой прокси", "own proxy");
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return "Tailscale";
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return t("домашняя сеть", "home network");
  return t("свой сервер (VPS)", "own server (VPS)");
}

export function HubAddresses() {
  const [urls, setUrls] = useState<string[]>([]);
  const [own, setOwn] = useState<string[]>([]);
  const [text, setText] = useState<string>();
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<string>();
  // общий адрес превью за тем же прокси (своё имя на порт хаба)
  const [preview, setPreview] = useState<string>();
  const [previewSaved, setPreviewSaved] = useState("");
  const [previewMsg, setPreviewMsg] = useState<{ ok: boolean; text: string }>();
  const savePreview = async () => {
    setPreviewMsg(undefined);
    try {
      const r = await client.setPreviewUrl(preview ?? "");
      setPreviewSaved(r.previewUrl);
      setPreview(undefined);
      setPreviewMsg({ ok: true, text: r.previewUrl ? t("Сохранено. Превью с телефона пойдёт через этот адрес сразу, без перезапуска.", "Saved. Previews from the phone go through this address right away, no restart.") : t("Общий адрес превью убран.", "The shared preview address is removed.") });
    } catch (e) {
      setPreviewMsg({ ok: false, text: (e as Error).message });
    }
  };
  const load = (r: { urls: string[]; publicUrls: string[]; previewUrl?: string }) => {
    if (r.previewUrl !== undefined) setPreviewSaved(r.previewUrl);
    setUrls(r.urls.filter((u) => !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(u + "/")));
    setOwn(r.publicUrls);
  };
  useEffect(() => void client.addresses().then(load, (e: Error) => setError(e.message)), []);

  const check = async (u: string) => {
    setChecks((c) => ({ ...c, [u]: "busy" }));
    const r: Check = await client.checkAddress(u).catch((e: Error) => ({ ok: false as const, error: e.message }));
    setChecks((c) => ({ ...c, [u]: r }));
  };
  const save = async () => {
    setError(undefined);
    setMsg(undefined);
    try {
      load(await client.setPublicUrls((text ?? "").split(/\s+/).filter(Boolean)));
      setText(undefined);
      setMsg(t("Сохранено. Новый адрес — в QR, подключённое приложение узнает его само.", "Saved. The new address is in the QR, a paired app learns it by itself."));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h3>{t("Адреса хаба", "Hub addresses")}</h3>
      <p className="muted">{t("По ним телефон находит хаб, они же в QR. Приложение пробует все и берёт тот, что отвечает. Проверка идёт с этого ПК.", "The phone finds the hub by these, they are in the QR too. The app tries them all and uses the one that answers. The check runs from this PC.")}</p>
      <ul className="list">
        {urls.map((u) => {
          const c = checks[u];
          return (
            <li key={u} className="list__row">
              <span>
                <span className="mono">{u}</span> <span className="muted">· {kind(u, own)}</span>{" "}
                {c && c !== "busy" ? c.ok ? <span>✓ {c.ms} {t("мс", "ms")}</span> : <span className="error">{c.error}</span> : null}
              </span>
              <button className="btn btn--small" disabled={c === "busy"} onClick={() => void check(u)}>
                {c === "busy" ? t("Проверяю…", "Checking…") : t("Проверить", "Check")}
              </button>
            </li>
          );
        })}
        {!urls.length && <li className="muted">{t("Для телефона адресов нет: подключи Tailscale или настрой доступ снаружи.", "No addresses for the phone: connect Tailscale or set up outside access.")}</li>}
      </ul>
      <p>
        {t("Свои адреса за прокси (NAS, роутер с белым IP), по одному в строке:", "Own addresses behind a proxy (a NAS, a router with a public IP), one per line:")}
      </p>
      <textarea className="input mono" rows={2} placeholder="https://krab.example.com" value={text ?? own.join("\n")} onChange={(e) => setText(e.target.value)} />
      <p className="muted">
        {t("Прокси ведёт на домашний адрес ПК и порт хаба. Этот адрес добавь в listen в config/kamharn.json, а порт открой только для прокси:", "The proxy points to the PC's home address and the hub port. Add that address to listen in config/kamharn.json, and open the port for the proxy only:")}{" "}
        <code>scripts\firewall-lan.ps1 -Proxy &lt;{t("IP прокси", "proxy IP")}&gt;</code>
      </p>
      <div className="row">
        <button className="btn btn--primary" disabled={text === undefined} onClick={() => void save()}>
          {t("Сохранить", "Save")}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error">{error}</p>}
      <h3>{t("Адрес для превью", "Preview address")}</h3>
      <p className="muted">
        {t(
          "Превью dev-сервера с телефона идёт через Tailscale. Чтобы оно открывалось и через твой прокси, заведи на нём ещё одно имя (например, preview.<твой домен>) на тот же адрес и порт хаба и впиши его сюда.",
          "A dev server preview from the phone goes through Tailscale. To open it through your proxy too, add one more name on it (e.g. preview.<your domain>) pointing to the same hub address and port, and put it here.",
        )}
      </p>
      <div className="row">
        <input className="input mono" style={{ flex: 1 }} placeholder="https://preview.krab.example.com" value={preview ?? previewSaved} onChange={(e) => setPreview(e.target.value)} />
        <button className="btn btn--primary" disabled={preview === undefined} onClick={() => void savePreview()}>
          {t("Сохранить", "Save")}
        </button>
      </div>
      {previewMsg && <p className={previewMsg.ok ? "muted" : "error"}>{previewMsg.text}</p>}
    </section>
  );
}
