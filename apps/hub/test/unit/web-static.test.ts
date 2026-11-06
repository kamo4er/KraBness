// Веб-UI после пересборки без рестарта хаба: новый бандл отдаётся как файл, а не как index.html
// (регресс 2026-10-18: веб ломался после `npm run web:build` до перезапуска хаба).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("файлы, появившиеся после старта, отдаются; несуществующий бандл — 404; маршруты SPA — index.html", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-web-"));
  const web = join(base, "dist");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<html>v1</html>");
  writeFileSync(join(web, "assets", "index-old.js"), "console.log('old')");
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
    webDir: web,
  });
  try {
    const u = hub.urls[0];
    // «пересборка» после старта
    writeFileSync(join(web, "assets", "index-new.js"), "console.log('new')");
    writeFileSync(join(web, "index.html"), "<html>v2</html>");

    const js = await fetch(u + "/assets/index-new.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    assert.equal(await js.text(), "console.log('new')");

    assert.equal((await fetch(u + "/assets/nope.js")).status, 404, "нет бандла — 404, а не index.html");
    assert.equal(await (await fetch(u + "/")).text(), "<html>v2</html>");
    assert.equal(await (await fetch(u + "/s/some/route")).text(), "<html>v2</html>", "SPA");
    assert.equal((await fetch(u + "/api/nope")).status, 404);
    // выйти за пределы dist нельзя
    const esc = await fetch(u + "/..%2Fkamharn.json");
    assert.ok(!(await esc.text()).includes("roots"));
  } finally {
    await hub.close();
  }
});

test("mermaid для приложения: с хаба без токена, с CORS и кэшем; чужого не отдаёт", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-vendor-"));
  const web = join(base, "dist");
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "index.html"), "<html>v1</html>");
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
    webDir: web,
  });
  try {
    const u = hub.urls[0];
    const r = await fetch(u + "/vendor/mermaid/mermaid.esm.min.mjs");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("cache-control") ?? "", /max-age=86400/);
    assert.match(await r.text(), /chunks\/mermaid\.esm\.min\//, "это сама библиотека");
    assert.equal((await fetch(u + "/vendor/mermaid/nope.mjs")).status, 404, "нет файла — 404, а не index.html");
    assert.equal((await fetch(u + "/vendor/nope.js")).status, 404);
    const esc = await fetch(u + "/vendor/mermaid/..%2F..%2F..%2Fpackage.json");
    assert.ok(!(await esc.text()).includes('"name": "kamharn"'), "за пределы папки mermaid не выйти");
  } finally {
    await hub.close();
  }
});
