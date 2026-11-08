// «Движки»: какие показывать в новой сессии и что выбрано по умолчанию (движок и модель для каждого).
import { useEffect, useState } from "react";
import { t, type EngineId, type ModelRef, type NewSessionPrefs } from "@kamharn/client";
import { client, useEngines } from "./hub.ts";
import { ClaudeAuthBox } from "./ClaudeAuth.tsx";

const NAME: Record<EngineId, string> = { opencode: "opencode", claude: "Claude Code" };
const hint = (e: EngineId) =>
  e === "opencode" ? t("локальные, бесплатные и подключённые модели", "local, free and connected models") : t("нужна подписка Claude и установленный Claude Code", "needs a Claude subscription and Claude Code installed");
const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

export function EngineSettings() {
  const engines = useEngines();
  const [p, setP] = useState<NewSessionPrefs>();
  const [error, setError] = useState<string>();
  useEffect(() => void client.newSessionPrefs().then(setP, (e: Error) => setError(e.message)), []);
  if (!p || !engines) return error ? <p className="error">{error}</p> : null;

  const save = (next: Partial<NewSessionPrefs>) => {
    setError(undefined);
    client.saveNewSessionPrefs({ ...p, ...next }).then(setP, (e: Error) => setError(e.message));
  };

  return (
    <section>
      <h3>{t("Движки", "Engines")}</h3>
      <p className="muted">{t("Какие движки показывать в «Новой сессии» и что там выбрано сразу. Уже открытые сессии продолжают работать.", "Which engines to show in “New session” and what is preselected there. Open sessions keep working.")}</p>
      <div className="engprefs">
        {engines.map((e) => {
          const on = p.engines.includes(e.id);
          const models = e.models.filter((m) => !m.offline);
          const cur = p.models[e.id] ? key(p.models[e.id]!) : "";
          return (
            <div key={e.id} className={`engprefs__row ${on ? "" : "engprefs__row--off"}`}>
              <label className="row">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(ev) => save({ engines: ev.target.checked ? [...p.engines, e.id] : p.engines.filter((x) => x !== e.id) })}
                />
                <b>{NAME[e.id]}</b>
                <span className="muted">{e.available || e.auth ? hint(e.id) : `${t("недоступен", "unavailable")}: ${e.error ?? t("не запущен", "not running")}`}</span>
              </label>
              {e.auth && <ClaudeAuthBox initial={{ ...e.auth, ...(e.error ? { error: e.error } : {}) }} />}
              {on && (
                <div className="row engprefs__opts">
                  <label className="row">
                    <input type="radio" name="defengine" checked={p.engine === e.id} onChange={() => save({ engine: e.id })} />
                    {t("по умолчанию", "default")}
                  </label>
                  <span className="muted">{t("модель:", "model:")}</span>
                  <select
                    className="select"
                    style={{ width: "auto", maxWidth: 360 }}
                    value={cur}
                    onChange={(ev) => {
                      const m = models.find((x) => key(x) === ev.target.value);
                      const models2 = { ...p.models };
                      if (m) models2[e.id] = { providerId: m.providerId, modelId: m.modelId };
                      else delete models2[e.id];
                      save({ models: models2 });
                    }}
                  >
                    <option value="">{t("как в движке", "engine default")}{e.defaultModel ? ` (${e.defaultModel.modelId})` : ""}</option>
                    {models.map((m) => (
                      <option key={key(m)} value={key(m)}>
                        {m.name}
                        {m.free ? " · free" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
