// Расход токенов: стоимость по ценам сверена с суммой самого CLI (живой прогон Haiku 2026-10-27),
// разница накопительных modelUsage, сообщения opencode, история из транскрипта, отчёт за период и сигнал клиентам.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { OpencodeEngine } from "../../src/engines/opencode.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine } from "../../src/engines/types.ts";
import { claudeCost, claudeHistory, dayOf, opencodeRecord, usageReport, type UsageRecord } from "../../src/usage.ts";

const fixture = (f: string) => join(import.meta.dirname, "../fixtures", f);
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("цена Claude совпадает с суммой самого CLI (Haiku 5.5, запись в кэш на час ×2, чтение ×0.1)", () => {
  // ход 1 и ход 2 из живого прогона: CLI насчитал $0.0043381 и ещё $0.00147417
  near(claudeCost("claude-haiku-5-5", { input: 2, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 21682 })!, 0.0043381);
  near(claudeCost("claude-haiku-5-5", { input: 2, output: 3, cacheRead: 17707, cacheWrite5m: 0, cacheWrite1h: 6477 })!, 0.00147417);
  // Opus 5.5: чтение кэша $0.20 (×0.05), а не ×0.1
  near(claudeCost("claude-opus-5-5", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0 })!, 0.2);
  assert.equal(claudeCost("claude-unknown-9", { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }), undefined);
});

test("claude вживую: расход хода — разница накопительных modelUsage, новый процесс — с нуля", () => {
  const got: UsageRecord[] = [];
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  (engine as unknown as { sink: unknown }).sink = { event: () => {}, delta: () => {}, usage: (_: string, u: UsageRecord) => got.push(u) };
  engine.attach("s1", { directory: "C:\\work", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual", hasHistory: true });
  const results = readFileSync(fixture("claude-usage-results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const r of results) engine.handle("s1", r);
  assert.equal(got.length, 2);
  assert.deepEqual([got[0]!.input, got[0]!.output, got[0]!.cacheWrite, got[0]!.cacheRead], [2, 3, 21682, 0]);
  near(got[0]!.cost!, 0.0043381);
  assert.deepEqual([got[1]!.input, got[1]!.output, got[1]!.cacheWrite, got[1]!.cacheRead], [2, 3, 6477, 17707], "второй ход — только своё");
  near(got[1]!.cost!, 0.00147417);
  assert.notEqual(got[0]!.key, got[1]!.key);
  // процесс перезапустился: счётчики CLI снова с нуля, первый итог — целиком
  (engine as unknown as { sessions: Map<string, { modelUsage?: unknown }> }).sessions.get("s1")!.modelUsage = undefined;
  engine.handle("s1", results[0]);
  near(got.at(-1)!.cost!, 0.0043381);
});

test("opencode: расход сообщения — вывод вместе с рассуждениями, незавершённое не считаем", () => {
  const raw = JSON.parse(readFileSync(fixture("opencode-v1-turn.json"), "utf8")) as { sid: string; events: Array<Record<string, any>> };
  const infos = raw.events.filter((p) => p.type === "message.updated" && p.properties?.info?.role === "assistant").map((p) => p.properties.info);
  const done = infos.find((i) => i.time?.completed && i.tokens?.input === 6845)!;
  const r = opencodeRecord(done)!;
  assert.deepEqual([r.input, r.output, r.cacheRead, r.cacheWrite, r.cost], [6845, 84 + 83, 1792, 0, 0]);
  assert.equal(r.key, `oc:${done.id}`);
  assert.equal(opencodeRecord(infos.find((i) => !i.time?.completed)!), undefined, "нулевые токены незавершённого ответа");

  const got: UsageRecord[] = [];
  const engine = new OpencodeEngine({ port: 0 });
  (engine as unknown as { sink: unknown }).sink = { event: () => {}, delta: () => {}, usage: (_: string, u: UsageRecord) => got.push(u) };
  engine.attach(raw.sid, { directory: "C:\\work", permissionMode: "auto" });
  for (const e of raw.events) engine.handle(e);
  assert.ok(got.length >= 2 && got.every((u) => u.input + u.output > 0), "только завершённые с токенами");
  assert.ok(got.some((u) => u.input === 6845) && got.some((u) => u.input === 311), "оба ответа хода");
});

test("история из транскрипта: одно сообщение — несколько строк, вывод — максимум, синтетика и чужое время мимо", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kh-usage-tr-"));
  const path = join(dir, "t.jsonl");
  const line = (id: string, ts: string, out: number, model = "claude-opus-5-5") =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model, usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 } } } });
  writeFileSync(
    path,
    [
      line("m1", "2026-10-20T10:00:00Z", 1),
      line("m1", "2026-10-20T10:00:01Z", 50),
      line("m2", "2026-10-20T11:00:00Z", 7),
      line("m3", "2026-10-20T12:00:00Z", 9, "<synthetic>"),
      line("old", "2026-10-01T10:00:00Z", 5),
      "не json",
    ].join("\n"),
  );
  const recs = await claudeHistory(path, Date.parse("2026-10-10T00:00:00Z"), Date.parse("2026-10-21T00:00:00Z"));
  assert.deepEqual(recs.map((r) => [r.key, r.output]), [["claude-msg:m1", 50], ["claude-msg:m2", 7]]);
  // 10×4 + 50×20 + 1000×0.2 + 200×4×2 = 40 + 1000 + 200 + 1600 → $0.00284
  near(recs[0]!.cost!, 0.00284);
});

