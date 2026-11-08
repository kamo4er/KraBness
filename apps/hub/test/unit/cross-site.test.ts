// localhost доверенный, поэтому чужим сайтам в браузере на ПК хаб недоступен: «слепой» POST, WebSocket и ?token=
// с чужим Origin получают 403. Свои клиенты (веб-UI, vite dev, приложение без Origin) работают как раньше.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { createHub } from "../../src/hub.ts";

const md = "---\nname: evil\ndescription: x\n---\nтекст\n";

test("чужой сайт не достучится до хаба на localhost, свои клиенты — да", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: join(base, "skills"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const upload = (headers: Record<string, string>, q = "") => fetch(`${url}/api/skills/upload?name=SKILL.md&overwrite=1${q}`, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: md });
  try {
    assert.equal((await upload({ origin: "https://evil.example" })).status, 403);
    assert.equal((await upload({ origin: "https://evil.example" }, "&token=anything")).status, 403, "?token= не помогает");
    assert.equal((await upload({ origin: "null" })).status, 403);
    assert.equal((await upload({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await fetch(`${url}/api/sessions`, { headers: { origin: "http://192.168.1.50:8080" } })).status, 403);

    // свои: без Origin (приложение, curl), веб-UI на 127.0.0.1, vite dev на localhost:5173
    assert.equal((await upload({})).status, 200);
    assert.equal((await upload({ origin: url })).status, 200);
    assert.equal((await upload({ origin: "http://localhost:5173", "sec-fetch-site": "same-site" })).status, 200);

    // WebSocket: на него CORS не действует, поэтому Origin проверяем сами
    const wsUrl = url.replace(/^http/, "ws") + "/ws";
    const evil = await new Promise<string>((res) => {
      const ws = new WebSocket(wsUrl, { origin: "https://evil.example" });
      ws.on("open", () => (ws.close(), res("open")));
      ws.on("unexpected-response", (_req, r) => res(String(r.statusCode)));
      ws.on("error", () => res("error"));
    });
    assert.equal(evil, "403");
    const own = await new Promise<string>((res) => {
      const ws = new WebSocket(wsUrl, { origin: url });
      ws.on("message", () => (ws.close(), res("hello")));
      ws.on("error", (e) => res(String(e)));
    });
    assert.equal(own, "hello");
  } finally {
    await hub.close();
  }
});
