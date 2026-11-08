// Мозги Диспетчера: одна лента, движок под ней меняется. Лимит и вход Claude → запасной → обратно; без Claude — сразу на opencode;
// инструменты мозга на opencode не утекают к обычным сессиям.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BrainRef, ClaudeAuthInfo, EngineId, ModelInfo } from "@kamharn/protocol";
import { AutoResume } from "../../src/autoresume.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { Dispatcher, dispatcherPrompt, opencodeRules } from "../../src/dispatcher.ts";
import { authFailedText } from "../../src/engines/claude.ts";
import type { Engine, EngineSink, PermissionRule } from "../../src/engines/types.ts";
import { FileStore } from "../../src/files.ts";
import { registerMcp } from "../../src/mcp.ts";
import { SessionManager } from "../../src/sessions.ts";

const KIMI: BrainRef = { engine: "opencode", model: { providerId: "kimi", modelId: "k3" } };
const LIMIT = "You've hit your limit · resets 10:30pm";

interface Sent {
  esid: string;
  text: string;
  hidden?: string;
  hideUser?: boolean;
  system?: string;
  files: string[];
}

function fakeEngine(id: EngineId, opts: { auth?: () => ClaudeAuthInfo; models?: () => ModelInfo[] } = {}) {
  let sink!: EngineSink;
  let n = 0;
  const f = {
    sink: () => sink,
    sent: [] as Sent[],
    created: [] as Array<{ esid: string; extraRules?: PermissionRule[] }>,
    attached: [] as Array<{ esid: string; permissionMode: string; hasHistory: boolean }>,
    /** следующий ход вместо ответа упрётся: текст ошибки */
    failNext: undefined as string | undefined,
    engine: undefined as unknown as Engine,
  };
  f.engine = {
    id,
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => {
      const auth = opts.auth?.();
      const models: ModelInfo[] = opts.models?.() ?? [{ engine: id, providerId: id === "opencode" ? "kimi" : "anthropic", modelId: id === "opencode" ? "k3" : "claude-sonnet-5-5", name: "M", tools: true, vision: true }];
      return { id, available: auth ? auth.installed && auth.loggedIn : true, models, ...(auth ? { auth } : {}), defaultModel: { providerId: models[0]?.providerId ?? "x", modelId: models[0]?.modelId ?? "x" } };
    },
    createSession: async (o) => {
      const esid = `${id}-${++n}`;
      f.created.push({ esid, ...(o.extraRules ? { extraRules: o.extraRules } : {}) });
      return esid;
    },
    attach: (esid, o) => void f.attached.push({ esid, permissionMode: o.permissionMode, hasHistory: o.hasHistory }),
    prompt: async (esid, o) => {
      f.sent.push({ esid, text: o.text, ...(o.hidden ? { hidden: o.hidden } : {}), ...(o.hideUser ? { hideUser: true } : {}), ...(o.system ? { system: o.system } : {}), files: o.files.map((x) => x.fileId) });
      const mu = `u${Date.now()}${Math.random()}`;
      // повтор в ленту не идёт: так ведёт себя настоящий движок
      if (!o.hideUser) {
        sink.event(esid, { type: "message.upserted", message: { id: mu, role: "user", createdAt: Date.now() } });
        sink.event(esid, { type: "part.upserted", messageId: mu, part: { type: "text", id: `${mu}t`, text: o.text } });
      }
      sink.event(esid, { type: "session.updated", patch: { status: "busy" } });
      const fail = f.failNext;
      f.failNext = undefined;
      setTimeout(() => {
        if (fail) sink.event(esid, { type: "error", message: fail });
        else {
          const m = `a${Date.now()}${Math.random()}`;
          sink.event(esid, { type: "message.upserted", message: { id: m, role: "assistant", createdAt: Date.now() } });
          sink.event(esid, { type: "part.upserted", messageId: m, part: { type: "text", id: `${m}x`, text: `${id}: ${o.text}` } });
        }
        sink.event(esid, { type: "session.updated", patch: { status: "idle" } });
      }, 30);
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  return f;
}

const authOk: ClaudeAuthInfo = { installed: true, loggedIn: true, apiKey: false };

async function setup(o: { dispatcher?: Record<string, unknown>; auth?: () => ClaudeAuthInfo; models?: () => ModelInfo[]; noClaude?: boolean; base?: string } = {}) {
  const base = o.base ?? mkdtempSync(join(tmpdir(), "kh-brains-"));
  const root = join(base, "Projects");
  mkdirSync(root, { recursive: true });
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data"), artifactsHint: false, ...(o.dispatcher ? { dispatcher: o.dispatcher } : {}) });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  const claude = fakeEngine("claude", { auth: o.auth ?? (() => authOk) });
  const opencode = fakeEngine("opencode", { ...(o.models ? { models: o.models } : {}) });
  const notes: string[] = [];
  const mcp = { ensured: [] as Array<{ dir: string; names: string[]; config: Record<string, Record<string, unknown>> }>, released: [] as string[], status: {} as Record<string, { status: string }> };
  const releasedClaude: string[] = [];
  const dispatcher = new Dispatcher({
    sessions,
    config,
    files,
    screen: async () => Buffer.from("x"),
    notify: (_s, m) => notes.push(m),
    mcpBaseUrl: () => "http://hub/mcp/s",
    opencodeMcp: () => ({
      ensureMcp: async (dir, servers) => {
        mcp.ensured.push({ dir, names: Object.keys(servers), config: servers });
        return Object.fromEntries(Object.keys(servers).map((k) => [k, mcp.status[k] ?? { status: "connected" }]));
      },
      releaseMcp: async (_d, name) => void mcp.released.push(name),
    }),
    releaseClaude: (esid) => releasedClaude.push(esid),
    warmComputer: async () => true,
  });
  const resumes: string[] = [];
  const autoResume = new AutoResume(sessions, () => sessions.limits, (_s, m) => resumes.push(m), () => {}, undefined, undefined, (s) => dispatcher.handlesLimit(s));
  sessions.on("event", (e) => autoResume.onEvent(e));
  await sessions.addEngine(opencode.engine);
  if (!o.noClaude) await sessions.addEngine(claude.engine);
  const close = async () => {
    // ход поддельного движка заканчивается по таймеру: база ему ещё нужна
    await new Promise((r) => setTimeout(r, 60));
    autoResume.close();
    dispatcher.close();
    db.close();
  };
  return { base, root, config, db, sessions, files, claude, opencode, dispatcher, notes, mcp, releasedClaude, resumes, autoResume, close };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("не дождались");
    await sleep(10);
  }
}
/** Сколько пузырей пользователя и что в ленте. */
const userBubbles = (sessions: SessionManager, id: string) => {
  const users = new Set<string>();
  const texts: string[] = [];
  for (const e of sessions.eventsAfter(id, 0)) {
    if (e.event.type === "message.upserted" && e.event.message.role === "user") users.add(e.event.message.id);
    if (e.event.type === "part.upserted" && e.event.part.type === "text") texts.push(e.event.part.text);
  }
  return { users: users.size, texts };
};
function fullWindow(sessions: SessionManager, inMs = 3600_000): void {
  (sessions as unknown as { setLimits(l: unknown): void }).setLimits({ fiveHour: { utilization: 1, resetsAt: Date.now() + inMs }, updatedAt: Date.now() });
}

test("без запасного всё как раньше: остаётся на Claude, лимит ждёт автопродолжение", async () => {
  const t = await setup();
  try {
    const d = await t.dispatcher.ensure();
    assert.equal(d.engine, "claude");
    assert.equal(d.permissionMode, "auto");
    fullWindow(t.sessions);
    t.claude.failNext = LIMIT;
    await t.sessions.prompt(d.id, "привет");
    assert.equal(t.claude.sent.length, 1, "окно полное, а запасного нет: пробует как раньше");
    assert.equal(t.opencode.sent.length, 0);
    await until(() => (t.sessions.get(d.id).resumeAt ?? 0) > 0);
    assert.equal(t.sessions.get(d.id).engine, "claude");
    assert.equal(t.dispatcher.handlesLimit(t.sessions.get(d.id)), false);
  } finally {
    await t.close();
  }
});

test("окно лимита заполнено: сообщение сразу на запасном, скрытая сводка, отметка и один пуш; после сброса обратно", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    await t.sessions.prompt(d.id, "первое");
    await until(() => t.sessions.get(d.id).status === "idle" && t.claude.sent.length === 1);
    fullWindow(t.sessions, 1500);
    await t.sessions.prompt(d.id, "второе");
    assert.equal(t.claude.sent.length, 1, "Claude больше не дёргаем");
    assert.equal(t.opencode.sent.length, 1);
    const sent = t.opencode.sent[0]!;
    assert.equal(sent.text, "второе");
    assert.match(sent.hidden!, /первое/, "что было — в сводке");
    assert.match(sent.hidden!, /недоступен|unavailable/);
    assert.ok(!sent.hideUser, "обычное сообщение видно в ленте");
    assert.ok(sent.system && !sent.system.includes("AskUserQuestion"));
    assert.match(sent.system, /question/);
    assert.match(sent.system, /запасной|fallback/);

    const row = t.sessions.get(d.id);
    assert.equal(row.engine, "opencode");
    assert.deepEqual(row.model, KIMI.model);
    assert.equal(row.permissionMode, "acceptEdits");
    assert.equal(row.id, d.id, "лента та же");
    assert.deepEqual(t.releasedClaude.length, 1, "Windows-MCP Claude отпущен");
    assert.equal(t.notes.length, 1);
    assert.match(t.notes[0]!, /лимит|limit/);
    assert.ok(userBubbles(t.sessions, d.id).texts.some((x) => x.startsWith("⇄")), "отметка в ленте");
    assert.ok(t.opencode.created[0]!.extraRules?.length, "правила мозга на opencode");
    assert.deepEqual(t.mcp.ensured[0]!.names, ["krabness"], "галка управления ПК выключена — windows нет");
    assert.match(String(t.mcp.ensured[0]!.config.krabness!.url), /\/mcp\/s\/opencode-1$/, "скоуп — случайный id сессии");
    assert.equal(t.dispatcher.brains().active, "fallback");
    assert.equal(t.dispatcher.brains().reason, "limit");
    assert.ok(t.dispatcher.brains().until! > Date.now());

    // ещё сообщение: на том же, сводка второй раз не идёт, пуша нет
    await until(() => t.sessions.get(d.id).status === "idle");
    await t.sessions.prompt(d.id, "третье");
    assert.equal(t.opencode.sent.at(-1)!.hidden, undefined);
    assert.equal(t.notes.length, 1);
    await until(() => t.sessions.get(d.id).status === "idle");

    // лимит сбросился: следующее сообщение на Claude, он узнаёт, что было
    t.dispatcher["st"]().until = Date.now() - 1;
    await until(() => (t.sessions.limits?.fiveHour?.resetsAt ?? 0) < Date.now(), 2000);
    await t.sessions.prompt(d.id, "четвёртое");
    assert.equal(t.claude.sent.at(-1)!.text, "четвёртое");
    assert.equal(t.claude.sent.at(-1)!.esid, "claude-1", "та же сессия Claude");
    assert.match(t.claude.sent.at(-1)!.hidden!, /третье/);
    assert.doesNotMatch(t.claude.sent.at(-1)!.hidden!, /первое/, "то, что он сам видел, не повторяем");
    assert.equal(t.sessions.get(d.id).engine, "claude");
    assert.equal(t.sessions.get(d.id).permissionMode, "auto");
    assert.deepEqual(t.mcp.released, ["windows"]);
    assert.equal(t.notes.length, 2);
    assert.equal(t.resumes.length, 0, "автопродолжение не вмешивалось");
  } finally {
    await t.close();
  }
});

