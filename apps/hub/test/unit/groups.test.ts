// Группы сессий: CRUD, перенос сессии (событие в журнале), удаление группы, промпт группы уходит движку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionGroup, StoredEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const prompts: Array<{ text: string; system?: string }> = [];
  await sessions.addEngine({
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es" + Math.random(),
    attach: () => {},
    prompt: async (_id, o) => void prompts.push({ text: o.text, ...(o.system ? { system: o.system } : {}) }),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  });
  return { sessions, db, root, prompts };
}

test("группы: создание, порядок, правка, промпт уходит движку, перенос и удаление группы", async () => {
  const { sessions, db, root, prompts } = await setup();
  const broadcasts: SessionGroup[][] = [];
  const events: StoredEvent[] = [];
  sessions.on("groups", (g) => broadcasts.push(g));
  sessions.on("event", (e) => events.push(e));

  const games = sessions.createGroup({ name: "  Игры ", icon: "🎮", prompt: "Ты психолог-программист." });
  const harness = sessions.createGroup({ name: "Харнесс" });
  assert.equal(games.name, "Игры");
  assert.deepEqual(sessions.groups().map((g) => g.name), ["Игры", "Харнесс"], "новые — в конец");
  assert.throws(() => sessions.createGroup({ name: "  " }), /Пустое/);
  assert.equal(broadcasts.length, 2, "клиенты узнают о каждой правке");

  // сессия сразу в группе и сессия без группы
  const a = await sessions.create({ engine: "opencode", directory: root, title: "Кот", groupId: games.id });
  const b = await sessions.create({ engine: "opencode", directory: root, title: "Без группы" });
  assert.equal(a.groupId, games.id);
  assert.equal(b.groupId, undefined);

  await sessions.prompt(a.id, "привет");
  await sessions.prompt(b.id, "привет");
  assert.deepEqual(prompts, [{ text: "привет", system: "Ты психолог-программист." }, { text: "привет" }]);

  // промпт поменяли — со следующего сообщения новый; убрали — без него
  sessions.updateGroup(games.id, { prompt: "Отвечай коротко." });
  await sessions.prompt(a.id, "ещё");
  assert.equal(prompts.at(-1)!.system, "Отвечай коротко.");

  // перенос: событие в журнале сессии (видно всем клиентам), в БД
  await sessions.update(b.id, { groupId: harness.id });
  assert.equal(db.getSession(b.id)!.groupId, harness.id);
  assert.deepEqual(events.at(-1)!.event, { type: "session.updated", patch: { groupId: harness.id } });
  await assert.rejects(sessions.update(b.id, { groupId: "g_nope" }), /Нет такой группы/);
  await sessions.update(b.id, { groupId: null });
  assert.equal(db.getSession(b.id)!.groupId, undefined);

  // удаление группы: сессии остаются, но без группы, и клиенты об этом узнают
  sessions.updateGroup(harness.id, { sort: -1 });
  assert.equal(sessions.groups()[0]!.id, harness.id, "порядок меняется");
  sessions.deleteGroup(games.id);
  assert.equal(db.getSession(a.id)!.groupId, undefined);
  assert.deepEqual(events.at(-1)!.event, { type: "session.updated", patch: { groupId: "" } });
  assert.deepEqual(sessions.groups().map((g) => g.name), ["Харнесс"]);
  await sessions.prompt(a.id, "после удаления");
  assert.equal(prompts.at(-1)!.system, undefined, "промпт удалённой группы больше не идёт");
});
