// «Новая сессия»: какие движки показывать и что выбрано по умолчанию — настройка хаба, а не «последний выбранный».
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("настройки новой сессии: по умолчанию все движки и opencode, сохранение, проверка", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0] + "/api/new-session";
  const put = (b: unknown) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  try {
    // ничего не настроено — Claude не навязываем
    assert.deepEqual(await (await fetch(url)).json(), { engines: ["opencode", "claude"], engine: "opencode", models: {} });

    let r = await put({ engines: ["claude"], engine: "claude", models: { claude: { providerId: "anthropic", modelId: "claude-sonnet-5-5" }, opencode: { bad: 1 } } });
    assert.deepEqual(await r.json(), { engines: ["claude"], engine: "claude", models: { claude: { providerId: "anthropic", modelId: "claude-sonnet-5-5" } } });

    // движок по умолчанию должен быть среди включённых; выключать все нельзя
    r = await put({ engines: ["opencode"], engine: "claude" });
    assert.equal(((await r.json()) as { engine: string }).engine, "opencode");
    assert.equal((await put({ engines: [] })).status, 400);
    assert.equal((await put({ engines: ["gpt"] })).status, 400);
    // модели сохраняются, даже если правили только движки
    assert.deepEqual(((await (await fetch(url)).json()) as { models: object }).models, { claude: { providerId: "anthropic", modelId: "claude-sonnet-5-5" } });
  } finally {
    await hub.close();
  }
});
