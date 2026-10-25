// Задачи: исполнитель в своей копии проекта → проверки → ревью → правки → отчёт и решение.
// Git настоящий (копия проекта, дифф, вливание), движки поддельные: «работу агента» пишем файлами сами.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

async function setup(root: string, opts: { claudeOut?: boolean } = {}) {
  const config = new ConfigStore(join(root, "cfg.json"), { roots: [root], dataDir: join(root, "data") });
  const db = new Db(join(root, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const sinks: Partial<Record<EngineId, EngineSink>> = {};
  /** что отправили каждому движку */
  const prompts: Array<{ engine: EngineId; esid: string; text: string }> = [];
  let n = 0;
  const made: Record<string, number> = { claude: 0, opencode: 0 };
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
    createSession: async () => `${id}-${++made[id]!}`,
    attach: () => {},
    prompt: async (esid, o) => void prompts.push({ engine: id, esid, text: o.text }),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  });
  await sessions.addEngine(engine("claude"));
  await sessions.addEngine(engine("opencode"));
  const notices: string[] = [];
  const checks = new AutoCheck({ sessions, config, notify: () => {}, run: async (command) => ({ command, code: 0, ms: 1, output: "" }) });
  const tasks = new Orchestrator({ sessions, db, config, autoCheck: checks, notify: (_s, m) => void notices.push(m) });
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
  return { config, db, sessions, tasks, checks, prompts, notices, turn, waitTask, sinks };
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
