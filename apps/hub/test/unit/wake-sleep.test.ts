// Сон ПК из приложения и настройки пробуждения (сервис на NAS).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub, type HubOptions } from "../../src/hub.ts";
import type { HubConfig } from "../../src/config.ts";

async function hub(extra: Partial<HubOptions> = {}, cfg: Partial<HubConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  return createHub({
    configPath: join(base, "kamharn.json"),
    overrides: {
      listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")],
      engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } },
      ...cfg,
    },
    log: () => {},
    ...extra,
  });
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("сон: без onSleep — 409 и canSleep=false, пробуждение не настроено — 404", async () => {
  const h = await hub();
  try {
    assert.equal((await (await fetch(h.urls[0] + "/api/hub")).json()).canSleep, false);
    assert.equal((await post(h.urls[0] + "/api/hub/sleep", {})).status, 409);
    assert.equal((await fetch(h.urls[0] + "/api/wake")).status, 404);
  } finally {
    await h.close();
  }
});

test("сон: не раньше задержки (минимум 5 с), настройки пробуждения отдаются", async () => {
  let slept = 0;
  const h = await hub({ onSleep: () => slept++ }, { wake: { url: "http://100.1.2.3:7421", token: "t".repeat(32) } });
  try {
    assert.equal((await (await fetch(h.urls[0] + "/api/hub")).json()).canSleep, true);
    const r = await post(h.urls[0] + "/api/hub/sleep", { delaySec: 0 });
    assert.deepEqual(await r.json(), { ok: true, delaySec: 5 });
    await new Promise((res) => setTimeout(res, 4500));
    assert.equal(slept, 0, "ответ должен успеть уйти до сна");
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(slept, 1);
    // старая настройка (только адрес и токен) работает; приложению ещё и порт хаба — проверять, проснулся ли ПК
    assert.deepEqual(await (await fetch(h.urls[0] + "/api/wake")).json(), { url: "http://100.1.2.3:7421", token: "t".repeat(32), pcPort: Number(new URL(h.urls[0]!).port) });
  } finally {
    await h.close();
  }
});
