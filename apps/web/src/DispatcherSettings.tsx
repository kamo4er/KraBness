// «Диспетчер»: основной и запасной мозг, автопереключение, управление ПК у мозга на opencode.
import { useCallback, useEffect, useState } from "react";
import { brainDownText, brainOptions, computerHint, engineName, modelKey, parseModelKey, t, type BrainRef, type DispatcherBrains } from "@kamharn/client";
import { client, fmtTime, useEngines } from "./hub.ts";
import { EffortSelect } from "./Effort.tsx";

export function DispatcherSettings() {
  const engines = useEngines();
  const [b, setB] = useState<DispatcherBrains>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => void client.dispatcherBrains().then(setB, (e: Error) => setError(e.message)), []);
  useEffect(load, [load]);
  // пока качается Windows-MCP, статус меняется сам
  useEffect(() => {
    if (b?.computer.warm !== "running") return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [b?.computer.warm, load]);
  if (!b || !engines) return error ? <p className="error">{error}</p> : null;

  const save = (next: Parameters<typeof client.setDispatcherBrains>[0]) => {
    setError(undefined);
    client.setDispatcherBrains(next).then(setB, (e: Error) => setError(e.message));
  };
  const options = brainOptions(engines);
  const select = (cur: BrainRef | null, onChange: (v: BrainRef | null) => void, none?: string) => {
    const curKey = cur ? modelKey(cur.engine, cur.model) : "";
    return (
      <select
        className="select"
        style={{ width: "auto", maxWidth: 360 }}
        value={curKey}
        onChange={(ev) => {
          const p = parseModelKey(ev.target.value);
          onChange(p ?? null);
        }}
      >
        {none !== undefined && <option value="">{none}</option>}
        {cur && !options.some((o) => o.key === curKey) && <option value={curKey}>{cur.model.modelId}</option>}
        {(["claude", "opencode"] as const).map((e) => {
          const mine = options.filter((o) => o.engine === e);
          return mine.length ? (
            <optgroup key={e} label={engineName(e)}>
              {mine.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.model.name}
                  {o.model.free ? " · free" : ""}
                  {o.engine === "opencode" && !o.model.vision ? t(" · без зрения", " · no vision") : ""}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
    );
  };
  const effort = (cur: BrainRef, onChange: (v: BrainRef) => void) => {
    const m = engines.find((e) => e.id === cur.engine)?.models.find((x) => x.providerId === cur.model.providerId && x.modelId === cur.model.modelId);
    return <EffortSelect efforts={m?.efforts ?? []} value={cur.effort ?? ""} onChange={(v) => onChange({ engine: cur.engine, model: cur.model, ...(v ? { effort: v } : {}) })} />;
  };
  const activeBrain = b.active === "fallback" && b.fallback ? b.fallback : b.primary;
  const onOpencode = b.primary.engine === "opencode" || b.fallback?.engine === "opencode";
  const hint = computerHint(b.computer);

  return (
    <section data-brains>
      <h3>{t("Диспетчер", "Dispatcher")}</h3>
      <p className="muted">{t("Помощник, который раздаёт работу сессиям и может управлять ПК. Чат один, а модель под ним можно менять.", "An assistant that hands out work to sessions and can control the PC. One chat, and the model under it can change.")}</p>
      <p data-brain-state>
        {t("Сейчас отвечает:", "Answering now:")} <b>{activeBrain.model.modelId}</b>
        {b.active === "fallback" && (
          <>
            {" · "}
            {brainDownText(b.reason)}
            {b.until ? ` ${t("до", "until")} ${fmtTime(b.until)}` : ""}{" "}
            <button className="btn btn--small" onClick={() => save({ backToPrimary: true })}>
              {t("Вернуть на основной", "Back to the main one")}
            </button>
          </>
        )}
      </p>
      <div className="engprefs">
        <div className="engprefs__row">
          <div className="row">
            <b>{t("Основной", "Main")}</b>
            {select(b.primary, (v) => v && save({ primary: v }))}
            {effort(b.primary, (v) => save({ primary: v }))}
          </div>
        </div>
        <div className="engprefs__row">
          <div className="row">
            <b>{t("Запасной", "Fallback")}</b>
            {select(b.fallback, (v) => save({ fallback: v }), t("нет: ждать сброса лимита", "none: wait for the limit to reset"))}
            {b.fallback && effort(b.fallback, (v) => save({ fallback: v }))}
          </div>
          {b.fallback && (
            <>
              <label className="row">
                <input type="checkbox" checked={b.autoFallback} onChange={(ev) => save({ autoFallback: ev.target.checked })} />
                {t("Переключать самому и возвращать обратно", "Switch and come back automatically")}
              </label>
              <p className="muted">
                {t(
                  "Срабатывает, когда основной — Claude и он упёрся в лимит или нет входа. Лимиты других поставщиков переключение не запускают, их ошибка будет видна в чате.",
                  "Works when the main one is Claude and it hit its limit or isn't signed in. Limits of other providers don't trigger it, their error shows in the chat.",
                )}
              </p>
              <p className="muted">
                {t(
                  "Разговор и снимки экрана уйдут поставщику запасной модели. У бесплатных моделей условия смотри у поставщика.",
                  "The conversation and screenshots go to the fallback model's provider. For free models, check the provider's terms.",
                )}
              </p>
            </>
          )}
        </div>
        {onOpencode && (
          <div className="engprefs__row">
            <label className="row">
              <input type="checkbox" disabled={!b.computer.available} checked={b.computerOnOpencode && b.computer.available} onChange={(ev) => save({ computerOnOpencode: ev.target.checked })} />
              <b>{t("Управление ПК на моделях opencode", "PC control on opencode models")}</b>
            </label>
            {hint && <p className="muted">{hint}</p>}
            <p className="muted" data-computer-warning>
              {t(
                "Снимки экрана и мышь идут без вопросов, ввод текста, клавиши, запуск программ и команды спрашивают каждый раз. Клик мышью по «Оплатить» или «Отправить» вопроса не вызовет: тут только просьба к модели спросить сама, а классификатора, как у Claude, нет.",
                "Screenshots and the mouse go without asking, typing, keys, launching programs and commands ask every time. A mouse click on “Pay” or “Send” won't ask: there is only a request to the model to ask first, and no classifier like Claude has.",
              )}
            </p>
          </div>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
