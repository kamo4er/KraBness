// Движок opencode для мозга Диспетчера. Фикстура opencode-mcp-permission.jsonl — настоящий поток (Kimi, opencode 1.19.3, windows_Type):
// сначала pending с пустыми аргументами, потом вопрос, и только потом running с аргументами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PartDelta, SessionEvent } from "@kamharn/protocol";
import { callTitle, OpencodeEngine } from "../../src/engines/opencode.ts";

const raw = readFileSync(join(import.meta.dirname, "../fixtures/opencode-mcp-permission.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Record<string, any>);
const sid: string = raw[0]!.properties.sessionID;

function engine(opts: { noAlways?: (esid: string) => boolean } = {}) {
  const events: SessionEvent[] = [];
  const e = new OpencodeEngine({ port: 0, ...opts });
  (e as any).sink = { event: (_s: string, ev: SessionEvent) => events.push(ev), delta: (_s: string, _d: PartDelta) => {} };
  e.attach(sid, { directory: "C:\\work\\Dispatcher", permissionMode: "acceptEdits" });
  return { e, events };
}
const cards = (events: SessionEvent[]) => events.flatMap((x) => (x.type === "permission.asked" ? [x.request] : []));

test("настоящий поток: карточка ждёт аргументы и показывает, что будет напечатано", () => {
  const { e, events } = engine({ noAlways: () => true });
  e.handle(raw[0]!);
  e.handle(raw[1]!);
  assert.equal(cards(events).length, 0, "вопрос пришёл раньше аргументов: без них карточка бессмысленна");
  e.handle(raw[2]!);
  const c = cards(events);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.tool, "windows_Type");
  assert.equal(c[0]!.title, "проверка");
  assert.deepEqual((c[0]!.detail as { input: { text: string } }).input.text, "проверка");
  assert.equal(c[0]!.canAlways, false, "у Диспетчера «всегда» нет");
  for (const x of raw.slice(3)) e.handle(x);
  assert.ok(events.some((x) => x.type === "permission.resolved"));
  assert.equal(cards(events).length, 1, "карточка одна");
  e.forget(sid);
});

test("аргументы не пришли: карточка всё равно показывается, ход не висит", async () => {
  const { e, events } = engine();
  e.handle(raw[1]!);
  await new Promise((r) => setTimeout(r, 1600));
  const c = cards(events);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.title, "windows_Type");
  assert.equal(c[0]!.canAlways, true, "у обычной сессии как было");
  e.forget(sid);
});

test("обычные разрешения не ждут: команда видна сразу", () => {
  const { e, events } = engine();
  e.handle({ type: "permission.asked", properties: { id: "p1", sessionID: sid, permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" }, always: ["npm *"], tool: { messageID: "m", callID: "c" } } });
  assert.equal(cards(events)[0]!.title, "npm test");
});

test("заголовок карточки: главное поле, Enter виден, пустые аргументы — ничего", () => {
  assert.equal(callTitle({ text: "привет", loc: [1, 2] }), "привет");
  assert.equal(callTitle({ text: "заказ", press_enter: true }), "заказ ⏎");
  assert.equal(callTitle({ shortcut: "alt+f4" }), "alt+f4");
  assert.equal(callTitle({ mode: "launch", name: "notepad" }), "notepad");
  assert.equal(callTitle({ mode: "read" }), '{"mode":"read"}');
  assert.equal(callTitle({}), "");
  assert.equal(callTitle(undefined), "");
});

test("скрытый повтор: сообщения пользователя нет в ленте, ответ есть; следующее сообщение снова видно", async () => {
  const { e, events } = engine();
  const sent: Array<Record<string, any>> = [];
  (e as any).req = async (_m: string, _p: string, body: Record<string, any>) => void sent.push(body);
  await e.prompt(sid, { text: "открой сайт", files: [], model: { providerId: "kimi", modelId: "k3" }, hidden: "сводка", hideUser: true });
  assert.deepEqual(sent[0]!.parts, [{ type: "text", text: "сводка", synthetic: true }, { type: "text", text: "открой сайт" }]);
  const msg = (id: string, role: string) => ({ type: "message.updated", properties: { sessionID: sid, info: { id, role, sessionID: sid, time: { created: 1 } } } });
  const part = (id: string, messageID: string, text: string, synthetic = false) => ({ type: "message.part.updated", properties: { sessionID: sid, part: { id, messageID, sessionID: sid, type: "text", text, ...(synthetic ? { synthetic } : {}) } } });
  e.handle(msg("u1", "user"));
  e.handle(part("p0", "u1", "сводка", true));
  e.handle(part("p1", "u1", "открой сайт"));
  e.handle(msg("a1", "assistant"));
  e.handle(part("p2", "a1", "открыл"));
  e.handle(msg("u2", "user"));
  e.handle(part("p3", "u2", "ещё"));
  const shown = events.flatMap((x) => (x.type === "part.upserted" && x.part.type === "text" ? [x.part.text] : []));
  assert.deepEqual(shown, ["открыл", "ещё"]);
  assert.ok(!events.some((x) => x.type === "message.upserted" && x.message.id === "u1"));
  // скрытая часть без повтора: сообщение видно, сводка нет
  await e.prompt(sid, { text: "обычное", files: [], model: { providerId: "kimi", modelId: "k3" }, hidden: "сводка2" });
  e.handle(msg("u3", "user"));
  e.handle(part("p4", "u3", "сводка2", true));
  e.handle(part("p5", "u3", "обычное"));
  assert.deepEqual(events.flatMap((x) => (x.type === "part.upserted" && x.part.type === "text" ? [x.part.text] : [])), ["открыл", "ещё", "обычное"]);
});

test("размер контекста: по последнему ответу; после пересказа только сам пересказ, иначе сжатие крутилось бы по кругу", () => {
  const { e } = engine();
  assert.equal(e.contextTokens(sid), undefined);
  const done = (id: string, tokens: Record<string, unknown>, summary?: boolean) => ({ type: "message.updated", properties: { sessionID: sid, info: { id, role: "assistant", sessionID: sid, providerID: "kimi", modelID: "k3", time: { created: 1, completed: 2 }, tokens, cost: 0, ...(summary ? { summary: true } : {}) } } });
  e.handle(done("a1", { input: 300, output: 50, reasoning: 0, cache: { read: 120_000, write: 700 } }));
  assert.equal(e.contextTokens(sid), 121_000);
  e.handle(done("a2", { input: 121_000, output: 2_000, reasoning: 0, cache: { read: 0, write: 0 } }, true));
  assert.equal(e.contextTokens(sid), 2_000);
});

test("зрение модели берётся из возможностей opencode", async () => {
  const e = new OpencodeEngine({ port: 0 });
  (e as any).req = async (_m: string, p: string) =>
    p === "/provider"
      ? { connected: ["k"], all: [{ id: "k", models: { a: { id: "a", capabilities: { toolcall: true, input: { image: true } } }, b: { id: "b", capabilities: { toolcall: true, input: { image: false } } } } }] }
      : {};
  const info = await e.info();
  assert.equal(info.models.find((m) => m.modelId === "a")!.vision, true);
  assert.equal(info.models.find((m) => m.modelId === "b")!.vision, undefined);
});
