// Какие события сессий становятся уведомлениями. В уведомление — только короткий текст (без кода и файлов).
// Каналы: FCM-пуши, приложения по WebSocket (без Firebase), Telegram-бот.
import type { HubNotice, StoredEvent } from "@kamharn/protocol";
import type { Db } from "./db.ts";
import type { PushMessage, PushSender } from "./push.ts";
import { isLimitError } from "./autoresume.ts";
import { L } from "./lang.ts";

const clip = (s: string, n: number) => {
  const t = s.replace(/```[\s\S]*?(```|$)/g, " ").replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

export class Notifier {
  private roles = new Map<string, "user" | "assistant">();
  /** последний текст ассистента по сессии — для «готово: …» */
  private lastText = new Map<string, string>();
  private busy = new Set<string>();
  private channels = new Set<(n: HubNotice) => void>();

  constructor(
    private db: Db,
    private sender: Pick<PushSender, "enabled" | "send">,
    /** пользователь в веб-UI — всё видит там, телефон не дёргаем */
    private presence?: { readonly active: boolean },
    /** у сессии включена автопроверка — обычное «готово» молчит, итог присылает она (checks.ts) */
    private quietDone?: (sessionId: string) => boolean,
  ) {}

  /** Вызывается на каждое событие журнала. */
  onEvent(e: StoredEvent): void {
    const ev = e.event;
    const sid = e.sessionId;
    switch (ev.type) {
      case "message.upserted":
        this.roles.set(ev.message.id, ev.message.role);
        break;
      case "part.upserted":
        if (ev.part.type === "text" && ev.part.text && this.roles.get(ev.messageId) === "assistant") this.lastText.set(sid, ev.part.text);
        break;
      case "permission.asked":
        void this.push(sid, {
          message: `${L("Нужно подтверждение", "Approval needed")}: ${ev.request.tool} · ${clip(ev.request.title, 140)}`,
          categoryId: "permission",
          data: { kind: "permission", sessionId: sid, requestId: ev.request.id },
          tag: `perm-${ev.request.id}`,
        });
        break;
      case "question.asked":
        void this.push(sid, {
          message: `${L("Агент спрашивает", "The agent asks")}: ${clip(ev.request.questions[0]?.question ?? "", 140)}`,
          data: { kind: "question", sessionId: sid },
          tag: `q-${ev.request.id}`,
        });
        break;
      case "error":
        // про лимит пушим отдельно, когда хаб назначит автопродолжение (session.updated resumeAt)
        if (isLimitError(ev.message)) {
          this.busy.delete(sid);
          break;
        }
        void this.push(sid, { message: `${L("Ошибка", "Error")}: ${clip(ev.message, 140)}`, data: { kind: "error", sessionId: sid } });
        break;
      case "session.updated":
        if (ev.patch.resumeAt) {
          const at = new Date(ev.patch.resumeAt).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
          void this.push(sid, { message: L(`Упёрлись в лимит Claude — продолжу сам в ${at}`, `Hit the Claude limit — I'll continue by myself at ${at}`), data: { kind: "done", sessionId: sid }, tag: `done-${sid}` });
        }
        if (ev.patch.status === "busy") this.busy.add(sid);
        if (ev.patch.status === "idle" && this.busy.delete(sid) && !this.quietDone?.(sid)) {
          const text = this.lastText.get(sid);
          void this.push(sid, { message: text ? `${L("Готово", "Done")}: ${clip(text.split("\n").find((l) => l.trim()) ?? text, 120)}` : L("Готово", "Done"), data: { kind: "done", sessionId: sid }, tag: `done-${sid}` });
        }
        break;
    }
  }

  /** Произвольное уведомление по сессии (например, автопродолжение после лимита). */
  notify(sessionId: string, message: string): void {
    void this.push(sessionId, { message, data: { kind: "done", sessionId } });
  }

  /** Другие каналы доставки (приложения по WebSocket, Telegram). Возвращает отписку. */
  subscribe(channel: (n: HubNotice) => void): () => void {
    this.channels.add(channel);
    return () => void this.channels.delete(channel);
  }

  private async push(sessionId: string, m: Omit<PushMessage, "title">): Promise<void> {
    if (this.presence?.active) return;
    const title = this.db.getSession(sessionId)?.title ?? "KraBness";
    const notice: HubNotice = {
      sessionId,
      title,
      message: m.message,
      kind: (m.data.kind as HubNotice["kind"]) ?? "done",
      ...(m.data.requestId ? { requestId: m.data.requestId } : {}),
      ...(m.tag ? { tag: m.tag } : {}),
    };
    for (const ch of this.channels) {
      try {
        ch(notice);
      } catch {
        // упавший канал не мешает остальным
      }
    }
    if (!this.sender.enabled) return;
    for (const d of this.db.listDevices()) {
      if (!d.fcmToken) continue;
      const r = await this.sender.send(d.fcmToken, { ...m, title });
      // приложение удалили или токен сменился — больше не шлём
      if (r === "unregistered") this.db.setFcmToken(d.id, null);
    }
  }
}
