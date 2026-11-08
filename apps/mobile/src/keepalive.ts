// «Держать связь в фоне»: фоновый сервис с постоянным уведомлением, чтобы Android не замораживал приложение
// и соединение с хабом не рвалось, когда приложение свёрнуто. Включается переключателем в настройках.
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { KeepAlive } from "../modules/kamharn-keepalive/index.ts";
import { recall, remember, useConn, useHub } from "./store.ts";
import { t } from "@kamharn/client";

const KEY = "keepalive";
const listeners = new Set<() => void>();

export const keepAliveOn = (): boolean => recall<boolean>(KEY) ?? false;

export function setKeepAlive(on: boolean): void {
  remember(KEY, on);
  if (!on) safe(() => KeepAlive.stop());
  for (const l of listeners) l();
}

export function useKeepAliveSetting(): boolean {
  const [on, setOn] = useState(keepAliveOn);
  useEffect(() => {
    const l = () => setOn(keepAliveOn());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return on;
}

function safe(f: () => void): void {
  try {
    f();
  } catch (e) {
    console.warn("[kamharn] keepalive", e);
  }
}

/** В корне приложения: сервис работает, пока переключатель включён и есть подключение к хабу. */
export function useKeepAlive(): void {
  const on = useKeepAliveSetting();
  const conn = useConn();
  const state = useHub();
  const busy = state.sessions.filter((s) => s.status === "busy" || s.status === "retry").length;
  const text = state.conn !== "online" ? t("переподключаюсь…", "reconnecting…") : busy ? t(`агентов в работе: ${busy}`, `agents running: ${busy}`) : t("держу связь с ПК", "connected to the PC");
  const title = t("KraBness на связи", "KraBness is connected");
  const channel = t("Связь с ПК в фоне", "PC connection in background");

  useEffect(() => {
    if (!on || !conn) return safe(() => KeepAlive.stop());
    // запускать сервис можно, только пока приложение на экране; из фона — лишь обновить текст
    if (AppState.currentState === "active") safe(() => KeepAlive.start(text, title, channel));
    else safe(() => KeepAlive.update(text, title, channel));
  }, [on, conn?.token, text, title]);

  // выключили, пока приложение было свёрнуто, или сервис убила система — поднимаем при возвращении
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active" && keepAliveOn() && conn && !KeepAlive.isRunning()) safe(() => KeepAlive.start(text, title, channel));
    });
    return () => sub.remove();
  }, [conn?.token, text, title]);
}
