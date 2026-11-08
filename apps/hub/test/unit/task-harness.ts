// Общая обвязка тестов задач: настоящий git (копия проекта, дифф, вливание), поддельные движки, ход агента — turn().
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineId, SessionEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { AutoCheck } from "../../src/checks.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

export function repo() {
  const root = mkdtempSync(join(tmpdir(), "kamharn-task-"));
  const dir = join(root, "Calc");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "sum.js"), "module.exports = (a, b) => a - b;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "старт");
  return { root, dir };
}

export async function setup(root: string, opts: { claudeOut?: boolean; gate?: boolean; throwOnGate?: boolean; fakeGit?: boolean; git?: (cwd: string, args: string[]) => Promise<string> } = {}) {
  const config = new ConfigStore(join(root, "cfg.json"), { roots: [root], dataDir: join(root, "data") });
  const db = new Db(join(root, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const sinks: Partial<Record<EngineId, EngineSink>> = {};
  /** что отправили каждому движку */
  const prompts: Array<{ engine: EngineId; esid: string; text: string }> = [];
  /** кого остановили */
  const aborts: string[] = [];
  let n = 0;
  const made: Record<string, number> = { claude: 0, opencode: 0 };
  /** с чем движки создавали сессии */
  const created: Array<{ engine: EngineId; confined: boolean }> = [];
  /** движок висит в createSession, пока тест не отпустит — для гонки с остановкой при запуске */
  let armed = false;
  let gone = false;
  let releaseGate: () => void;
  const gate = new Promise<void>((r) => void (releaseGate = r));
  const engine = (id: EngineId): Engine => ({
    id,
    start: async (s) => void (sinks[id] = s),
    stop: async () => {},
    info: async () => ({
      id,
      available: true,
      models: [],
      defaultModel: { providerId: id === "claude" ? "anthropic" : "opencode", modelId: id === "claude" ? "haiku" : "free" },
      // у человека нет ни подписки, ни ключа Claude
      ...(id === "claude" && opts.claudeOut ? { auth: { installed: true, loggedIn: false, apiKey: false } } : {}),
    }),
    createSession: async (o) => {
      created.push({ engine: id, confined: !!o.confined });
      if (opts.gate && armed) {
        await gate;
        if (opts.throwOnGate && gone) throw new Error("копию уже снесли");
      }
      return `${id}-${++made[id]!}`;
    },
    attach: () => {},
    prompt: async (esid, o) => void prompts.push({ engine: id, esid, text: o.text }),
    abort: async (esid) => {
      aborts.push(esid);
      // движок отвечает idle асинхронно (у Claude abort — запрос прерывания, процесс умирает позже)
      sinks[id]?.event(esid, { type: "session.updated", patch: { status: "idle" } } as SessionEvent);
    },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  });
  await sessions.addEngine(engine("claude"));
  await sessions.addEngine(engine("opencode"));
  const notices: string[] = [];
  const checks = new AutoCheck({ sessions, config, notify: () => {}, run: async (command) => ({ command, code: 0, ms: 1, output: "" }) });
  const tasks = new Orchestrator({
    sessions,
    db,
    config,
    autoCheck: checks,
    notify: (_s, m) => void notices.push(m),
    ...(opts.git ? { git: opts.git } : {}),
    // фиктивный git с задержкой — чтобы остановка пришла, пока конвейер ждёт diff
    ...(opts.fakeGit
      ? {
        git: async (_cwd: string, args: string[]) => {
          await tick(250);
          if (args[0] === "merge-base") return "abc123";
          if (args[0] === "diff" && args[1] === "--name-status") return "M\tsum.js";
          if (args[0] === "diff") return "diff --git a/sum.js b/sum.js\n+++ b/sum.js\n+module.exports = (a, b) => a + b;\n";
          return "";
        },
      }
      : {}),
  });
  /** дождаться состояния задачи (git в копии проекта идёт десятки-сотни мс) */
  const waitTask = async (id: string, pred: (t: ReturnType<typeof tasks.get>) => boolean, what = "состояния") => {
    for (let i = 0; i < 200; i++) {
      if (pred(tasks.get(id))) return tasks.get(id);
      await tick(25);
    }
    throw new Error(`не дождался ${what}: ${JSON.stringify(tasks.get(id).status)}`);
  };
  /** ход агента в сессии движка: busy → (ответ) → idle */
  const turn = async (eid: EngineId, esid: string, text: string) => {
    const sink = sinks[eid]!;
    sink.event(esid, { type: "session.updated", patch: { status: "busy" } } as SessionEvent);
    const mid = `m${++n}`;
    sink.event(esid, { type: "message.upserted", message: { id: mid, role: "assistant", createdAt: Date.now() } });
    sink.event(esid, { type: "part.upserted", messageId: mid, part: { type: "text", id: `${mid}:t`, text } });
    sink.event(esid, { type: "session.updated", patch: { status: "idle" } });
    await tick(60);
  };
  return { config, db, sessions, tasks, checks, prompts, notices, aborts, turn, waitTask, sinks, created, gate: { arm: () => void (armed = true), release: () => void releaseGate(), gone: () => void (gone = true) } };
}
