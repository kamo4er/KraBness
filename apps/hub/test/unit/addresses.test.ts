// «Адреса хаба»: свои адреса за прокси (publicUrls) правятся из UI, попадают в известные адреса,
// проверять снаружи можно только адреса хаба — хаб не ходит по чужим ссылкам.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("свои адреса хаба: правка, проверка, только https", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, j: (await r.json()) as any }));
  try {
    assert.deepEqual((await api("GET", "/api/addresses")).j.publicUrls, []);
    assert.equal((await api("PUT", "/api/addresses", { publicUrls: ["http://nas.example"] })).status, 400, "http наружу — нет");
    assert.equal((await api("PUT", "/api/addresses", { publicUrls: ["https://nas.example/path"] })).status, 400);
    assert.equal((await api("PUT", "/api/addresses", { publicUrls: "https://nas.example" })).status, 400);

    // loopback по http разрешён — так проверяем «снаружи» на этом же хабе
    const self = url.replace("127.0.0.1", "localhost");
    const r = (await api("PUT", "/api/addresses", { publicUrls: ["https://nas.example/", self, ""] })).j;
    assert.deepEqual(r.publicUrls, ["https://nas.example", self]);
    assert.ok(hub.urls.includes("https://nas.example"));
    assert.deepEqual(JSON.parse(readFileSync(join(base, "kamharn.json"), "utf8")).publicUrls, ["https://nas.example", self]);

    assert.equal((await api("POST", "/api/addresses/check", { url: self })).j.ok, true);
    assert.equal((await api("POST", "/api/addresses/check", { url: "https://evil.example" })).status, 400, "чужой адрес не проверяем");

    assert.deepEqual((await api("PUT", "/api/addresses", { publicUrls: [] })).j.publicUrls, []);
    assert.ok(!hub.urls.includes("https://nas.example"));
  } finally {
    await hub.close();
  }
});
