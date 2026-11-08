// Живой тест: хаб + настоящий opencode + бесплатная модель opencode.
// Модель можно переопределить: KAMHARN_TEST_MODEL=provider/model
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import type { ServerMessage, SessionInfo, StoredEvent } from "@kamharn/protocol";
import { createHub, type Hub } from "../../src/hub.ts";

const [testProvider, ...testModelRest] = (process.env.KAMHARN_TEST_MODEL ?? "opencode/deepseek-v4.1-flash-free").split("/");
const MODEL = { providerId: testProvider!, modelId: testModelRest.join("/") };

let hub: Hub;
let base: string;
let root: string;
let outside: string;

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kamharn-e2e-"));
  root = join(tmp, "Projects");
  mkdirSync(join(root, "demo"), { recursive: true });
  writeFileSync(join(root, "demo", "README.md"), "# Demo\n\nСекретное слово: арбуз.\n");
  outside = join(tmp, "outside");
  mkdirSync(outside);
  hub = await createHub({
    configPath: join(tmp, "kamharn.json"),
    overrides: {
      listen: ["127.0.0.1"],
      port: 0,
      dataDir: join(tmp, "data"),
      roots: [root],
      engines: { opencode: { enabled: true, port: 0 }, claude: { enabled: false } },
    },
    log: () => {},
  });
  base = hub.urls[0]!;
});

