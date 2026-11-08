// Группа «без моих правил»: сессии Claude в ней запускаются без ~/.claude/CLAUDE.md и ~/.claude/rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRef } from "@kamharn/protocol";
import { ClaudeEngine, NO_USER_RULES } from "../../src/engines/claude.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine } from "../../src/engines/types.ts";

const haiku: ModelRef = { providerId: "anthropic", modelId: "claude-haiku-5-5" };

test("claude: без правил — --settings с claudeMdExcludes, переключение перезапускает простаивающий процесс", async () => {
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  const e = engine as unknown as {
    sessions: Map<string, { busy: boolean; proc?: unknown }>;
    ensureProc: (s: unknown) => unknown;
    killProc: (s: { proc?: unknown }) => void;
  };
  engine.attach("s1", { directory: "C:\\work", model: haiku, permissionMode: "manual", hasHistory: true });
  const starts: string[][] = [];
  let kills = 0;
  e.ensureProc = (s) => {
    const sess = s as { proc?: unknown };
    if (!sess.proc) {
      starts.push(engine.procArgs(s as never, "m.json"));
      sess.proc = { exitCode: null, stdin: { write: () => true, end: () => {} } };
    }
    return sess.proc;
  };
  e.killProc = (s) => {
    kills++;
    s.proc = undefined;
  };
  const sess = e.sessions.get("s1")!;
  const turn = async (noUserRules?: boolean) => {
    await engine.prompt("s1", { text: "hi", files: [], model: haiku, ...(noUserRules ? { noUserRules } : {}) });
    sess.busy = false;
  };

  await turn();
  assert.ok(!starts[0]!.includes("--settings"), "по умолчанию правила грузятся");
  await turn(true);
  assert.equal(kills, 1, "включили — перезапуск");
  const args = starts.at(-1)!;
  assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!), { claudeMdExcludes: NO_USER_RULES });
  assert.ok(args.includes("--resume"), "история продолжается");
  await turn(true);
  assert.equal(kills, 1, "то же — без перезапуска");
  await engine.compact("s1", { model: haiku, noUserRules: true });
  assert.equal(kills, 1, "сжатие не сбрасывает настройку");
  sess.busy = false;
  await turn();
  assert.equal(kills, 2, "выключили — снова перезапуск");
  assert.ok(!starts.at(-1)!.includes("--settings"));
});

test("группа: «без моих правил» хранится и уходит движку у сессий группы", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-grules-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data"), artifactsHint: false });
  const dbPath = join(base, "t.db");
  const db = new Db(dbPath);
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const sent: Array<{ system?: string; noUserRules?: boolean }> = [];
  const engine: Engine = {
    id: "claude",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "claude", available: true, models: [], defaultModel: haiku }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async (_, o) => void sent.push({ ...(o.system ? { system: o.system } : {}), ...(o.noUserRules ? { noUserRules: true } : {}) }),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const g = sessions.createGroup({ name: "Дом", prompt: "Ты врач", noUserRules: true });
  assert.equal(g.noUserRules, true);
  assert.equal(new Db(dbPath).getGroup(g.id)?.noUserRules, true, "в базе");
  const s = await sessions.create({ engine: "claude", directory: root, groupId: g.id });
  await sessions.prompt(s.id, "раз");
  // правка промпта не трогает галку
  sessions.updateGroup(g.id, { prompt: "Ты педиатр" });
  await sessions.prompt(s.id, "два");
  sessions.updateGroup(g.id, { noUserRules: false });
  await sessions.prompt(s.id, "три");
  assert.deepEqual(sent, [
    { system: "Ты врач", noUserRules: true },
    { system: "Ты педиатр", noUserRules: true },
    { system: "Ты педиатр" },
  ]);
  assert.equal(sessions.groups()[0]!.noUserRules, undefined);
});
