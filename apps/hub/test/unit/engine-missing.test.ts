// opencode не установлен: хаб работает дальше, в списке движков он есть с подсказкой, как поставить,
// а провайдеры отвечают понятной ошибкой вместо «Invalid URL».
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("opencode не установлен: виден в движках с подсказкой, провайдеры без «Invalid URL»", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-noopencode-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: {
      listen: ["127.0.0.1"],
      port: 0,
      dataDir: join(base, "data"),
      roots: [join(base, "Projects")],
      engines: { opencode: { enabled: true, port: 0, bin: join(base, "нет-такого-opencode.exe") }, claude: { enabled: false } },
    },
    log: () => {},
  });
  const url = hub.urls[0]!;
  try {
    const engines = (await (await fetch(url + "/api/engines")).json()) as Array<{ id: string; available: boolean; error?: string }>;
    const oc = engines.find((e) => e.id === "opencode");
    assert.ok(oc, "opencode в списке, а не пропал");
    assert.equal(oc.available, false);
    assert.match(oc.error ?? "", /не установлен|isn't installed/);
    assert.match(oc.error ?? "", /npm i -g opencode-ai/);

    const prov = await fetch(url + "/api/providers");
    const body = (await prov.json()) as { error?: string };
    assert.notEqual(prov.status, 200);
    assert.doesNotMatch(body.error ?? "", /Invalid URL/);
    assert.match(body.error ?? "", /opencode/);
  } finally {
    await hub.close();
  }
});
