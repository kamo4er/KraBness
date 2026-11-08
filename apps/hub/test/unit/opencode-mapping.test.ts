// Маппинг реального потока событий opencode (записан с 1.19.3) в протокол KamHarn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDelta, applyEvent, emptyView, type PartDelta, type SessionEvent } from "@kamharn/protocol";
import { OpencodeEngine } from "../../src/engines/opencode.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/opencode-v1-turn.json"), "utf8")) as {
  sid: string;
  events: Array<Record<string, any>>;
};

function run() {
  const events: SessionEvent[] = [];
  const deltas: PartDelta[] = [];
  const engine = new OpencodeEngine({ port: 0 });
  (engine as any).sink = {
    event: (_sid: string, ev: SessionEvent) => events.push(ev),
    delta: (_sid: string, d: PartDelta) => deltas.push(d),
  };
  engine.attach(fixture.sid, { directory: "C:\\work\\sandbox", permissionMode: "acceptEdits" });
  for (const e of fixture.events) engine.handle(e);
  return { events, deltas };
}

test("ход агента: сообщения, tool-вызовы, permission, статусы", () => {
  const { events, deltas } = run();
  const types = events.map((e) => e.type);
  assert.ok(types.includes("message.upserted"));
  assert.ok(types.includes("permission.asked"));
  assert.ok(types.includes("permission.resolved"));
  assert.ok(deltas.length > 10, "дельты текста дошли");

  const perm = events.find((e) => e.type === "permission.asked");
  assert.equal(perm?.type === "permission.asked" && perm.request.tool, "bash");
  assert.equal(perm?.type === "permission.asked" && perm.request.title, "echo hi");

  const tools = events.flatMap((e) => (e.type === "part.upserted" && e.part.type === "tool" ? [e.part] : []));
  const bashDone = tools.find((t) => t.type === "tool" && t.tool === "bash" && t.status === "completed");
  assert.ok(bashDone && bashDone.type === "tool" && bashDone.output?.includes("hi"));
  assert.ok(tools.some((t) => t.type === "tool" && t.tool === "read" && t.status === "completed"));

  // статус: busy → … → idle, без подряд идущих дублей
  const statuses = events.flatMap((e) => (e.type === "session.updated" && e.patch.status ? [e.patch.status] : []));
  assert.equal(statuses.at(-1), "idle");
  for (let i = 1; i < statuses.length; i++) assert.notEqual(statuses[i], statuses[i - 1]);
});

test("дубли opencode отсеиваются", () => {
  const { events } = run();
  const seen = new Set<string>();
  let prev = "";
  for (const e of events) {
    const j = JSON.stringify(e);
    if (e.type !== "session.updated") assert.notEqual(j, prev, "подряд одинаковых событий быть не должно");
    prev = j;
    seen.add(j);
  }
  assert.ok(events.length < fixture.events.length, "событий меньше, чем сырых");
});

test("редьюсер собирает из потока итоговый ответ", () => {
  const { events } = run();
  const view = emptyView();
  let seq = 0;
  // итоговые part.upserted содержат полный текст, поэтому дельты здесь не нужны
  for (const ev of events) applyEvent(view, { seq: ++seq, sessionId: "s", ts: seq, event: ev });
  assert.equal(view.permissions.length, 0, "запрос разрешения закрыт");
  const user = view.messages.find((m) => m.info.role === "user");
  assert.ok(user?.parts.some((p) => p.type === "text" && p.text.includes("README")));
  const lastAssistant = view.messages.filter((m) => m.info.role === "assistant").at(-1);
  const text = lastAssistant?.parts.find((p) => p.type === "text");
  assert.ok(text && text.type === "text" && text.text.length > 0, "финальный текст ассистента есть");
});

test("дельта до part.upserted не теряется", () => {
  const view = emptyView();
  applyDelta(view, { messageId: "m", partId: "p", field: "text", delta: "abc" });
  assert.equal(view.messages[0]?.parts[0]?.type, "text");
});

test("вложение пользователя: служебный текст скрыт, data:-файл узнаётся по отправленному", async () => {
  const events: SessionEvent[] = [];
  const engine = new OpencodeEngine({ port: 0 });
  (engine as any).sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  (engine as any).req = async () => ({});
  const sid = "ses_test";
  engine.attach(sid, { directory: "C:\\work\\sandbox", permissionMode: "acceptEdits" });
  const file = { fileId: "kf_abc", path: "C:\\work\\sandbox\\.kamharn\\inbox\\20261018-163135-upload-test.png", name: "upload-test.png", mime: "image/png", size: 52983 };
  await engine.prompt(sid, { text: "describe", files: [file], model: { providerId: "p", modelId: "m" } });
  // части записаны из реального потока opencode 1.19.3
  const part = (p: Record<string, unknown>) => ({ type: "message.part.updated", properties: { sessionID: sid, part: { sessionID: sid, messageID: "msg_u", ...p } } });
  engine.handle(part({ id: "prt_1", type: "text", text: "describe" }));
  engine.handle(part({ id: "prt_2", type: "text", synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"C:\\work"}' }));
  engine.handle(part({ id: "prt_3", type: "file", mime: "image/png", filename: "upload-test.png", url: "data:image/png;base64,iVBORw0KGgo=" }));
  const parts = events.flatMap((e) => (e.type === "part.upserted" ? [e.part] : []));
  assert.deepEqual(parts.map((p) => p.type), ["text", "file"]);
  assert.deepEqual(parts[1], { type: "file", id: "prt_3", fileId: "kf_abc", name: "upload-test.png", mime: "image/png", size: 52983 });
});