after(async () => {
  await hub?.close();
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(base + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

class Client {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  constructor() {
    this.ws = new WebSocket(base.replace("http", "ws") + "/ws");
    this.ws.on("message", (raw) => {
      this.msgs.push(JSON.parse(String(raw)) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }
  async open(): Promise<void> {
    await new Promise<void>((res, rej) => this.ws.once("open", () => res()).once("error", rej));
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 120_000): Promise<ServerMessage> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error("timeout waiting for message");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 500);
      });
    }
  }
  events(sessionId: string): Array<Extract<ServerMessage, { t: "ev" }>> {
    return this.msgs.filter((m): m is Extract<ServerMessage, { t: "ev" }> => m.t === "ev" && m.sessionId === sessionId);
  }
  close(): void {
    this.ws.close();
  }
}

test("allowlist: сессия и листинг вне разрешённых папок запрещены", async () => {
  const r1 = await api("POST", "/api/sessions", { engine: "opencode", directory: outside, model: MODEL });
  assert.equal(r1.status, 403);
  const r2 = await api("GET", "/api/fs/list?path=" + encodeURIComponent(join(root, "demo", "..", "..", "outside")));
  assert.equal(r2.status, 403);
  const r3 = await api("GET", "/api/fs/list?path=" + encodeURIComponent(root));
  assert.equal(r3.status, 200);
  assert.ok(r3.json.some((e: { name: string }) => e.name === "demo"));
});

test("движок opencode доступен и отдаёт модели", async () => {
  const r = await api("GET", "/api/engines");
  const oc = r.json.find((e: { id: string }) => e.id === "opencode");
  assert.ok(oc?.available, `opencode недоступен: ${oc?.error}`);
  assert.ok(oc.models.length > 0);
});

test("полный ход агента видят оба клиента одинаково; permission; replay с середины", async () => {
  const a = new Client();
  const b = new Client();
  await Promise.all([a.open(), b.open()]);
  await a.waitFor((m) => m.t === "hello");

  const created = await api("POST", "/api/sessions", {
    engine: "opencode",
    directory: join(root, "demo"),
    model: MODEL,
    permissionMode: "acceptEdits",
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const session = created.json as SessionInfo;

  // оба клиента узнают о новой сессии из общего канала
  await b.waitFor((m) => m.t === "session" && m.session.id === session.id);

  a.send({ t: "sub", sessionId: session.id, after: 0 });
  b.send({ t: "sub", sessionId: session.id, after: 0 });
  await a.waitFor((m) => m.t === "live" && m.sessionId === session.id);
  await b.waitFor((m) => m.t === "live" && m.sessionId === session.id);

  const p = await api("POST", `/api/sessions/${session.id}/prompt`, {
    text: "Прочитай README.md и назови секретное слово. Затем выполни в shell ровно команду: echo kamharn-ok",
  });
  assert.equal(p.status, 200);

  // bash в режиме acceptEdits требует подтверждения — отвечаем с клиента A
  const ask = (await a.waitFor((m) => m.t === "ev" && m.event.type === "permission.asked")) as Extract<ServerMessage, { t: "ev" }>;
  assert.equal(ask.event.type === "permission.asked" && ask.event.request.tool, "bash");
  const permId = ask.event.type === "permission.asked" ? ask.event.request.id : "";
  const rep = await api("POST", `/api/sessions/${session.id}/permissions/${permId}`, { reply: "once" });
  assert.equal(rep.status, 200);

  // ждём конца хода: idle после bash
  await a.waitFor(
    (m) =>
      m.t === "ev" &&
      m.sessionId === session.id &&
      m.event.type === "session.updated" &&
      m.event.patch.status === "idle" &&
      a.events(session.id).some((e) => e.event.type === "part.upserted" && e.event.part.type === "tool" && e.event.part.tool === "bash" && e.event.part.status === "completed"),
    180_000,
  );
  await new Promise((r) => setTimeout(r, 1500)); // хвостовые события

  const evA = a.events(session.id);
  const evB = b.events(session.id);
  assert.deepEqual(evB.map((e) => e.seq), evA.map((e) => e.seq), "оба клиента получили одну и ту же последовательность");
  assert.deepEqual(evA.map((e) => e.seq), evA.map((_, i) => i + 1), "seq без дыр, с 1");

  const resolved = evA.find((e) => e.event.type === "permission.resolved");
  assert.ok(resolved && resolved.event.type === "permission.resolved" && resolved.event.by === "local", "видно, кто подтвердил");

  const bash = evA.map((e) => e.event).find((e) => e.type === "part.upserted" && e.part.type === "tool" && e.part.tool === "bash" && e.part.status === "completed");
  assert.ok(bash && bash.type === "part.upserted" && bash.part.type === "tool" && bash.part.output?.includes("kamharn-ok"), "bash реально выполнился");

  const texts = evA.flatMap((e) => (e.event.type === "part.upserted" && e.event.part.type === "text" ? [e.event.part.text] : []));
  assert.ok(texts.some((t) => /арбуз/i.test(t)), "агент прочитал файл: " + texts.join(" | ").slice(0, 300));

  // дельты тоже дошли до обоих
  assert.ok(a.msgs.some((m) => m.t === "delta") && b.msgs.some((m) => m.t === "delta"));

  // переподключение с середины: приходит ровно хвост
  const mid = Math.floor(evA.length / 2);
  const c = new Client();
  await c.open();
  c.send({ t: "sub", sessionId: session.id, after: mid });
  await c.waitFor((m) => m.t === "live" && m.sessionId === session.id);
  assert.deepEqual(c.events(session.id).map((e) => e.seq), evA.slice(mid).map((e) => e.seq), "replay хвоста без потерь");

  // REST-журнал совпадает с тем, что пришло по WS
  const rest = await api("GET", `/api/sessions/${session.id}/events?after=0`);
  assert.deepEqual((rest.json as StoredEvent[]).map((e) => e.seq), evA.map((e) => e.seq));

  // статус сессии в списке — idle
  const list = await api("GET", "/api/sessions");
  assert.equal((list.json as SessionInfo[]).find((s) => s.id === session.id)?.status, "idle");

  a.close();
  b.close();
  c.close();
});

test("opencode: MCP хаба подключён, агент отдаёт файл пользователю", async () => {
  const c = new Client();
  await c.open();
  const created = await api("POST", "/api/sessions", { engine: "opencode", directory: join(root, "demo"), model: MODEL, permissionMode: "auto" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const sid = (created.json as SessionInfo).id;
  c.send({ t: "sub", sessionId: sid, after: 0 });
  await c.waitFor((m) => m.t === "live" && m.sessionId === sid);
  await api("POST", `/api/sessions/${sid}/prompt`, {
    text: "Отправь мне файл README.md из текущей папки с помощью инструмента kamharn_send_file_to_user (передай абсолютный путь). Больше ничего не делай.",
  });
  const filePart = (await c.waitFor(
    (m) => m.t === "ev" && m.sessionId === sid && m.event.type === "part.upserted" && m.event.part.type === "file",
    180_000,
  )) as Extract<ServerMessage, { t: "ev" }>;
  assert.ok(filePart.event.type === "part.upserted" && filePart.event.part.type === "file");
  const dl = await fetch(`${base}/api/files/${filePart.event.part.fileId}`);
  assert.equal(dl.status, 200);
  assert.match(await dl.text(), /арбуз/);
  c.close();
});

test("opencode: смена режима на auto посреди хода одобряет ждущий запрос и действует дальше", async () => {
  const c = new Client();
  await c.open();
  const created = await api("POST", "/api/sessions", { engine: "opencode", directory: join(root, "demo"), model: MODEL, permissionMode: "manual" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const sid = (created.json as SessionInfo).id;
  c.send({ t: "sub", sessionId: sid, after: 0 });
  await c.waitFor((m) => m.t === "live" && m.sessionId === sid);
  await api("POST", `/api/sessions/${sid}/prompt`, {
    text: "Выполни в shell ровно команду: echo mode-one. Затем выполни ровно команду: echo mode-two. Больше ничего не делай.",
  });
  await c.waitFor((m) => m.t === "ev" && m.sessionId === sid && m.event.type === "permission.asked", 180_000);

  const r = await api("PATCH", `/api/sessions/${sid}`, { permissionMode: "auto" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json as SessionInfo).permissionMode, "auto");

  const bashDone = (cmd: string) =>
    c.events(sid).some((e) => e.event.type === "part.upserted" && e.event.part.type === "tool" && e.event.part.tool === "bash" && e.event.part.status === "completed" && !!e.event.part.output?.includes(cmd));
  await c.waitFor((m) => m.t === "ev" && m.sessionId === sid && m.event.type === "session.updated" && m.event.patch.status === "idle" && bashDone("mode-two"), 180_000).catch((e) => {
    console.log(JSON.stringify(c.events(sid).map((x) => x.event)).slice(0, 6000));
    throw e;
  });

  const evs = c.events(sid).map((e) => e.event);
  assert.ok(bashDone("mode-one"), "первая команда выполнилась после автоодобрения");
  // модель может запросить обе команды сразу, до переключения: все запросы до него должны закрыться
  const switchAt = evs.findIndex((e) => e.type === "session.updated" && e.patch.permissionMode === "auto");
  assert.ok(switchAt > 0);
  const asked = evs.flatMap((e) => (e.type === "permission.asked" ? [e.request.id] : []));
  const resolved = new Set(evs.flatMap((e) => (e.type === "permission.resolved" ? [e.id] : [])));
  assert.ok(asked.every((id) => resolved.has(id)), "все запросы до переключения одобрены");
  assert.ok(!evs.slice(switchAt).some((e) => e.type === "permission.asked"), "после переключения вопросов нет");
  c.close();
});

test("opencode: пользовательский конфиг не потерялся при добавлении MCP хаба", async () => {
  // OPENCODE_CONFIG_CONTENT должен сливаться с ~/.config/opencode, а не заменять его
  const r = await api("GET", "/api/engines");
  const oc = r.json.find((e: { id: string }) => e.id === "opencode");
  const userModel = process.env.KAMHARN_EXPECT_PROVIDER;
  if (userModel) assert.ok(oc.models.some((m: { providerId: string }) => m.providerId === userModel), `нет провайдера ${userModel}`);
  assert.ok(oc.available);
});
