// Пуши через FCM: токен устройства регистрируется в хабе, хаб шлёт data-сообщения, expo-notifications их показывает.
// Кнопки «Разрешить/Отклонить» отвечают хабу из фоновой задачи — приложение не открывается.
// Модуль импортируется первым в index.ts: фоновая задача должна быть объявлена при любом запуске бандла.
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { HubClient, type PermissionReply, t, onLangChange } from "@kamharn/client";
import { client, loadConnection, pickUrl, recall } from "./store.ts";

const TASK = "kamharn-notification";
const CHANNEL = "kamharn";
export const PERMISSION_CATEGORY = "permission";

interface PushData {
  kind?: "permission" | "question" | "done" | "error";
  sessionId?: string;
  requestId?: string;
}

// В фоновую задачу по кнопке expo отдаёт сырой content: данные лежат строкой в dataString, data нет
// (слушатели получают уже разобранное — mapNotificationContent в expo-notifications).
const dataOf = (n: Notifications.Notification): PushData => {
  const c = n.request.content as Notifications.NotificationContent & { dataString?: string };
  if (c.data) return c.data as PushData;
  try {
    return typeof c.dataString === "string" ? (JSON.parse(c.dataString) as PushData) : {};
  } catch {
    return {};
  }
};

/** Ответ на запрос подтверждения прямо из уведомления (в фоне: приложение может быть закрыто). */
async function answerFromNotification(data: PushData, reply: PermissionReply): Promise<void> {
  if (!data.sessionId || !data.requestId) return;
  let c = client;
  if (!c) {
    const conn = loadConnection();
    if (!conn) return;
    c = new HubClient(conn.url ?? conn.urls[0]!, conn.token);
  }
  try {
    await c.reply(data.sessionId, data.requestId, reply);
  } catch {
    // последний адрес мог смениться (Wi-Fi → LTE) — ищем рабочий и пробуем ещё раз
    const conn = loadConnection();
    const url = conn && (await pickUrl(conn.urls, conn.url));
    if (!url || !conn) return;
    await new HubClient(url, conn.token).reply(data.sessionId, data.requestId, reply);
  }
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data }) => {
  if (!data || !("actionIdentifier" in data)) return;
  const action = data.actionIdentifier;
  if (action !== "once" && action !== "reject") return;
  try {
    await answerFromNotification(dataOf(data.notification), action);
  } finally {
    await Notifications.dismissNotificationAsync(data.notification.request.identifier).catch(() => {});
  }
});

let configured = false;

/** кнопки «Разрешить / Отклонить» в уведомлении о подтверждении — на языке интерфейса */
const setCategories = () =>
  Notifications.setNotificationCategoryAsync(PERMISSION_CATEGORY, [
    { identifier: "once", buttonTitle: t("Разрешить", "Allow"), options: { opensAppToForeground: false } },
    { identifier: "reject", buttonTitle: t("Отклонить", "Deny"), options: { opensAppToForeground: false } },
  ]);

/** Канал, кнопки, поведение на экране и фоновая задача — один раз при старте. */
export async function setupNotifications(): Promise<void> {
  if (configured || Platform.OS !== "android") return;
  configured = true;
  // приложение на экране — всё и так видно в UI, баннер не нужен
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
  });
  await Notifications.setNotificationChannelAsync(CHANNEL, { name: "KraBness", importance: Notifications.AndroidImportance.HIGH });
  await setCategories();
  // сменили язык — подписи кнопок в уведомлениях тоже
  onLangChange(() => void setCategories().catch(() => {}));
  await Notifications.registerTaskAsync(TASK).catch(() => {});
}

/** Разрешение на уведомления и FCM-токен → хаб. Вызывать, когда есть связь. */
/** ok — токен у хаба; hubnopush — у хаба нет ключа Firebase; skipped — нет связи или разрешения. Без Firebase в сборке бросает. */
export async function registerPush(): Promise<"ok" | "hubnopush" | "skipped"> {
  if (!client || Platform.OS !== "android") return "skipped";
  await setupNotifications();
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return "skipped";
  const { data: token } = await Notifications.getDevicePushTokenAsync();
  const r = await client.api<{ push?: boolean }>("POST", "/api/devices/me/push", { token });
  return r.push === false ? "hubnopush" : "ok";
}

/** Токен FCM сменился — сообщаем хабу. */
export function watchPushToken(): () => void {
  // в режиме «уведомления из приложения» Firebase не используем — новый токен хабу не отдаём
  const sub = Notifications.addPushTokenListener(({ data }) => {
    if (recall("notify.mode") === "app") return;
    void client?.api("POST", "/api/devices/me/push", { token: data }).catch(() => {});
  });
  return () => sub.remove();
}

/** Нажали на уведомление (не на кнопку) — открыть сессию. */
export function onNotificationOpen(open: (sessionId: string) => void): () => void {
  const handle = (r: Notifications.NotificationResponse | null) => {
    if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = dataOf(r.notification).sessionId;
    if (id) open(id);
  };
  // холодный старт по нажатию на уведомление
  void Notifications.getLastNotificationResponseAsync().then(handle);
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => sub.remove();
}
