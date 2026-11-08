// Просмотр проекта без агента: файлы и git-изменения папки сессии.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gitInfo, readFileView } from "../../src/project.ts";

test("readFileView: текст, обрезка, двоичный", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamharn-pv-"));
  writeFileSync(join(dir, "a.md"), "# Привет\n");
  writeFileSync(join(dir, "big.txt"), "x".repeat(2000));
  writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(dir, "pic.png"), "not really png");
  assert.deepEqual(readFileView(join(dir, "a.md")), { path: join(dir, "a.md"), size: 15, mime: "text/markdown", text: "# Привет\n", truncated: false, sha256: createHash("sha256").update("# Привет\n").digest("hex") });
  const big = readFileView(join(dir, "big.txt"), 100);
  assert.equal(big.text?.length, 100);
  assert.equal(big.truncated, true);
  assert.equal(big.sha256, undefined, "обрезанный файл править нельзя — хеша нет");
  assert.equal(readFileView(join(dir, "bin.dat")).binary, true);
  assert.equal(readFileView(join(dir, "pic.png")).binary, true, "картинки — по расширению");
});

test("gitInfo: ветка, изменённые и новые файлы, дифф только по папке; не репозиторий", async () => {
  const repo = mkdtempSync(join(tmpdir(), "kamharn-git-"));
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo });
  g("init", "-q", "-b", "main");
  mkdirSync(join(repo, "app"));
  mkdirSync(join(repo, "other"));
  writeFileSync(join(repo, "app", "x.ts"), "const a = 1;\n");
  writeFileSync(join(repo, "other", "y.ts"), "1\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "app", "x.ts"), "const a = 2;\n");
  writeFileSync(join(repo, "app", "new.ts"), "new\n");
  writeFileSync(join(repo, "other", "y.ts"), "2\n");

  const info = await gitInfo(join(repo, "app"));
  assert.equal(info.repo, true);
  assert.equal(info.branch, "main");
  assert.deepEqual(info.files.map((f) => f.status).sort(), ["??", "M"]);
  assert.match(info.diff, /-const a = 1;\n\+const a = 2;/);
  assert.ok(!info.diff.includes("y.ts"), "чужая папка не попала");

  assert.deepEqual(await gitInfo(mkdtempSync(join(tmpdir(), "kamharn-nogit-"))), { repo: false, files: [], diff: "", truncated: false });
});
