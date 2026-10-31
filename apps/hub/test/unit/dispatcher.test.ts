// Диспетчер: своя сессия (Claude, «Автономно», свой промпт), пишет в другие сессии и ждёт их ответа,
// на необратимое «да» не говорит, инструменты управления харнессом в MCP — только у него.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import Fastify from "fastify";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EngineId, PermissionReply } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { computerExtras, DANGEROUS, Dispatcher, dispatcherPrompt, findUvx, WINDOWS_MCP } from "../../src/dispatcher.ts";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { registerMcp } from "../../src/mcp.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

interface Fake {
  engine: Engine;
  sink: () => EngineSink;
  prompts: Array<{ esid: string; text: string; system?: string }>;
  replies: Array<{ esid: string; id: string; reply: PermissionReply }>;
}

function fakeEngine(id: EngineId): Fake {
  let sink!: EngineSink;
  let n = 0;
  const f: Fake = { engine: undefined as unknown as Engine, sink: () => sink, prompts: [], replies: [] };
  f.engine = {
    id,
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id, available: true, models: [{ engine: id, providerId: "p", modelId: "m", name: "M" }], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => `${id}-${++n}`,
    attach: () => {},
    // ход: «работает» → ответ «готово: …» → «ждёт»
    prompt: async (esid, o) => {
      f.prompts.push({ esid, text: o.text, ...(o.system ? { system: o.system } : {}) });
      sink.event(esid, { type: "session.updated", patch: { status: "busy" } });
      setTimeout(() => {
        const mid = `m${Date.now()}${Math.random()}`;
        sink.event(esid, { type: "message.upserted", message: { id: mid, role: "assistant", createdAt: Date.now() } });
        sink.event(esid, { type: "part.upserted", messageId: mid, part: { type: "tool", id: mid + "t", tool: "Bash", status: "completed", input: {} } as never });
        sink.event(esid, { type: "part.upserted", messageId: mid, part: { type: "text", id: mid + "x", text: `готово: ${o.text}` } });
        sink.event(esid, { type: "session.updated", patch: { status: "idle" } });
      }, 150);
    },
    abort: async () => {},
    replyPermission: async (esid, rid, reply) => void f.replies.push({ esid, id: rid, reply }),
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  return f;
}

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "kh-disp-"));
  const root = join(base, "Projects");
  mkdirSync(join(root, "Shop"), { recursive: true });
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data"), artifactsHint: false });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  const claude = fakeEngine("claude");
  const opencode = fakeEngine("opencode");
  await sessions.addEngine(claude.engine);
  await sessions.addEngine(opencode.engine);
  const created: string[] = [];
  const dispatcher = new Dispatcher({ sessions, config, files, screen: async () => Buffer.from("fake-jpg"), tasks: { create: async (r) => (created.push(r.goal), { id: "tk_1", title: "t", goal: r.goal } as never) } });
  return { base, root, config, sessions, files, claude, opencode, dispatcher, created };
}

test("своя сессия: Claude, «Автономно», папка Dispatcher, свой промпт; повторно — та же", async () => {
  const { root, sessions, claude, dispatcher } = await setup();
  assert.equal(dispatcher.session(), undefined);
  const d = await dispatcher.ensure();
  assert.equal(d.kind, "dispatcher");
  assert.equal(d.engine, "claude");
  assert.equal(d.model.modelId, "claude-opus-5-5");
  assert.equal(d.permissionMode, "auto");
  assert.equal(d.directory, join(root, "Dispatcher"));
  assert.ok(existsSync(join(root, "Dispatcher")));
  assert.equal((await dispatcher.ensure()).id, d.id);
  await sessions.prompt(d.id, "привет");
  assert.ok(claude.prompts[0]!.system?.startsWith(dispatcherPrompt(false)), "промпт Диспетчера уходит движку");
  // обычные сессии его не получают
  const w = await sessions.create({ engine: "claude", directory: root });
  await sessions.prompt(w.id, "x");
  assert.equal(claude.prompts[1]!.system, undefined);
  assert.equal(dispatcher.isScope(sessions.engineSessionIdOf(d.id)!), true);
  assert.equal(dispatcher.isScope(sessions.engineSessionIdOf(w.id)!), false);
});

