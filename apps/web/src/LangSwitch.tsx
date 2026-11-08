// «Язык / Language»: одна настройка на хабе — меняется сразу везде (веб, приложение, уведомления, бот).
import { useState } from "react";
import { getLangSetting, t, type LangSetting } from "@kamharn/client";
import { client } from "./hub.ts";

const OPTIONS: Array<[LangSetting, string]> = [
  ["auto", "Auto"],
  ["ru", "Русский"],
  ["en", "English"],
];

export function LangSwitch() {
  const [error, setError] = useState<string>();
  const cur = getLangSetting();
  return (
    <section>
      <h3>{t("Язык / Language", "Language / Язык")}</h3>
      <div className="row">
        {OPTIONS.map(([v, label]) => (
          <button
            key={v}
            className={`btn ${cur === v ? "btn--primary" : ""}`}
            onClick={() => client.setLanguage(v).catch((e: Error) => setError(e.message))}
          >
            {v === "auto" ? t("Как в системе", "System") : label}
          </button>
        ))}
      </div>
      <p className="muted">
        {cur === "auto"
          ? t(`Сейчас: русский (язык этого устройства). Уведомления и бот — на языке ПК.`, `Now: English (this device's language). Notifications and the bot use the PC language.`)
          : t("Для всех устройств, уведомлений и бота.", "For all devices, notifications and the bot.")}
      </p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