test("лимит посреди хода: сообщение повторяется один раз без второго пузыря, для голоса и пушей ход не кончался", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    t.claude.failNext = LIMIT;
    await t.sessions.prompt(d.id, "открой сайт");
    await until(() => t.opencode.sent.length === 1);
    const sent = t.opencode.sent[0]!;
    assert.equal(sent.text, "открой сайт");
    assert.equal(sent.hideUser, true);
    assert.match(sent.hidden!, /не повторяй|don't redo/);
    assert.equal(t.claude.sent.length, 1);
    assert.equal(userBubbles(t.sessions, d.id).users, 1, "пузырь один");
    assert.equal(t.sessions.get(d.id).resumeAt ?? 0, 0, "автопродолжение не назначено: оно запустило бы второго агента");
    await until(() => t.opencode.sent.length === 1 && t.sessions.get(d.id).status === "idle");
    assert.equal(t.dispatcher.rerouting(d.id), false);
  } finally {
    await t.close();
  }
});

test("пока идёт повтор, ход для голоса не кончился", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    t.claude.sink();
    await t.sessions.prompt(d.id, "x");
    await until(() => t.sessions.get(d.id).status === "idle");
    const esid = t.sessions.engineSessionIdOf(d.id)!;
    t.claude.sink().event(esid, { type: "error", message: LIMIT });
    assert.equal(t.dispatcher.rerouting(d.id), true);
    assert.equal(t.dispatcher.quiet(d.id), true, "пуш «готово» молчит");
  } finally {
    await t.close();
  }
});

