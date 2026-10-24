// Экономия лимитов: выжимка сессии для бесплатной модели и ревью диффа.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineId } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

function fakeEngine(id: EngineId, prompts: string[], sinks: Record<string, EngineSink>): Engine {
  let n = 0;
  return {
    id,
    start: async (s) => void (sinks[id] = s),
    stop: async () => {},
    info: async () => ({ id, available: true, models: [], defaultModel: { providerId: id === "claude" ? "anthropic" : "opencode", modelId: id === "claude" ? "claude-opus-5-5" : "free" } }),
    createSession: async () => `${id}-${++n}`,
    attach: () => {},
    prompt: async (_, o) => void prompts.push(o.text),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
}

async function setup(root: string) {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const prompts: string[] = [];
  const sinks: Record<string, EngineSink> = {};
  await sessions.addEngine(fakeEngine("claude", [], sinks));
  await sessions.addEngine(fakeEngine("opencode", prompts, sinks));
  return { sessions, prompts, sinks, db };
}

test("handoff: новая opencode-сессия в той же папке, первым сообщением — выжимка", async () => {
  const root = mkdtempSync(join(tmpdir(), "kamharn-root-"));
  const { sessions, prompts, sinks } = await setup(root);
  const s = await sessions.create({ engine: "claude", directory: root, title: "Фича X", permissionMode: "auto" });
  const ev = sinks.claude!.event.bind(sinks.claude);
  ev("claude-1", { type: "message.upserted", message: { id: "u1", role: "user", createdAt: 1 } });
  ev("claude-1", { type: "part.upserted", messageId: "u1", part: { type: "text", id: "u1:t", text: "Сделай кнопку экспорта" } });
  ev("claude-1", { type: "message.upserted", message: { id: "a1", role: "assistant", createdAt: 2 } });
  ev("claude-1", { type: "part.upserted", messageId: "a1", part: { type: "tool", id: "a1:0", tool: "Edit", status: "completed", input: { file_path: "src/export.ts" } } });
  ev("claude-1", { type: "part.upserted", messageId: "a1", part: { type: "tool", id: "a1:1", tool: "Bash", status: "completed", input: { command: "npm test" } } });
  ev("claude-1", { type: "part.upserted", messageId: "a1", part: { type: "text", id: "a1:2", text: "Кнопка готова, тесты зелёные." } });

  const ns = await sessions.handoff(s.id);
  assert.equal(ns.engine, "opencode");
  assert.equal(ns.directory, s.directory);
  assert.equal(ns.permissionMode, "auto", "режим подтверждений сохраняется");
  assert.match(ns.title, /^→ Фича X/);
  const p = prompts.at(-1)!;
  for (const piece of ["Сделай кнопку экспорта", "Кнопка готова", "src/export.ts", "$ npm test", "ничего не делай"]) assert.ok(p.includes(piece), piece);
  assert.deepEqual(ns.model, { providerId: "opencode", modelId: "free" }, "без выбора — модель по умолчанию");
  const chosen = await sessions.handoff(s.id, { providerId: "zai", modelId: "glm-5" });
  assert.deepEqual(chosen.model, { providerId: "zai", modelId: "glm-5" });
});

test("review: дифф в промпте, режим «спрашивать всё»; без изменений — понятная ошибка", async () => {
  const root = mkdtempSync(join(tmpdir(), "kamharn-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root });
  g("init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const x = 1;\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  const { sessions, prompts } = await setup(root);
  const s = await sessions.create({ engine: "claude", directory: root, title: "Фича" });
  await assert.rejects(sessions.review(s.id), /изменений нет/);

  writeFileSync(join(root, "src", "a.ts"), "export const x = 2;\n");
  const r = await sessions.review(s.id);
  assert.equal(r.engine, "opencode");
  assert.equal(r.permissionMode, "manual");
  assert.match(prompts.at(-1)!, /-export const x = 1;\n\+export const x = 2;/);
  assert.match(prompts.at(-1)!, /ничего не запускай/);
  // выбранная перед стартом модель
  const r2 = await sessions.review(s.id, { providerId: "openrouter", modelId: "qwen3-coder:free" });
  assert.deepEqual(r2.model, { providerId: "openrouter", modelId: "qwen3-coder:free" });
});
