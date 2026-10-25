import { useState } from "react";
import { client, go, recall, remember, useHub, useRoute, fmtTime, shortPath } from "./hub.ts";
import { Chat } from "./Chat.tsx";
import { Project } from "./Project.tsx";
import { NewSession } from "./NewSession.tsx";
import { Settings } from "./Settings.tsx";
import { Group } from "./Group.tsx";
import { Providers } from "./Providers.tsx";
import { Mcp } from "./Mcp.tsx";
import { Skills } from "./Skills.tsx";
import { ModelPickHost } from "./ModelPick.tsx";
import { PairScreen } from "./PairScreen.tsx";
import { Limits } from "./Parts.tsx";
import { UpdateBanner } from "./Updates.tsx";
import { t, locale, type SessionGroup, type SessionInfo } from "@kamharn/client";

const connLabel = (c: "connecting" | "online" | "offline" | "unauthorized") =>
  ({ connecting: t("подключение…", "connecting…"), online: t("онлайн", "online"), offline: t("нет связи", "offline"), unauthorized: t("нужен вход", "sign-in needed") })[c];

export function App() {
  const state = useHub();
  const route = useRoute();

  if (state.conn === "unauthorized") return <PairScreen />;

  const inner = route.page !== "home";
  return (
    <div className={`app ${inner ? "app--inner" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar__head">
          <div className="brand">
            <img className="brand__logo" src="/favicon.svg" alt="" />
            KraBness <span className={`dot dot--${state.conn}`} title={connLabel(state.conn)} />
          </div>
          <div className="sidebar__actions">
            <button className="btn btn--primary" onClick={() => go({ page: "new" })}>
              {t("+ Новая", "+ New")}
            </button>
            <button className="btn btn--icon" title={t("Настройки", "Settings")} onClick={() => go({ page: "settings" })}>
              ⚙
            </button>
          </div>
        </header>
        {state.limits && (
          <div className="sidebar__limits">
            <Limits limits={state.limits} />
          </div>
        )}
        <UpdateBanner />
        <SessionList sessions={state.sessions} groups={state.groups} activeId={route.page === "session" || route.page === "project" ? route.id : undefined} />
      </aside>
      <main className="main">
        {route.page === "session" && <Chat key={route.id} id={route.id} />}
        {route.page === "project" && <Project key={`${route.id}|${route.file ?? ""}|${route.line ?? ""}`} id={route.id} file={route.file} line={route.line} />}
        {route.page === "new" && <NewSession key={route.group ?? ""} group={route.group} />}
        {route.page === "settings" && <Settings key={route.section ?? ""} section={route.section} />}
        {route.page === "group" && <Group key={route.id} id={route.id} />}
        {route.page === "providers" && <Providers />}
        {route.page === "mcp" && <Mcp />}
        {route.page === "skills" && <Skills />}
        <ModelPickHost />
        {route.page === "home" && (
          <div className="empty">
            <p>{t("Выбери сессию слева или создай новую.", "Pick a session on the left or start a new one.")}</p>
          </div>
        )}
      </main>
    </div>
  );
}

const DRAG = "text/kamharn-session";

/** Сессии по группам: сворачивание, перетаскивание сессий между группами, «+» — новая сессия в группе. */
function SessionList({ sessions, groups, activeId }: { sessions: SessionInfo[]; groups: SessionGroup[]; activeId?: string }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => recall("groups.collapsed") ?? {});
  const [over, setOver] = useState<string>();
  const toggle = (key: string) => {
    const next = { ...collapsed, [key]: !collapsed[key] };
    setCollapsed(next);
    remember("groups.collapsed", next);
  };
  const known = new Set(groups.map((g) => g.id));
  const sections = [
    ...groups.map((g) => ({ key: g.id, group: g as SessionGroup | undefined, items: sessions.filter((s) => s.groupId === g.id) })),
    { key: "", group: undefined, items: sessions.filter((s) => !s.groupId || !known.has(s.groupId)) },
  ];
  const drop = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    setOver(undefined);
    const id = e.dataTransfer.getData(DRAG);
    const s = sessions.find((x) => x.id === id);
    if (s && (s.groupId ?? "") !== groupId) void client.moveSession(id, groupId || null).catch((err: Error) => alert(err.message));
  };

  return (
    <div className="groups">
      {sections.map(({ key, group, items }) => {
        // «Без группы» показываем заголовком, только когда группы вообще есть
        const titled = !!group || groups.length > 0;
        if (!group && !items.length && !groups.length) return null;
        const isCollapsed = !!collapsed[key];
        const busy = items.some((s) => s.status === "busy");
        return (
          <section
            key={key || "none"}
            className={`group ${over === key ? "group--over" : ""}`}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(DRAG)) return;
              e.preventDefault();
              setOver(key);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(undefined);
            }}
            onDrop={(e) => drop(e, key)}
          >
            {titled && (
              <div className="group__head">
                <button className="group__toggle" onClick={() => toggle(key)} title={isCollapsed ? t("Развернуть", "Expand") : t("Свернуть", "Collapse")}>
                  <span className="group__caret">{isCollapsed ? "▸" : "▾"}</span>
                  {group?.icon ? <span>{group.icon}</span> : null}
                  <span className="group__name">{group ? group.name : t("Без группы", "Ungrouped")}</span>
                  <span className="muted">{items.length}</span>
                  {busy && <span className="spinner" title={t("кто-то работает", "something is running")} />}
                  {group?.prompt ? <span className="muted" title={group.prompt}>✎</span> : null}
                </button>
                {group && (
                  <>
                    <button className="btn btn--icon btn--tiny" title={t("Новая сессия в группе", "New session in this group")} onClick={() => go({ page: "new", group: group.id })}>
                      +
                    </button>
                    <button className="btn btn--icon btn--tiny" title={t("Настроить группу", "Group settings")} onClick={() => go({ page: "group", id: group.id })}>
                      ⋯
                    </button>
                  </>
                )}
              </div>
            )}
            {!isCollapsed && (
              <ul className="sessions">
                {items.map((s) => (
                  <li key={s.id} draggable onDragStart={(e) => (e.dataTransfer.setData(DRAG, s.id), (e.dataTransfer.effectAllowed = "move"))}>
                    <SessionItem s={s} active={s.id === activeId} />
                  </li>
                ))}
                {titled && !items.length && <li className="muted group__empty">{t("Перетащи сюда сессию", "Drag a session here")}</li>}
              </ul>
            )}
          </section>
        );
      })}
      {!sessions.length && <p className="muted pad">{t("Сессий пока нет.", "No sessions yet.")}</p>}
      <button className="linkish group__add" onClick={() => go({ page: "group", id: "new" })}>
        {t("+ Группа", "+ Group")}
      </button>
    </div>
  );
}

function SessionItem({ s, active }: { s: SessionInfo; active: boolean }) {
  return (
    <button className={`session ${active ? "session--active" : ""}`} onClick={() => go({ page: "session", id: s.id })}>
      <div className="session__row">
        <span className="session__title">{s.title}</span>
        <span className="session__time">{fmtTime(s.updatedAt)}</span>
      </div>
      <div className="session__row muted">
        <span className={`badge badge--${s.engine}`}>{s.engine}</span>
        {s.status === "busy" && <span className="spinner" title={t("работает", "running")} />}
        {s.resumeAt ? <span title={t("продолжит сам после лимита", "will resume by itself after the limit")} style={{ whiteSpace: "nowrap", flexShrink: 0 }}>⏳ {new Date(s.resumeAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</span> : null}
        <span className="session__dir">{shortPath(s.directory)}</span>
      </div>
    </button>
  );
}