test("команда CLI и ход хаба не повторяются на запасном", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    t.claude.failNext = LIMIT;
    await t.sessions.prompt(d.id, "/compact");
    await until(() => t.sessions.get(d.id).status === "idle" && !t.dispatcher.rerouting(d.id));
    await sleep(40);
    assert.equal(t.opencode.sent.length, 0);
  } finally {
    await t.close();
  }
});

test("запасному тоже плохо: ждём сброса лимита, как раньше", async () => {
  const t = await setup({ dispatcher: { fallback: { engine: "opencode", model: { providerId: "kimi", modelId: "пропала" } } } });
  try {
    const d = await t.dispatcher.ensure();
    t.claude.failNext = LIMIT;
    await t.sessions.prompt(d.id, "x");
    await until(() => (t.sessions.get(d.id).resumeAt ?? 0) > 0);
    assert.equal(t.opencode.sent.length, 0);
    assert.equal(t.sessions.get(d.id).engine, "claude");
  } finally {
    await t.close();
  }
});

test("нет входа в Claude: запасной; вошёл — обратно. Ошибка входа посреди хода тоже уводит", async () => {
  let auth = authOk;
  const t = await setup({ dispatcher: { fallback: KIMI }, auth: () => auth });
  try {
    const d = await t.dispatcher.ensure();
    assert.equal(d.engine, "claude");
    t.claude.failNext = authFailedText();
    auth = { ...authOk, loggedIn: false };
    await t.sessions.prompt(d.id, "посреди");
    // вход пропал уже к сообщению: сразу запасной
    assert.equal(t.claude.sent.length, 0);
    assert.equal(t.opencode.sent[0]!.text, "посреди");
    assert.equal(t.dispatcher.brains().reason, "auth");
    await until(() => t.sessions.get(d.id).status === "idle");
    auth = authOk;
    await t.sessions.prompt(d.id, "снова");
    assert.equal(t.claude.sent.at(-1)!.text, "снова");
    await until(() => t.sessions.get(d.id).status === "idle");
    // вход отвалился во время хода
    t.claude.failNext = authFailedText();
    await t.sessions.prompt(d.id, "во время");
    auth = { ...authOk, loggedIn: false };
    await until(() => t.opencode.sent.at(-1)!.text === "во время");
    assert.equal(t.opencode.sent.at(-1)!.hideUser, true);
  } finally {
    await t.close();
  }
});

