// Задачи: исполнитель в своей копии проекта → проверки → ревью → правки → отчёт и решение.
// Git настоящий (копия проекта, дифф, вливание), движки поддельные: «работу агента» пишем файлами сами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineId, SessionEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { AutoCheck } from "../../src/checks.ts";
import { Orchestrator, MAX_REVIEWS } from "../../src/orchestrator.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function repo() {
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

async function setup(root: string, opts: { claudeOut?: boolean; gate?: boolean; throwOnGate?: boolean; fakeGit?: boolean; git?: (cwd: string, args: string[]) => Promise<string> } = {}) {
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

test("задача: исполнитель → ревью с замечаниями → правки → чистое ревью → отчёт → влить", async () => {
  const { root, dir } = repo();
  const { sessions, tasks, prompts, notices, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение в sum.js", directory: dir });
  assert.equal(t0.status, "running");
  assert.ok(t0.workerSessionId, "есть сессия исполнителя");
  assert.ok(t0.worktree?.path, "есть копия проекта");
  assert.deepEqual(t0.reviewModel, { providerId: "opencode", modelId: "free" }, "ревью бесплатной моделью по умолчанию");
  assert.match(prompts.at(-1)!.text, /Почини сложение/);
  assert.match(prompts.at(-1)!.text, /отдельной копии проекта/);
  // сессии задачи помечены и не болтаются в общем списке
  assert.equal(sessions.get(t0.workerSessionId!).taskId, t0.id);

  // «агент» поработал в копии проекта
  const wt = t0.worktree!.path;
  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => a + b;\n");
  writeFileSync(join(wt, "NEW.md"), "новый файл\n");
  await turn("claude", "claude-1", "Починил оператор в sum.js.");

  let t = await waitTask(t0.id, (x) => !!x.reviewSessionId, "сессии ревью");
  assert.equal(t.status, "running");
  const rp = prompts.at(-1)!;
  assert.equal(rp.engine, "opencode");
  assert.match(rp.text, /a \+ b/, "в ревью ушёл дифф");
  assert.match(rp.text, /NEW\.md/, "новые файлы тоже в диффе");
  assert.match(rp.text, /ЧИСТО/, "как ответить, если замечаний нет");

  await turn("opencode", "opencode-1", "sum.js:1 — нет проверки аргументов — добавь.");
  t = await waitTask(t0.id, (x) => x.reviews === 1, "первого ревью");
  assert.equal(t.status, "running");
  assert.match(prompts.at(-1)!.text, /нет проверки аргументов/, "замечания ушли исполнителю");
  assert.equal(prompts.at(-1)!.engine, "claude");

  await turn("claude", "claude-1", "Добавил проверку.");
  await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "review", "второго ревью");
  await turn("opencode", "opencode-1", "ЧИСТО");
  t = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(t.report?.review, "fixed");
  assert.equal(t.report?.checks, "none", "команд проверки нет — проверок не было");
  assert.match(t.report?.summary ?? "", /Добавил проверку/);
  assert.deepEqual(t.report?.files.map((f) => f.path).sort(), ["NEW.md", "sum.js"]);
  assert.ok(notices.some((m) => /готова|ready/i.test(m)), notices.join("|"));

  const merged = await tasks.act(t.id, { action: "merge" });
  assert.equal(merged.status, "merged");
  assert.ok(merged.report?.commit, "коммит в основной ветке");
  assert.equal(readFileSync(join(dir, "sum.js"), "utf8"), "module.exports = (a, b) => a + b;\n");
  assert.equal(git(dir, "log", "-1", "--pretty=%s"), t.title);
  // влитую задачу выбросить нельзя — в истории должно остаться, что её влили
  await assert.rejects(tasks.act(t.id, { action: "discard" }), /Выбросить можно|Discard is only/i);
});

test("по задаче идёт только одно действие: «влить» и «выбросить» не пересекаются", async () => {
  const { root, dir } = repo();
  const { tasks, sessions, turn, waitTask } = await setup(root);
  const realMerge = sessions.mergeWorktree.bind(sessions);
  sessions.mergeWorktree = async (id: string) => { await tick(150); return realMerge(id); };
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, reviewModel: null });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  const ready = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  const first = tasks.act(ready.id, { action: "merge" });
  await tick(50);
  const second = await tasks.act(ready.id, { action: "discard" }).catch((e: Error & { status?: number }) => e);
  assert.equal(second.status, 409, "второе действие получает 409, а не работает параллельно");
  assert.match(second.message, /обрабатывается|already being handled/i);
  const merged = await first;
  assert.equal(merged.status, "merged", "вливание не затёрто выбросом");
  assert.ok(merged.report?.commit, "коммит в основной ветке");
  // действие закончилось — задача снова свободна: влитую выбросить нельзя
  await assert.rejects(tasks.act(ready.id, { action: "discard" }), /Выбросить можно|Discard is only/i);
});

