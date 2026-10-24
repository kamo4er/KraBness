// Живой тест движка Claude: настоящий `claude` CLI под подпиской пользователя, модель Haiku.
// Пропускается, если claude не установлен или не залогинен.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import type { ServerMessage, SessionInfo } from "@kamharn/protocol";
import { createHub, type Hub } from "../../src/hub.ts";
import type { HubConfig } from "../../src/config.ts";

const MODEL = { providerId: "anthropic", modelId: process.env.KAMHARN_TEST_CLAUDE_MODEL ?? "claude-haiku-5-5" };

let tmp: string;
let root: string;
let demo: string;
let hub: Hub;
let base: string;
let skip: string | false = false;

const overrides = (): Partial<HubConfig> => ({
  listen: ["127.0.0.1"],
  port: 0,
  dataDir: join(tmp, "data"),
  roots: [root],
  engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: true } },
});

async function start(): Promise<void> {
  hub = await createHub({ configPath: join(tmp, "kamharn.json"), overrides: overrides(), log: () => {} });
  base = hub.urls[0]!;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "kamharn-claude-"));
  root = join(tmp, "Projects");
  demo = join(root, "demo");
  mkdirSync(demo, { recursive: true });
  writeFileSync(join(demo, "README.md"), "# Demo\n");
  await start();
  const engines = await (await fetch(base + "/api/engines")).json();
  const c = engines.find((e: { id: string }) => e.id === "claude");
  if (!c?.available) skip = `claude недоступен: ${c?.error}`;
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

type Ev = Extract<ServerMessage, { t: "ev" }>;