test("без Claude Диспетчер сразу на opencode и остаётся там основным; без подходящих моделей — понятная ошибка", async () => {
  const t = await setup({ auth: () => ({ installed: true, loggedIn: false, apiKey: false }) });
  try {
    const d = await t.dispatcher.ensure();
    assert.equal(d.engine, "opencode");
    assert.equal(d.permissionMode, "acceptEdits");
    assert.ok(t.opencode.created[0]!.extraRules?.length);
    assert.equal(t.config.config.dispatcher?.primary?.engine, "opencode", "запомнен как основной");
    assert.equal(t.dispatcher.brains().active, "primary");
    await t.sessions.prompt(d.id, "привет");
    assert.equal(t.opencode.sent[0]!.hidden, undefined);
    assert.doesNotMatch(t.opencode.sent[0]!.system!, /Сейчас ты запасной|You are the fallback/);
    assert.doesNotMatch(t.opencode.sent[0]!.system!, /ask_model/, "Haiku нет, своего сервера нет");
    assert.doesNotMatch(t.opencode.sent[0]!.system!, /Opus или Sonnet|Opus or Sonnet/);
    assert.equal(t.notes.length, 0);
  } finally {
    await t.close();
  }
  const empty = await setup({ noClaude: true, models: () => [{ engine: "opencode", providerId: "x", modelId: "y", name: "Y", tools: false }] });
  try {
    await assert.rejects(empty.dispatcher.ensure(), /модель с инструментами|needs a model with tools/);
  } finally {
    await empty.close();
  }
});

