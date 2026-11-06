// Действия сессии для шапки чата (меню ⋯, палитра, плашки): одно описание на веб и приложение.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchQuery, permissionShort, sessionActions, sessionSummary, type ModelInfo, type SessionInfo } from "@kamharn/client";

const session = (extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "s1",
  engine: "claude",
  directory: "C:\\p",
  title: "Проба",
  model: { providerId: "anthropic", modelId: "opus" },
  permissionMode: "manual",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
  ...extra,
}) as SessionInfo;

const ids = (s: SessionInfo, o: Parameters<typeof sessionActions>[1]) => sessionActions(s, o).map((a) => a.id);

test("набор действий: веб без «Разговора» и поиска, ветка — только у сессии с веткой, удаление последним", () => {
  assert.deepEqual(ids(session(), { platform: "web" }), ["project", "preview", "checks", "compact", "bot", "delete"]);
  assert.deepEqual(ids(session(), { platform: "mobile" }), ["project", "preview", "checks", "compact", "talk", "bot", "search", "delete"]);
  const wt = session({ worktree: { branch: "kamharn/fix-a", base: "main", path: "C:\\p.worktrees\\fix-a" } as SessionInfo["worktree"] });
  assert.deepEqual(ids(wt, { platform: "web" }).slice(0, 3), ["project", "preview", "worktree"]);
  const del = sessionActions(session(), { platform: "web" }).at(-1)!;
  assert.equal(del.danger, true);
  assert.equal(del.group, "danger");
});

test("плашки и переключатели: видно только включённое", () => {
  const off = sessionActions(session(), { platform: "mobile", talk: false });
  assert.deepEqual(off.filter((a) => a.pill).map((a) => a.id), []);
  assert.equal(off.find((a) => a.id === "checks")!.on, false);
  // про бота ещё не спросили — ни «вкл», ни «выкл»
  assert.equal("on" in off.find((a) => a.id === "bot")!, false);

  const wt = { branch: "kamharn/fix-a", base: "main", path: "x" } as SessionInfo["worktree"];
  const on = sessionActions(session({ autoCheck: true, worktree: wt }), { platform: "mobile", talk: true, bot: true });
  assert.deepEqual(on.filter((a) => a.pill).map((a) => a.id), ["worktree", "checks", "talk", "bot"]);
  assert.match(on.find((a) => a.id === "worktree")!.pill!, /fix-a$/);
  assert.doesNotMatch(on.find((a) => a.id === "worktree")!.pill!, /kamharn\//);
  assert.equal(on.find((a) => a.id === "bot")!.on, true);
});

test("плашка параметров: модель · уровень (если модель его знает) · подтверждения", () => {
  const models = [
    { engine: "claude", providerId: "anthropic", modelId: "opus", name: "Claude Opus", efforts: ["low", "high"] },
    { engine: "opencode", providerId: "opencode", modelId: "plain", name: "Plain" },
  ] as ModelInfo[];
  assert.equal(sessionSummary(session({ effort: "high" }), models), `Claude Opus · high · ${permissionShort("manual")}`);
  // уровень не из списка модели или не задан — по умолчанию
  assert.equal(sessionSummary(session({ effort: "max" }), models), `Claude Opus · auto · ${permissionShort("manual")}`);
  const plain = session({ engine: "opencode", model: { providerId: "opencode", modelId: "plain" }, permissionMode: "auto" });
  assert.equal(sessionSummary(plain, models), `Plain · ${permissionShort("auto")}`);
  // моделей ещё нет — id модели
  assert.equal(sessionSummary(session(), []), `opus · ${permissionShort("manual")}`);
});

test("поиск палитры: все слова запроса, кириллица находит латиницу через ключевые слова, ё = е", () => {
  const find = (q: string) => sessionActions(session(), { platform: "mobile" }).filter((a) => matchQuery(`${a.label} ${a.hint} ${a.keywords}`, q)).map((a) => a.id);
  assert.deepEqual(find("телег"), ["bot"]);
  assert.deepEqual(find("telegram"), ["bot"]);
  assert.deepEqual(find("сжать"), ["compact"]);
  assert.ok(find("").length > 5);
  assert.equal(matchQuery("Вёрстка страницы", "верстка стр"), true);
  assert.equal(matchQuery("Вёрстка страницы", "верстка кот"), false);
});
