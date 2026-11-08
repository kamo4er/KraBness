// Обновление Android-приложения: хаб отдаёт последнюю опубликованную сборку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("/api/app/latest и /api/app/apk: 404 без сборки, файл с Range после публикации", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const dataDir = join(base, "data");
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir, roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  try {
    const u = hub.urls[0];
    assert.equal((await fetch(u + "/api/app/latest")).status, 404);
    assert.equal((await fetch(u + "/api/app/apk")).status, 404);

    // то, что кладёт apps/mobile/scripts/publish-apk.mjs
    mkdirSync(join(dataDir, "apk"));
    const apk = Buffer.alloc(4096, 7);
    writeFileSync(join(dataDir, "apk", "KamHarn-0.2.0.apk"), apk);
    const release = { version: "0.2.0", versionCode: 4, file: "KamHarn-0.2.0.apk", size: apk.length, sha256: "x", builtAt: 1 };
    writeFileSync(join(dataDir, "apk", "latest.json"), JSON.stringify(release));

    assert.deepEqual(await (await fetch(u + "/api/app/latest")).json(), release);
    const r = await fetch(u + "/api/app/apk");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.equal((await r.arrayBuffer()).byteLength, 4096);
    const part = await fetch(u + "/api/app/apk", { headers: { range: "bytes=4000-" } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 96);
  } finally {
    await hub.close();
  }
});
