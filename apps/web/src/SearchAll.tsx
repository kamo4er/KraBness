// Поиск по всем чатам: строка над списком сессий, результаты — сессия, кто, когда и кусок текста с найденными словами.
import { Fragment, useEffect, useRef, useState } from "react";
import { t, type SearchHit } from "@kamharn/client";
import { client, fmtTime, go } from "./hub.ts";

/** «**слово**» из сниппета хаба → жирный */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/\*\*(.+?)\*\*/g).map((s, i) => (i % 2 ? <b key={i}>{s}</b> : <Fragment key={i}>{s}</Fragment>))}
    </>
  );
}

export function SearchAll() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>();
  const [error, setError] = useState<string>();
  const seq = useRef(0);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(undefined);
      return;
    }
    const my = ++seq.current;
    const timer = setTimeout(() => {
      client.search(query, 30).then(
        (h) => my === seq.current && (setHits(h), setError(undefined)),
        (e: Error) => my === seq.current && setError(e.message),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <div className="searchall" data-searchall>
      <input
        className="input searchall__input"
        placeholder={t("Поиск по всем чатам…", "Search all chats…")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
      />
      {error ? <p className="error">{error}</p> : null}
      {hits ? (
        <div className="searchall__hits">
          {hits.length ? null : <p className="muted searchall__empty">{t("Ничего не нашлось", "Nothing found")}</p>}
          {hits.map((h) => (
            <button key={`${h.sessionId}|${h.messageId}|${h.snippet}`} className="searchall__hit" onClick={() => (go({ page: "session", id: h.sessionId }), setQ(""))}>
              <span className="searchall__meta">
                <b>{h.title}</b> · {h.role === "user" ? t("ты", "you") : t("агент", "agent")} · {fmtTime(h.ts)}
              </span>
              <span className="searchall__snip">
                <Snippet text={h.snippet} />
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
