// Пробуждение спящего ПК: хаб спит вместе с ним, поэтому приложение зовёт будильник в домашней сети
// (scripts/nas-wake/wake.py на NAS, Raspberry Pi…) по Tailscale, а тот шлёт Wake-on-LAN в локалку.
// Адрес, токен, MAC и адрес хаба берём у хаба, пока ПК не спит (настраивается в «Настройки → Пробуждение ПК»).
import { useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { t, type WakeRuntime } from "@kamharn/client";
import { client, revive } from "./store.ts";

const KEY = "kamharn.wake";
const WAIT_MS = 150_000;

type WakeConfig = WakeRuntime;

let cached: WakeConfig | null | undefined;
const listeners = new Set<() => void>();

export function loadWake(): WakeConfig | null {
  if (cached === undefined) {
    try {
      const raw = SecureStore.getItem(KEY);
      cached = raw ? (JSON.parse(raw) as WakeConfig) : null;
    } catch {
      cached = null;
    }
  }
  return cached;
}

/** Вызывать, когда есть связь с хабом: запомнить, как будить ПК (или забыть, если на хабе выключено). */
export async function syncWake(): Promise<void> {
  if (!client) return;
  let next: WakeConfig | null;
  try {
    next = await client.wakeConfig();
  } catch (e) {
    if ((e as { status?: number }).status !== 404) return; // сеть моргнула — оставляем старое
    next = null;
  }
  if (JSON.stringify(next) === JSON.stringify(loadWake())) return;
  cached = next;
  if (next) SecureStore.setItem(KEY, JSON.stringify(next));
  else await SecureStore.deleteItemAsync(KEY);
  for (const l of listeners) l();
}

async function call(cfg: WakeConfig, method: "GET" | "POST", path: string, body?: object): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(cfg.url + path, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    if (!r.ok) throw Object.assign(new Error(r.status === 401 ? t("Будильник не принял токен", "The relay rejected the token") : `${t("Будильник ответил", "The relay answered")} ${r.status}`), { status: r.status });
    return (await r.json()) as Record<string, unknown>;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(t("Будильник не отвечает (Tailscale на телефоне включён?)", "The relay doesn't answer (is Tailscale on the phone on?)"));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Проснулся ли ПК: новый wake.py проверяет адрес из запроса, старый (адрес в параметрах запуска) на ?host= отвечает 404. */
async function pcStatus(cfg: WakeConfig): Promise<Record<string, unknown>> {
  if (!cfg.pcHost) return call(cfg, "GET", "/status");
  try {
    return await call(cfg, "GET", `/status?host=${encodeURIComponent(cfg.pcHost)}&port=${cfg.pcPort ?? 7420}`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return call(cfg, "GET", "/status");
    throw e;
  }
}

export type WakePhase = "idle" | "sending" | "waiting" | "awake" | "error";

/** Кнопка «Разбудить ПК»: шлёт пакет и ждёт, пока хаб снова станет доступен. */
export function useWake() {
  const [cfg, setCfg] = useState(loadWake);
  const [phase, setPhase] = useState<WakePhase>("idle");
  const [error, setError] = useState<string>();
  const alive = useRef(true);
  useEffect(() => {
    const l = () => setCfg(loadWake());
    listeners.add(l);
    return () => {
      alive.current = false;
      listeners.delete(l);
    };
  }, []);

  const wake = async () => {
    if (!cfg) return;
    setError(undefined);
    setPhase("sending");
    try {
      await call(cfg, "POST", "/wake", { ...(cfg.mac ? { mac: cfg.mac } : {}), ...(cfg.broadcast ? { broadcast: cfg.broadcast } : {}) });
      setPhase("waiting");
      const until = Date.now() + WAIT_MS;
      while (alive.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await pcStatus(cfg).catch(() => undefined);
        if (s?.pc === "online") {
          void revive();
          if (alive.current) setPhase("awake");
          // если связь и так была (будили из настроек), экран не сменится — вернуть кнопку в обычный вид
          setTimeout(() => alive.current && setPhase("idle"), 5000);
          return;
        }
      }
      if (alive.current) {
        setPhase("error");
        setError(t("ПК так и не ответил за 2,5 минуты. Возможно, он выключен из розетки или не спит, а завис.", "The PC didn't answer in 2.5 minutes. It may be unplugged, or hung instead of sleeping."));
      }
    } catch (e) {
      if (!alive.current) return;
      setPhase("error");
      setError((e as Error).message);
    }
  };

  return { available: !!cfg, phase, error, wake };
}

export const wakeLabel = (p: WakePhase): string =>
  ({
    idle: "",
    sending: t("Отправляю сигнал…", "Sending the signal…"),
    waiting: t("Сигнал отправлен, ПК просыпается (обычно 10–30 с)…", "Signal sent, the PC is waking up (usually 10–30 s)…"),
    awake: t("ПК проснулся, подключаюсь…", "The PC is awake, connecting…"),
    error: "",
  })[p];
