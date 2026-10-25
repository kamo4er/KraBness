// Один клиент хаба на всё приложение + хуки для React.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SettingsSection } from "./Settings.tsx";
import { HubClient, applyLangSetting, getLang, getLangSetting, onLangChange, type ClientState, type EngineInfo, type Lang, type LangSetting, t, locale } from "@kamharn/client";

const TOKEN_KEY = "kamharn.token";

export const client = new HubClient(window.location.origin, localStorage.getItem(TOKEN_KEY) ?? undefined);

export function saveToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  client.token = token;
  client.disconnect();
  client.connect();
}

// язык: последняя настройка — сразу при загрузке (до ответа хаба), чтобы не мигал другой язык
const LANG_KEY = "kamharn.lang";
applyLangSetting((localStorage.getItem(LANG_KEY) as LangSetting | null) ?? "auto");
document.documentElement.lang = getLang();
onLangChange(() => {
  localStorage.setItem(LANG_KEY, getLangSetting());
  document.documentElement.lang = getLang();
});

export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang);
}

export function useHub(): ClientState {
  return useSyncExternalStore(client.subscribe, client.getState);
}

/** Список движков и моделей; перезапрашивается при монтировании — статус локальных моделей меняется. */
export function useEngines(): EngineInfo[] | undefined {
  const [engines, setEngines] = useState<EngineInfo[]>();
  useEffect(() => {
    let alive = true;
    client.engines().then(
      (e) => alive && setEngines(e),
      () => alive && setEngines([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  return engines;
}

// ---------- запоминание последнего выбора ----------

export function remember<T>(key: string, value: T): void {
  localStorage.setItem(`kamharn.last.${key}`, JSON.stringify(value));
}

export function recall<T>(key: string): T | undefined {
  const v = localStorage.getItem(`kamharn.last.${key}`);
  return v ? (JSON.parse(v) as T) : undefined;
}

// ---------- роутинг на hash ----------

export type Route =
  | { page: "home" }
  | { page: "session"; id: string }
  /** file — сразу открыть этот файл (абсолютный путь), line — строку в нём (ссылки на файлы из чата) */
  | { page: "project"; id: string; file?: string; line?: number }
  /** group — новая сессия сразу в группе */
  | { page: "new"; group?: string }
  /** section — раздел настроек (без него — список разделов) */
  | { page: "settings"; section?: SettingsSection }
  /** модели и провайдеры: ключи, подписки, свои серверы */
  | { page: "providers" }
  | { page: "mcp" }
  | { page: "skills" }
  /** экран группы: id "new" — создать */
  | { page: "group"; id: string };

function parse(hash: string): Route {
  const p = /^#\/s\/([^/?]+)\/project(?:\?(.*))?$/.exec(hash);
  if (p) {
    const q = new URLSearchParams(p[2] ?? "");
    const file = q.get("f") ?? undefined;
    const line = Number(q.get("l")) || undefined;
    return { page: "project", id: decodeURIComponent(p[1]!), ...(file ? { file } : {}), ...(line ? { line } : {}) };
  }
  const m = /^#\/s\/(.+)$/.exec(hash);
  if (m) return { page: "session", id: decodeURIComponent(m[1]!) };
  const n = /^#\/new(?:\?g=(.+))?$/.exec(hash);
  if (n) return n[1] ? { page: "new", group: decodeURIComponent(n[1]) } : { page: "new" };
  const g = /^#\/g\/(.+)$/.exec(hash);
  if (g) return { page: "group", id: decodeURIComponent(g[1]!) };
  if (hash === "#/settings") return { page: "settings" };
  const st = /^#\/settings\/([a-z]+)$/.exec(hash);
  if (st) return { page: "settings", section: st[1] as SettingsSection };
  if (hash === "#/providers") return { page: "providers" };
  if (hash === "#/mcp") return { page: "mcp" };
  if (hash === "#/skills") return { page: "skills" };
  return { page: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(route: Route): void {
  window.location.hash =
    route.page === "session"
      ? `#/s/${encodeURIComponent(route.id)}`
      : route.page === "project"
        ? `#/s/${encodeURIComponent(route.id)}/project` + (route.file ? `?${new URLSearchParams({ f: route.file, ...(route.line ? { l: String(route.line) } : {}) })}` : "")
        : route.page === "new"
          ? route.group
            ? `#/new?g=${encodeURIComponent(route.group)}`
            : "#/new"
          : route.page === "group"
            ? `#/g/${encodeURIComponent(route.id)}`
          : route.page === "settings"
            ? `#/settings${route.section ? `/${route.section}` : ""}`
            : route.page === "providers"
              ? "#/providers"
              : route.page === "mcp" || route.page === "skills"
                ? `#/${route.page}`
                : "";
}

// ---------- форматирование ----------

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} ${t("Б", "B")}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} ${t("КБ", "KB")}`;
  return `${(n / 1024 / 1024).toFixed(1)} ${t("МБ", "MB")}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

export function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? "…\\" + parts.slice(-2).join("\\") : p;
}

// ---------- быстрые кнопки (общие для всех устройств, хранятся на хабе) ----------

let quickCache: string[] | undefined;

export function useQuickPrompts(): string[] {
  const [list, setList] = useState<string[]>(quickCache ?? []);
  useEffect(() => {
    client.quickPrompts().then((l) => setList((quickCache = l)), () => {});
  }, []);
  return list;
}

export async function saveQuickPrompts(list: string[]): Promise<string[]> {
  return (quickCache = await client.setQuickPrompts(list));
}
