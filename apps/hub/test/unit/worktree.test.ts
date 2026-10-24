// Ветка на сессию: настоящий git во временной папке.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorktree, discardWorktree, mergeWorktree, removeWorktree, slugify, worktreeStatus } from "../../src/worktree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo() {
  const root = mkdtempSync(join(tmpdir(), "kamharn-wt-"));
  const dir = join(root, "DemoGame");
  mkdirSync(join(dir, "app"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  // у пользователя глобально core.autocrlf=true: в тесте сравниваем байты как есть
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "app", "game.txt"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "старт");
  return { root, dir };
}

test("slugify: кириллица и мусор → имя ветки", () => {
  assert.equal(slugify("Детская игра: кнопки!"), "detskaya-igra-knopki");
  assert.equal(slugify("   "), "");
  assert.ok(slugify("очень длинное название сессии про всё на свете сразу").length <= 30);
});

test("worktree: копия рядом с проектом, вливание одним коммитом, сессия работает дальше", async () => {
  const { root, dir } = repo();
  const { worktree: wt, directory } = await createWorktree(join(dir, "app"), "Детская игра", "ks_abcdef123456");
  assert.equal(wt.branch, "kamharn/detskaya-igra-123456");
  assert.equal(wt.base, "main");
  assert.equal(wt.path, join(root, "DemoGame.worktrees", "detskaya-igra-123456"));
  assert.equal(directory, join(wt.path, "app"), "подпапка сессии сохраняется");
  assert.equal(readFileSync(join(directory, "game.txt"), "utf8"), "v1\n");

  // агент: один коммит + незакоммиченный хвост
  writeFileSync(join(directory, "game.txt"), "v2\n");
  git(wt.path, "commit", "-qam", "кнопки по ширине");
  writeFileSync(join(directory, "sound.txt"), "хрум\n");
  let st = await worktreeStatus(wt);
  assert.equal(st.ahead, 1);
  assert.equal(st.dirty, 1);

  const r = await mergeWorktree(wt, "Детская игра");
  assert.equal(r.files, 2);
  assert.equal(readFileSync(join(dir, "app", "game.txt"), "utf8"), "v2\n");
  assert.ok(existsSync(join(dir, "app", "sound.txt")));
  const msg = git(dir, "log", "-1", "--format=%B");
  assert.match(msg, /^Детская игра\n\nСессия KraBness, ветка kamharn\/detskaya-igra-123456:\n- кнопки по ширине\n- Работа сессии «Детская игра»/);
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2", "один коммит в основной");
  st = await worktreeStatus(wt);
  assert.deepEqual([st.ahead, st.dirty], [0, 0], "копия совпадает с основной");
  await assert.rejects(mergeWorktree(wt, "x"), /нечего/);

  // второй круг: новая работа вливается поверх
  writeFileSync(join(directory, "game.txt"), "v3\n");
  await mergeWorktree(wt, "Детская игра, круг 2");
  assert.equal(readFileSync(join(dir, "app", "game.txt"), "utf8"), "v3\n");

  // выбросить: копия снова как основная
  writeFileSync(join(directory, "game.txt"), "мусор\n");
  writeFileSync(join(directory, "junk.txt"), "x\n");
  await discardWorktree(wt);
  assert.equal(readFileSync(join(directory, "game.txt"), "utf8"), "v3\n");
  assert.ok(!existsSync(join(directory, "junk.txt")));

  await removeWorktree(wt);
  assert.ok(!existsSync(wt.path));
  assert.equal(git(dir, "branch", "--list", wt.branch), "");
});

test("worktree: пересечение с незакоммиченным в основном проекте — понятная ошибка, основной проект не тронут", async () => {
  const { dir } = repo();
  const { worktree: wt, directory } = await createWorktree(dir, "конфликт", "ks_000000000001");
  writeFileSync(join(directory, "app", "game.txt"), "из сессии\n");
  writeFileSync(join(dir, "app", "game.txt"), "правлю руками\n");
  await assert.rejects(mergeWorktree(wt, "конфликт"), /Не влилось/);
  assert.equal(readFileSync(join(dir, "app", "game.txt"), "utf8"), "правлю руками\n");
  assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1");

  // основной проект на другой ветке — не вливаем
  git(dir, "checkout", "-q", "--", ".");
  git(dir, "checkout", "-qb", "feature");
  await assert.rejects(mergeWorktree(wt, "конфликт"), /на ветке «feature»/);
  await removeWorktree(wt);
});

test("worktree: не git-папка — понятная ошибка", async () => {
  const plain = mkdtempSync(join(tmpdir(), "kamharn-plain-"));
  await assert.rejects(createWorktree(plain, "x", "ks_1"), /не в git/);
});

test("сессия в отдельной ветке: движок получает папку копии, слить/выбросить, удаление сессии убирает копию", async () => {
  const { root, dir } = repo();
  const { ConfigStore } = await import("../../src/config.ts");
  const { Db } = await import("../../src/db.ts");
  const { FileStore } = await import("../../src/files.ts");
  const { SessionManager } = await import("../../src/sessions.ts");
  const config = new ConfigStore(join(root, "cfg.json"), { roots: [root], dataDir: join(root, "data") });
  const db = new Db(join(root, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const dirs: string[] = [];
  await sessions.addEngine({
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async (o) => (dirs.push(o.directory), "es1"),
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  });

  const s = await sessions.create({ engine: "opencode", directory: dir, title: "Кнопки", worktree: true });
  assert.ok(s.worktree, "в списке сессий видно, что ветка своя");
  assert.equal(s.worktree!.base, "main");
  assert.equal(dirs[0], s.worktree!.path, "агент работает в копии");
  assert.equal(s.directory, s.worktree!.path);

  writeFileSync(join(s.directory, "app", "game.txt"), "из сессии\n");
  assert.equal((await sessions.worktreeStatus(s.id)).dirty, 1);
  db.updateSession(s.id, { status: "busy" });
  await assert.rejects(sessions.mergeWorktree(s.id), /ещё работает/);
  db.updateSession(s.id, { status: "idle" });
  const r = await sessions.mergeWorktree(s.id);
  assert.equal(r.files, 1);
  assert.equal(readFileSync(join(dir, "app", "game.txt"), "utf8"), "из сессии\n");

  writeFileSync(join(s.directory, "app", "game.txt"), "мусор\n");
  await sessions.discardWorktree(s.id);
  assert.equal(readFileSync(join(s.directory, "app", "game.txt"), "utf8"), "из сессии\n");

  // обычная папка, не git — понятный отказ
  const plain = join(root, "plain");
  mkdirSync(plain);
  await assert.rejects(sessions.create({ engine: "opencode", directory: plain, worktree: true }), /не в git/);

  sessions.delete(s.id);
  await new Promise((res) => setTimeout(res, 3500));
  assert.ok(!existsSync(s.worktree!.path), "копия удалена вместе с сессией");
  assert.equal(git(dir, "branch", "--list", s.worktree!.branch), "");
});
