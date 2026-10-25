// Подключение к хабу: сохранённые адреса и токен, выбор живого адреса, переподключение
// при смене сети и возврате из фона. Один HubClient на всё приложение.
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Network from "expo-network";
import { HubClient, applyLangSetting, getLang, getLangSetting, onLangChange, type ClientState, type EngineInfo, type Lang, type LangSetting, t } from "@kamharn/client";

export interface Conn {
  /** адреса хаба из QR (Tailscale и т.п.) */
  urls: string[];
  token: string;
  deviceId: string;
  /** последний адрес, который отвечал */
  url?: string;
}

const CONN_KEY = "kamharn.conn";

export function loadConnection(): Conn | null {
  try {
    const raw = SecureStore.getItem(CONN_KEY);
    return raw ? (JSON.parse(raw) as Conn) : null;
  } catch {
    return null;
  }
}

let conn = loadConnection();
export let client: HubClient | null = conn ? new HubClient(conn.url ?? conn.urls[0]!, conn.token) : null;

const connListeners = new Set<() => void>();
function setConn(c: Conn | null): void {
  conn = c;
  if (c) SecureStore.setItem(CONN_KEY, JSON.stringify(c));
  else void SecureStore.deleteItemAsync(CONN_KEY);
  for (const l of connListeners) l();
}

export function useConn(): Conn | null {
  return useSyncExternalStore(
    (l) => (connListeners.add(l), () => connListeners.delete(l)),
    () => conn,
  );
}

const EMPTY: ClientState = { conn: "offline", sessions: [], groups: [], views: {}, versions: {} };
const noop = () => () => {};

export function useHub(): ClientState {
  const c = client;
  return useSyncExternalStore(c ? c.subscribe : noop, c ? c.getState : () => EMPTY);
}

