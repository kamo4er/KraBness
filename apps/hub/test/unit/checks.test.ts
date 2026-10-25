// Автопроверка: агент закончил ход → хаб гоняет команды; красная — ошибка уходит агенту, до 3 кругов,
// та же ошибка дважды — стоп; зелёная — одно уведомление с итогом. Движок поддельный, команды подменены.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CheckResult, Part, SessionEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { AutoCheck, MAX_ATTEMPTS, runCommand, suggestChecks } from "../../src/checks.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function setup(results: Array<Partial<CheckResult>>) {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  let sink!: EngineSink;
  const prompts: string[] = [];
  const engine: Engine = {
    id: "opencode",
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async (_esid, o) => void prompts.push(o.text),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: root });
  const notices: string[] = [];
  const queue = [...results];
  const ran: string[] = [];
  const check = new AutoCheck({
    sessions,
    config,
    notify: (_sid, m) => void notices.push(m),
    run: async (command) => (ran.push(command), { command, code: 0, ms: 1, output: "", ...(queue.shift() ?? {}) }),
  });
  const ev = (e: SessionEvent) => sink.event("es1", e);
  let n = 0;
  /** ход агента: при желании — сообщение пользователя (как его показывает движок), busy → idle */
  const turn = async (userText?: string) => {
    if (userText !== undefined) {
      n++;
      ev({ type: "message.upserted", message: { id: `u${n}`, role: "user", createdAt: Date.now() } });
    }
    ev({ type: "session.updated", patch: { status: "busy" } });
    ev({ type: "session.updated", patch: { status: "idle" } });
    for (let i = 0; i < 50 && check["state"].get(s.id)?.running !== false; i++) await tick(5);
    await tick();
  };
  const checkParts = () =>
    db
      .eventsAfter(s.id, 0)
      .map((x) => x.event)
      .filter((e): e is Extract<SessionEvent, { type: "part.upserted" }> => e.type === "part.upserted" && e.part.type === "check")
      .map((e) => e.part as Extract<Part, { type: "check" }>);
  return { sessions, config, s, root, prompts, notices, ran, check, turn, checkParts };
}

test("выключена или команд нет — ничего не гоняет; рестарт хаба (idle без busy) — не ход", async () => {
  const t = await setup([]);
  await t.turn();
  assert.equal(t.ran.length, 0);
  t.config.setChecks(t.root, ["npm test"]);
  await t.turn();
  assert.equal(t.ran.length, 0, "autoCheck выключен");
  await t.sessions.update(t.s.id, { autoCheck: true });
  assert.equal(t.check.active(t.s.id), true);
  // idle без busy в этом запуске
  t.sessions["append"](t.s.id, { type: "session.updated", patch: { status: "idle" } });
  await tick();
  assert.equal(t.ran.length, 0);
});

test("красная → ошибка уходит агенту → после его хода зелёная → одно уведомление", async () => {
  const t = await setup([{ code: 1, output: "FAIL a.test.ts: expected 2, got 3" }, { code: 0 }]);
  t.config.setChecks(t.root, ["npm test"]);
  await t.sessions.update(t.s.id, { autoCheck: true });
  await t.turn("сделай фичу");
  assert.equal(t.prompts.length, 1);
  assert.match(t.prompts[0]!, /npm test/);
  assert.match(t.prompts[0]!, /expected 2, got 3/);
  let last = t.checkParts().at(-1)!;
  assert.equal(last.status, "failed");
  assert.match(last.note ?? "", /1/);
  // ход по нашему промпту: движок показывает его как сообщение пользователя — это не «человек написал сам»
  await t.turn("<наш промпт>");
  last = t.checkParts().at(-1)!;
  assert.equal(last.status, "passed");
  assert.equal(t.notices.length, 1);
  assert.match(t.notices[0]!, /прошли|passed/);
});

