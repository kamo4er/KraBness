// Импорт сессий Claude Code: разбор транскрипта (фикстура из реального ~/.claude/projects), список, импорт, форк.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRef, PermissionMode, SessionEvent, StoredEvent } from "@kamharn/protocol";
import { listTranscripts, transcriptHistory, userText } from "../../src/engines/claude-transcript.ts";
import { ClaudeEngine } from "../../src/engines/claude.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine } from "../../src/engines/types.ts";

const FIXTURE = join(import.meta.dirname, "../fixtures/claude-transcript.jsonl");
const ID = "35293a2c-0000-4000-8000-000000000001";

/** Копия фикстуры в «~/.claude/projects» с рабочей папкой cwd; extra — ещё транскрипты: id → поля строк (entrypoint и т. п.). */
function projects(cwd: string, extra: Record<string, Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "kamharn-cc-"));
  mkdirSync(join(dir, "proj"));
  const src = readFileSync(FIXTURE, "utf8").split("\n").filter(Boolean);
  for (const [id, fields] of Object.entries({ [ID]: {}, ...extra })) {
    const lines = src.map((l) => JSON.stringify({ ...JSON.parse(l), cwd, ...fields }));
    writeFileSync(join(dir, "proj", `${id}.jsonl`), lines.join("\n") + "\n");
  }
  return dir;
}

test("история: реплика, размышления, инструменты с результатами, ответ — по порядку", () => {
  const h = transcriptHistory(FIXTURE);
  assert.equal(h.skipped, 0);
  const parts = h.events.flatMap((e) => (e.type === "part.upserted" ? [e.part] : []));
  const user = parts.find((p) => p.type === "text" && p.id.startsWith("u_"));
  assert.ok(user && user.type === "text" && user.text.startsWith("Прочитай приложенный список покупок"));
  const tools = parts.flatMap((p) => (p.type === "tool" ? [p] : []));
  assert.deepEqual(tools.map((t) => t.tool), ["Read", "ToolSearch", "Write", "mcp__kamharn__send_file_to_user"]);
  assert.ok(tools.every((t) => t.status === "completed" && typeof t.output === "string"), "результаты инструментов подтянулись");
  // в транскрипте размышления сохранены пустыми (только подпись) — их не показываем
  assert.ok(!parts.some((p) => p.type === "reasoning" && !p.text));
  const last = parts.at(-1);
  assert.ok(last?.type === "text" && last.text.startsWith("Готово"));
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length, "id частей уникальны");
  const times = h.events.flatMap((e) => (e.type === "message.upserted" ? [e.message.createdAt] : []));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "сообщения по времени");
});

test("список: только разрешённые папки, без уже известных сессий", () => {
  const dir = projects("C:\\work\\app");
  const ok = (c: string) => (c.startsWith("C:\\work") ? c : undefined);
  const list = listTranscripts(dir, ok, new Set());
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, ID);
  assert.match(list[0]!.title, /^Прочитай приложенный/);
  assert.equal(listTranscripts(dir, () => undefined, new Set()).length, 0);
  assert.equal(listTranscripts(dir, ok, new Set([ID])).length, 0);
});