test("хаб: расход пишется в базу, повтор той же записи не задваивает, отчёт за период и сигнал клиентам", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-usage-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  let sink: { usage?: (esid: string, u: UsageRecord) => void } = {};
  const engine: Engine = {
    id: "opencode",
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: root, title: "Проба" });
  const signals: string[] = [];
  sessions.on("usage", (id) => signals.push(id));
  const day1 = Date.parse("2026-10-20T12:00:00");
  const day2 = Date.parse("2026-10-21T12:00:00");
  sink.usage!("es1", { key: "oc:a", model: "glm", input: 100, output: 20, cacheWrite: 0, cacheRead: 500, cost: 0, ts: day1 });
  sink.usage!("es1", { key: "oc:a", model: "glm", input: 100, output: 20, cacheWrite: 0, cacheRead: 500, cost: 0, ts: day1 }); // повтор события
  sink.usage!("es1", { key: "oc:b", model: "big", input: 1000, output: 100, cacheWrite: 50, cacheRead: 0, cost: 0.5, ts: day2 });
  sink.usage!("unknown-esid", { key: "x", model: "m", input: 1, output: 1, cacheWrite: 0, cacheRead: 0 });
  assert.deepEqual(signals, [s.id, s.id, s.id]);
  const tot = sessions.sessionUsage(s.id);
  assert.deepEqual([tot.tokens, tot.cacheRead, tot.cost], [100 + 20 + 1000 + 100 + 50, 500, 0.5]);
  assert.deepEqual(Object.keys(sessions.usageTotals()), [s.id]);

  const r = usageReport(db, "2026-10-20", "2026-10-20", (id) => ({ title: db.getSession(id)!.title, engine: db.getSession(id)!.engine }));
  assert.equal(r.total.tokens, 120);
  assert.deepEqual(r.days.map((d) => d.day), ["2026-10-20"]);
  assert.equal(r.firstDay, "2026-10-20");
  const all = usageReport(db, "2026-10-01", "2026-10-31", () => undefined);
  assert.deepEqual(all.models.map((m) => m.model), ["big", "glm"], "по убыванию новых токенов");
  assert.equal(all.sessions[0]!.deleted, true, "сессии нет — расход всё равно виден");
  // записи без цены помечаются
  sink.usage!("es1", { key: "oc:c", model: "nocost", input: 1, output: 1, cacheWrite: 0, cacheRead: 0, ts: day2 });
  assert.equal(sessions.sessionUsage(s.id).costUnknown, true);
  assert.equal(dayOf(day1), "2026-10-20");
});
