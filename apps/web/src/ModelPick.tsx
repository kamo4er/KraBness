// Выбор модели opencode перед ревью и «→ opencode»: окно поверх всего, как confirm(), но с выбором.
// Последний выбор запоминается и предлагается в следующий раз.
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { t, type ModelInfo, type ModelRef } from "@kamharn/client";
import { recall, remember, useEngines } from "./hub.ts";

interface Ask {
  title: string;
  text?: string;
  action: string;
  done: (m: ModelRef | undefined) => void;
}

let current: Ask | undefined;
const listeners = new Set<() => void>();
const set = (a: Ask | undefined) => {
  current = a;
  for (const l of listeners) l();
};

const KEY = "opencode.pickModel";
const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

/** Спросить модель opencode; undefined — передумали. */
export function pickOpencodeModel(title: string, action: string, text?: string): Promise<ModelRef | undefined> {
  current?.done(undefined);
  return new Promise((done) => set({ title, action, ...(text ? { text } : {}), done: (m) => (set(undefined), done(m)) }));
}

export function ModelPickHost() {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
  const engines = useEngines();
  const oc = engines?.find((e) => e.id === "opencode");
  const models: ModelInfo[] = useMemo(() => oc?.models.filter((m) => !m.offline) ?? [], [oc]);
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!ask) return;
    // последний выбор → модель по умолчанию → первая бесплатная → первая
    const last = recall<string>(KEY);
    const pick = [last, oc?.defaultModel && key(oc.defaultModel), models.find((m) => m.free) && key(models.find((m) => m.free)!), models[0] && key(models[0])].find(
      (k) => k && models.some((m) => key(m) === k),
    );
    setValue(pick ?? "");
  }, [ask, models, oc]);
  useEffect(() => {
    if (!ask) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && ask.done(undefined);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [ask]);
  if (!ask) return null;

  const grouped = [...models.reduce((m, x) => m.set(x.providerId, [...(m.get(x.providerId) ?? []), x]), new Map<string, ModelInfo[]>())];
  const start = () => {
    const m = models.find((x) => key(x) === value);
    if (!m) return;
    remember(KEY, value);
    ask.done({ providerId: m.providerId, modelId: m.modelId });
  };

  return (
    <div className="modal" onClick={() => ask.done(undefined)}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        {ask.text && <p className="muted">{ask.text}</p>}
        {!oc?.available ? (
          <p className="error">{t("opencode не запущен", "opencode is not running")}{oc?.error ? `: ${oc.error}` : ""}</p>
        ) : !models.length ? (
          <p className="muted">{t("Нет доступных моделей — подключи провайдера в «Настройки → Модели и провайдеры».", "No models available — connect a provider in “Settings → Models and providers”.")}</p>
        ) : (
          <select className="select" value={value} autoFocus onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && start()}>
            {grouped.map(([provider, ms]) => (
              <optgroup key={provider} label={provider}>
                {ms.map((m) => (
                  <option key={key(m)} value={key(m)}>
                    {m.name}
                    {m.free ? " · free" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        <div className="row modal__btns">
          <button className="btn" onClick={() => ask.done(undefined)}>
            {t("Отмена", "Cancel")}
          </button>
          <button className="btn btn--primary" disabled={!value} onClick={start}>
            {ask.action}
          </button>
        </div>
      </div>
    </div>
  );
}
