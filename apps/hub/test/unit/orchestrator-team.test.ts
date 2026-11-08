// Задача для команды: аналитик → архитектор → одобрение пользователя → разработчик → тестировщик → отчёт.
// Git настоящий, движки поддельные: спецификацию и «работу» пишем файлами сами, ответы ролей — turn().
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@kamharn/protocol";
import { isApproved, isPassed, MAX_DESIGN_ROUNDS, Orchestrator, SPEC_FILE } from "../../src/orchestrator.ts";
import { git, repo, setup } from "./task-harness.ts";

const SPEC = "# Сложение\n## Цель\nsum складывает.\n## Критерии приёмки\n1. sum(2, 3) === 5\n";

function writeSpec(wt: string, text: string) {
  mkdirSync(join(wt, ".kamharn"), { recursive: true });
  writeFileSync(join(wt, SPEC_FILE), text);
}

test("вердикты ролей — первая строка целиком, разметка не мешает", () => {
  assert.ok(isApproved("ОДОБРЯЮ\nвсё хорошо"));
  assert.ok(isApproved("**APPROVED**"));
  assert.ok(!isApproved("Замечания:\n1. ОДОБРЯЮ, но…"), "слово не в первой строке — не одобрение");
  assert.ok(!isApproved("Одобряю частично"));
  assert.ok(isPassed("ПРОЙДЕНО.\n1. ок"));
  assert.ok(!isPassed("Критерий 1 не ПРОЙДЕНО"));
});

