// «@» в поле ввода: список файлов и папок проекта под курсором, как в IDE (↑↓, Enter/Tab, Esc).
import { useEffect, useState } from "react";
import { applyMention, mentionAt, t, type FileHit } from "@kamharn/client";
import { client } from "./hub.ts";

export function useMention(sessionId: string, text: string, caret: number) {
  const at = mentionAt(text, caret);
  const [hits, setHits] = useState<FileHit[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(false);
  /** Esc закрывает список для этого «@» (по позиции), пока его не сотрут */
  const [dismissed, setDismissed] = useState<number>();
  const query = at?.query;
  const open = at !== undefined && dismissed !== at.start;

  useEffect(() => {
    if (!open || query === undefined) return;
    let gone = false;
    setLoading(true);
    // не дёргаем хаб на каждую букву
    const timer = setTimeout(() => {
      client.searchFiles(sessionId, query).then(
        (h) => !gone && (setHits(h), setSel(0), setLoading(false)),
        () => !gone && (setHits([]), setLoading(false)),
      );
    }, 120);
    return () => ((gone = true), clearTimeout(timer));
  }, [sessionId, query, open]);
  useEffect(() => {
    if (dismissed !== undefined && at?.start !== dismissed) setDismissed(undefined);
  }, [at?.start]);

  return {
    open,
    hits: open ? hits : [],
    loading: open && loading,
    sel,
    /** обработать клавишу; true — съели (не отправлять, не двигать курсор) */
    key(e: React.KeyboardEvent, pick: (h: FileHit) => void): boolean {
      if (!open || !hits.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const d = e.key === "ArrowDown" ? 1 : -1;
        setSel((s) => (s + d + hits.length) % hits.length);
      } else if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") pick(hits[Math.min(sel, hits.length - 1)]!);
      else if (e.key === "Escape") setDismissed(at!.start);
      else return false;
      e.preventDefault();
      return true;
    },
    apply: (h: FileHit) => applyMention(text, caret, h.path, h.dir),
  };
}

export function MentionList({ m, pick }: { m: ReturnType<typeof useMention>; pick: (h: FileHit) => void }) {
  if (!m.open || (!m.hits.length && !m.loading)) return null;
  return (
    <ul className="slash mention" role="listbox">
      {!m.hits.length && <li className="muted mention__empty">{t("ищу…", "searching…")}</li>}
      {m.hits.map((h, i) => {
        const cut = h.path.lastIndexOf("/") + 1;
        return (
          <li key={h.path}>
            <button
              className={`slash__item mention__item ${i === m.sel ? "mention__item--on" : ""}`}
              ref={(el) => void (i === m.sel && el?.scrollIntoView({ block: "nearest" }))}
              // mousedown, а не click: иначе поле теряет фокус и курсор
              onMouseDown={(e) => (e.preventDefault(), pick(h))}
            >
              <span>{h.dir ? "📁" : "📄"}</span>
              <span className="mention__name">{h.path.slice(cut)}{h.dir ? "/" : ""}</span>
              {cut > 0 && <span className="muted mention__dir">{h.path.slice(0, cut)}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