test("пишет в сессию с пометкой, ждёт конец хода и пересказывает; свою сессию не трогает", async () => {
  const { root, sessions, opencode, dispatcher } = await setup();
  const d = await dispatcher.ensure();
  const w = await sessions.create({ engine: "opencode", directory: join(root, "Shop"), title: "Магазин" });
  assert.match(dispatcher.listSessions(), new RegExp(`${w.id} · Магазин · idle`));
  assert.doesNotMatch(dispatcher.listSessions(), new RegExp(d.id), "себя в списке не показывает");
  await dispatcher.send(w.id, "почини корзину");
  assert.equal(opencode.prompts.at(-1)!.text, "[Диспетчер] почини корзину");
  const t0 = Date.now();
  const out = await dispatcher.wait(w.id, 10);
  assert.ok(Date.now() - t0 < 3000, `вернулся по концу хода, а не по таймауту (${Date.now() - t0} мс)`);
  assert.match(out, /готово: \[Диспетчер\] почини корзину/);
  assert.match(out, /инструменты: Bash/);
  assert.match(dispatcher.listSessions(), /↳ готово/);
  await assert.rejects(dispatcher.send(d.id, "x"), /самого Диспетчера/);
});

test("разрешения: обычное — отвечает, необратимое — отказ без ответа движку", async () => {
  const { root, sessions, opencode, dispatcher } = await setup();
  const w = await sessions.create({ engine: "opencode", directory: root });
  const esid = sessions.engineSessionIdOf(w.id)!;
  opencode.sink().event(esid, { type: "permission.asked", request: { id: "r1", tool: "bash", title: "git push origin main", canAlways: true } });
  opencode.sink().event(esid, { type: "permission.asked", request: { id: "r2", tool: "bash", title: "npm test", canAlways: true } });
  const tail = dispatcher.readSession(w.id);
  assert.match(tail, /request_id=r1 · bash: git push origin main/);
  // wait сразу возвращается: сессия ждёт ответа
  assert.match(await dispatcher.wait(w.id, 10), /request_id=r2/);
  assert.match(await dispatcher.answer(w.id, "r1", "once"), /необратимое/);
  assert.match(await dispatcher.answer(w.id, "r1", "reject"), /reject/, "отказать можно");
  assert.match(await dispatcher.answer(w.id, "r2", "once"), /once/);
  assert.deepEqual(opencode.replies.map((r) => [r.id, r.reply]), [["r1", "reject"], ["r2", "once"]]);
  await assert.rejects(dispatcher.answer(w.id, "nope", "once"), /Такого запроса нет/);
  for (const s of ["git push", "rm -rf build", "Remove-Item x", "DROP TABLE users", "del /q a.txt", "git reset --hard HEAD~1"]) assert.ok(DANGEROUS.test(s), s);
  for (const s of ["npm test", "git status", "git commit -m x", "npm run build", "rmdirs.txt"]) assert.ok(!DANGEROUS.test(s), s);
});

test("задачи и модели", async () => {
  const { root, dispatcher, created } = await setup();
  assert.match(await dispatcher.createTask({ goal: "сделай отчёт", directory: root }), /tk_1/);
  assert.deepEqual(created, ["сделай отчёт"]);
  assert.match(await dispatcher.listModels(), /claude: p\/m/);
  assert.match(await dispatcher.createSession({ directory: root, engine: "opencode", model: { providerId: "p", modelId: "m" } }), /Создана сессия ks_/);
});

