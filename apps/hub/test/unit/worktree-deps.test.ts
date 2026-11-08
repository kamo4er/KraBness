// Зависимости в копии проекта: node_modules подключаются ссылками, пакеты рабочей области — на копию,
// удаление копии не трогает основной проект. И название задачи из цели.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree, removeWorktree } from "../../src/worktree.ts";
import { taskTitle } from "../../src/orchestrator.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const kind = process.platform === "win32" ? "junction" : "dir";

function project() {
  const base = mkdtempSync(join(tmpdir(), "kh-deps-"));
  const top = join(base, "Proj");
  const put = (rel: string, text: string) => {
    mkdirSync(join(top, rel, ".."), { recursive: true });
    writeFileSync(join(top, rel), text);
  };
  put(".gitignore", "node_modules/\n");
  put("packages/lib/index.js", "main");
  put("apps/app/index.js", "app");
  put("node_modules/dep/index.js", "dep");
  put("node_modules/@sc/x/index.js", "scoped");
  put("node_modules/.package-lock.json", "{}");
  put("apps/app/node_modules/only/index.js", "only");
  // пакет рабочей области: ссылка внутрь основного проекта, как делает npm workspaces
  symlinkSync(join(top, "packages", "lib"), join(top, "node_modules", "lib"), kind);
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@e.com");
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  return { base, top };
}

test("копия получает node_modules ссылками, пакет рабочей области — свой, git их не видит", async (t) => {
  const { base, top } = project();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { worktree: wt } = await createWorktree(top, "Задача", "ks_000000abcdef");
  const nm = join(wt.path, "node_modules");

  assert.equal(readFileSync(join(nm, "dep", "index.js"), "utf8"), "dep");
  assert.equal(readFileSync(join(nm, "@sc", "x", "index.js"), "utf8"), "scoped");
  assert.equal(readFileSync(join(wt.path, "apps", "app", "node_modules", "only", "index.js"), "utf8"), "only");
  // пакет рабочей области ведёт в копию: правка в копии видна через node_modules
  writeFileSync(join(wt.path, "packages", "lib", "index.js"), "copy");
  assert.equal(readFileSync(join(nm, "lib", "index.js"), "utf8"), "copy");
  assert.equal(realpathSync(join(nm, "lib")), realpathSync(join(wt.path, "packages", "lib")));
  assert.equal(readFileSync(join(top, "packages", "lib", "index.js"), "utf8"), "main", "основной проект не задет");
  assert.equal(existsSync(join(nm, ".package-lock.json")), false, "служебные файлы npm не тащим");

  // git ссылок не видит: в диффе только правка пакета
  git(wt.path, "add", "-A");
  assert.deepEqual(git(wt.path, "diff", "--cached", "--name-only").split("\n"), ["packages/lib/index.js"]);

  await removeWorktree(wt);
  assert.equal(existsSync(wt.path), false, "копия удалена целиком");
  assert.equal(readFileSync(join(top, "node_modules", "dep", "index.js"), "utf8"), "dep", "зависимости основного проекта на месте");
  assert.equal(readFileSync(join(top, "node_modules", "@sc", "x", "index.js"), "utf8"), "scoped");
  assert.equal(readFileSync(join(top, "apps", "app", "node_modules", "only", "index.js"), "utf8"), "only");
  assert.equal(readFileSync(join(top, "packages", "lib", "index.js"), "utf8"), "main");
});

test("node_modules не в .gitignore — ссылок не делаем (иначе они уехали бы в коммит)", async (t) => {
  const { base, top } = project();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(top, ".gitignore"), "");
  git(top, "commit", "-qam", "без ignore");
  const { worktree: wt } = await createWorktree(top, "Задача", "ks_000000fedcba");
  // node_modules закоммичен целиком — он пришёл из git сам, а не нашими ссылками
  assert.equal(existsSync(join(wt.path, "node_modules", ".krabness-linked")), false);
  await removeWorktree(wt);
});

test("название задачи: первое предложение или обрезка по слову", () => {
  assert.equal(taskTitle("Почини сложение в sum.js и добавь тест"), "Почини сложение в sum.js и добавь тест");
  assert.equal(taskTitle("Почини сложение в sum.js. Потом добавь тест на отрицательные числа и ноль."), "Почини сложение в sum.js");
  const long = taskTitle(
    "В мобильном приложении на экране задач (apps/mobile/src/screens/Tasks.tsx) добавь выбор, сколько задач работает одновременно",
  );
  assert.ok(long.length <= 80, long);
  // режем по слову: «добавь» уже не влезает, обрывка слова нет
  assert.equal(long, "В мобильном приложении на экране задач (apps/mobile/src/screens/Tasks.tsx)…");
  assert.equal(taskTitle("Первая строка\nвторая строка"), "Первая строка");
});
