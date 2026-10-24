// Снимок экрана ПК: отдаётся JPEG без кэша; ошибка снимка — понятный 409.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub, type HubOptions } from "../../src/hub.ts";

async function hub(extra: Partial<HubOptions>) {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  return createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
    ...extra,
  });
}

test("GET /api/screen: JPEG без кэша; снимок не получился — 409 с причиной", async () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const ok = await hub({ screen: async () => jpg });
  try {
    const r = await fetch(ok.urls[0] + "/api/screen");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/jpeg");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), jpg);
  } finally {
    await ok.close();
  }
  const bad = await hub({ screen: async () => Promise.reject(new Error("Для снимка экрана нужен ffmpeg")) });
  try {
    const r = await fetch(bad.urls[0] + "/api/screen");
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /ffmpeg/);
  } finally {
    await bad.close();
  }
});