test("ревью молчит про замечания до MAX_REVIEWS кругов, дальше зовёт пользователя; «ещё круг» и «выбросить»", async () => {
  const { root, dir } = repo();
  const { tasks, prompts, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Добавь комментарий", directory: dir });
  const wt = t0.worktree!.path;
  writeFileSync(join(wt, "sum.js"), "// складываем\nmodule.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  for (let i = 0; i < MAX_REVIEWS; i++) {
    await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "review", "ревью");
    await turn("opencode", "opencode-1", `Замечание ${i + 1}: мало комментариев.`);
    if (i < MAX_REVIEWS - 1) {
      await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "fix", "правок");
      await turn("claude", "claude-1", "Поправил.");
    }
  }
  let t = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(t.reviews, MAX_REVIEWS);
  assert.equal(t.report?.review, "remarks");
  assert.match(t.report?.reviewText ?? "", /Замечание 2/);

  // «ещё круг» с комментарием: снова исполнитель, круги ревью с нуля
  t = await tasks.act(t.id, { action: "more", comment: "Добавь ещё примеры" });
  assert.equal(t.status, "running");
  assert.equal(t.reviews, 0);
  assert.match(prompts.at(-1)!.text, /Добавь ещё примеры/);
  await turn("claude", "claude-1", "Добавил примеры.");
  await waitTask(t.id, (x) => x.steps.at(-1)?.kind === "review", "ревью");
  await turn("opencode", "opencode-1", "ЧИСТО");
  await waitTask(t.id, (x) => x.status === "ready", "отчёта");

  // «выбросить»: копия проекта возвращается к основной ветке
  const after = await tasks.act(t.id, { action: "discard" });
  assert.equal(after.status, "discarded");
  assert.equal(readFileSync(join(wt, "sum.js"), "utf8"), "module.exports = (a, b) => a - b;\n");
  // остановленную задачу «ещё круг» не оживляет, влитую — не выбросить
  await assert.rejects(tasks.act(t.id, { action: "more", comment: "ещё раз" }), /готовой или упавшей|ready or failed/i);
});

