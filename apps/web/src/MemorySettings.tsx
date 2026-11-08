// «Память»: что помнит Диспетчер (дневник по дням, поиск, забыть). Закрыть группу для памяти — в настройках группы.
import { useCallback, useEffect, useState } from "react";
import { t, type MemoryInfo, type MemoryRecall } from "@kamharn/client";
import { client } from "./hub.ts";

export function MemorySettings() {
  const [info, setInfo] = useState<MemoryInfo>();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MemoryRecall>();
  const [error, setError] = useState<string>();
  const [gone, setGone] = useState<string[]>();
  const load = useCallback(() => void client.memoryInfo().then(setInfo, (e: Error) => setError(e.message)), []);
  useEffect(load, [load]);
  if (!info) return error ? <section><h3>{t("Память", "Memory")}</h3><p className="muted">{error}</p></section> : null;
  const search = () => {
    setGone(undefined);
    client.memoryRecall(q).then(setFound, (e: Error) => setError(e.message));
  };
  const forget = () => {
    if (!confirm(t(`Забыть всё, что подходит под «${q}»?`, `Forget everything matching “${q}”?`))) return;
    client.memoryForget(q).then((r) => {
      setGone(r.forgotten);
      setFound(undefined);
      load();
    }, (e: Error) => setError(e.message));
  };
  return (
    <section data-memory>
      <h3>{t("Память", "Memory")}</h3>
      <p className="muted">
        {t(
          "Диспетчер помнит разговоры по дням: что делали, что о тебе известно, где что лежит. Всё хранится на этом ПК. Группу можно закрыть для памяти в её настройках.",
          "The Dispatcher remembers conversations by day: what was done, what is known about you, where things are. Everything stays on this PC. A group can be closed for memory in its settings.",
        )}
      </p>
      <p className="muted" data-memory-stats>
        {t(`Записей: ${info.items}, дней в дневнике: ${info.diaries}, фактов: ${info.facts}, мест: ${info.places}.`, `Records: ${info.items}, diary days: ${info.diaries}, facts: ${info.facts}, places: ${info.places}.`)}{" "}
        {!info.vectors && t("Модели векторов нет: ищет только по словам. ", "No embedding model: searches by words only. ")}
        {!info.writer && t("Модели для дневника нет: дневник не пишется.", "No model for the diary: it isn't written.")}
      </p>
      <div className="row">
        <input className="input" style={{ flex: 1 }} value={q} placeholder={t("Что вспомнить? Например: что было вчера", "What to recall? For example: what happened yesterday")} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search()} />
        <button className="btn" disabled={!q.trim()} onClick={search}>{t("Найти", "Find")}</button>
        <button className="btn" disabled={!q.trim()} onClick={forget}>{t("Забыть", "Forget")}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {gone && <p className="muted">{gone.length ? t(`Забыто записей: ${gone.length}`, `Forgotten: ${gone.length}`) : t("Такого нет", "Nothing like that")}</p>}
      {found && (
        <div data-memory-found>
          {found.diaries.map((d) => (
            <p key={d.day} style={{ whiteSpace: "pre-wrap" }}>
              <b>{d.day}</b>
              {"\n"}
              {d.text}
            </p>
          ))}
          {found.items.map((h) => (
            <p key={h.id} className="muted">
              <b>{h.day}</b> · {h.where}: {h.text.slice(0, 300)}
            </p>
          ))}
          {!found.diaries.length && !found.items.length && <p className="muted">{t("Ничего не нашлось", "Nothing found")}</p>}
        </div>
      )}
      {info.days.length > 0 && (
        <details>
          <summary>{t("Дневник", "Diary")}</summary>
          {info.days.map((d) => (
            <p key={d.day} style={{ whiteSpace: "pre-wrap" }}>
              <b>{d.day}</b>
              {"\n"}
              {d.text}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