class Client {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  constructor() {
    this.ws = new WebSocket(base.replace("http", "ws") + "/ws");
    this.ws.on("message", (raw) => this.msgs.push(JSON.parse(String(raw)) as ServerMessage));
  }
  open = () => new Promise<void>((res, rej) => this.ws.once("open", () => res()).once("error", rej));
  sub(sessionId: string) {
    this.ws.send(JSON.stringify({ t: "sub", sessionId, after: 0 }));
  }
  events = (sid: string) => this.msgs.filter((m): m is Ev => m.t === "ev" && m.sessionId === sid);
  async waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, ms?: number): Promise<T>;
  async waitFor(pred: (m: ServerMessage) => boolean, ms?: number): Promise<ServerMessage>;
  async waitFor(pred: (m: ServerMessage) => boolean, ms = 180_000): Promise<ServerMessage> {
    const deadline = Date.now() + ms;
    let from = 0;
    for (;;) {
      for (; from < this.msgs.length; from++) if (pred(this.msgs[from]!)) return this.msgs[from]!;
      if (Date.now() > deadline) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  /** ждёт idle после момента вызова */
  async idleAfter(sid: string, fromIdx: number, ms = 180_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = this.msgs.slice(fromIdx).some((m) => m.t === "ev" && m.sessionId === sid && m.event.type === "session.updated" && m.event.patch.status === "idle");
      if (hit) return;
      if (Date.now() > deadline) throw new Error("timeout waiting idle");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  close = () => this.ws.close();
}

let session: SessionInfo;

test("файл с телефона → Claude читает → просит разрешение на запись → отдаёт файл обратно", async (t) => {
  if (skip) return t.skip(skip);
  const created = await api("POST", "/api/sessions", { engine: "claude", directory: demo, model: MODEL, permissionMode: "manual" });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  session = created.json;

  const c = new Client();
  await c.open();
  c.sub(session.id);
  await c.waitFor((m) => m.t === "live");

  // загрузка «с телефона»
  const up = await fetch(`${base}/api/sessions/${session.id}/files?name=${encodeURIComponent("заметка.txt")}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "Код от сейфа: 4242\n",
  });
  assert.equal(up.status, 200);
  const file = await up.json();
  assert.ok(existsSync(join(demo, ".kamharn", "inbox")), "inbox создан");

  const mark = c.msgs.length;
  const p = await api("POST", `/api/sessions/${session.id}/prompt`, {
    text: "Прочитай приложенный файл. Создай в текущей папке файл answer.txt, в котором только код из него. Затем отправь мне answer.txt инструментом send_file_to_user. Ответь коротко.",
    fileIds: [file.fileId],
  });
  assert.equal(p.status, 200, JSON.stringify(p.json));

  // вложение видно в сообщении пользователя
  await c.waitFor((m) => m.t === "ev" && m.event.type === "part.upserted" && m.event.part.type === "file" && m.event.part.fileId === file.fileId);

  // отвечаем «разрешить» на все запросы (Write и, возможно, send_file_to_user)
  const answered = new Set<string>();
  const deadline = Date.now() + 180_000;
  for (;;) {
    for (const m of c.events(session.id)) {
      if (m.event.type === "permission.asked" && !answered.has(m.event.request.id)) {
        answered.add(m.event.request.id);
        const r = await api("POST", `/api/sessions/${session.id}/permissions/${m.event.request.id}`, { reply: "once" });
        assert.equal(r.status, 200, JSON.stringify(r.json));
      }
    }
    const idle = c.msgs.slice(mark).some((m) => m.t === "ev" && m.event.type === "session.updated" && m.event.patch.status === "idle");
    if (idle) break;
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 300));
  }

  const evs = c.events(session.id).map((e) => e.event);
  assert.ok(answered.size >= 1, "был хотя бы один запрос разрешения (Write в manual)");
  const writeAsk = evs.find((e) => e.type === "permission.asked" && /Write|Edit/.test(e.request.tool));
  assert.ok(writeAsk, "спросили про запись файла: " + evs.filter((e) => e.type === "permission.asked").map((e) => (e as any).request.tool).join(","));
  assert.ok(evs.some((e) => e.type === "permission.resolved" && e.by === "local"));

  assert.ok(existsSync(join(demo, "answer.txt")), "answer.txt создан");
  assert.match(readFileSync(join(demo, "answer.txt"), "utf8"), /4242/);

  const out = evs.find((e) => e.type === "part.upserted" && e.part.type === "file" && e.part.name === "answer.txt");
  assert.ok(out && out.type === "part.upserted" && out.part.type === "file", "исходящий файл в ленте");
  const dl = await fetch(`${base}/api/files/${out.part.fileId}`);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.match(buf.toString("utf8"), /4242/);
  assert.equal(createHash("sha256").update(buf).digest("hex"), dl.headers.get("x-sha256"), "sha256 совпадает");
  assert.match(dl.headers.get("content-disposition") ?? "", /answer\.txt/);

  // стрим текста был
  assert.ok(c.msgs.some((m) => m.t === "delta"));
  c.close();
});

test("отказ в разрешении: файл не создаётся", async (t) => {
  if (skip || !session) return t.skip(skip || "нет сессии");
  const c = new Client();
  await c.open();
  c.sub(session.id);
  await c.waitFor((m) => m.t === "live");
  const mark = c.msgs.length;
  await api("POST", `/api/sessions/${session.id}/prompt`, { text: "Создай файл denied.txt с текстом nope. Если не получится — просто скажи об этом, не пытайся обойти." });
  const ask = await c.waitFor((m): m is Ev => m.t === "ev" && m.event.type === "permission.asked" && c.msgs.indexOf(m) >= mark);
  const id = ask.event.type === "permission.asked" ? ask.event.request.id : "";
  await api("POST", `/api/sessions/${session.id}/permissions/${id}`, { reply: "reject" });
  // на повторные попытки тоже отказываем
  const stop = setInterval(async () => {
    for (const m of c.msgs.slice(mark)) {
      if (m.t === "ev" && m.event.type === "permission.asked" && m.event.request.id !== id) {
        await api("POST", `/api/sessions/${session.id}/permissions/${m.event.request.id}`, { reply: "reject" }).catch(() => {});
      }
    }
  }, 500);
  await c.idleAfter(session.id, mark);
  clearInterval(stop);
  assert.ok(!existsSync(join(demo, "denied.txt")), "файл не создан");
  c.close();
});

test("abort посреди ответа возвращает сессию в idle", async (t) => {
  if (skip || !session) return t.skip(skip || "нет сессии");
  const c = new Client();
  await c.open();
  c.sub(session.id);
  await c.waitFor((m) => m.t === "live");
  const mark = c.msgs.length;
  await api("POST", `/api/sessions/${session.id}/prompt`, { text: "Напиши очень длинный рассказ (минимум 1500 слов) про путешествие на Марс. Ничего не создавай в файлах." });
  await c.waitFor((m) => m.t === "delta" && c.msgs.indexOf(m) >= mark, 120_000);
  const t0 = Date.now();
  await api("POST", `/api/sessions/${session.id}/abort`, {});
  await c.idleAfter(session.id, mark, 20_000);
  assert.ok(Date.now() - t0 < 15_000, "остановилось быстро");
  c.close();
});

test("после перезапуска хаба Claude помнит контекст (--resume)", async (t) => {
  if (skip || !session) return t.skip(skip || "нет сессии");
  await hub.close();
  await start();
  const c = new Client();
  await c.open();
  c.sub(session.id);
  await c.waitFor((m) => m.t === "live");
  const mark = c.msgs.length;
  const r = await api("POST", `/api/sessions/${session.id}/prompt`, { text: "Какой код был в файле, который я присылал? Ответь только числом." });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await c.idleAfter(session.id, mark);
  const texts = c.events(session.id).slice().filter((e) => c.msgs.indexOf(e) >= mark)
    .flatMap((e) => (e.event.type === "part.upserted" && e.event.part.type === "text" ? [e.event.part.text] : []));
  assert.ok(texts.some((x) => /4242/.test(x)), "ответ: " + texts.join(" | "));
  c.close();
});