/** «http://» и порт 7420 по умолчанию (у https — нет), без хвостового слэша. */
export function normalizeUrl(s: string): string {
  let u = s.trim();
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  u = u.replace(/\/+$/, "");
  // https — свой сервер (VPS) на стандартном 443, порт хаба нужен только для http
  if (!/:\d+$/.test(u.replace(/^https?:\/\//i, "")) && !/^https:/i.test(u)) u += ":7420";
  return u;
}

async function healthy(url: string, ms: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url + "/api/health", { signal: ac.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Первый отвечающий адрес: сначала последний рабочий, потом все сразу. */
export async function pickUrl(urls: string[], preferred?: string): Promise<string | undefined> {
  if (preferred && (await healthy(preferred, 2000))) return preferred;
  const rest = urls.filter((u) => u !== preferred);
  if (!rest.length) return undefined;
  return new Promise((resolve) => {
    let left = rest.length;
    for (const u of rest) {
      void healthy(u, 4000).then((ok) => {
        if (ok) resolve(u);
        else if (--left === 0) resolve(undefined);
      });
    }
  });
}

export function deviceName(): string {
  const c = Platform.constants as { Manufacturer?: string; Model?: string };
  return [c.Manufacturer, c.Model].filter(Boolean).join(" ") || "Android";
}

/** Pairing: найти рабочий адрес, обменять код на токен, подключиться. */
export async function pair(urls: string[], code: string): Promise<void> {
  const url = await pickUrl(urls);
  if (!url) throw new Error(`${t("Хаб не отвечает", "The hub doesn't answer")}: ${urls.join(", ")}`);
  const r = await new HubClient(url).pairComplete(code.trim(), `${deviceName()} (${t("приложение", "app")})`);
  client?.disconnect();
  client = new HubClient(url, r.token);
  setConn({ urls, token: r.token, deviceId: r.deviceId, url });
  watch();
  client.connect();
}

export function unpair(): void {
  client?.disconnect();
  client = null;
  setConn(null);
}

// ---------- переподключение ----------

let probing = false;
let offlineTimer: ReturnType<typeof setTimeout> | undefined;

/** Связь потеряна или сменилась сеть: ищем рабочий адрес и переподключаемся сразу. */
export async function revive(): Promise<void> {
  const c = client;
  if (!c || !conn || probing) return;
  if (c.state.conn === "online" || c.state.conn === "unauthorized") return;
  probing = true;
  try {
    const url = await pickUrl(conn.urls.includes(c.baseUrl) ? conn.urls : [c.baseUrl, ...conn.urls], c.baseUrl);
    if (!url || client !== c) return;
    if (url !== c.baseUrl) {
      c.disconnect();
      c.baseUrl = url;
      setConn({ ...conn, url });
      c.connect();
    } else {
      c.reconnectNow();
    }
  } finally {
    probing = false;
  }
}

/** Хаб знает свои адреса лучше (подключили свой сервер, сменился IP в Tailscale): дописываем новые к сохранённым. */
async function learnUrls(): Promise<void> {
  const c = client;
  const info = c && (await c.hubInfo().catch(() => undefined));
  if (!info || client !== c || !conn) return;
  const known = conn.urls;
  const fresh = info.urls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(u) && !known.includes(u));
  if (fresh.length) setConn({ ...conn, urls: [...known, ...fresh] });
}
let learnedFor: HubClient | null = null;

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  AppState.addEventListener("change", (s) => {
    if (s === "active") void revive();
  });
  Network.addNetworkStateListener((s) => {
    if (s.isConnected) setTimeout(() => void revive(), 500);
  });
  // офлайн дольше пары секунд — возможно, сменилась сеть и текущий адрес больше не доступен
  setInterval(() => {
    const st = client?.state.conn;
    // каждое новое подключение — заново спрашиваем адреса
    if (st === "online" && learnedFor !== client) {
      learnedFor = client;
      void learnUrls();
    } else if (st !== "online") learnedFor = null;
    if (st === "offline" || st === "connecting") {
      if (!offlineTimer) offlineTimer = setTimeout(() => ((offlineTimer = undefined), void revive()), 3000);
    }
  }, 2000);
}

export function start(): void {
  if (!client) return;
  watch();
  client.connect();
}

/** Список движков и моделей; перезапрашивается при монтировании. */
export function useEngines(): EngineInfo[] | undefined {
  const [engines, setEngines] = useState<EngineInfo[]>();
  useEffect(() => {
    let alive = true;
    client?.engines().then(
      (e) => alive && setEngines(e),
      () => alive && setEngines([]),
    );
    return () => {
      alive = false;
    };
  }, []);
  return engines;
}

// ---------- язык ----------
// последняя настройка — сразу при запуске (до ответа хаба), чтобы не мигал другой язык
applyLangSetting(recallLang());
onLangChange(() => remember("lang", getLangSetting()));

function recallLang(): LangSetting {
  try {
    const v = SecureStore.getItem("kamharn.last.lang");
    return v ? (JSON.parse(v) as LangSetting) : "auto";
  } catch {
    return "auto";
  }
}

export function useLang(): Lang {
  return useSyncExternalStore(onLangChange, getLang);
}

// ---------- запоминание последнего выбора ----------

export function remember<T>(key: string, value: T): void {
  SecureStore.setItem(`kamharn.last.${key}`, JSON.stringify(value));
}

export function recall<T>(key: string): T | undefined {
  try {
    const v = SecureStore.getItem(`kamharn.last.${key}`);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} ${t("Б", "B")}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ${t("КБ", "KB")}`;
  return `${(n / 1024 / 1024).toFixed(1)} ${t("МБ", "MB")}`;
}

// ---------- быстрые кнопки (общие для всех устройств, хранятся на хабе) ----------

let quickCache: string[] | undefined;

export function useQuickPrompts(): string[] {
  const [list, setList] = useState<string[]>(quickCache ?? []);
  useEffect(() => {
    client?.quickPrompts().then((l) => setList((quickCache = l)), () => {});
  }, []);
  return list;
}

export async function saveQuickPrompts(list: string[]): Promise<string[]> {
  return (quickCache = await client!.setQuickPrompts(list));
}