test("команда: вопрос аналитика → спецификация → замечания архитектора → одобрение → разработка → баг → тесты пройдены → влить", async () => {
  const { root, dir } = repo();
  const { tasks, prompts, notices, turn, waitTask, sessions } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение в sum.js", directory: dir, mode: "team" });
  assert.equal(t0.status, "running");
  assert.equal(t0.stage, "analysis");
  assert.equal(t0.team?.analyst?.engine, "claude", "аналитик — как разработчик");
  assert.equal(t0.team?.tester?.engine, "opencode", "тестировщик — другая модель");
  assert.ok(t0.worktree?.path, "копия проекта есть с самого начала");
  const wt = t0.worktree!.path;
  // первый — аналитик (claude-1 — разработчик, он ждёт одобрения)
  let p = prompts.at(-1)!;
  assert.equal(p.esid, "claude-2");
  assert.match(p.text, /Почини сложение/);
  assert.ok(p.text.includes(SPEC_FILE), "аналитик знает, куда писать");
  assert.match(p.text, /Критерии приёмки/, "шаблон спецификации в промпте");
  assert.ok(!prompts.some((x) => x.esid === "claude-1"), "разработчику пока ничего");
  assert.equal(sessions.get(t0.team!.analyst!.sessionId!).taskId, t0.id, "сессия роли — сессия задачи");

  // аналитик спросил — задача ждёт твоего ответа
  await turn("claude", "claude-2", "Вопрос: отрицательные числа тоже?");
  let t = await waitTask(t0.id, (x) => x.asking?.kind === "reply", "вопроса аналитика");
  assert.match(t.asking!.text, /отрицательные/);
  assert.equal(t.stage, "analysis");
  assert.ok(notices.some((m) => /Аналитик спрашивает/.test(m)), notices.join("|"));

  // ты ответил, аналитик записал спецификацию — к архитектору
  writeSpec(wt, SPEC);
  // заодно «случайно» поправил код и создал файл — до разработки это откатится
  writeFileSync(join(wt, "sum.js"), "// аналитик тут был\n");
  writeFileSync(join(wt, "junk.txt"), "мусор\n");
  await turn("claude", "claude-2", "Записал спецификацию.");
  t = await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  assert.equal(t.asking, undefined, "ответ получен");
  assert.equal(t.spec, SPEC.trim());
  p = prompts.at(-1)!;
  assert.equal(p.esid, "claude-3");
  assert.match(p.text, /sum\(2, 3\)/, "архитектор получил спецификацию");
  assert.match(p.text, /ОДОБРЯЮ/);

  // замечания архитектора — аналитику
  await turn("claude", "claude-3", "1. Нет критерия про ошибки.");
  t = await waitTask(t0.id, (x) => x.stage === "analysis" && x.designRounds === 1, "замечаний архитектора");
  assert.equal(prompts.at(-1)!.esid, "claude-2");
  assert.match(prompts.at(-1)!.text, /Нет критерия про ошибки/);

  writeSpec(wt, SPEC + "2. sum('a', 1) бросает TypeError\n");
  await turn("claude", "claude-2", "Добавил критерий.");
  await waitTask(t0.id, (x) => x.stage === "design" && x.steps.at(-1)?.kind === "design", "второго круга архитектора");
  writeSpec(wt, SPEC + "2. sum('a', 1) бросает TypeError\n## Как делать\nПоправить sum.js.\n");
  await turn("claude", "claude-3", "ОДОБРЯЮ\nПлан дописал.");
  t = await waitTask(t0.id, (x) => x.status === "approval", "одобрения");
  assert.equal(t.stage, undefined);
  assert.match(t.spec ?? "", /## Как делать/, "в спецификации раздел архитектора");
  assert.ok(notices.some((m) => /Спецификация готова/.test(m)), notices.join("|"));
  assert.ok(!prompts.some((x) => x.esid === "claude-1"), "без одобрения разработчик не начинает");

  // одобрил — случайные правки откатились, разработчик получил спецификацию
  t = await tasks.act(t0.id, { action: "approve" });
  assert.equal(t.status, "running");
  assert.equal(t.stage, "dev");
  assert.equal(readFileSync(join(wt, "sum.js"), "utf8"), "module.exports = (a, b) => a - b;\n", "код вернулся");
  assert.ok(!existsSync(join(wt, "junk.txt")), "лишний файл убран");
  assert.ok(existsSync(join(wt, SPEC_FILE)), "спецификация на месте");
  assert.match(t.steps.at(-1)!.note ?? "", /откачены/);
  p = prompts.at(-1)!;
  assert.equal(p.esid, "claude-1");
  assert.match(p.text, /<spec>[\s\S]*TypeError[\s\S]*<\/spec>/);
  assert.match(p.text, /отдельной копии проекта/);

  // разработчик сделал — тестировщик
  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  t = await waitTask(t0.id, (x) => x.stage === "testing", "тестировщика");
  p = prompts.at(-1)!;
  assert.equal(p.engine, "opencode");
  assert.match(p.text, /ПРОЙДЕНО/);
  assert.match(p.text, /M sum\.js/, "что поменял разработчик");
  assert.ok(!/\.kamharn/.test(p.text), "спецификация не считается изменением");

  // баг — разработчику
  await turn("opencode", "opencode-1", "Критерий 2: sum('a', 1) возвращает 'a1'.");
  t = await waitTask(t0.id, (x) => x.stage === "dev" && x.testRounds === 1, "бага");
  assert.equal(prompts.at(-1)!.esid, "claude-1");
  assert.match(prompts.at(-1)!.text, /<test-report>[\s\S]*'a1'/);

  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => { if (typeof a !== 'number') throw new TypeError(); return a + b; };\n");
  await turn("claude", "claude-1", "Добавил проверку типа.");
  await waitTask(t0.id, (x) => x.stage === "testing" && x.steps.at(-1)?.kind === "test", "второго круга тестов");
  assert.match(prompts.at(-1)!.text, /Проверь снова/);
  await turn("opencode", "opencode-1", "ПРОЙДЕНО\n1. ок\n2. ок");
  t = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(t.report?.test, "passed");
  assert.match(t.report?.testText ?? "", /2\. ок/);
  assert.equal(t.testRounds, 2);
  assert.deepEqual(t.report?.files.map((f) => f.path), ["sum.js"]);

  const merged = await tasks.act(t.id, { action: "merge" });
  assert.equal(merged.status, "merged");
  const committed = git(dir, "show", "--name-only", "--pretty=", "HEAD");
  assert.equal(committed, "sum.js", "спецификация в коммит не попала");
  assert.match(merged.spec ?? "", /TypeError/, "спецификация осталась в задаче");
});

test("команда: круги архитектора кончились — решаешь ты; «Править» → аналитику; одобрение с правкой руками", async () => {
  const { root, dir } = repo();
  const { tasks, prompts, turn, waitTask } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, mode: "team" });
  const wt = t0.worktree!.path;
  writeSpec(wt, SPEC);
  await turn("claude", "claude-2", "Записал.");
  for (let round = 1; round <= MAX_DESIGN_ROUNDS; round++) {
    await waitTask(t0.id, (x) => x.stage === "design", `архитектора, круг ${round}`);
    await turn("claude", "claude-3", `Замечание круга ${round}.`);
    if (round < MAX_DESIGN_ROUNDS) {
      await waitTask(t0.id, (x) => x.stage === "analysis", "аналитика");
      writeSpec(wt, `${SPEC}\nправка ${round}\n`);
      await turn("claude", "claude-2", "Поправил.");
    }
  }
  let t = await waitTask(t0.id, (x) => x.status === "approval", "одобрения после кругов");
  assert.match(t.designRemarks ?? "", /Замечание круга 2/, "последние замечания видны тебе");

  await assert.rejects(tasks.act(t0.id, { action: "merge" }), /не готова|isn't ready/i);
  await assert.rejects(tasks.act(t0.id, { action: "revise", comment: " " }), /что поправить|what to change/i);
  t = await tasks.act(t0.id, { action: "revise", comment: "Добавь умножение" });
  assert.equal(t.status, "running");
  assert.equal(t.stage, "analysis");
  assert.equal(t.designRounds, 0, "круги заново");
  assert.equal(t.designRemarks, undefined);
  assert.equal(prompts.at(-1)!.esid, "claude-2");
  assert.match(prompts.at(-1)!.text, /Пользователь[\s\S]*Добавь умножение/);

  writeSpec(wt, `${SPEC}3. mul(2, 3) === 6\n`);
  await turn("claude", "claude-2", "Добавил умножение.");
  await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  await turn("claude", "claude-3", "ОДОБРЯЮ");
  t = await waitTask(t0.id, (x) => x.status === "approval", "одобрения");
  assert.equal(t.designRemarks, undefined);

  // поправил спецификацию руками и одобрил
  const mine = `${t.spec}\n4. Без внешних зависимостей`;
  t = await tasks.act(t0.id, { action: "approve", spec: mine });
  assert.equal(t.spec, mine);
  assert.equal(readFileSync(join(wt, SPEC_FILE), "utf8").trim(), mine);
  assert.match(prompts.at(-1)!.text, /Без внешних зависимостей/);
  await assert.rejects(tasks.act(t0.id, { action: "approve" }), /не ждёт одобрения|isn't waiting/i);
});

test("команда без тестировщика: после разработки — сразу отчёт; выбросить можно и на одобрении", async () => {
  const { root, dir } = repo();
  const { tasks, turn, waitTask, prompts } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, mode: "team", team: { tester: null } });
  assert.equal(t0.team?.tester, undefined);
  const wt = t0.worktree!.path;
  writeSpec(wt, SPEC);
  await turn("claude", "claude-2", "Записал.");
  await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  await turn("claude", "claude-3", "APPROVED");
  await waitTask(t0.id, (x) => x.status === "approval", "одобрения");
  await tasks.act(t0.id, { action: "approve" });
  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await turn("claude", "claude-1", "Готово.");
  const t = await waitTask(t0.id, (x) => x.status === "ready", "отчёта");
  assert.equal(t.report?.test, "skipped");
  assert.ok(!prompts.some((p) => p.engine === "opencode"), "тестировщика не звали");

  // вторая задача: выбросить, пока спецификация ждёт одобрения
  const { root: r2, dir: d2 } = repo();
  const h = await setup(r2);
  const a = await h.tasks.create({ goal: "Что-то", directory: d2, mode: "team" });
  writeSpec(a.worktree!.path, SPEC);
  // аналитик «наследил» в коде — выброс откатывает копию на основную ветку (удаляется она вместе с задачей)
  writeFileSync(join(a.worktree!.path, "sum.js"), "// мусор\n");
  await h.turn("claude", "claude-2", "Записал.");
  await h.waitTask(a.id, (x) => x.stage === "design", "архитектора");
  await h.turn("claude", "claude-3", "ОДОБРЯЮ");
  await h.waitTask(a.id, (x) => x.status === "approval", "одобрения");
  const gone = await h.tasks.act(a.id, { action: "discard" });
  assert.equal(gone.status, "discarded");
  assert.equal(readFileSync(join(a.worktree!.path, "sum.js"), "utf8"), "module.exports = (a, b) => a - b;\n", "копия откачена");
  // удаление задачи убирает все её сессии, и роли тоже (копия уходит вместе с сессией разработчика)
  const ids = [gone.workerSessionId!, gone.team!.analyst!.sessionId!, gone.team!.architect!.sessionId!];
  await h.tasks.remove(a.id);
  for (const id of ids) assert.throws(() => h.sessions.get(id), /Нет сессии|No session/i);
});

