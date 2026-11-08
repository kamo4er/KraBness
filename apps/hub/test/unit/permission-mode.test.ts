// Смена режима подтверждений в живой сессии.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { PermissionMode, SessionEvent, StoredEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import type { Engine } from "../../src/engines/types.ts";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const calls: PermissionMode[] = [];
  const engine: Engine = {
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async (_, mode) => void calls.push(mode),
    forget: () => {},
  };
  return { sessions, db, root, engine, calls };
}

test("PATCH permissionMode: движок получает режим, событие в журнале, режим в БД", async () => {
  const { sessions, db, root, engine, calls } = setup();
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: root, permissionMode: "manual" });
  const evs: StoredEvent[] = [];
  sessions.on("event", (e) => evs.push(e));

  const info = await sessions.update(s.id, { permissionMode: "auto" });
  assert.equal(info.permissionMode, "auto");
  assert.deepEqual(calls, ["auto"]);
  assert.deepEqual(evs.map((e) => e.event), [{ type: "session.updated", patch: { permissionMode: "auto" } }]);
  assert.equal(db.getSession(s.id)?.permissionMode, "auto");

  // тот же режим — без лишних вызовов и событий
  await sessions.update(s.id, { permissionMode: "auto" });
  assert.equal(calls.length, 1);
  assert.equal(evs.length, 1);

  await assert.rejects(sessions.update(s.id, { permissionMode: "yolo" as PermissionMode }), /Неизвестный режим/);
});

test("claude: set_permission_mode уходит в stdin, ждущие запросы одобряются по новому режиму", async () => {
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  const events: SessionEvent[] = [];
  (engine as any).sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  engine.attach("cs1", { directory: "C:\\work", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual", hasHistory: true });

  const stdin = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d: Buffer) => written.push(d.toString()));
  (engine as any).sessions.get("cs1").proc = { exitCode: null, stdin };

  const bash = engine.requestPermission("cs1", "Bash", { command: "ls" });
  const edit = engine.requestPermission("cs1", "Edit", { file_path: "C:\\work\\a.txt" });

  await engine.setPermissionMode("cs1", "acceptEdits");
  assert.equal(await edit, "once", "правка одобрена режимом acceptEdits");
  await new Promise((r) => setImmediate(r));
  const cmd = JSON.parse(written.join("").trim().split("\n")[0]!);
  assert.equal(cmd.type, "control_request");
  assert.deepEqual(cmd.request, { subtype: "set_permission_mode", mode: "acceptEdits" });

  await engine.setPermissionMode("cs1", "auto");
  assert.equal(await bash, "once", "команда одобрена режимом auto");
  assert.equal(events.filter((e) => e.type === "permission.resolved").length, 2);
});
