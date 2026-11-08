// Правка файлов руками из просмотра проекта: только текстовые в разрешённых папках, переводы строк сохраняются,
// файл, изменённый на диске после открытия (агентом), не затирается.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("правка файла: сохранить, CRLF остаётся, конфликт — 409, чужие и двоичные — нельзя", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(join(root, "app"), { recursive: true });
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [root], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const read = async (p: string) => (await (await fetch(`${url}/api/fs/read?path=${encodeURIComponent(p)}`)).json()) as { text: string; sha256: string };
  const write = (p: string, text: string, base?: string) =>
    fetch(`${url}/api/fs/write`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: p, text, base }) });
  try {
    const rules = join(root, "app", "AGENTS.md");
    writeFileSync(rules, "# Правила\r\n- раз\r\n");
    let v = await read(rules);
    assert.equal(v.text, "# Правила\r\n- раз\r\n");
    // браузер отдаёт текст из поля с \n — на диске остаётся CRLF
    let r = await write(rules, "# Правила\n- раз\n- два\n", v.sha256);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(readFileSync(rules, "utf8"), "# Правила\r\n- раз\r\n- два\r\n");
    const saved = (await r.json()) as { sha256: string };

    // агент поменял файл, пока его правили руками — не затираем
    writeFileSync(rules, "# Правила\r\n- от агента\r\n");
    r = await write(rules, "моё", saved.sha256);
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /изменился на диске/);
    assert.equal(readFileSync(rules, "utf8"), "# Правила\r\n- от агента\r\n");
    assert.equal((await write(rules, "без base")).status, 409);

    // LF-файл остаётся LF
    const lf = join(root, "app", "a.ts");
    writeFileSync(lf, "export const a = 1;\n");
    v = await read(lf);
    assert.equal((await write(lf, "export const a = 2;\n", v.sha256)).status, 200);
    assert.equal(readFileSync(lf, "utf8"), "export const a = 2;\n");

    // двоичный, вне разрешённых папок, несуществующий
    const bin = join(root, "app", "x.bin");
    writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
    assert.equal((await write(bin, "x", "y")).status, 400);
    const outside = join(base, "secret.txt");
    writeFileSync(outside, "s");
    assert.equal((await write(outside, "x", "y")).status, 403);
    assert.equal(readFileSync(outside, "utf8"), "s");
    assert.ok([403, 404, 500].includes((await write(join(root, "app", "nope.txt"), "x", "y")).status));
    assert.equal(readFileSync(lf, "utf8"), "export const a = 2;\n");
  } finally {
    await hub.close();
  }
});