test("занят или ждёт ответа: мозг не меняется", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    const esid = t.sessions.engineSessionIdOf(d.id)!;
    t.claude.sink().event(esid, { type: "permission.asked", request: { id: "r1", tool: "bash", title: "npm test", canAlways: false } });
    fullWindow(t.sessions);
    await t.sessions.prompt(d.id, "ещё");
    assert.equal(t.sessions.get(d.id).engine, "claude");
    assert.equal(t.claude.sent.length, 1);
  } finally {
    await t.close();
  }
});

test("рестарт на запасном: оба мозга подключены, скоупы верные, сводка не теряется", async () => {
  const first = await setup({ dispatcher: { fallback: KIMI } });
  const d = await first.dispatcher.ensure();
  await first.sessions.prompt(d.id, "на Claude");
  await until(() => first.sessions.get(d.id).status === "idle" && first.claude.sent.length === 1);
  await sleep(50);
  fullWindow(first.sessions);
  await first.sessions.prompt(d.id, "до рестарта");
  assert.equal(first.opencode.sent.length, 1);
  await until(() => first.sessions.get(d.id).status === "idle");
  await first.close();
  const again = await setup({ base: first.base, dispatcher: { fallback: KIMI } });
  try {
    assert.equal(again.sessions.get(d.id).engine, "opencode");
    assert.ok(again.claude.attached.some((a) => a.esid === "claude-1" && a.permissionMode === "auto" && a.hasHistory), "Claude подключён с --resume и своим режимом");
    assert.ok(again.opencode.attached.some((a) => a.esid === "opencode-1"));
    assert.equal(again.dispatcher.isScope("claude-1"), true);
    assert.equal(again.dispatcher.isScope("opencode-1"), true);
    assert.equal(again.dispatcher.isOpencodeBrain("opencode-1"), true);
    assert.equal(again.dispatcher.isOpencodeBrain("claude-1"), false);
    assert.equal(again.dispatcher.brains().active, "fallback");
  } finally {
    await again.close();
  }
});

test("удаление Диспетчера забывает оба мозга, новый создаётся с чистого листа", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    fullWindow(t.sessions);
    await t.sessions.prompt(d.id, "x");
    await until(() => t.sessions.get(d.id).status === "idle");
    t.sessions.delete(d.id);
    assert.equal(t.dispatcher.isScope("claude-1"), false);
    assert.equal(t.dispatcher.isScope("opencode-1"), false);
    (t.sessions as unknown as { lastLimits?: unknown }).lastLimits = undefined;
    writeFileSync(join(t.base, "data", "claude-limits.json"), "{}");
    const n = await t.dispatcher.ensure();
    assert.notEqual(n.id, d.id);
    assert.equal(n.engine, "claude");
  } finally {
    await t.close();
  }
});