test("команда: переписка с аналитиком во время разработки задачу не двигает; рестарт посреди архитектора — продолжает", async () => {
  const { root, dir } = repo();
  const h = await setup(root);
  const t0 = await h.tasks.create({ goal: "Почини сложение", directory: dir, mode: "team" });
  const wt = t0.worktree!.path;
  writeSpec(wt, SPEC);
  await h.turn("claude", "claude-2", "Записал.");
  await h.waitTask(t0.id, (x) => x.stage === "design", "архитектора");

  // хаб лёг, пока архитектор работал; ответ пришёл без оркестратора
  h.tasks.close();
  await h.turn("claude", "claude-3", "ОДОБРЯЮ");
  assert.equal(h.tasks.get(t0.id).stage, "design", "без оркестратора задача стоит");
  const again = new Orchestrator({ sessions: h.sessions, db: h.db, config: h.config, autoCheck: h.checks, notify: () => {} });
  again.start();
  let t = await waitFor(() => again.get(t0.id), (x) => x.status === "approval", "одобрения после рестарта");

  t = await again.act(t0.id, { action: "approve" });
  assert.equal(t.stage, "dev");
  const before = h.prompts.length;
  // ты пишешь аналитику, пока разработчик работает: ход аналитика не должен увести задачу
  writeSpec(wt, SPEC + "\nещё мысль\n");
  await h.turn("claude", "claude-2", "Принял к сведению.");
  t = again.get(t0.id);
  assert.equal(t.stage, "dev");
  assert.equal(h.prompts.length, before, "никому ничего не отправили");
  // а ход разработчика — как обычно
  writeFileSync(join(wt, "sum.js"), "module.exports = (a, b) => a + b;\n");
  await h.turn("claude", "claude-1", "Готово.");
  await waitFor(() => again.get(t0.id), (x) => x.stage === "testing", "тестировщика");
  again.close();
});

