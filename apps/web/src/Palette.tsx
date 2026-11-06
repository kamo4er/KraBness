// Палитра команд (Ctrl+K): действия открытой сессии, смена модели, переходы, разделы настроек, сессии по названию.
// Действия сессии выполняет её шапка (ChatHeader подписан через onSessionAction): там же панели и подтверждения.
import { useEffect, useMemo, useRef, useState } from "react";
import { matchQuery, sessionActions, t, type SessionActionId } from "@kamharn/client";
import { client, go, useEngines, useHub, useRoute } from "./hub.ts";
import { SECTIONS } from "./Settings.tsx";

export type HeaderAction = SessionActionId | "params" | "handoff";

const actionListeners = new Set<(id: HeaderAction) => void>();
export function onSessionAction(f: (id: HeaderAction) => void): () => void {
  actionListeners.add(f);
  return () => void actionListeners.delete(f);
}

const openListeners = new Set<() => void>();
export const openPalette = (): void => openListeners.forEach((f) => f());

interface Item {
  key: string;
  icon: string;
  label: string;
  hint: string;
  keywords?: string;
  run: () => void;
}

const LIMIT = 10;

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const { sessions } = useHub();
  const engines = useEngines();
  const route = useRoute();

  useEffect(() => {
    const show = () => (setQ(""), setSel(0), setOpen(true));
    openListeners.add(show);
    // e.code, а не e.key: в русской раскладке K — это «л»
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === "KeyK") {
        e.preventDefault();
        // зажатая клавиша повторяется — палитра мигала бы
        if (e.repeat) return;
        setOpen((o) => (o ? false : (setQ(""), setSel(0), true)));
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      openListeners.delete(show);
      removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const current = route.page === "session" ? sessions.find((s) => s.id === route.id) : undefined;
  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    if (current) {
      const emit = (id: HeaderAction) => () => actionListeners.forEach((f) => f(id));
      list.push({ key: "params", icon: "⚙", label: t("Параметры сессии", "Session settings"), hint: t("модель, рассуждение, подтверждения", "model, reasoning, approvals"), keywords: "model effort approvals модель рассуждение подтверждения режим", run: emit("params") });
      for (const a of sessionActions(current, { platform: "web" })) list.push({ key: a.id, icon: a.icon, label: a.label, hint: a.hint, keywords: a.keywords, run: emit(a.id) });
      if (current.engine === "claude")
        list.push({ key: "handoff", icon: "→", label: t("Продолжить на бесплатной модели", "Continue on a free model"), hint: t("новая сессия opencode с выжимкой этой", "a new opencode session with a summary of this one"), keywords: "handoff opencode free limit лимит бесплатная", run: emit("handoff") });
      const models = engines?.find((e) => e.id === current.engine)?.models ?? [];
      for (const m of models) {
        if (m.offline || (m.providerId === current.model.providerId && m.modelId === current.model.modelId)) continue;
        list.push({
          key: `model:${m.providerId}/${m.modelId}`,
          icon: "🧠",
          label: `${t("Модель", "Model")}: ${m.name}`,
          hint: t("сменить модель этой сессии", "switch this session's model"),
          keywords: "model модель",
          run: () => void client.updateSession(current.id, { model: { providerId: m.providerId, modelId: m.modelId } }).catch((e: Error) => alert(e.message)),
        });
      }
    }
    list.push({ key: "new", icon: "+", label: t("Новая сессия", "New session"), hint: "", keywords: "new session новая сессия", run: () => go({ page: "new" }) });
    list.push({ key: "tasks", icon: "🗂", label: t("Задачи", "Tasks"), hint: "", keywords: "tasks задачи", run: () => go({ page: "tasks" }) });
    const disp = sessions.find((s) => s.kind === "dispatcher");
    if (disp) list.push({ key: "dispatcher", icon: "🦀", label: t("Диспетчер", "Dispatcher"), hint: "", keywords: "dispatcher диспетчер", run: () => go({ page: "session", id: disp.id }) });
    for (const s of SECTIONS())
      list.push({ key: `settings:${s.id}`, icon: s.icon, label: `${t("Настройки", "Settings")}: ${s.title}`, hint: s.hint, keywords: "settings настройки", run: () => go({ page: "settings", section: s.id }) });
    for (const s of sessions) {
      if (s.taskId || s.kind === "dispatcher" || s.id === current?.id) continue;
      list.push({ key: `session:${s.id}`, icon: "💬", label: s.title, hint: s.directory, keywords: `session сессия ${s.engine}`, run: () => go({ page: "session", id: s.id }) });
    }
    return list;
  }, [current, engines, sessions]);

  if (!open) return null;
  const found = items.filter((i) => matchQuery(`${i.label} ${i.hint} ${i.keywords ?? ""}`, q)).slice(0, LIMIT);
  const at = Math.min(sel, Math.max(0, found.length - 1));
  const run = (i: Item | undefined) => {
    if (!i) return;
    setOpen(false);
    i.run();
  };
  return (
    <>
      <div className="palette__scrim" onClick={() => setOpen(false)} />
      <div className="palette" role="dialog" data-palette>
        <input
          ref={input}
          className="input"
          placeholder={t("Действие, настройка или сессия…", "Action, setting or session…")}
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((at + 1) % Math.max(found.length, 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((at - 1 + found.length) % Math.max(found.length, 1)));
            else if (e.key === "Enter") (e.preventDefault(), run(found[at]));
            else if (e.key === "Escape") setOpen(false);
          }}
        />
        <div className="palette__list">
          {found.length ? (
            found.map((i, n) => (
              <button
                key={i.key}
                ref={n === at ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={`amenu__item ${n === at ? "amenu__item--sel" : ""}`}
                onMouseEnter={() => setSel(n)}
                onClick={() => run(i)}
              >
                <span className="amenu__icon">{i.icon}</span>
                <span className="amenu__text">
                  <span>{i.label}</span>
                  {i.hint && <span className="amenu__hint">{i.hint}</span>}
                </span>
              </button>
            ))
          ) : (
            <p className="muted palette__empty">{t("Ничего не нашлось", "Nothing found")}</p>
          )}
        </div>
        <div className="muted palette__keys">{t("↑↓ выбрать · Enter выполнить · Esc закрыть", "↑↓ select · Enter run · Esc close")}</div>
      </div>
    </>
  );
}