test("управление ПК на opencode: нужна галка и модель со зрением; нет зрения или сервер не поднялся — в промпте его нет", async () => {
  if (process.platform !== "win32") return;
  let vision = false;
  const t = await setup({ auth: () => ({ installed: false, loggedIn: false, apiKey: false }), models: () => [{ engine: "opencode", providerId: "kimi", modelId: "k3", name: "K", tools: true, ...(vision ? { vision: true } : {}) }] });
  const uvxDir = join(t.base, "bin");
  mkdirSync(uvxDir);
  writeFileSync(join(uvxDir, "uvx.exe"), "");
  const oldPath = process.env.PATH;
  process.env.PATH = uvxDir;
  try {
    const d = await t.dispatcher.ensure();
    const send = async (x: string) => {
      await t.sessions.prompt(d.id, x);
      await until(() => t.sessions.get(d.id).status === "idle");
      return t.opencode.sent.at(-1)!.system!;
    };
    assert.doesNotMatch(await send("без галки"), /MCP windows/);
    assert.deepEqual(t.mcp.ensured.at(-1)!.names, ["krabness"]);

    await t.dispatcher.setBrains({ computerOnOpencode: true });
    assert.doesNotMatch(await send("без зрения"), /MCP windows/);
    assert.deepEqual(t.mcp.ensured.at(-1)!.names, ["krabness"]);

    vision = true;
    const on = await send("со зрением");
    assert.match(on, /MCP windows/);
    assert.deepEqual(t.mcp.ensured.at(-1)!.names, ["krabness", "windows"]);
    const w = t.mcp.ensured.at(-1)!.config.windows as { command: string[]; timeout: number };
    assert.match(w.command[0]!, /uvx\.exe$/);
    assert.ok(w.timeout >= 60_000);

    t.mcp.status.windows = { status: "failed" };
    assert.doesNotMatch(await send("не поднялся"), /MCP windows/, "обещать то, чего нет, нельзя");
    delete t.mcp.status.windows;

    await until(() => t.dispatcher.brains().computer.warm === "done");
  } finally {
    process.env.PATH = oldPath;
    await t.close();
  }
});

test("настройки: проверка модели, запасной на Claude при основном Claude не принимается, «вернуть на основной»", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.dispatcher.setBrains({ fallback: { engine: "opencode", model: { providerId: "kimi", modelId: "нет такой" } } }), /Нет модели|No model/);
    await assert.rejects(t.dispatcher.setBrains({ fallback: { engine: "claude", model: { providerId: "anthropic", modelId: "claude-sonnet-5-5" } } }), /лимит и вход|limit and the sign-in/);
    const r = await t.dispatcher.setBrains({ fallback: KIMI });
    assert.deepEqual(r.fallback, KIMI);
    assert.equal(t.config.config.dispatcher?.fallback?.model.modelId, "k3");

    const d = await t.dispatcher.ensure();
    fullWindow(t.sessions);
    await t.sessions.prompt(d.id, "x");
    await until(() => t.sessions.get(d.id).status === "idle");
    assert.equal(t.dispatcher.brains().active, "fallback");
    const back = await t.dispatcher.setBrains({ backToPrimary: true });
    assert.equal(back.active, "primary", "свободен — сразу");
    assert.equal(t.sessions.get(d.id).engine, "claude");
    // снова упёрся — запасной
    t.claude.failNext = LIMIT;
    await t.sessions.prompt(d.id, "y");
    await until(() => t.opencode.sent.at(-1)!.text === "y");

    // выключили запасной: опять Claude, лимит ждёт автопродолжение
    await until(() => t.sessions.get(d.id).status === "idle");
    await t.dispatcher.setBrains({ fallback: null });
    assert.equal(t.dispatcher.handlesLimit(t.sessions.get(d.id)), false);
    assert.equal(t.dispatcher.brains().fallback, null);
  } finally {
    await t.close();
  }
});

test("смена модели запасного в настройках применяется без смены движка: без сводки и пуша", async () => {
  const models: ModelInfo[] = [{ engine: "opencode", providerId: "kimi", modelId: "k3", name: "K", tools: true }, { engine: "opencode", providerId: "kimi", modelId: "k4", name: "K4", tools: true, efforts: ["low", "high"] }];
  const t = await setup({ auth: () => ({ installed: false, loggedIn: false, apiKey: false }), models: () => models });
  try {
    const d = await t.dispatcher.ensure();
    const r = await t.dispatcher.setBrains({ primary: { engine: "opencode", model: { providerId: "kimi", modelId: "k4" }, effort: "high" } });
    assert.equal(r.primary.effort, "high");
    assert.equal(t.sessions.get(d.id).model.modelId, "k4");
    assert.equal(t.sessions.get(d.id).effort, "high");
    assert.equal(t.notes.length, 0);
    assert.equal(t.opencode.created.length, 1, "сессия та же");
  } finally {
    await t.close();
  }
});