test("та же ошибка дважды подряд — стоп; новые ошибки — до MAX_ATTEMPTS кругов", async () => {
  const same = { code: 1, output: "Error at line 12: boom" };
  const t = await setup([same, { ...same, output: "Error at line 13: boom" }]);
  t.config.setChecks(t.root, ["npm test"]);
  await t.sessions.update(t.s.id, { autoCheck: true });
  await t.turn("задача");
  await t.turn("<наш промпт>");
  assert.equal(t.prompts.length, 1, "вторую такую же (номера строк не в счёт) агенту не шлём");
  assert.match(t.checkParts().at(-1)!.note ?? "", /Та же ошибка|same error/);
  assert.equal(t.notices.length, 1);

  const fails = Array.from({ length: MAX_ATTEMPTS + 1 }, (_, i) => ({ code: 1, output: `ошибка вида ${"x".repeat(i + 1)}` }));
  const u = await setup(fails);
  u.config.setChecks(u.root, ["npm test"]);
  await u.sessions.update(u.s.id, { autoCheck: true });
  await u.turn("задача");
  for (let i = 0; i < MAX_ATTEMPTS; i++) await u.turn("<наш промпт>");
  assert.equal(u.prompts.length, MAX_ATTEMPTS);
  assert.match(u.checkParts().at(-1)!.note ?? "", /Попытки кончились|Out of attempts/);
  // человек написал сам — счёт заново
  u.check["state"].get(u.s.id)!.ourPrompt = false;
  await u.turn("попробуй иначе");
  assert.equal(u.prompts.length, MAX_ATTEMPTS, "очередь результатов пуста — зелёная, ничего не отправили");
  assert.equal(u.checkParts().at(-1)!.status, "passed");
});

test("агент ждёт сброса лимита — ошибку не отправляем, ждём его хода", async () => {
  const t = await setup([{ code: 1, output: "FAIL: boom" }, { code: 1, output: "FAIL: boom" }]);
  t.config.setChecks(t.root, ["npm test"]);
  await t.sessions.update(t.s.id, { autoCheck: true });
  t.sessions.setResumeAt(t.s.id, Date.now() + 3600_000);
  await t.turn("задача");
  assert.equal(t.prompts.length, 0, "агенту в лимите не пишем");
  assert.match(t.checkParts().at(-1)!.note ?? "", /лимит|limit/);

  // лимит сбросился, агент продолжил — теперь ошибка уходит ему
  t.sessions.setResumeAt(t.s.id, 0);
  await t.turn("<продолжай>");
  assert.equal(t.prompts.length, 1);
});

test("падает первая команда — следующие не гоняем; результаты по командам в карточке", async () => {
  const t = await setup([{ code: 0, output: "types ok" }, { code: 2, output: "lint: 3 problems" }]);
  t.config.setChecks(t.root, ["npm run typecheck", "npm run lint", "npm test"]);
  await t.sessions.update(t.s.id, { autoCheck: true });
  await t.turn("задача");
  assert.deepEqual(t.ran, ["npm run typecheck", "npm run lint"]);
  const last = t.checkParts().at(-1)!;
  assert.deepEqual(last.results.map((r) => [r.command, r.code]), [["npm run typecheck", 0], ["npm run lint", 2]]);
});

test("команды предлагаются по файлам проекта", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamharn-sug-"));
  assert.deepEqual(suggestChecks(dir), []);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc", build: "vite build" } }));
  assert.deepEqual(suggestChecks(dir), ["npm run typecheck", "npm test"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.deepEqual(suggestChecks(dir), [], "заглушка npm init — не проверка");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  writeFileSync(join(dir, "pyproject.toml"), "");
  assert.deepEqual(suggestChecks(dir), ["pnpm lint", "python -m pytest"]);
});

test("настоящий запуск команды: код выхода, вывод, таймаут", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamharn-run-"));
  const ok = await runCommand("node -e \"console.log('привет'); process.exit(3)\"", dir);
  assert.equal(ok.code, 3);
  assert.match(ok.output, /привет/);
  const slow = await runCommand('node -e "setTimeout(() => {}, 20000)"', dir, 500);
  assert.equal(slow.code, null);
  assert.equal(slow.timedOut, true);
});
