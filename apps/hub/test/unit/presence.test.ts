// Пользователь активен в веб-UI — пуши на телефон не шлются; ушёл (пульс пропал, вкладка закрыта) — снова шлются.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import type { SessionEvent, StoredEvent } from "@kamharn/protocol";
import { Presence, PRESENCE_TTL_MS } from "../../src/presence.ts";
import { Notifier } from "../../src/notifier.ts";
import type { PushMessage } from "../../src/push.ts";
import { Db } from "../../src/db.ts";
import { createHub } from "../../src/hub.ts";

test("Presence: активен, пока идёт пульс; active:false и drop снимают сразу", () => {
  let now = 1_000_000;
  const p = new Presence(() => now);
  const a = {}, b = {};
  assert.equal(p.active, false);
  p.set(a, true);
  assert.equal(p.active, true);
  now += PRESENCE_TTL_MS - 1;
  assert.equal(p.active, true);
  now += 1;
  assert.equal(p.active, false, "пульс пропал — присутствие истекло");
  p.set(a, true);
  p.set(b, true);
  p.set(a, false);
  assert.equal(p.active, true, "вторая вкладка ещё активна");
  p.drop(b);
  assert.equal(p.active, false);
});

test("Notifier: при активном вебе пуши не уходят, но «готово» после ухода считается верно", async () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "kamharn-")), "t.db"));
  const now = Date.now();
  db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: "C:\\w", title: "Ф", model: { providerId: "a", modelId: "m" }, permissionMode: "manual", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  db.insertDevice({ id: "d1", name: "phone", tokenHash: "h", createdAt: now, lastSeen: now, fcmToken: "tok-1" });
  const sent: PushMessage[] = [];
  const presence = { active: true };
  const n = new Notifier(db, { enabled: true, send: async (_t, m) => (sent.push(m), "ok") }, presence);
  let seq = 0;
  const ev = (event: SessionEvent): StoredEvent => ({ seq: ++seq, sessionId: "s1", ts: now, event });
  const flush = () => new Promise((r) => setTimeout(r, 10));

  n.onEvent(ev({ type: "session.updated", patch: { status: "busy" } }));
  n.onEvent(ev({ type: "permission.asked", request: { id: "r1", tool: "Bash", title: "npm test", canAlways: true } }));
  await flush();
  assert.equal(sent.length, 0, "пользователь за ПК — телефон молчит");

  presence.active = false;
  n.onEvent(ev({ type: "session.updated", patch: { status: "idle" } }));
  await flush();
  assert.deepEqual(sent.map((m) => m.message), ["Готово"], "статус busy отслеживался и при активном вебе");
});

test("WS: presence от клиента глушит пуши, закрытие вкладки снимает", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const ws = new WebSocket(hub.urls[0]!.replace(/^http/, "ws") + "/ws");
  // hello может прийти в одном пакете с апгрейдом, раньше любого слушателя — копим с самого начала
  const inbox: string[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (m) => (inbox.push(String(m)), waiters.shift()?.()));
  const next = async (t: string) => {
    const until = Date.now() + 5000;
    for (;;) {
      const i = inbox.findIndex((m) => JSON.parse(m).t === t);
      if (i >= 0) return void inbox.splice(i, 1);
      if (Date.now() > until) throw new Error(`нет сообщения ${t}`);
      await new Promise<void>((res) => (waiters.push(res), setTimeout(res, 100)));
    }
  };
  const pong = () => next("pong");
  try {
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    await next("hello");
    ws.send(JSON.stringify({ t: "presence", active: true }));
    ws.send(JSON.stringify({ t: "ping" }));
    await pong(); // сообщения обрабатываются по порядку — presence уже применён
    assert.equal(hub.presence.active, true);

    ws.send(JSON.stringify({ t: "presence", active: false }));
    ws.send(JSON.stringify({ t: "ping" }));
    await pong();
    assert.equal(hub.presence.active, false);

    ws.send(JSON.stringify({ t: "presence", active: true }));
    ws.send(JSON.stringify({ t: "ping" }));
    await pong();
    ws.close();
    for (let i = 0; i < 50 && hub.presence.active; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(hub.presence.active, false, "вкладку закрыли — присутствие снято");
  } finally {
    ws.terminate();
    await hub.close();
  }
});