test("команда: лимит Claude у роли — задача ждёт, обрывок хода дальше не уходит; ошибка в чате чужой роли задачу не роняет", async () => {
  const { root, dir } = repo();
  const { tasks, turn, waitTask, prompts, sinks, created } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, mode: "team" });
  assert.deepEqual(created.at(-1), { engine: "claude", confined: true }, "роль заперта в копии");
  writeSpec(t0.worktree!.path, SPEC);
  await turn("claude", "claude-2", "Записал.");
  await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  const before = prompts.length;
  // архитектор упёрся в лимит: автопродолжение ставит resumeAt, потом ход кончается обрывком
  const claude = sinks.claude!;
  claude.event("claude-3", { type: "session.updated", patch: { resumeAt: Date.now() + 3_600_000 } });
  await turn("claude", "claude-3", "You've hit your limit · resets 5pm");
  let t = await waitTask(t0.id, (x) => x.status === "waiting_limit", "ожидания лимита");
  assert.equal(t.stage, "design");
  assert.equal(prompts.length, before, "обрывок не ушёл аналитику замечаниями");
  // сброс: автопродолжение снимает resumeAt и пишет «Продолжай» — архитектор доделывает
  claude.event("claude-3", { type: "session.updated", patch: { resumeAt: 0 } });
  await turn("claude", "claude-3", "ОДОБРЯЮ");
  t = await waitTask(t0.id, (x) => x.status === "approval", "одобрения после лимита");

  await tasks.act(t0.id, { action: "approve" });
  // ты пишешь аналитику во время разработки, и у него ошибка — задача живёт
  claude.event("claude-2", { type: "error", message: "что-то сломалось в чате аналитика" } as SessionEvent);
  await new Promise((r) => setTimeout(r, 100));
  t = tasks.get(t0.id);
  assert.equal(t.status, "running");
  assert.equal(t.stage, "dev");
});