test("MCP: инструменты харнесса только в скоупе Диспетчера", async () => {
  const { root, sessions, files, dispatcher } = await setup();
  const d = await dispatcher.ensure();
  const w = await sessions.create({ engine: "claude", directory: root, title: "Обычная" });
  const app = Fastify();
  registerMcp(app, { secret: "s3", files, claudeSessionDir: () => root, dispatcher });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/mcp/s3`;
  const tools = async (scope: string) => {
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/${scope}`)));
    const names = (await c.listTools()).tools.map((t) => t.name);
    return { c, names };
  };
  try {
    const mine = await tools(sessions.engineSessionIdOf(d.id)!);
    for (const n of ["list_sessions", "read_session", "send_to_session", "wait_session", "answer_request", "create_session", "create_task", "list_models", "show_screen"]) assert.ok(mine.names.includes(n), n);
    const shot = (await mine.c.callTool({ name: "show_screen", arguments: {} })) as { content: Array<{ text: string }> };
    const fid = /kamharn-file:(kf_\w+)/.exec(shot.content[0]!.text)?.[1];
    assert.ok(fid, "маркер файла в выводе");
    const f = files.get(fid!)!;
    assert.ok(f.path.startsWith(join(root, "Dispatcher", ".kamharn", "screens")), f.path);
    assert.equal(readFileSync(f.path, "utf8"), "fake-jpg");
    const r = (await mine.c.callTool({ name: "list_sessions", arguments: {} })) as { content: Array<{ text: string }> };
    assert.match(r.content[0]!.text, /Обычная/);
    const bad = (await mine.c.callTool({ name: "read_session", arguments: { session_id: "ks_nope" } })) as { isError?: boolean };
    assert.equal(bad.isError, true);
    await mine.c.close();
    const other = await tools(sessions.engineSessionIdOf(w.id)!);
    assert.ok(!other.names.includes("send_to_session"), "у обычной сессии нет");
    assert.ok(other.names.includes("send_file_to_user"));
    await other.c.close();
  } finally {
    await app.close();
  }
});

test("компьютер: uvx находится, Windows-MCP закреплён и урезан, дополнения — только сессии Диспетчера", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-uvx-"));
  const bin = join(base, "bin");
  mkdirSync(bin);
  const exe = join(bin, process.platform === "win32" ? "uvx.exe" : "uvx");
  writeFileSync(exe, "");
  assert.equal(findUvx({ PATH: bin }), exe);
  assert.equal(findUvx({ PATH: join(base, "nope"), LOCALAPPDATA: join(base, "nope") }), existsSync(join(homedir(), ".local", "bin", process.platform === "win32" ? "uvx.exe" : "uvx")) ? join(homedir(), ".local", "bin", process.platform === "win32" ? "uvx.exe" : "uvx") : undefined);

  const x = computerExtras(exe);
  const w = x.mcp.windows as { command: string; args: string[]; env: Record<string, string> };
  assert.equal(w.command, exe);
  assert.equal(w.args[0], WINDOWS_MCP);
  assert.match(WINDOWS_MCP, /==\d+\.\d+\.\d+$/, "версия закреплена");
  const excluded = w.args[w.args.indexOf("--exclude-tools") + 1]!.split(",");
  for (const t of ["PowerShell", "FileSystem", "Registry", "Process"]) assert.ok(excluded.includes(t), t);
  assert.equal(w.env.ANONYMIZED_TELEMETRY, "false");
  assert.ok(x.allowedTools.includes("mcp__windows__Snapshot"));
  assert.ok(!x.allowedTools.includes("mcp__windows__Type"), "ввод текста — через классификатор");
  assert.match(dispatcherPrompt(true), /AskUserQuestion/);
  assert.doesNotMatch(dispatcherPrompt(false), /MCP windows/);

  // движок: дополнения попадают в аргументы и mcp-файл только своей сессии
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0, sessionExtras: (esid) => (esid === "disp" ? x : undefined) });
  const haiku = { providerId: "anthropic", modelId: "claude-haiku-5-5" };
  engine.attach("disp", { directory: base, model: haiku, permissionMode: "auto", hasHistory: false });
  engine.attach("other", { directory: base, model: haiku, permissionMode: "auto", hasHistory: false });
  const sessOf = (id: string) => (engine as unknown as { sessions: Map<string, unknown> }).sessions.get(id);
  const allowed = (id: string) => {
    const a = engine.procArgs(sessOf(id) as never, "m.json");
    return a[a.indexOf("--allowedTools") + 1]!;
  };
  assert.equal(allowed("other"), "mcp__kamharn");
  assert.match(allowed("disp"), /^mcp__kamharn,mcp__windows__Screenshot,/);
});

