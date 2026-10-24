// Лимиты подписки Claude: rate_limit_event (записан с claude 2.1.302) → проценты окон 5 ч и 7 дней.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClaudeLimits } from "@kamharn/protocol";
import { ClaudeEngine, parseLimits } from "../../src/engines/claude.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";

const event = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/claude-rate-limit.json"), "utf8"));

test("parseLimits: доли и время сброса в мс", () => {
  assert.deepEqual(parseLimits(event.rate_limit_info, 42), {
    fiveHour: { utilization: 0.04, resetsAt: 1792361400000 },
    sevenDay: { utilization: 0.06, resetsAt: 1792807200000 },
    status: "allowed",
    updatedAt: 42,
  });
  assert.equal(parseLimits({}), undefined);
});

test("движок отдаёт лимиты, хаб рассылает и помнит после рестарта", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const engine = new ClaudeEngine({ dataDir: join(base, "data"), mcpBaseUrl: () => "", idleKillMs: 0 });
  await sessions.addEngine(engine);
  const got: ClaudeLimits[] = [];
  sessions.on("limits", (l) => got.push(l));
  engine.attach("cs1", { directory: root, model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "auto", hasHistory: true });
  engine.handle("cs1", event);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.fiveHour?.utilization, 0.04);

  const again = new SessionManager(db, config, new FileStore(db, config));
  assert.equal(again.limits?.sevenDay?.utilization, 0.06, "сохранено в data/claude-limits.json");
});

test("limitView: проценты, сброшенное окно = 0, уровни", async () => {
  const { limitView } = await import("@kamharn/client");
  const l = parseLimits(event.rate_limit_info, 1792350000000)!;
  const v = limitView(l, 1792350000000 + 5 * 60_000)!;
  assert.equal(v.fiveHour, 4);
  assert.equal(v.sevenDay, 6);
  assert.equal(v.level, "ok");
  assert.equal(v.ageMin, 5);
  assert.ok(v.fiveHourReset && v.sevenDayReset);
  // пятичасовое окно сброшено, недельное — нет
  const after = limitView(l, 1792361400000 + 1)!;
  assert.equal(after.fiveHour, 0);
  assert.equal(after.fiveHourReset, undefined);
  assert.equal(limitView({ ...l, sevenDay: { utilization: 0.96, resetsAt: 1792807200000 } }, 1792350000000)!.level, "danger");
  assert.equal(limitView({ ...l, fiveHour: { utilization: 0.85, resetsAt: 1792361400000 } }, 1792350000000)!.level, "warn");
});