test("команда: на одобрении аналитик переписал файл в чате — показывается и одобряется новая; пока роль отвечает — 409; споткнулось — failed, а не вечный running", async () => {
  const { root, dir } = repo();
  const { tasks, turn, waitTask, prompts, sinks } = await setup(root);
  const t0 = await tasks.create({ goal: "Почини сложение", directory: dir, mode: "team" });
  const wt = t0.worktree!.path;
  writeSpec(wt, SPEC);
  await turn("claude", "claude-2", "Записал.");
  await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  await turn("claude", "claude-3", "ОДОБРЯЮ");
  await waitTask(t0.id, (x) => x.status === "approval", "одобрения");

  // обсуждаешь с аналитиком: он занят — одобрять нельзя
  sinks.claude!.event("claude-2", { type: "session.updated", patch: { status: "busy" } } as SessionEvent);
  await assert.rejects(tasks.act(t0.id, { action: "approve" }), /ещё отвечает|still answering/i);
  writeSpec(wt, SPEC + "2. Новый критерий из разговора\n");
  sinks.claude!.event("claude-2", { type: "session.updated", patch: { status: "idle" } } as SessionEvent);
  let t = await waitTask(t0.id, (x) => /Новый критерий/.test(x.spec ?? ""), "обновлённой спецификации");
  assert.equal(t.status, "approval", "задача по-прежнему ждёт тебя");
  t = await tasks.act(t0.id, { action: "approve" });
  assert.match(prompts.at(-1)!.text, /Новый критерий/, "разработчик получил новую спецификацию");

  // вторая задача: «Править», а сессия аналитика пропала и новую создать нельзя
  const { root: r2, dir: d2 } = repo();
  const h = await setup(r2);
  const a = await h.tasks.create({ goal: "Что-то", directory: d2, mode: "team" });
  writeSpec(a.worktree!.path, SPEC);
  await h.turn("claude", "claude-2", "Записал.");
  await h.waitTask(a.id, (x) => x.stage === "design", "архитектора");
  await h.turn("claude", "claude-3", "ОДОБРЯЮ");
  await h.waitTask(a.id, (x) => x.status === "approval", "одобрения");
  h.sessions.delete(h.tasks.get(a.id).team!.analyst!.sessionId!);
  h.sessions.create = async () => {
    throw new Error("Claude Code: вход не выполнен");
  };
  await assert.rejects(h.tasks.act(a.id, { action: "revise", comment: "поправь" }), /вход не выполнен/);
  const failed = h.tasks.get(a.id);
  assert.equal(failed.status, "failed", "не висит в running");
  assert.match(failed.error ?? "", /вход не выполнен/);
});

