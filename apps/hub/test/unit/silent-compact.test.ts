// Тихое сжатие Диспетчера: в журнале только отметка и пересказ, без реплики и статуса, иначе сработают пуш и озвучка.
// Размер контекста — по последнему вызову модели, а не из result (там сумма за ход).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineId, ModelRef, SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { Dispatcher, DISPATCHER_ENV } from "../../src/dispatcher.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

const haiku: ModelRef = { providerId: "anthropic", modelId: "claude-haiku-5-5" };

function engineWithFakeProc() {
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  const events: SessionEvent[] = [];
  const written: string[] = [];
  const e = engine as unknown as { sink: EngineSink; ensureProc: (s: { proc?: unknown }) => unknown };
  e.sink = { event: (_, ev) => void events.push(ev), delta: () => {} };
  e.ensureProc = (s) => (s.proc ??= { exitCode: null, stdin: { write: (l: string) => (written.push(l), true), end: () => {} } });
  engine.attach("s1", { directory: "C:\\work", model: haiku, permissionMode: "auto", hasHistory: true });
  const statuses = () => events.flatMap((x) => (x.type === "session.updated" && x.patch.status ? [x.patch.status] : []));
  const feed = (j: Record<string, unknown>) => engine.handle("s1", j);
  return { engine, events, written, statuses, feed };
}

const BOUNDARY = { type: "system", subtype: "compact_boundary", uuid: "b1", compact_metadata: { trigger: "manual", pre_tokens: 120000, post_tokens: 4200 } };
const RESULT = { type: "result", subtype: "success", result: "", uuid: "r1" };

test("тихое сжатие: ни реплики, ни статуса; отметка есть и помечена auto; указание уходит в /compact", async () => {
  const { engine, events, written, statuses, feed } = engineWithFakeProc();
  await engine.compact("s1", { model: haiku, silent: true, instructions: "сохрани поручения" });
  assert.equal(JSON.parse(written[0]!).message.content[0].text, "/compact сохрани поручения");
  feed(BOUNDARY);
  feed(RESULT);
  assert.deepEqual(statuses(), [], "статус не менялся");
  assert.ok(!events.some((x) => x.type === "message.upserted" && x.message.role === "user"), "реплики нет");
  const part = events.find((x) => x.type === "part.upserted" && x.part.type === "compaction");
  assert.ok(part && part.type === "part.upserted" && part.part.type === "compaction" && part.part.trigger === "auto");
  assert.equal(engine.contextTokens("s1"), 4200, "размер — из отметки");
});

test("обычное сжатие по кнопке осталось ходом: реплика и статусы", async () => {
  const { engine, events, statuses, feed } = engineWithFakeProc();
  await engine.compact("s1", { model: haiku });
  feed(BOUNDARY);
  feed(RESULT);
  assert.deepEqual(statuses(), ["busy", "idle"]);
  assert.ok(events.some((x) => x.type === "message.upserted" && x.message.role === "user"));
});

test("сообщение во время тихого сжатия: «работает» сразу, сжатие его не завершает, ход закрывает свой result", async () => {
  const { engine, statuses, feed, written } = engineWithFakeProc();
  await engine.compact("s1", { model: haiku, silent: true });
  await engine.prompt("s1", { text: "какое слово?", files: [], model: haiku });
  assert.equal(written.length, 2, "оба сообщения в stdin");
  assert.deepEqual(statuses(), ["busy"]);
  feed(BOUNDARY);
  feed(RESULT);
  assert.deepEqual(statuses(), ["busy"], "итог сжатия ход не закрывает");
  feed({ type: "result", subtype: "success", result: "ПЕЛИКАН", uuid: "r2" });
  assert.deepEqual(statuses(), ["busy", "idle"]);
});

test("ошибка тихого сжатия не попадает в журнал: лимит запустил бы автопродолжение", async () => {
  const { engine, events, statuses, feed } = engineWithFakeProc();
  await engine.compact("s1", { model: haiku, silent: true });
  feed({ type: "result", subtype: "error_during_execution", is_error: true, result: "You've hit your limit", uuid: "r1" });
  assert.ok(!events.some((x) => x.type === "error"));
  assert.deepEqual(statuses(), []);
  // следующий ход идёт как обычно
  await engine.prompt("s1", { text: "дальше", files: [], model: haiku });
  assert.deepEqual(statuses(), ["busy"]);
});

