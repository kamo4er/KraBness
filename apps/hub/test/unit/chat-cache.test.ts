// Кэш чатов на телефоне: хаб присылает только события после lastSeq кэша, а если кэш новее журнала — reset.
// Плюс сжатие WebSocket (большие чаты — мегабайты JSON).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { emptyView, HubClient } from "@kamharn/client";
import { createHub } from "../../src/hub.ts";

async function hubWithSession() {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const now = Date.now();
  hub.db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: join(base, "Projects"), title: "Чат", model: { providerId: "a", modelId: "m" }, permissionMode: "manual", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  for (const t of ["один", "два", "три"]) {
    const id = `m-${t}`;
    hub.db.appendEvent("s1", { type: "message.upserted", message: { id, role: "assistant", createdAt: now + t.length } });
    hub.db.appendEvent("s1", { type: "part.upserted", messageId: id, part: { type: "text", id: `${id}:0`, text: t } });
  }
  return hub;
}

function wsClient(url: string) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { perMessageDeflate: true });
  const inbox: Array<{ t: string; seq?: number }> = [];
  ws.on("message", (m) => inbox.push(JSON.parse(String(m))));
  const until = async (t: string) => {
    for (let i = 0; i < 100; i++) {
      if (inbox.some((m) => m.t === t)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`нет ${t}`);
  };
  return { ws, inbox, until };
}

test("WS: сжатие включено; after больше журнала — reset и replay с начала", async () => {
  const hub = await hubWithSession();
  const c = wsClient(hub.urls[0]!);
  try {
    await new Promise((res, rej) => (c.ws.once("open", res), c.ws.once("error", rej)));
    assert.match(c.ws.extensions, /permessage-deflate/);
    await c.until("hello");
    c.ws.send(JSON.stringify({ t: "sub", sessionId: "s1", after: 999 }));
    await c.until("live");
    const types = c.inbox.filter((m) => m.t !== "hello").map((m) => m.t);
    assert.equal(types[0], "reset");
    assert.deepEqual(c.inbox.filter((m) => m.t === "ev").map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
  } finally {
    c.ws.terminate();
    await hub.close();
  }
});

test("HubClient.hydrate: после кэша приходят только новые события, чат собирается целиком", async () => {
  const hub = await hubWithSession();
  // «кэш с телефона»: первые два сообщения
  const cached = emptyView();
  const full = hub.db.eventsAfter("s1", 0);
  const { applyEvent } = await import("@kamharn/protocol");
  for (const e of full.slice(0, 4)) applyEvent(cached, e);
  assert.equal(cached.lastSeq, 4);

  const client = new HubClient(hub.urls[0]!);
  const seen: number[] = [];
  const raw = (client as unknown as { onMessage(m: { t: string; seq?: number }): void }).onMessage.bind(client);
  (client as unknown as { onMessage(m: { t: string; seq?: number }): void }).onMessage = (m) => {
    if (m.t === "ev") seen.push(m.seq!);
    raw(m);
  };
  try {
    client.connect();
    for (let i = 0; i < 100 && client.state.conn !== "online"; i++) await new Promise((r) => setTimeout(r, 20));
    client.hydrate("s1", cached);
    client.openSession("s1");
    for (let i = 0; i < 100 && (client.state.views.s1?.lastSeq ?? 0) < 6; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [5, 6], "только то, чего нет в кэше");
    const texts = client.state.views.s1!.messages.map((m) => (m.parts[0] as { text: string }).text);
    assert.equal(texts.length, 3);
    assert.ok(["один", "два", "три"].every((t) => texts.includes(t)));
    assert.equal(client.state.views.s1!.info?.title, "Чат", "info подставлена из списка сессий");
  } finally {
    client.disconnect();
    await hub.close();
  }
});
