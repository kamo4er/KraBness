// «@» в поле ввода: что считается набираемым упоминанием, как вставляется путь, как ищутся файлы (с git и без).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMention, mentionAt } from "@kamharn/client";
import { clearFileSearchCache, searchFiles } from "../../src/filesearch.ts";

test("набираемое «@…» у курсора", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionAt("глянь @src/ses", 14), { start: 6, query: "src/ses" });
  assert.equal(mentionAt("почта me@x.ru", 13), undefined, "не после буквы");
  assert.equal(mentionAt("@src/a.ts дальше", 16), undefined, "после пробела — уже не упоминание");
  assert.deepEqual(mentionAt("@ab cd", 2), { start: 0, query: "a" }, "считаем до курсора");
});

test("вставка пути: файл с пробелом после, папка — без (ищем дальше внутри), пробелы в имени — в кавычках", () => {
  assert.deepEqual(applyMention("глянь @ses", 10, "apps/hub/src/sessionbot.ts"), { text: "глянь @apps/hub/src/sessionbot.ts ", caret: 34 });
  assert.deepEqual(applyMention("@ap", 3, "apps", true), { text: "@apps/", caret: 6 });
  assert.equal(applyMention("@ро", 3, "Алиса/УЗИ и обследования", true).text, '@"Алиса/УЗИ и обследования/" ');
  assert.equal(applyMention("Windows: @c", 11, "a\\b.ts").text, "Windows: @a/b.ts ");
  // правка посередине: хвост слова заменяется, остальной текст на месте
  assert.equal(applyMention("@sesbot и ещё", 4, "x/sessionbot.ts").text, "@x/sessionbot.ts и ещё");
  assert.deepEqual(applyMention("без упоминания", 5, "a.ts"), { text: "без упоминания", caret: 5 });
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "kh-mention-"));
  for (const f of ["apps/hub/src/sessionbot.ts", "apps/hub/src/sessions.ts", "apps/web/src/Chat.tsx", "README.md", "Алиса/УЗИ/2026-10-20-узи.pdf", "node_modules/x/index.js", "dist/app.js"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  return dir;
}

test("поиск без git: верхний уровень, содержимое папки, по имени и по буквам; мусорные папки не видны", async () => {
  clearFileSearchCache();
  const dir = project();
  assert.deepEqual(await searchFiles(dir, ""), [{ path: "apps", dir: true }, { path: "Алиса", dir: true }, { path: "README.md" }]);
  assert.deepEqual(await searchFiles(dir, "apps/hub/src/"), [{ path: "apps/hub/src/sessionbot.ts" }, { path: "apps/hub/src/sessions.ts" }]);
  assert.equal((await searchFiles(dir, "sessions"))[0]!.path, "apps/hub/src/sessions.ts", "точное имя выше");
  assert.equal((await searchFiles(dir, "sbt"))[0]!.path, "apps/hub/src/sessionbot.ts", "буквы по порядку");
  assert.equal((await searchFiles(dir, "узи"))[0]!.path, "Алиса/УЗИ", "кириллица, папка");
  assert.equal((await searchFiles(dir, "apps/web/ch"))[0]!.path, "apps/web/src/Chat.tsx", "внутри папки глубже");
  assert.deepEqual(await searchFiles(dir, "index"), [], "node_modules не обходим");
  assert.deepEqual(await searchFiles(dir, "app.js"), []);
});

test("поиск в git: .gitignore соблюдается, новые (неотслеживаемые) файлы видны, кириллица без экранирования", async () => {
  clearFileSearchCache();
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\nsecret.env\n");
  writeFileSync(join(dir, "secret.env"), "x");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q");
  g("add", "README.md", "apps");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const paths = (await searchFiles(dir, "", 100)).map((h) => h.path);
  assert.deepEqual(paths, ["apps", "Алиса", ".gitignore", "README.md"], "верхний уровень: игнорируемых нет");
  assert.equal((await searchFiles(dir, "узи.pdf"))[0]!.path, "Алиса/УЗИ/2026-10-20-узи.pdf", "новый файл с кириллицей");
  assert.deepEqual(await searchFiles(dir, "secret"), []);
});
