// Вопросы агента: AskUserQuestion у claude и инструмент question у opencode (записано с живых движков).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { OpencodeEngine } from "../../src/engines/opencode.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures", name), "utf8"));

function claude() {
  const events: SessionEvent[] = [];
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  (engine as any).sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  engine.attach("cs1", { directory: "C:\\work", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "auto", hasHistory: true });
  return { engine, events };
}

test("claude: AskUserQuestion → question.asked, ответ уходит в updatedInput.answers в формате SDK", async () => {
  const { input } = fixture("claude-ask-input.json");
  const { engine, events } = claude();
  const decision = engine.answerQuestion("cs1", input);
  await new Promise((r) => setImmediate(r));
  const asked = events.find((e) => e.type === "question.asked");
  assert.ok(asked && asked.type === "question.asked");
  const q = asked.request.questions[0]!;
  assert.equal(q.question, "Какой цвет ты предпочитаешь?");
  assert.deepEqual(q.options.map((o) => o.label), ["Красный", "Синий"]);
  assert.equal(q.multiple, false);
  assert.equal(q.custom, true);

  // режим auto не должен «одобрить» вопрос сам
  await engine.setPermissionMode("cs1", "auto");
  await engine.replyQuestion("cs1", asked.request.id, [["Синий"]]);
  const d = await decision;
  assert.equal(d.behavior, "allow");
  assert.deepEqual(d.updatedInput.answers, { "Какой цвет ты предпочитаешь?": "Синий" });
  assert.deepEqual(d.updatedInput.questions, input.questions, "исходные вопросы сохранены");
  assert.deepEqual(events.at(-1), { type: "question.resolved", id: asked.request.id, answers: [["Синий"]] });
});

test("claude: несколько вариантов — через запятую; отказ — deny; смерть процесса снимает вопрос", async () => {
  const { engine } = claude();
  const multi = { questions: [{ question: "Что взять?", header: "Фрукты", multiSelect: true, options: [{ label: "Арбуз" }, { label: "Киви" }] }] };
  const d1 = engine.answerQuestion("cs1", multi);
  await new Promise((r) => setImmediate(r));
  const id1 = [...(engine as any).sessions.get("cs1").questions.keys()][0];
  await engine.replyQuestion("cs1", id1, [["Арбуз", "Киви"]]);
  assert.deepEqual((await d1).updatedInput.answers, { "Что взять?": "Арбуз, Киви" });

  const d2 = engine.answerQuestion("cs1", multi);
  await new Promise((r) => setImmediate(r));
  const id2 = [...(engine as any).sessions.get("cs1").questions.keys()][0];
  await engine.replyQuestion("cs1", id2, null);
  assert.equal((await d2).behavior, "deny");

  const d3 = engine.answerQuestion("cs1", multi);
  await new Promise((r) => setImmediate(r));
  (engine as any).rejectPending((engine as any).sessions.get("cs1"));
  assert.equal((await d3).behavior, "deny");
});

test("opencode: question.asked / question.replied из реального потока", async () => {
  const { sid, events: raw } = fixture("opencode-question.json");
  const events: SessionEvent[] = [];
  const engine = new OpencodeEngine({ port: 0 });
  (engine as any).sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  const calls: Array<[string, string, unknown]> = [];
  (engine as any).req = async (method: string, path: string, body: unknown) => (calls.push([method, path, body]), true);
  engine.attach(sid, { directory: "C:\\work", permissionMode: "acceptEdits" });

  engine.handle(raw[0]);
  const asked = events.find((e) => e.type === "question.asked");
  assert.ok(asked && asked.type === "question.asked");
  assert.match(asked.request.id, /^que_/);
  assert.deepEqual(asked.request.questions[0]!.options.map((o) => o.label), ["Красный", "Синий"]);

  await engine.replyQuestion(sid, asked.request.id, [["Синий"]]);
  await engine.replyQuestion(sid, asked.request.id, null);
  assert.deepEqual(calls, [
    ["POST", `/question/${asked.request.id}/reply`, { answers: [["Синий"]] }],
    ["POST", `/question/${asked.request.id}/reject`, {}],
  ]);

  engine.handle(raw[1]);
  assert.deepEqual(events.at(-1), { type: "question.resolved", id: asked.request.id, answers: [["Синий"]] });
});
