// Сборка состояния сессии из потока событий. Один и тот же код у веб-UI и мобилки,
// поэтому оба клиента видят одинаковую картину.
import type { MessageInfo, Part, PartDelta, PermissionRequest, QuestionRequest, SessionInfo, StoredEvent } from "./index.ts";

export interface MessageView {
  info: MessageInfo;
  parts: Part[];
}

export interface SessionView {
  info?: SessionInfo;
  messages: MessageView[];
  /** ожидающие ответа запросы разрешений */
  permissions: PermissionRequest[];
  /** вопросы агента, ждущие ответа */
  questions: QuestionRequest[];
  errors: string[];
  lastSeq: number;
}

export function emptyView(info?: SessionInfo): SessionView {
  return { info, messages: [], permissions: [], questions: [], errors: [], lastSeq: 0 };
}

function findMessage(view: SessionView, id: string): MessageView | undefined {
  return view.messages.find((m) => m.info.id === id);
}

function ensureMessage(view: SessionView, id: string): MessageView {
  let msg = findMessage(view, id);
  if (!msg) {
    // часть может прийти раньше сообщения — создаём заглушку
    msg = { info: { id, role: "assistant", createdAt: 0 }, parts: [] };
    view.messages.push(msg);
  }
  return msg;
}

export function upsertPart(view: SessionView, messageId: string, part: Part): void {
  const msg = ensureMessage(view, messageId);
  const i = msg.parts.findIndex((p) => p.id === part.id);
  if (i >= 0) msg.parts[i] = part;
  else msg.parts.push(part);
}

/** Применяет сохранённое событие. Повторное применение события с seq <= lastSeq игнорируется. */
export function applyEvent(view: SessionView, stored: StoredEvent): SessionView {
  if (stored.seq <= view.lastSeq) return view;
  const ev = stored.event;
  switch (ev.type) {
    case "session.updated":
      if (view.info) view.info = { ...view.info, ...ev.patch, updatedAt: stored.ts };
      break;
    case "message.upserted": {
      const msg = findMessage(view, ev.message.id);
      if (msg) msg.info = ev.message;
      else {
        view.messages.push({ info: ev.message, parts: [] });
        // ошибки относятся к своему ходу: новое сообщение пользователя — новый ход, старые плашки убираем
        if (ev.message.role === "user") view.errors = [];
      }
      view.messages.sort((a, b) => a.info.createdAt - b.info.createdAt);
      break;
    }
    case "part.upserted":
      upsertPart(view, ev.messageId, ev.part);
      break;
    case "permission.asked":
      if (!view.permissions.some((p) => p.id === ev.request.id)) view.permissions.push(ev.request);
      break;
    case "permission.resolved":
      view.permissions = view.permissions.filter((p) => p.id !== ev.id);
      break;
    case "question.asked":
      if (!view.questions.some((q) => q.id === ev.request.id)) view.questions.push(ev.request);
      break;
    case "question.resolved":
      view.questions = view.questions.filter((q) => q.id !== ev.id);
      break;
    case "error":
      view.errors.push(ev.message);
      break;
  }
  view.lastSeq = stored.seq;
  if (view.info) view.info = { ...view.info, lastSeq: stored.seq };
  return view;
}

export function applyDelta(view: SessionView, d: PartDelta): SessionView {
  const msg = ensureMessage(view, d.messageId);
  const part = msg.parts.find((p) => p.id === d.partId);
  if (part && (part.type === "text" || part.type === "reasoning")) {
    part.text += d.delta;
  } else if (!part) {
    // дельта раньше part.upserted: считаем это текстом
    msg.parts.push({ type: "text", id: d.partId, text: d.delta });
  }
  return view;
}
