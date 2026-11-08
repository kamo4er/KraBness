// Перезапуск хаба из API: только под сторожем, с задержкой.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub, type HubOptions } from "../../src/hub.ts";

async function hub(extra: Partial<HubOptions> = {}) {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  return createHub({
    configPath: join(base, "kamharn.json"),
    overrides: {
      listen: ["127.0.0.1"],
      port: 0,
      dataDir: join(base, "data"),
      roots: [join(base, "Projects")],
      engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } },
    },
    log: () => {},
    ...extra,
  });
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("без сторожа: 409 и supervised=false", async () => {
  const h = await hub();
  try {
    const info = await (await fetch(h.urls[0] + "/api/hub")).json();
    assert.equal(info.supervised, false);
    assert.ok(info.startedAt > 0);
    const r = await post(h.urls[0] + "/api/hub/restart", {});
    assert.equal(r.status, 409);
  } finally {
    await h.close();
  }
});

test("под сторожем: ответ уходит сразу, onRestart — после задержки", async () => {
  let restarted = 0;
  const h = await hub({ onRestart: () => restarted++ });
  try {
    assert.equal((await (await fetch(h.urls[0] + "/api/hub")).json()).supervised, true);
    const r = await post(h.urls[0] + "/api/hub/restart", { delaySec: 1 });
    assert.deepEqual(await r.json(), { ok: true, delaySec: 1 });
    assert.equal(restarted, 0, "не раньше задержки");
    await new Promise((res) => setTimeout(res, 1300));
    assert.equal(restarted, 1);
    // задержка ограничена сверху
    const r2 = await post(h.urls[0] + "/api/hub/restart", { delaySec: 99999 });
    assert.equal((await r2.json()).delaySec, 300);
  } finally {
    await h.close();
  }
});