test("список: без claude -p (хаб, тесты), откуда сессия, регистр диска; скрытые — отдельно", () => {
  const VS = "35293a2c-0000-4000-8000-0000000000a1";
  const CLI = "35293a2c-0000-4000-8000-0000000000a2";
  const SDK = "35293a2c-0000-4000-8000-0000000000a3";
  // хаб запущен из терминала VS Code: entrypoint унаследован, но реплика от SDK
  const FAKE_VS = "35293a2c-0000-4000-8000-0000000000a4";
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const dir = projects(root, {
    [VS]: { entrypoint: "claude-vscode", turnOrigin: "human" },
    [CLI]: { entrypoint: "cli" },
    [SDK]: { entrypoint: "sdk-cli" },
    [FAKE_VS]: { entrypoint: "claude-vscode", turnOrigin: "sdk" },
  });
  const list = listTranscripts(dir, (c) => c, new Set());
  assert.deepEqual(list.map((t) => [t.id, t.source ?? "?"]).sort(), [[ID, "?"], [VS, "vscode"], [CLI, "cli"]].sort());
  // VS Code пишет «c:\…» — приводим к «C:\…», чтобы проекты не двоились
  const lower = projects("c:\\work\\app");
  assert.equal(listTranscripts(lower, (c) => c, new Set())[0]!.directory, "C:\\work\\app");

  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config), { claudeProjectsDir: dir });
  sessions.hideTranscript(VS, true);
  assert.deepEqual(sessions.claudeTranscripts().map((t) => t.id).sort(), [ID, CLI].sort());
  assert.deepEqual(sessions.claudeTranscripts(true).map((t) => t.id), [VS]);
  assert.ok(readFileSync(join(dir, "proj", `${VS}.jsonl`), "utf8").length > 0, "файл Claude не тронут");
  sessions.hideTranscript(VS, false);
  assert.equal(sessions.claudeTranscripts().length, 3);
  assert.deepEqual(sessions.claudeTranscripts(true), []);
  assert.throws(() => sessions.hideTranscript("../../x", true), /Неверный id/);
});

test("заголовок: вставки VS Code о файле и выделении не считаются словами пользователя", () => {
  const line = (...texts: string[]) => ({ type: "user", message: { content: texts.map((text) => ({ type: "text", text })) } });
  const ide = "<ide_opened_file>The user opened the file c:\\x\\a.css in the IDE.</ide_opened_file>";
  assert.equal(userText(line(ide, "Почини стили")), "Почини стили");
  assert.equal(userText(line(ide)), undefined);
  assert.equal(userText(line("<ide_selection>const a = 1</ide_selection>\nЧто это?")), "Что это?");
});

test("импорт: сессия-форк с историей в журнале; чужая папка — 403", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config), { claudeProjectsDir: projects(root) });
  const created: Array<{ forkFrom?: string; model: ModelRef; permissionMode: PermissionMode }> = [];
  const engine: Engine = {
    id: "claude",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "claude", available: true, models: [], defaultModel: { providerId: "anthropic", modelId: "claude-opus-5-5" } }),
    createSession: async (o) => (created.push(o), "new-engine-id"),
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  assert.equal(sessions.claudeTranscripts().length, 1);

  const s = await sessions.importClaude(ID);
  assert.equal(created[0]!.forkFrom, ID, "движок продолжает копию");
  assert.match(s.title, /^↪ Прочитай/);
  assert.equal(s.engine, "claude");
  const evs: StoredEvent[] = sessions.eventsAfter(s.id, 0);
  assert.ok(evs.some((e) => e.event.type === "part.upserted" && e.event.part.type === "tool" && e.event.part.tool === "Write"));
  assert.equal(sessions.claudeTranscripts().length, 0, "импортированная больше не предлагается");
  await assert.rejects(sessions.importClaude(ID), /уже/);
  sessions.delete(s.id);
  assert.equal(sessions.claudeTranscripts().length, 1, "после удаления копии — снова можно");
  await assert.rejects(sessions.importClaude("../../etc"), /Нет сессии/);
});

test("форк переживает перезапуск хаба и снимается после init", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kamharn-"));
  const model = { providerId: "anthropic", modelId: "claude-haiku-5-5" };
  const a = new ClaudeEngine({ dataDir, mcpBaseUrl: () => "", idleKillMs: 0 });
  const id = await a.createSession({ directory: "C:\\work", model, permissionMode: "acceptEdits", forkFrom: ID });
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "claude-forks.json"), "utf8")), { [id]: ID });

  // «после рестарта»
  const b = new ClaudeEngine({ dataDir, mcpBaseUrl: () => "", idleKillMs: 0 });
  const events: SessionEvent[] = [];
  (b as any).sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  b.attach(id, { directory: "C:\\work", model, permissionMode: "acceptEdits", hasHistory: true });
  assert.equal((b as any).sessions.get(id).forkFrom, ID);
  b.handle(id, { type: "system", subtype: "init", session_id: id });
  assert.equal((b as any).sessions.get(id).forkFrom, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "claude-forks.json"), "utf8")), {});
});
