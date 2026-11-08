import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDelta, applyEvent, emptyView, type SessionInfo, type StoredEvent } from "../src/index.ts";

const info: SessionInfo = {
  id: "s1", engine: "opencode", directory: "C:\\p", title: "t",
  model: { providerId: "p", modelId: "m" }, permissionMode: "acceptEdits",
  status: "idle", createdAt: 1, updatedAt: 1, lastSeq: 0,
};
const ev = (seq: number, event: StoredEvent["event"]): StoredEvent => ({ seq, sessionId: "s1", ts: seq, event });

test("сообщения, части и дельты собираются в состояние", () => {
  const v = emptyView(info);
  applyEvent(v, ev(1, { type: "message.upserted", message: { id: "m1", role: "assistant", createdAt: 10 } }));
  applyEvent(v, ev(2, { type: "part.upserted", messageId: "m1", part: { type: "text", id: "p1", text: "" } }));
  applyDelta(v, { messageId: "m1", partId: "p1", field: "text", delta: "При" });
  applyDelta(v, { messageId: "m1", partId: "p1", field: "text", delta: "вет" });
  assert.deepEqual(v.messages[0]?.parts[0], { type: "text", id: "p1", text: "Привет" });
  // финальный upsert перезаписывает накопленный текст
  applyEvent(v, ev(3, { type: "part.upserted", messageId: "m1", part: { type: "text", id: "p1", text: "Привет!" } }));
  assert.equal((v.messages[0]?.parts[0] as { text: string }).text, "Привет!");
  assert.equal(v.lastSeq, 3);
  assert.equal(v.info?.lastSeq, 3);
});

test("повторное событие с тем же seq игнорируется", () => {
  const v = emptyView(info);
  const e = ev(1, { type: "error", message: "x" });
  applyEvent(v, e);
  applyEvent(v, e);
  assert.equal(v.errors.length, 1);
});

test("ошибка хода снимается следующим сообщением пользователя (лимит кончился → «Продолжай»)", () => {
  const v = emptyView(info);
  applyEvent(v, ev(1, { type: "message.upserted", message: { id: "a1", role: "assistant", createdAt: 10 } }));
  applyEvent(v, ev(2, { type: "error", message: "You've hit your session limit" }));
  // повторный upsert ответа ассистента ошибку не трогает
  applyEvent(v, ev(3, { type: "message.upserted", message: { id: "a1", role: "assistant", createdAt: 10 } }));
  assert.deepEqual(v.errors, ["You've hit your session limit"]);
  applyEvent(v, ev(4, { type: "message.upserted", message: { id: "u2", role: "user", createdAt: 20 } }));
  assert.deepEqual(v.errors, []);
});

test("permission: asked → resolved", () => {
  const v = emptyView(info);
  applyEvent(v, ev(1, { type: "permission.asked", request: { id: "r1", tool: "bash", title: "echo hi", canAlways: true } }));
  assert.equal(v.permissions.length, 1);
  applyEvent(v, ev(2, { type: "permission.resolved", id: "r1", reply: "once" }));
  assert.equal(v.permissions.length, 0);
});

test("session.updated патчит info, сообщения сортируются по времени", () => {
  const v = emptyView(info);
  applyEvent(v, ev(1, { type: "message.upserted", message: { id: "b", role: "assistant", createdAt: 20 } }));
  applyEvent(v, ev(2, { type: "message.upserted", message: { id: "a", role: "user", createdAt: 10 } }));
  applyEvent(v, ev(3, { type: "session.updated", patch: { status: "busy", title: "Новая" } }));
  assert.deepEqual(v.messages.map((m) => m.info.id), ["a", "b"]);
  assert.equal(v.info?.status, "busy");
  assert.equal(v.info?.title, "Новая");
});

test("вопрос агента: появляется и снимается ответом, повтор не дублирует", () => {
  const v = emptyView(info);
  const request = { id: "q1", questions: [{ question: "Какой цвет?", options: [{ label: "Красный" }, { label: "Синий" }] }] };
  applyEvent(v, ev(1, { type: "question.asked", request }));
  applyEvent(v, ev(2, { type: "question.asked", request }));
  assert.equal(v.questions.length, 1);
  applyEvent(v, ev(3, { type: "question.resolved", id: "q1", answers: [["Синий"]] }));
  assert.equal(v.questions.length, 0);
});
