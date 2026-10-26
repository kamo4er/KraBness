// Уровень рассуждений («умность»): claude --effort при запуске процесса (смена — перезапуск), opencode — variant в сообщении,
// сессия хранит уровень, смена модели его сбрасывает, задача передаёт уровни исполнителю и ревьюеру.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRef } from "@kamharn/protocol";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { OpencodeEngine } from "../../src/engines/opencode.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine } from "../../src/engines/types.ts";

const haiku: ModelRef = { providerId: "anthropic", modelId: "claude-haiku-5-5" };

test("claude: --effort в аргументах запуска, смена уровня перезапускает простаивающий процесс", async () => {
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  const e = engine as unknown as {
    sessions: Map<string, { effort?: string; busy: boolean; proc?: unknown }>;
    ensureProc: (s: unknown) => unknown;
    killProc: (s: { proc?: unknown }) => void;
  };
  engine.attach("s1", { directory: "C:\\work", model: haiku, permissionMode: "manual", hasHistory: true });
  const starts: string[][] = [];
  let kills = 0;
  e.ensureProc = (s) => {
    const sess = s as { proc?: unknown };
    if (!sess.proc) {
      starts.push(engine.procArgs(s as never, "m.json"));
      sess.proc = { exitCode: null, stdin: { write: () => true, end: () => {} } };
    }
    return sess.proc;
  };
  e.killProc = (s) => {
    kills++;
    s.proc = undefined;
  };
  const sess = e.sessions.get("s1")!;
  const turn = async (effort?: string) => {
    await engine.prompt("s1", { text: "hi", files: [], model: haiku, ...(effort ? { effort } : {}) });
    sess.busy = false; // ход закончился
  };

  await turn();
  assert.ok(!starts[0]!.includes("--effort"), "без уровня — флага нет");
  await turn("high");
  assert.equal(kills, 1, "уровень сменился — процесс перезапущен");
  const args = starts.at(-1)!;
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.ok(args.includes("--resume"), "история продолжается");
  await turn("high");
  assert.equal(kills, 1, "тот же уровень — без перезапуска");
  await turn();
  assert.equal(kills, 2, "вернули по умолчанию — снова перезапуск");
  assert.ok(!starts.at(-1)!.includes("--effort"));
  assert.deepEqual((await engine.info()).models.find((m) => m.modelId === "claude-haiku-5-5")?.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("opencode: уровень уходит полем variant, варианты модели — в efforts", async () => {
  const engine = new OpencodeEngine({ port: 0 });
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  (engine as unknown as { req: unknown }).req = async (method: string, path: string, body?: Record<string, unknown>) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (path === "/provider")
      return {
        connected: ["opencode"],
        all: [{ id: "opencode", models: { glm: { id: "glm", name: "GLM", variants: { low: {}, high: {}, max: {} } }, plain: { id: "plain", name: "Plain" } } }],
      };
    if (path === "/config") return {};
    return undefined;
  };
  engine.attach("oc1", { directory: "C:\\work", permissionMode: "auto" });
  const model = { providerId: "opencode", modelId: "glm" };
  await engine.prompt("oc1", { text: "hi", files: [], model, effort: "max" });
  await engine.prompt("oc1", { text: "hi", files: [], model });
  const sent = calls.filter((c) => c.path.endsWith("/prompt_async"));
  assert.equal(sent[0]!.body!.variant, "max");
  assert.equal("variant" in sent[1]!.body!, false, "без уровня — поля нет");
  const info = await engine.info();
  assert.deepEqual(info.models.find((m) => m.modelId === "glm")?.efforts, ["low", "high", "max"]);
  assert.equal(info.models.find((m) => m.modelId === "plain")?.efforts, undefined, "у модели без вариантов уровней нет");
});

test("сессия: уровень хранится, уходит движку, смена модели сбрасывает, мусор не принимается", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-effort-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const prompts: Array<string | undefined> = [];
  const engine: Engine = {
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async (_, o) => void prompts.push(o.effort),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: root, effort: "high" });
  assert.equal(s.effort, "high");
  await sessions.prompt(s.id, "раз");
  assert.equal((await sessions.update(s.id, { effort: "low" })).effort, "low");
  await sessions.prompt(s.id, "два");
  assert.equal(db.getSession(s.id)?.effort, "low", "уровень в базе");
  // у другой модели свои уровни — сбрасываем
  assert.equal((await sessions.update(s.id, { model: { providerId: "p", modelId: "other" } })).effort, undefined);
  await sessions.prompt(s.id, "три");
  // смена модели вместе с уровнем — уровень остаётся
  assert.equal((await sessions.update(s.id, { model: { providerId: "p", modelId: "m" }, effort: "max" })).effort, "max");
  // мусор — значит «по умолчанию»
  assert.equal((await sessions.update(s.id, { effort: "x; rm -rf /" })).effort, undefined);
  assert.deepEqual(prompts, ["high", "low", undefined]);
});
