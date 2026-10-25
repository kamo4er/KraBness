// Удалённый доступ через VPS: хаб держит ssh -R, а запросы, пришедшие туннелем, — не локальные (нужен токен),
// даже без X-Forwarded-For: иначе любой процесс на VPS получил бы доверие localhost.
// Вместо ssh — fake-ssh.mjs: он по-настоящему слушает порт «на VPS» и пробрасывает на хаб.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { createHub } from "../../src/hub.ts";

const FAKE = join(import.meta.dirname, "..", "fixtures", "fake-ssh.mjs");

const freePort = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

async function until(f: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("не дождался");
}

test("туннель на VPS: поднимается, переподключается, запросы через него требуют токен", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const log = join(base, "ssh.log");
  process.env.FAKE_SSH_LOG = log;
  // ssh от «прошлого запуска», который хаб не успел убить: в его командной строке ключ хаба
  mkdirSync(join(base, "data"));
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(base, "config", "remote_ed25519")], { stdio: "ignore" });
  const orphanExit = new Promise((r) => orphan.on("exit", r));
  writeFileSync(join(base, "data", "remote-ssh.json"), JSON.stringify({ pid: orphan.pid }));
  const hub = await createHub({
    configPath: join(base, "config", "kamharn.json"),
    skillsDir: null,
    // 192.0.2.1 (TEST-NET) на машине нет — хаб должен стартовать без него
    overrides: { publicUrls: ["https://nas.example"], listen: ["127.0.0.1", "192.0.2.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    remote: { sshBin: process.execPath, sshPrefix: [FAKE], upAfterMs: 300 },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(url + path, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, j: (await r.json()) as any }));
  try {
    // ключ хаба создаётся сам, команда для VPS содержит его открытую часть
    let st = (await api("GET", "/api/remote")).j;
    assert.equal(st.configured, false);
    assert.equal(st.state, "off");
    assert.match(st.publicKey, /^ssh-ed25519 \S+ krabness-hub-tunnel$/);
    assert.ok(st.setupCommand.includes(st.publicKey));
    assert.ok(existsSync(join(base, "config", "remote_ed25519")));

    assert.equal((await api("PUT", "/api/remote", { host: "-oProxyCommand=calc", user: "ok" })).status, 400);
    assert.equal((await api("PUT", "/api/remote", { host: "1.2.3.4", user: "ok", url: "https://x.example/path" })).status, 400);
    assert.equal((await api("PUT", "/api/remote", { host: "1.2.3.4", user: "ok", url: "http://x.example" })).status, 400, "токен по http через интернет — нет");
    assert.equal((await api("PUT", "/api/remote", { host: "1.2.3.4", user: "ok", enabled: "false" })).status, 400);
    if (process.platform === "win32") await Promise.race([orphanExit, new Promise((_, rej) => setTimeout(() => rej(new Error("сирота жива")), 5000))]);
    // по IP адрес на sslip.io подставляется сам
    st = (await api("PUT", "/api/remote", { host: "1.2.3.4", user: "ok", enabled: false })).j;
    assert.equal(st.settings.url, "https://krab.1-2-3-4.sslip.io");
    assert.equal(st.state, "off");

    const vpsPort = await freePort();
    const pub = `http://127.0.0.1:${vpsPort}`;
    st = (await api("PUT", "/api/remote", { host: "127.0.0.1", user: "ok", remotePort: vpsPort, url: pub })).j;
    assert.equal(st.state, "connecting");
    await until(async () => (await api("GET", "/api/remote")).j.state === "up");
    assert.ok(hub.urls.includes(pub), "публичный адрес среди известных");
    assert.ok(hub.urls.includes("https://nas.example"), "адрес за своим прокси (publicUrls) — тоже");
    assert.ok(!hub.urls.some((u) => u.includes("192.0.2.1")), "недоступный адрес не в списке");
    assert.ok((await api("GET", "/api/hub")).j.urls.includes(pub));

    const first = JSON.parse(readFileSync(log, "utf8").trim().split("\n").pop()!) as { pid: number; args: string[] };
    assert.equal(first.args.at(-1), "ok@127.0.0.1");
    assert.ok(first.args.includes("ExitOnForwardFailure=yes"));
    assert.equal(first.args[first.args.indexOf("-F") + 1], "none");
    assert.match(first.args[first.args.indexOf("-R") + 1]!, new RegExp(`^127\\.0\\.0\\.1:${vpsPort}:127\\.0\\.0\\.1:\\d+$`));
    assert.notEqual(first.args[first.args.indexOf("-R") + 1]!.split(":")[3], new URL(url).port, "туннель идёт на отдельный порт, не на основной");

    // через туннель: адрес 127.0.0.1 и без X-Forwarded-For, но токен всё равно нужен
    assert.equal((await fetch(`${pub}/api/health`)).status, 200);
    assert.equal((await fetch(`${pub}/api/sessions`)).status, 401);
    assert.equal((await fetch(`${pub}/api/pair/start`, { method: "POST" })).status, 401);
    const { code } = (await api("POST", "/api/pair/start")).j as { code: string };
    const { token } = (await (await fetch(`${pub}/api/pair/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "phone" }) })).json()) as { token: string };
    assert.equal((await fetch(`${pub}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const ws = (q: string) =>
      new Promise<string>((res) => {
        const s = new WebSocket(`${pub.replace(/^http/, "ws")}/ws${q}`);
        s.on("open", () => (s.close(), res("open")));
        s.on("unexpected-response", (_req, r) => res(String(r.statusCode)));
        s.on("error", () => res("error"));
      });
    assert.equal(await ws(""), "401");
    assert.equal(await ws(`?token=${encodeURIComponent(token)}`), "open");
    // MCP хаба через туннель закрыт, даже с правильным путём
    assert.equal((await fetch(`${pub}/mcp/x/claude`, { method: "POST" })).status, 403);

    assert.deepEqual((await api("POST", "/api/remote/test")).j.ok, true);


    // ssh упал — хаб переподключается сам
    const runs = readFileSync(log, "utf8").trim().split("\n");
    process.kill((JSON.parse(runs.at(-1)!) as { pid: number }).pid);
    await until(async () => readFileSync(log, "utf8").trim().split("\n").length > runs.length && (await api("GET", "/api/remote")).j.state === "up");
    assert.equal((await fetch(`${pub}/api/health`)).status, 200);

    // ключ не принят — понятная ошибка
    st = (await api("PUT", "/api/remote", { host: "127.0.0.1", user: "denied", remotePort: vpsPort, url: pub })).j;
    await until(async () => (await api("GET", "/api/remote")).j.state === "error");
    assert.match((await api("GET", "/api/remote")).j.error, /Permission denied/);

    st = (await api("DELETE", "/api/remote")).j;
    assert.equal(st.configured, false);
    assert.ok(!hub.urls.includes(pub));
  } finally {
    orphan.kill();
    await hub.close();
  }
});