test("дизайнер «авто»: UI: да — интерфейс и прототип до архитектора, прототип в задаче и у разработчика; после замечаний — снова через дизайнера", async () => {
  const { root, dir } = repo();
  const { tasks, turn, waitTask, prompts } = await setup(root);
  const t0 = await tasks.create({ goal: "Добавь кнопку «Очистить»", directory: dir, mode: "team" });
  assert.equal(t0.designerMode, "auto");
  assert.equal(t0.team?.designer?.engine, "claude", "дизайнер — как разработчик");
  assert.match(prompts.at(-1)!.text, /UI: да/, "аналитика просят отметить, про интерфейс ли задача");
  const wt = t0.worktree!.path;
  writeSpec(wt, `UI: да\n${SPEC}`);
  await turn("claude", "claude-2", "Записал.");
  let t = await waitTask(t0.id, (x) => x.stage === "ux", "дизайнера");
  assert.equal(t.ui, true);
  assert.equal(prompts.at(-1)!.esid, "claude-3");
  assert.ok(prompts.at(-1)!.text.includes(".kamharn/prototype.html"), "дизайнер знает, куда класть прототип");
  assert.match(prompts.at(-1)!.text, /## Интерфейс/);

  writeSpec(wt, `UI: да\n${SPEC}## Интерфейс\nКнопка справа.\n`);
  writeFileSync(join(wt, ".kamharn", "prototype.html"), "<!doctype html><button>Очистить</button>");
  await turn("claude", "claude-3", "Нарисовал.");
  t = await waitTask(t0.id, (x) => x.stage === "design", "архитектора");
  assert.match(t.prototype ?? "", /Очистить/, "прототип в задаче");
  assert.match(t.spec ?? "", /## Интерфейс/);
  assert.match(prompts.at(-1)!.text, /prototype\.html/, "архитектор знает про прототип");

  // замечания архитектора → аналитик → снова дизайнер (повторный проход)
  await turn("claude", "claude-4", "1. Нет состояния «пусто».");
  await waitTask(t0.id, (x) => x.stage === "analysis", "аналитика");
  writeSpec(wt, `UI: да\n${SPEC}2. Пустой список — кнопка неактивна\n## Интерфейс\nКнопка справа.\n`);
  await turn("claude", "claude-2", "Добавил.");
  await waitTask(t0.id, (x) => x.stage === "ux" && x.steps.filter((s) => s.kind === "ux").length === 2, "второго прохода дизайнера");
  assert.match(prompts.at(-1)!.text, /Спецификация поменялась/);
  await turn("claude", "claude-3", "Обновил.");
  await waitTask(t0.id, (x) => x.stage === "design", "архитектора снова");
  await turn("claude", "claude-4", "ОДОБРЯЮ");
  await waitTask(t0.id, (x) => x.status === "approval", "одобрения");
  t = await tasks.act(t0.id, { action: "approve" });
  assert.match(prompts.at(-1)!.text, /по прототипу дизайнера[\s\S]*prototype\.html/, "разработчик делает по прототипу");
});

test("дизайнер: «авто» с UI: нет — мимо; «всегда» — без отметки аналитика; «без дизайнера» — роли нет", async () => {
  const { root, dir } = repo();
  const h = await setup(root);
  const a = await h.tasks.create({ goal: "Почини сложение", directory: dir, mode: "team" });
  writeSpec(a.worktree!.path, `UI: нет\n${SPEC}`);
  await h.turn("claude", "claude-2", "Записал.");
  const ta = await h.waitTask(a.id, (x) => x.stage === "design", "архитектора");
  assert.equal(ta.ui, false);
  assert.ok(!ta.steps.some((s) => s.kind === "ux"), "дизайнера не звали");
  assert.equal(ta.team?.designer?.sessionId, undefined);

  const { root: r2, dir: d2 } = repo();
  const h2 = await setup(r2);
  const b = await h2.tasks.create({ goal: "Кнопка", directory: d2, mode: "team", designer: "on" });
  assert.ok(!/UI: да/.test(h2.prompts.at(-1)!.text), "при «всегда» отметка не нужна");
  writeSpec(b.worktree!.path, SPEC);
  await h2.turn("claude", "claude-2", "Записал.");
  await h2.waitTask(b.id, (x) => x.stage === "ux", "дизайнера");

  const { root: r3, dir: d3 } = repo();
  const h3 = await setup(r3);
  const c = await h3.tasks.create({ goal: "Кнопка", directory: d3, mode: "team", designer: "off" });
  assert.equal(c.team?.designer, undefined);
  assert.equal(c.designerMode, undefined);
  await assert.rejects(h3.tasks.create({ goal: "x", directory: d3, mode: "team", designer: "maybe" as "on" }), /designer/);
});

async function waitFor<T>(get: () => T, pred: (x: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const x = get();
    if (pred(x)) return x;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`не дождался ${what}`);
}