test("память и поиск: файлы памяти в промпте, remember дописывает, search_history находит по всем чатам", async () => {
  const { root, sessions, claude, opencode, dispatcher } = await setup();
  const d = await dispatcher.ensure();
  const dir = join(root, "Dispatcher");
  assert.ok(existsSync(join(dir, "USER.md")) && existsSync(join(dir, "MEMORY.md")), "файлы памяти созданы");
  await sessions.prompt(d.id, "x");
  assert.match(claude.prompts.at(-1)!.system!, /\(пока пусто\)/, "пустые заготовки в промпт не идут");
  assert.match(dispatcher.remember("Зовут Ваня, жена Аня", "user"), /USER\.md/);
  dispatcher.remember("Прокси Claude — только через VPS", "notes");
  assert.match(readFileSync(join(dir, "USER.md"), "utf8"), /^- Зовут Ваня, жена Аня \(\d{4}-\d{2}-\d{2}\)$/m);
  await sessions.prompt(d.id, "y");
  const sys = claude.prompts.at(-1)!.system!;
  assert.match(sys, /<USER\.md>[\s\S]*жена Аня[\s\S]*<\/USER\.md>/);
  assert.match(sys, /<MEMORY\.md>[\s\S]*только через VPS/);

  // поиск: текст ответа агента в другой сессии попадает в индекс сразу
  const w = await sessions.create({ engine: "opencode", directory: root, title: "Генерация картинок" });
  await sessions.prompt(w.id, "почему GigaChat падает через прокси");
  await new Promise((r) => setTimeout(r, 300));
  const found = dispatcher.searchHistory("gigachat прокс");
  assert.match(found, new RegExp(`${w.id} · Генерация картинок · агент`));
  assert.match(found, /\*\*GigaChat\*\*/);
  assert.match(dispatcher.searchHistory("несуществующееслово"), /Ничего не нашлось/);
  // удалили сессию — из поиска пропала
  sessions.delete(w.id);
  assert.match(dispatcher.searchHistory("gigachat"), /Ничего не нашлось/);
  void opencode;
});

test("поиск: старая история попадает в индекс один раз, повтор части заменяет текст", () => {
  const base = mkdtempSync(join(tmpdir(), "kh-search-"));
  const db = new Db(join(base, "t.db"));
  db.setMeta("search.v1", ""); // как до появления поиска: метки нет
  db.insertSession({ id: "s1", engine: "opencode", engineSessionId: "e1", directory: base, title: "Старая", model: { providerId: "p", modelId: "m" }, permissionMode: "auto", status: "idle", createdAt: 1, updatedAt: 1, lastSeq: 0 });
  db.appendEvent("s1", { type: "message.upserted", message: { id: "m1", role: "user", createdAt: 1 } });
  db.appendEvent("s1", { type: "part.upserted", messageId: "m1", part: { type: "text", id: "p1", text: "черновик" } });
  db.appendEvent("s1", { type: "part.upserted", messageId: "m1", part: { type: "text", id: "p1", text: "настрой маршрутизатор Keenetic" } });
  assert.equal(db.backfillSearch(), 1);
  assert.equal(db.backfillSearch(), 0, "второй раз не идёт");
  const hits = db.searchText("маршрутиз");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.role, "user");
  assert.equal(db.searchText("черновик").length, 0, "старая версия части заменена");
});

test("ask_model: quick — Haiku, local — локальный сервер, он молчит — Haiku с пометкой", async () => {
  const { sessions, config, files } = await setup();
  const asked: Array<[string, string]> = [];
  const d = new Dispatcher({ sessions, config, files, ask: async (p, m) => (asked.push([p, m]), `haiku: ${p}`) });
  assert.equal(await d.askModel("quick", "перескажи"), "haiku: перескажи");
  assert.deepEqual(asked.at(-1), ["перескажи", "claude-haiku-5-5"]);
  // поддельная Strata
  const got: unknown[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c)).on("end", () => {
      got.push(JSON.parse(b));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "локально: ок" } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  config.config.dispatcher = { local: { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`, model: "strata" } };
  assert.equal(await d.askModel("local", "классифицируй"), "локально: ок");
  assert.deepEqual((got[0] as { model: string; messages: unknown[] }).model, "strata");
  await new Promise((r) => srv.close(r));
  // сервер выключен — ответил Haiku
  assert.match(await d.askModel("local", "ещё"), /^haiku: ещё\n\n\(локальная модель не ответила/);
});
