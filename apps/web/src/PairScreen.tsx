// Вход с другого устройства (через Tailscale): одноразовый код с ПК → device-токен.
import { useState } from "react";
import { client, saveToken } from "./hub.ts";
import { t } from "@kamharn/client";

export function PairScreen() {
  const [code, setCode] = useState("");
  const [name, setName] = useState(() => (/Android/i.test(navigator.userAgent) ? t("Android (браузер)", "Android (browser)") : t("Браузер", "Browser")));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.pairComplete(code.trim(), name.trim());
      saveToken(r.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pair">
      <form className="card pair__card" onSubmit={submit}>
        <h1>KraBness</h1>
        <p className="muted">
          {t(
            "Это устройство ещё не подключено. На ПК открой KraBness → ⚙ Настройки → «Подключить устройство» и введи код.",
            "This device isn't connected yet. On the PC open KraBness → ⚙ Settings → “Connect a device” and enter the code.",
          )}
        </p>
        <label>
          {t("Код", "Code")}
          <input className="input input--code" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </label>
        <label>
          {t("Название устройства", "Device name")}
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary" disabled={code.length !== 6 || busy}>
          {t("Подключить", "Connect")}
        </button>
      </form>
    </div>
  );
}
