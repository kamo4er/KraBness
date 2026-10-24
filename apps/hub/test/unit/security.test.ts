// Обходы авторизации из аудита перед публикацией:
// 1) %XX в пути (/%61pi/… → роутер раскодирует в /api/…), 2) DNS rebinding (чужой Host на доверенном localhost),
// 3) чужой localhost-порт в Origin, 4) запрос через обратный прокси (X-Forwarded-For) — не «локальный».
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { createHub } from "../../src/hub.ts";

/** fetch не даёт подменить Host — шлём сырым http.request */
function raw(url: string, path: string, headers: Record<string, string>, method = "GET", body?: string): Promise<number> {
  const u = new URL(url);
  return new Promise((res, rej) => {
    const r = request({ host: u.hostname, port: u.port, path, method, headers }, (resp) => {
      resp.resume();
      res(resp.statusCode ?? 0);
    });
    r.on("error", rej);
    r.end(body);
  });
}

const wsOpens = (url: string, headers: Record<string, string>) =>
  new Promise<boolean>((res) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => (ws.close(), res(true)));
    ws.on("error", () => res(false));
    ws.on("unexpected-response", () => res(false));
  });

test("авторизацию не обойти: %XX в пути, чужой Host, чужой localhost-порт, обратный прокси", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-sec-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: join(base, "skills"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const host = new URL(url).host;
  const evil = { origin: "https://evil.example" };
  const md = "---\nname: evil\ndescription: x\n---\n";
  try {
    // 1. %XX: чужой сайт через закодированный путь
    assert.equal(await raw(url, "/api/sessions", { host, ...evil }), 403);
    assert.equal(await raw(url, "/%61pi/sessions", { host, ...evil }), 403, "/%61pi/ — тот же /api/");
    assert.equal(await raw(url, "/%61pi/skills/upload?name=SKILL.md", { host, ...evil, "content-type": "text/plain" }, "POST", md), 403);
    // %2F роутер не раскодирует: это не API, а запасная отдача index.html
    const slash = await fetch(url + "/api%2Fsessions", { headers: evil });
    assert.ok(!(slash.headers.get("content-type") ?? "").includes("json"), "не данные API");
    const ws = url.replace(/^http/, "ws");
    assert.equal(await wsOpens(`${ws}/w%73`, evil), false, "/w%73 — тот же /ws");
    assert.equal(await wsOpens(`${ws}/ws`, {}), true, "свой WebSocket работает");

    // 2. DNS rebinding: страница evil.com перепривязана на 127.0.0.1 — Host чужой, Origin нет
    assert.equal(await raw(url, "/api/sessions", { host: `evil.example:${new URL(url).port}` }), 403);
    assert.equal(await raw(url, "/api/sessions", { host }), 200);
    assert.equal(await raw(url, "/api/sessions", { host: `localhost:${new URL(url).port}` }), 200);

    // 3. Origin — только сам хаб (и vite dev :5173), а не любой localhost
    assert.equal(await raw(url, "/api/sessions", { host, origin: "http://localhost:3000" }), 403);
    assert.equal(await raw(url, "/api/sessions", { host, origin: url }), 200);
    assert.equal(await raw(url, "/api/sessions", { host: "localhost:5173", origin: "http://localhost:5173" }), 200);

    // 4. через прокси (tailscale serve, ssh -L) запрос не локальный: нужен токен
    const fwd = { host, "x-forwarded-for": "100.64.0.9" };
    assert.equal(await raw(url, "/api/sessions", fwd), 401);
    assert.equal(await raw(url, "/%61pi/sessions", fwd), 401);
    assert.equal(await raw(url, "/api/sessions", { host, forwarded: "for=100.64.0.9" }), 401);
    assert.equal(await raw(url, "/api/health", fwd), 200, "публичное — без токена");
    // токен устройства работает и через прокси
    const { code } = (await (await fetch(url + "/api/pair/start", { method: "POST" })).json()) as { code: string };
    const { token } = (await (await fetch(url + "/api/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "proxy" }) })).json()) as { token: string };
    assert.equal(await raw(url, "/api/sessions", { ...fwd, authorization: `Bearer ${token}` }), 200);

    // статика и веб-UI как раньше
    assert.equal(await raw(url, "/", { host }), 200);

    // сетевые пути отклоняются до обращения к диску (иначе Windows отдаёт NTLM-хэш чужому серверу)
    for (const p of ["\\\\nonexistent.invalid\\share", "//nonexistent.invalid/share", "\\\\?\\UNC\\nonexistent.invalid\\share"]) {
      assert.throws(() => hub.config.resolveAllowed(p), /Сетевые пути|Network paths/);
      assert.throws(() => hub.config.addRoot(p), /Сетевые пути|Network paths/);
    }
  } finally {
    await hub.close();
  }
});
