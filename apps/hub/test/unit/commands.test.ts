// Меню «/»: скиллы и команды Claude из папок .claude и из system:init.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeCommands, describe } from "../../src/commands.ts";

test("describe: заголовок YAML, кавычки, без заголовка — первая строка текста", () => {
  assert.deepEqual(describe('---\nname: commit\ndescription: "Автокоммит + бэкап .env"\n---\n\n# Commit'), { name: "commit", description: "Автокоммит + бэкап .env" });
  assert.deepEqual(describe("# Docker\n\nИспользуй когда: сервис в контейнере.\n"), { description: "Используй когда: сервис в контейнере." });
});

test("claudeCommands: проект важнее пользователя, init без описаний, встроенные в конце, без дублей", () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-cmd-"));
  const home = join(base, "home");
  const proj = join(base, "proj");
  const skill = (root: string, name: string, md: string) => {
    mkdirSync(join(root, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", name, "SKILL.md"), md);
  };
  skill(home, "commit", "---\nname: commit\ndescription: пользовательский\n---\n");
  skill(proj, "commit", "---\nname: commit\ndescription: проектный\n---\n");
  skill(home, "deploy", "---\nname: deploy\ndescription: Деплой\n---\n");
  mkdirSync(join(proj, ".claude", "commands"), { recursive: true });
  writeFileSync(join(proj, ".claude", "commands", "release.md"), "Собрать и выпустить версию\n");

  const list = claudeCommands(proj, home, ["deploy", "code-review"]);
  const by = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(by.commit!.description, "проектный");
  assert.equal(by.deploy!.description, "Деплой", "описание из файла не затирается именем из init");
  assert.deepEqual(by["code-review"], { name: "code-review", kind: "skill" });
  assert.deepEqual(by.release, { name: "release", description: "Собрать и выпустить версию", kind: "command" });
  assert.equal(by.compact!.kind, "command");
  assert.equal(list.length, new Set(list.map((c) => c.name)).size, "без дублей");
  assert.equal(list.at(-1)!.name, "security-review", "встроенные — в конце");
});
