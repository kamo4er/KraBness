// Карточка сессии в общем списке обновляется и во время работы (время, порядок), но не на каждую часть.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionInfo } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SESSION_LIST_THROTTLE_MS, SessionManager } from "../../src/sessions.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

test("session в список: сразу при session.updated, иначе не чаще раза в 15 с", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const base = mkdtempSync(join(tmpdir(), "kamharn-"));
    const root = join(base, "Projects");
    mkdirSync(root);
    const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
    const db = new Db(join(base, "t.db"));
    const sessions = new SessionManager(db, config, new FileStore(db, config));
    let sink!: EngineSink;
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
    await sessions.create({ engine: "opencode", directory: root });
    const list: SessionInfo[] = [];
    sessions.on("session", (s) => list.push(s));

    const part = (i: number) => sink.event("es1", { type: "part.upserted", messageId: "m1", part: { type: "text", id: `p${i}`, text: "x" } });
    part(1); // первое событие — карточка уходит
    part(2);
    part(3);
    assert.equal(list.length, 1);
    mock.timers.tick(SESSION_LIST_THROTTLE_MS);
    part(4);
    assert.equal(list.length, 2, "через 15 с — снова");
    assert.ok(list[1]!.updatedAt > list[0]!.updatedAt, "время в карточке свежее");
    sink.event("es1", { type: "session.updated", patch: { status: "busy" } });
    assert.equal(list.length, 3, "смена статуса — сразу");
  } finally {
    mock.timers.reset();
  }
});