test("папка Диспетчера занята: обычная сессия opencode туда не создаётся, Claude — можно", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  try {
    const d = await t.dispatcher.ensure();
    await assert.rejects(t.sessions.create({ engine: "opencode", directory: d.directory }), /отдана Диспетчеру|belongs to the Dispatcher/);
    assert.ok(await t.sessions.create({ engine: "claude", directory: d.directory }));
    assert.ok(await t.sessions.create({ engine: "opencode", directory: t.root }));
  } finally {
    await t.close();
  }
});

test("MCP: мозг на opencode получает харнесс и не получает approve; общий скоуп и чужая сессия — нет", async () => {
  const t = await setup({ dispatcher: { fallback: KIMI } });
  const d = await t.dispatcher.ensure();
  fullWindow(t.sessions);
  await t.sessions.prompt(d.id, "x");
  await until(() => t.sessions.get(d.id).status === "idle");
  const other = await t.sessions.create({ engine: "opencode", directory: t.root });
  const app = Fastify();
  registerMcp(app, { secret: "s", files: t.files, claude: {} as never, claudeSessionDir: (esid) => t.sessions.directoryOf("claude", esid) ?? t.sessions.directoryOf("opencode", esid), dispatcher: t.dispatcher });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/s`;
  const names = async (scope: string) => {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/${scope}`)));
    const list = (await c.listTools()).tools.map((x) => x.name);
    await c.close();
    return list;
  };
  try {
    const brain = await names(t.sessions.engineSessionIdOf(d.id)!);
    for (const n of ["list_sessions", "send_to_session", "open_url", "show_screen", "send_file_to_user", "remember"]) assert.ok(brain.includes(n), n);
    assert.ok(!brain.includes("approve"), "у opencode свои разрешения");
    assert.ok(!brain.includes("ask_model") || t.dispatcher.askAvailable(), "ask_model только если есть кому отвечать");
    for (const scope of ["opencode", t.sessions.engineSessionIdOf(other.id)!, "ses_чужая"]) {
      const list = await names(encodeURIComponent(scope));
      assert.ok(!list.includes("send_to_session"), scope);
      assert.ok(!list.includes("open_url"), scope);
    }
  } finally {
    await app.close();
    await t.close();
  }
});

test("правила: незнакомое спрашивает, мышь без вопросов, ввод с вопросом, task запрещён, порядок верный", () => {
  const rules = opencodeRules();
  // как у opencode: последнее совпавшее
  const match = (p: string, r: string) => r === p || r === "*" || (r.endsWith("*") && p.startsWith(r.slice(0, -1)));
  const action = (p: string) => rules.filter((r) => match(p, r.permission) && r.pattern === "*").at(-1)?.action;
  for (const p of ["windows_Click", "windows_Screenshot", "windows_Scroll", "krabness_open_url", "read", "question", "doom_loop", "edit"]) assert.equal(action(p), "allow", p);
  for (const p of ["windows_Type", "windows_Shortcut", "windows_App", "windows_Clipboard", "windows_Новое", "bash", "external_directory", "мой_сервер_удалить"]) assert.equal(action(p), "ask", p);
  for (const p of ["task", "kamharn_send_file_to_user"]) assert.equal(action(p), "deny", p);
});

test("промпт Claude без отличий; отличия только у мозга на opencode", () => {
  const claude = dispatcherPrompt(true, "память", "дополнение");
  assert.match(claude, /AskUserQuestion/);
  assert.match(claude, /ask_model/);
  assert.match(claude, /Opus или Sonnet|Opus or Sonnet/);
  assert.doesNotMatch(claude, /krabness_/);
  const oc = dispatcherPrompt(true, "память", undefined, { ask: false });
  assert.doesNotMatch(oc, /AskUserQuestion/);
  assert.doesNotMatch(oc, /ask_model/);
  assert.match(oc, /krabness_list_sessions/);
  assert.match(dispatcherPrompt(false, "", undefined, { ask: true }), /ask_model/);
});
