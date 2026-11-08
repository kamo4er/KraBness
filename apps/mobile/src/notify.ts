// Откуда приходят уведомления: Firebase (пуши, работают и при выгруженном приложении)
// или «из приложения» — хаб присылает их по WebSocket, приложение показывает само. Второе не требует
// своего проекта Firebase, но работает, пока приложение на связи (вместе с «Держать связь в фоне»).
import { useEffect, useState } from "react";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import type { HubNotice } from "@kamharn/client";
import { client, recall, remember, useConn } from "./store.ts";
import { PERMISSION_CATEGORY, registerPush, setupNotifications } from "./push.ts";

export type NotifyMode = "fcm" | "app";
const KEY = "notify.mode";
const listeners = new Set<() => void>();

/** Firebase есть в сборке (публичный APK — без него, см. app.config.js) */
export const firebaseBuilt: boolean = Constants.expoConfig?.extra?.firebase !== false;

export const notifyMode = (): NotifyMode => (firebaseBuilt ? (recall<NotifyMode>(KEY) ?? "fcm") : "app");
/** способ выбран пользователем явно (иначе — Firebase, а если его нет в сборке, сами переключимся) */
const explicit = () => recall<NotifyMode>(KEY) !== undefined;

export async function setNotifyMode(m: NotifyMode): Promise<void> {
  remember(KEY, m);
  for (const l of listeners) l();
  if (m === "app") {
    // Firebase этому телефону больше не шлём — иначе каждое уведомление придёт дважды
    await client?.api("POST", "/api/devices/me/push", { token: null }).catch(() => {});
    await setupNotifications();
    await Notifications.requestPermissionsAsync().catch(() => {});
  } else {
    await registerPush();
  }
}

export function useNotifyMode(): NotifyMode {
  const [m, setM] = useState(notifyMode);
  useEffect(() => {
    const l = () => setM(notifyMode());
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return m;
}

/** Регистрация пушей с учётом выбора; сборка без Firebase — сразу «из приложения». */
export async function registerNotifications(): Promise<void> {
  if (notifyMode() === "app") return void (await setNotifyMode("app"));
  let r: Awaited<ReturnType<typeof registerPush>> | "nofirebase";
  try {
    r = await registerPush();
  } catch {
    r = "nofirebase";
  }
  // в сборке нет Firebase или у хаба нет ключа (пуши ему слать нечем) — уведомления «из приложения»
  if (r === "nofirebase" || r === "hubnopush") {
    if (!explicit()) await setNotifyMode("app");
  }
}

async function show(n: HubNotice): Promise<void> {
  await setupNotifications();
  await Notifications.scheduleNotificationAsync({
    // тот же тег — заменяет предыдущее уведомление (как collapse_key у FCM)
    ...(n.tag ? { identifier: n.tag } : {}),
    content: {
      title: n.title,
      body: n.message,
      data: { kind: n.kind, sessionId: n.sessionId, ...(n.requestId ? { requestId: n.requestId } : {}) },
      ...(n.kind === "permission" ? { categoryIdentifier: PERMISSION_CATEGORY } : {}),
    },
    trigger: { channelId: "kamharn" },
  });
}

/** В корне приложения: в режиме «из приложения» показываем уведомления хаба сами (на экране их глушит обработчик). */
export function useLocalNotices(): void {
  const mode = useNotifyMode();
  const conn = useConn();
  useEffect(() => {
    if (mode !== "app" || !client) return;
    return client.onNotice((n) => void show(n).catch(() => {}));
  }, [mode, conn?.token]);
}
