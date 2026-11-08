// Новая папка из выбора папки: только внутри разрешённых, имя проверяется, существующую не трогаем;
// с git — сразу репозиторий с первым коммитом, и на ней можно запустить задачу (ей нужна своя ветка).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";
import { createWorktree, removeWorktree } from "../../src/worktree.ts";
import { notRepoError } from "@kamharn/client";

test("новая папка: обычная и с git, плохие имена — 400, вне разрешённых — 403, уже есть — 409; от новой папки с git делается копия проекта для задачи", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root, { recursive: true });
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [root], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const mkdir = (parent: string, name: unknown, git?: boolean) =>
    fetch(`${url}/api/fs/mkdir`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parent, name, git }) });
  try {
    // обычная
    let r = await mkdir(root, "  Заметки  ");
    assert.equal(r.status, 200, await r.clone().text());
    const plain = ((await r.json()) as { path: string }).path;
    assert.equal(plain, join(root, "Заметки"), "имя без пробелов по краям");
    assert.ok(existsSync(plain));
    assert.ok(!existsSync(join(plain, ".git")), "без git — просто папка");

    // уже есть
    r = await mkdir(root, "Заметки");
    assert.equal(r.status, 409);

    // плохие имена
    for (const bad of ["", "   ", "a/b", "a\\b", "..", ".", "CON", "nul.txt", "a:b", "x?", "end.", "x".repeat(101), null]) {
      r = await mkdir(root, bad);
      assert.equal(r.status, 400, `имя ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(readdirSync(root), ["Заметки"], "ничего лишнего не создано");

    // вне разрешённых и через ..
    r = await mkdir(base, "чужое");
    assert.equal(r.status, 403);
    r = await mkdir(join(root, ".."), "чужое");
    assert.equal(r.status, 403);
    assert.ok(!existsSync(join(base, "чужое")));

    // с git — репозиторий с первым коммитом, вложенная папка тоже можно
    r = await mkdir(plain, "Игра", true);
    assert.equal(r.status, 200, await r.clone().text());
    const repo = ((await r.json()) as { path: string }).path;
    assert.equal(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), "1", "есть первый коммит");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), "", "рабочее дерево чистое");

    // задаче нужна своя копия проекта в ветке — от новой папки она создаётся
    const wt = await createWorktree(repo, "Сделай игру", "ks_test01");
    assert.ok(existsSync(wt.worktree.path), "копия проекта есть");
    assert.equal(wt.worktree.base, "main");
    await removeWorktree(wt.worktree);
  } finally {
    await hub.close();
  }
});

test("существующая папка без git: задача отвечает узнаваемой ошибкой, git-init делает репозиторий с её файлами", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  const photos = join(root, "AlicePhotos");
  mkdirSync(photos, { recursive: true });
  writeFileSync(join(photos, "readme.md"), "# фото\n");
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [root], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // задача на папке без git — та самая ошибка, которую клиенты узнают и предлагают git
    let r = await post("/api/tasks", { goal: "Сделай галерею", directory: photos });
    assert.equal(r.status, 409);
    const err = ((await r.json()) as { error: string }).error;
    assert.ok(notRepoError(err), `клиент узнаёт ошибку: ${err}`);

    r = await post("/api/fs/git-init", { path: photos });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(execFileSync("git", ["ls-files"], { cwd: photos, encoding: "utf8" }).trim(), "readme.md", "файлы папки — в первом коммите");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: photos, encoding: "utf8" }).trim(), "");

    // теперь задача упирается уже не в git (а в отсутствие движков в тесте)
    r = await post("/api/tasks", { goal: "Сделай галерею", directory: photos });
    assert.ok(!notRepoError(((await r.json()) as { error?: string }).error ?? ""), "git больше не мешает");

    // свой .git есть, но git его не принимает (битый HEAD, чужой владелец) — не трогаем: это чья-то история
    const broken = join(root, "Broken");
    mkdirSync(join(broken, ".git"), { recursive: true });
    writeFileSync(join(broken, ".git", "HEAD"), "мусор");
    writeFileSync(join(broken, "важное.txt"), "данные");
    r = await post("/api/fs/git-init", { path: broken });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /уже есть .git|already has .git/);
    assert.equal(readFileSync(join(broken, ".git", "HEAD"), "utf8"), "мусор", ".git цел");

    // повторно и подпапка репозитория — уже в git; вне разрешённых — нельзя
    assert.equal((await post("/api/fs/git-init", { path: photos })).status, 409);
    mkdirSync(join(photos, "sub"));
    assert.equal((await post("/api/fs/git-init", { path: join(photos, "sub") })).status, 409);
    assert.equal((await post("/api/fs/git-init", { path: base })).status, 403);
  } finally {
    await hub.close();
  }
});