test("размер контекста: последний вызов; субагенты и нули не считаются; result не влияет", () => {
  const { engine, feed } = engineWithFakeProc();
  const a = (id: string, usage: unknown, extra: object = {}) => ({ type: "assistant", message: { id, model: "m", content: [], usage }, ...extra });
  feed(a("m1", { input_tokens: 3, cache_read_input_tokens: 100000, cache_creation_input_tokens: 500 }));
  assert.equal(engine.contextTokens("s1"), 100503);
  feed(a("m2", { input_tokens: 50000 }, { parent_tool_use_id: "toolu_1" }));
  assert.equal(engine.contextTokens("s1"), 100503, "субагент");
  feed(a("m3", { input_tokens: 0, output_tokens: 0 }));
  assert.equal(engine.contextTokens("s1"), 100503, "служебная реплика");
  // в result сумма по всем вызовам хода: по ней Диспетчер сжимался бы после каждого хода
  feed({ type: "result", subtype: "success", result: "", uuid: "r1", usage: { cache_read_input_tokens: 900000 } });
  assert.equal(engine.contextTokens("s1"), 100503);
});

test("окно автосжатия: только в окружении Диспетчера", () => {
  assert.ok(Number(DISPATCHER_ENV.CLAUDE_CODE_AUTO_COMPACT_WINDOW) > 200_000);
});

// ---------- когда Диспетчер сжимается сам ----------

async function dispatcherSetup(compactAt?: number) {
  const base = mkdtempSync(join(tmpdir(), "kh-silent-"));
  const root = join(base, "Projects");
  mkdirSync(root, { recursive: true });
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data"), artifactsHint: false, ...(compactAt !== undefined ? { dispatcher: { compactAt } } : {}) });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  let sink!: EngineSink;
  const compacts: Array<{ silent?: boolean; instructions?: string }> = [];
  const size = { tokens: 150_000 as number | undefined };
  const id: EngineId = "claude";
  const engine: Engine = {
    id,
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id, available: true, models: [], defaultModel: haiku }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
    compact: async (_, o) => void compacts.push({ ...(o.silent ? { silent: true } : {}), ...(o.instructions ? { instructions: o.instructions } : {}) }),
    contextTokens: () => size.tokens,
  };
  await sessions.addEngine(engine);
  const dispatcher = new Dispatcher({ sessions, config, compactPauseMs: 30 });
  const d = await dispatcher.ensure();
  const status = (s: "busy" | "idle") => sink.event("es1", { type: "session.updated", patch: { status: s } });
  return { dispatcher, sessions, compacts, size, status, sink: () => sink, id: d.id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("Диспетчер: большой контекст + пауза → тихое сжатие с указанием", async () => {
  const { dispatcher, compacts, status } = await dispatcherSetup();
  status("busy");
  status("idle");
  await sleep(80);
  assert.equal(compacts.length, 1);
  assert.equal(compacts[0]!.silent, true);
  assert.ok(compacts[0]!.instructions);
  dispatcher.close();
});

test("Диспетчер: заговорили в паузу — сжатия нет", async () => {
  const { dispatcher, compacts, status } = await dispatcherSetup();
  status("busy");
  status("idle");
  status("busy");
  await sleep(80);
  assert.equal(compacts.length, 0);
  dispatcher.close();
});

test("Диспетчер: контекст мал, размер неизвестен или сжатие выключено — не сжимается", async () => {
  const small = await dispatcherSetup();
  small.size.tokens = 99_000;
  small.status("busy");
  small.status("idle");
  await sleep(80);
  assert.equal(small.compacts.length, 0);
  small.size.tokens = undefined;
  small.status("busy");
  small.status("idle");
  await sleep(80);
  assert.equal(small.compacts.length, 0);
  small.dispatcher.close();

  const off = await dispatcherSetup(0);
  off.status("busy");
  off.status("idle");
  await sleep(80);
  assert.equal(off.compacts.length, 0);
  off.dispatcher.close();
});

test("Диспетчер: ждёт ответа на вопрос — не сжимается", async () => {
  const { dispatcher, compacts, status, sink } = await dispatcherSetup();
  status("busy");
  sink().event("es1", { type: "question.asked", request: { id: "q1", questions: [{ question: "Отправить?", options: [] }] } } as never);
  status("idle");
  await sleep(80);
  assert.equal(compacts.length, 0);
  dispatcher.close();
});