test("без ревью: после исполнителя сразу отчёт; автопроверка — часть отчёта", async () => {
  const { root, dir } = repo();
  const { config, tasks, turn, prompts, waitTask } = await setup(root);
  config.setChecks(dir, ["npm test"]);
  const t0 = await tasks.create({ goal: "Поправь", directory: dir, reviewModel: null });
  assert.equal(t0.reviewModel, undefined);
  writeFileSync(join(t0.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Сделал.");
  const t = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(t.report?.checks, "passed", "автопроверка прошла");
  assert.equal(t.report?.review, "skipped");
  assert.equal(prompts.filter((p) => p.engine === "opencode").length, 0, "сессию ревью не создавали");
});

test("лимит Claude: задача ждёт, после сброса продолжает; чужая ошибка — задача сломалась", async () => {
  const { root, dir } = repo();
  const { sessions, tasks, turn, sinks, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Работай", directory: dir, reviewModel: null });
  sessions.setResumeAt(t0.workerSessionId!, Date.now() + 3600_000);
  await tick();
  assert.equal(tasks.get(t0.id).status, "waiting_limit");
  sessions.setResumeAt(t0.workerSessionId!, 0);
  await tick();
  assert.equal(tasks.get(t0.id).status, "running");
  await turn("claude", "claude-1", "Доделал после лимита.");
  await waitTask(t0.id, (x) => x.status === "ready", "отчёта");

  const t1 = await tasks.create({ goal: "Вторая", directory: dir, reviewModel: null });
  sinks.claude!.event("claude-2", { type: "error", message: "claude: Not logged in" });
  const broken = await waitTask(t1.id, (x) => x.status === "failed", "ошибки");
  assert.match(broken.error ?? "", /Not logged in/);
});

test("остановка работающей задачи: агент рвётся, ожидание лимита снимается, копия откатывается; idle от остановленного агента задачу не двигает", async () => {
  const { root, dir } = repo();
  const { config, sessions, tasks, checks, turn, aborts, prompts } = await setup(root);
  config.setChecks(dir, ["npm test"]);
  const t0 = await tasks.create({ goal: "Останови mid-work", directory: dir, reviewModel: null });
  const wt = t0.worktree!.path;
  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => a + b;\n");
  writeFileSync(join(wt, "NEW.md"), "новый файл\n");
  sessions.setResumeAt(t0.workerSessionId!, Date.now() + 3600_000);
  await tick();
  assert.equal(tasks.get(t0.id).status, "waiting_limit");
  assert.ok(checks.active(t0.workerSessionId!), "автопроверка была включена");

  const stopped = await tasks.act(t0.id, { action: "discard" });
  assert.equal(stopped.status, "discarded");
  assert.ok(aborts.includes("claude-1"), "агента остановили");
  assert.equal(sessions.get(t0.workerSessionId!).resumeAt, undefined, "ожидание лимита снято");
  assert.ok(!checks.active(t0.workerSessionId!), "автопроверка погашена — «почини» остановленному агенту не уйдёт");
  assert.equal(readFileSync(join(wt, "sum.js"), "utf8"), "module.exports = (a, b) => a - b;\n", "копия откатилась");
  assert.ok(!existsSync(join(wt, "NEW.md")), "новый файл тоже выбросился");
  assert.ok(sessions.get(t0.workerSessionId!), "чат задачи остался");
  assert.equal(stopped.steps.at(-1)?.status, "skipped");

  // агент догоняет с idle — задача не двигается и ничего не получает
  const before = prompts.length;
  await turn("claude", "claude-1", "Доделал?");
  assert.equal(tasks.get(t0.id).status, "discarded", "idle от остановленного агента задачу не двигает");
  assert.equal(tasks.get(t0.id).report, undefined, "отчёт не появился");
  assert.equal(prompts.length, before, "остановленной сессии ничего не писали");
});

test("остановка, пока исполнитель ещё работает: idle от abort не двигает задачу", async () => {
  const { root, dir } = repo();
  const { tasks, aborts, prompts, sinks } = await setup(root);
  const t0 = await tasks.create({ goal: "Останови в работе", directory: dir, reviewModel: { providerId: "opencode", modelId: "free" } });
  // исполнитель ещё не закончил ход
  sinks.claude!.event(t0.workerSessionId!, { type: "session.updated", patch: { status: "busy" } } as SessionEvent);
  await tick();
  const stopped = await tasks.act(t0.id, { action: "discard" });
  assert.equal(stopped.status, "discarded");
  assert.ok(aborts.includes("claude-1"), "агента остановили");
  await tick(120);
  const t = tasks.get(t0.id);
  assert.equal(t.status, "discarded", "idle от остановленного не запустил ревью");
  assert.equal(t.reviewSessionId, undefined, "сессия ревью не создалась");
  assert.equal(t.report, undefined, "отчёт не появился");
  assert.equal(t.steps.at(-1)?.status, "skipped");
  assert.equal(prompts.length, 1, "агенту ушла только цель");
});

test("остановка queued во время запуска: launch не оживляет задачу, созданная сессия убирается", async () => {
  const { root, dir } = repo();
  const { config, sessions, tasks, turn, waitTask, gate, prompts } = await setup(root, { gate: true });
  config.setTasksParallel(1);
  const a = await tasks.create({ goal: "Первая", directory: dir, reviewModel: null });
  await waitTask(a.id, (x) => !!x.workerSessionId, "сессии первой");
  gate.arm();
  const b = await tasks.create({ goal: "Вторая", directory: dir, reviewModel: null });
  assert.equal(b.status, "queued");
  await turn("claude", "claude-1", "Первая готова.");
  await waitTask(a.id, (x) => x.status === "ready", "отчёта первой");
  // вторая сейчас в launch: движок висит в createSession
  const before = prompts.length;
  const stopped = await tasks.act(b.id, { action: "discard" });
  assert.equal(stopped.status, "discarded");
  gate.release();
  await tick(100);
  const t = tasks.get(b.id);
  assert.equal(t.status, "discarded", "launch не перевёл задачу обратно в running");
  assert.equal(t.workerSessionId, undefined);
  assert.ok(!sessions.list().some((s) => s.taskId === b.id), "сессию убрали");
  assert.equal(prompts.length, before, "остановленной задаче не отправляем промпт");
});

test("остановку не перекрашивает ошибка, которая пришла уже после остановки", async () => {
  const { root, dir } = repo();
  const { tasks, turn, notices, created, gate, waitTask } = await setup(root, { gate: true, throwOnGate: true });
  const t0 = await tasks.create({ goal: "Посмотри diff", directory: dir, reviewModel: { providerId: "opencode", modelId: "free" } });
  writeFileSync(join(t0.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await waitTask(t0.id, (x) => !!x.workerSessionId, "запуска");
  gate.arm();
  await turn("claude", "claude-1", "Починил.");
  // конвейер дошёл до ревью и висит в createSession
  for (let i = 0; i < 60 && !created.some((c) => c.engine === "opencode"); i++) await tick(20);
  assert.ok(created.some((c) => c.engine === "opencode"), "ревью-сессия ещё создаётся");
  const stopped = await tasks.act(t0.id, { action: "discard" });
  assert.equal(stopped.status, "discarded");
  gate.gone();
  gate.release();
  await tick(200);
  const t = tasks.get(t0.id);
  assert.equal(t.status, "discarded", "ошибка не перекрасила остановленную задачу");
  assert.equal(t.error, undefined);
  assert.ok(!notices.some((m) => /сломал|broke/i.test(m)), notices.join(" | "));
});

test("остановку не затирает конвейер, который уже ждал git", async () => {
  const { root, dir } = repo();
  const { tasks, turn, notices, prompts, created } = await setup(root, { fakeGit: true });
  const t0 = await tasks.create({ goal: "Посмотри diff", directory: dir, reviewModel: { providerId: "opencode", modelId: "free" } });
  // idle → advance → diff, git ещё идёт
  await turn("claude", "claude-1", "Починил.");
  const stopped = await tasks.act(t0.id, { action: "discard" });
  assert.equal(stopped.status, "discarded");
  await tick(1200);
  const t = tasks.get(t0.id);
  assert.equal(t.status, "discarded", "конвейер не перезаписал остановку");
  assert.equal(t.reviewSessionId, undefined, "ревью не стартовало на откаченной копии");
  assert.equal(t.report, undefined, "отчёта нет");
  assert.ok(!created.some((c) => c.engine === "opencode"), "ревью-сессию не создаём");
  assert.equal(prompts.filter((p) => p.engine === "opencode").length, 0, "ревьюеру не шлём промпт");
  assert.ok(!notices.some((m) => /готова|ready/i.test(m)), notices.join(" | "));
});

test("удаление задачи убирает её сессии", async () => {
  const { root, dir } = repo();
  const { sessions, tasks, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Удалю", directory: dir });
  writeFileSync(join(t0.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  const t = await waitTask(t0.id, (x) => !!x.reviewSessionId, "сессии ревью");
  const ids = [t.workerSessionId!, t.reviewSessionId!];
  await tasks.remove(t.id);
  assert.equal(tasks.list().length, 0);
  for (const id of ids) assert.throws(() => sessions.get(id), /Нет сессии|No session/i);
});

test("очередь: больше parallel сразу не запускаем, по времени — не раньше срока, в конце одна сводка", async () => {
  const { root, dir } = repo();
  const { config, tasks, turn, waitTask, notices } = await setup(root);
  config.setTasksParallel(1);

  const a = await tasks.create({ goal: "Первая", directory: dir, reviewModel: null });
  const b = await tasks.create({ goal: "Вторая", directory: dir, reviewModel: null });
  assert.equal(a.status, "running");
  assert.equal(b.status, "queued", "вторая ждёт очереди");
  assert.equal(b.workerSessionId, undefined, "сессию ей ещё не создавали");

  writeFileSync(join(a.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Первая готова.");
  await waitTask(a.id, (x) => x.status === "ready", "отчёта первой");
  // место освободилось — вторая стартовала сама
  const started = await waitTask(b.id, (x) => x.status === "running", "запуска второй");
  assert.ok(started.workerSessionId);
  await turn("claude", "claude-2", "Вторая готова.");
  await waitTask(b.id, (x) => x.status === "ready", "отчёта второй");
  // обе кончились — одна сводка на двоих
  assert.ok(notices.some((m) => /Задачи закончились|Tasks finished/.test(m)), notices.join(" | "));

  // отложенный запуск: время ещё не пришло — ждём
  const later = await tasks.create({ goal: "Ночная", directory: dir, reviewModel: null, startAt: Date.now() + 60_000 });
  assert.equal(later.status, "queued");
  assert.equal(later.startAt && later.startAt > Date.now(), true);
  await tick(120);
  assert.equal(tasks.get(later.id).status, "queued", "раньше срока не стартует");
  assert.equal(tasks.get(later.id).workerSessionId, undefined);
});

test("исполнитель не зашит: без входа в Claude задача идёт на opencode, движки можно выбрать явно", async () => {
  // нет Claude — и исполнитель, и ревьюер opencode
  {
    const { root, dir } = repo();
    const { tasks, sessions, waitTask } = await setup(root, { claudeOut: true });
    const a = await tasks.create({ goal: "Без Claude", directory: dir });
    const run = await waitTask(a.id, (x) => x.status === "running", "запуска");
    assert.equal(run.workerEngine, "opencode");
    assert.equal(run.reviewEngine, "opencode");
    assert.equal(sessions.get(run.workerSessionId!).engine, "opencode");
    // явно попросили Claude, а входа нет — понятная ошибка сразу, а не упавшая задача
    await assert.rejects(tasks.create({ goal: "С Claude", directory: dir, workerEngine: "claude" }), /недоступен|isn't available|вход|signed in/i);
  }
  // наоборот: opencode делает, Claude ревьюит
  {
    const { root, dir } = repo();
    const { tasks, sessions, turn, waitTask } = await setup(root);
    const b = await tasks.create({
      goal: "Делает opencode",
      directory: dir,
      workerEngine: "opencode",
      workerModel: { providerId: "opencode", modelId: "big" },
      reviewEngine: "claude",
    });
    const run = await waitTask(b.id, (x) => x.status === "running", "запуска");
    const w = sessions.get(run.workerSessionId!);
    assert.equal(w.engine, "opencode");
    assert.equal(w.model?.modelId, "big");
    assert.equal(run.reviewEngine, "claude");
    writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
    await turn("opencode", "opencode-1", "Готово.");
    const rev = await waitTask(b.id, (x) => !!x.reviewSessionId, "ревью");
    assert.equal(sessions.get(rev.reviewSessionId!).engine, "claude", "ревью пошло в Claude");
    await assert.rejects(tasks.create({ goal: "x", directory: dir, workerEngine: "gpt" as never }), /Неизвестный движок|Unknown engine/);
    // папка без git — отказ сразу, а не упавшая задача
    const plain = join(root, "plain");
    mkdirSync(plain, { recursive: true });
    await assert.rejects(tasks.create({ goal: "x", directory: plain }), /git/);
  }
});

test("упавшую задачу можно продолжить: работа в копии цела, агент получает ошибку и доделывает", async () => {
  const { root, dir } = repo();
  const { tasks, sinks, prompts, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, reviewModel: null });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  // агент успел поправить файл и оборвался (например, кончилось окно у локальной модели)
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  sinks.claude!.event("claude-1", { type: "error", message: "request exceeds the context window" });
  const broken = await waitTask(t0.id, (x) => x.status === "failed", "ошибки");
  assert.match(broken.error ?? "", /context window/);

  // продолжить можно без комментария; ошибка уходит агенту, из задачи снимается
  const again = await tasks.act(t0.id, { action: "more", comment: "" });
  assert.equal(again.status, "running");
  assert.equal(again.error, undefined);
  assert.equal(again.steps.at(-1)!.kind, "work");
  const last = prompts.filter((p) => p.esid === "claude-1").at(-1)!.text;
  assert.match(last, /оборвалась|interrupted/);
  assert.match(last, /context window/);
  assert.match(last, /git status/);
  await turn("claude", "claude-1", "Доделал.");
  const done = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.deepEqual(done.report!.files.map((f) => f.path), ["sum.js"], "сделанное до обрыва не потерялось");

  // у выброшенной задачи ещё круга нет
  await tasks.act(t0.id, { action: "discard" });
  await assert.rejects(tasks.act(t0.id, { action: "more", comment: "ещё" }), /готовой или упавшей|ready or failed/);
});

test("задача ждёт ответа — это видно; исполнитель в копии проекта не выходит за неё", async () => {
  const { root, dir } = repo();
  const { tasks, sessions, sinks, waitTask, created } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини", directory: dir, workerEngine: "opencode", reviewModel: null });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  // исполнитель создан «в загоне», обычная сессия — нет
  assert.deepEqual(created.at(-1), { engine: "opencode", confined: true });
  await sessions.create({ engine: "opencode", directory: dir });
  assert.deepEqual(created.at(-1), { engine: "opencode", confined: false });

  sinks.opencode!.event("opencode-1", { type: "permission.asked", request: { id: "per1", tool: "external_directory", title: "Select-String D:/main/x.ts", canAlways: true } });
  const asking = await waitTask(t0.id, (x) => !!x.asking, "пометки");
  assert.equal(asking.asking!.kind, "permission");
  assert.equal(asking.asking!.sessionId, run.workerSessionId);
  assert.match(asking.asking!.text, /external_directory/);
  sinks.opencode!.event("opencode-1", { type: "permission.resolved", id: "per1", reply: "once" });
  await waitTask(t0.id, (x) => !x.asking, "снятия пометки");

  // вопрос агента — тоже; задача упала — ждать от человека нечего
  sinks.opencode!.event("opencode-1", { type: "question.asked", request: { id: "q1", questions: [{ question: "Какой формат даты?", options: [] }] } });
  assert.equal((await waitTask(t0.id, (x) => !!x.asking, "вопроса")).asking!.text, "Какой формат даты?");
  sinks.opencode!.event("opencode-1", { type: "error", message: "boom" });
  const failed = await waitTask(t0.id, (x) => x.status === "failed", "ошибки");
  assert.equal(failed.asking, undefined);
});

test("дифф задачи — от точки ответвления: коммиты в основную ветку после старта задаче не приписываются", async () => {
  const { root, dir } = repo();
  const { tasks, prompts, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, workerEngine: "claude", reviewEngine: "opencode" });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  // пока задача работает, в основную ветку влили чужую работу
  writeFileSync(join(dir, "later.js"), "module.exports = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "чужая работа");
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  await waitTask(t0.id, (x) => !!x.reviewSessionId, "ревью");
  const review = prompts.filter((p) => p.engine === "opencode").at(-1)!.text;
  assert.match(review, /sum\.js/);
  assert.doesNotMatch(review, /later\.js/, "чужой коммит не попадает в ревью как «удалённый»");
  await turn("opencode", "opencode-1", "ЧИСТО");
  const done = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.deepEqual(done.report!.files, [{ status: "M", path: "sum.js" }]);
  // и влить можно: squash сам считает от точки ответвления, чужая работа на месте
  await tasks.act(t0.id, { action: "merge" });
  assert.equal(readFileSync(join(dir, "later.js"), "utf8"), "module.exports = 1;\n");
  assert.match(readFileSync(join(dir, "sum.js"), "utf8"), /a \+ b/);
});

test("«ещё круг» после исчерпанных ревью отдаёт исполнителю последнее ревью — один раз", async () => {
  const { root, dir } = repo();
  const { tasks, prompts, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, workerEngine: "claude", reviewEngine: "opencode" });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "review", "первого ревью");
  await turn("opencode", "opencode-1", "1. Нет проверки аргументов.");
  await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "fix", "правок");
  await turn("claude", "claude-1", "Поправил.");
  await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "review" && x.steps.at(-1)?.status === "running", "второго ревью");
  await turn("opencode", "opencode-1", "2. Осталась гонка в launch.");
  const done = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(done.reviewVerdict, "remarks");
  // второе ревью исполнитель не видел: после него хаб сразу поставил «готово»
  assert.ok(!prompts.some((p) => p.engine === "claude" && p.text.includes("Осталась гонка")));

  await tasks.act(t0.id, { action: "more", comment: "Доделай по ревью" });
  const sent = prompts.filter((p) => p.engine === "claude").at(-1)!.text;
  assert.match(sent, /Доделай по ревью/);
  assert.match(sent, /Осталась гонка в launch/, "последнее ревью ушло вместе с просьбой");
  assert.equal(tasks.get(t0.id).reviewVerdict, undefined, "замечания отданы — второй раз не повторяем");
});

test("ошибка посреди обработки ревью не теряет текст ревью", async () => {
  const { root, dir } = repo();
  const { tasks, sessions, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, workerEngine: "claude", reviewEngine: "opencode" });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  await waitTask(t0.id, (x) => x.steps.at(-1)?.kind === "review", "ревью");
  // журнал исполнителя не читается при сборке отчёта — уже после того, как ревью разобрано
  const orig = sessions.eventsAfter.bind(sessions);
  sessions.eventsAfter = (id: string, after: number) => {
    if (id === run.workerSessionId) throw new Error("журнал сломался");
    return orig(id, after);
  };
  await turn("opencode", "opencode-1", "ЧИСТО\nВсё хорошо.");
  const failed = await waitTask(t0.id, (x) => x.status === "failed", "ошибки");
  assert.match(failed.error ?? "", /журнал сломался/);
  assert.match(failed.reviewText ?? "", /Всё хорошо/, "текст ревью сохранён");
  assert.equal(failed.reviews, 1);
});

test("уровни рассуждений задачи доходят до сессий исполнителя и ревьюера", async () => {
  const { root, dir } = repo();
  const { tasks, sessions, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини", directory: dir, workerEngine: "claude", workerEffort: "xhigh", reviewEngine: "opencode", reviewEffort: "low" });
  const run = await waitTask(t0.id, (x) => x.status === "running", "запуска");
  assert.equal(sessions.get(run.workerSessionId!).effort, "xhigh");
  writeFileSync(join(run.worktree!.path, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  const rev = await waitTask(t0.id, (x) => !!x.reviewSessionId, "ревью");
  assert.equal(sessions.get(rev.reviewSessionId!).effort, "low");
});
