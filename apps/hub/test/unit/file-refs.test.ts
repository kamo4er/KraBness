// Пути к файлам в ответах агента становятся ссылками: что считаем путём, а что нет.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFileRef, resolveFileRef } from "@kamharn/client";

test("что в `коде` считается путём к файлу", () => {
  assert.deepEqual(parseFileRef("tmp/posts/krabness-tunnel.md"), { path: "tmp/posts/krabness-tunnel.md" });
  assert.deepEqual(parseFileRef("apps/hub/src/remote.ts:42"), { path: "apps/hub/src/remote.ts", line: 42 });
  assert.deepEqual(parseFileRef("apps/hub/src/remote.ts:42-50"), { path: "apps/hub/src/remote.ts", line: 42 });
  assert.deepEqual(parseFileRef("./scripts/vps-setup.sh"), { path: "./scripts/vps-setup.sh" });
  assert.deepEqual(parseFileRef("D:\\work\\proj\\README.md"), { path: "D:\\work\\proj\\README.md" });
  assert.deepEqual(parseFileRef("C:\\Program Files\\Tailscale\\readme.txt"), { path: "C:\\Program Files\\Tailscale\\readme.txt" });
  assert.deepEqual(parseFileRef("tmp/plans/"), { path: "tmp/plans/", dir: true });
  assert.deepEqual(parseFileRef("tmp/"), { path: "tmp/", dir: true });

  for (const not of [
    "npm test",
    "node.exe",
    "README.md", // без папки — неясно где лежит
    "/api/remote", // маршрут хаба
    "https://example.com/a.md",
    "~/.claude/rules",
    "apps/hub/src", // папка без слеша на конце — не отличить от owner/repo
    "kamo4er/KraBness",
    "text/plain",
    "git add a.ts b.ts",
    "foo/bar.ts(1)",
    "-F none",
    "",
  ]) {
    assert.equal(parseFileRef(not), undefined, not);
  }
});

test("относительные пути — от папки сессии, её разделителем", () => {
  assert.equal(resolveFileRef({ path: "tmp/a.md" }, "C:\\proj"), "C:\\proj\\tmp\\a.md");
  assert.equal(resolveFileRef({ path: "./tmp/a.md" }, "C:\\proj\\"), "C:\\proj\\tmp\\a.md");
  assert.equal(resolveFileRef({ path: "tmp/plans/", dir: true }, "C:\\proj"), "C:\\proj\\tmp\\plans");
  assert.equal(resolveFileRef({ path: "D:/x/y.ts" }, "C:\\proj"), "D:/x/y.ts");
  assert.equal(resolveFileRef({ path: "src/a.ts" }, "/home/u/p"), "/home/u/p/src/a.ts");
});
