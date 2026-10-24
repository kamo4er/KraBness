// Превью dev-сервера: прокси по ключу, Host/Origin как localhost, WebSocket (горячая перезагрузка), запасной порт.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { Previews } from "../../src/preview.ts";

async function devServer() {
  const seen: Array<{ host?: string; cookie?: string; origin?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, cookie: req.headers.cookie });
    // как Vite: чужой Host — отказ
    if (!req.headers.host?.startsWith("localhost:")) return res.writeHead(403).end("Blocked request. This host is not allowed.");
    res.writeHead(200, { "content-type": "text/plain" }).end(`dev ${req.url}`);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    seen.push({ host: req.headers.host, origin: req.headers.origin });
    ws.on("message", (m) => ws.send(`echo ${m}`));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, wss, port: (server.address() as AddressInfo).port, seen };
}

const free = async () => {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "::1", () => r()));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
};

test("превью: без ключа — 401; ключ → кука; запросы и WebSocket уходят на dev-сервер как с localhost", async () => {
  const dev = await devServer();
  const pv = new Previews(() => "::1");
  try {
    const url = await pv.open({ port: dev.port, address: "127.0.0.1" });
    assert.equal(url, `http://[::1]:${dev.port}/?kh_preview=${pv.keyFor(dev.port)}`);
    const base = `http://[::1]:${dev.port}`;

    assert.equal((await fetch(base + "/")).status, 401);
    const r = await fetch(`${base}/?kh_preview=${pv.keyFor(dev.port)}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/");
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!;

    const page = await fetch(base + "/src/main.ts?x=1", { headers: { cookie: `${cookie}; theme=dark` } });
    assert.equal(await page.text(), "dev /src/main.ts?x=1");
    const last = dev.seen.at(-1)!;
    assert.equal(last.host, `localhost:${dev.port}`);
    assert.equal(last.cookie, "theme=dark", "ключ превью dev-серверу не передаётся");

    // ключ одного порта к другому не подходит; общий ключ хаба не годится
    assert.notEqual(pv.keyFor(dev.port), pv.keyFor(dev.port + 1));
    assert.equal((await fetch(`${base}/?kh_preview=${pv.key}`, { redirect: "manual" })).status, 401);
    // редирект после ключа — только на свой путь, не на //evil.example
    const evil = await fetch(`${base}//evil.example/x?kh_preview=${pv.keyFor(dev.port)}`, { redirect: "manual" });
    const loc = evil.headers.get("location") ?? "";
    assert.ok(loc.startsWith("/") && !loc.startsWith("//"), `свой путь: ${loc}`);
    // кривая строка запроса — 400, а не падение хаба
    const bad = await new Promise<string>((res) => {
      const s = connect(dev.port, "::1", () => s.write("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n"));
      s.on("data", (d) => (res(String(d).split("\r\n")[0]!), s.destroy()));
      s.on("error", () => res("error"));
    });
    assert.match(bad, /400/);

    // без куки WebSocket не пускаем
    await assert.rejects(new Promise((res, rej) => {
      const ws = new WebSocket(`ws://[::1]:${dev.port}/hmr`);
      ws.on("open", res);
      ws.on("error", rej);
    }));
    const ws = new WebSocket(`ws://[::1]:${dev.port}/hmr`, { headers: { cookie, origin: `http://[::1]:${dev.port}` } });
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    ws.send("ping");
    const reply = await new Promise<string>((res) => ws.once("message", (m) => res(String(m))));
    assert.equal(reply, "echo ping");
    assert.equal(dev.seen.at(-1)!.origin, `http://localhost:${dev.port}`);
    ws.close();
  } finally {
    await pv.close();
    dev.wss.close();
    await new Promise((r) => dev.server.close(r));
  }
});

test("превью: порт на адресе занят — запасной; dev-сервер на всех адресах — ссылка напрямую", async () => {
  const dev = await devServer();
  const busy: Server = createServer();
  await new Promise<void>((r) => busy.listen(dev.port, "::1", () => r()));
  const spare = await free();
  const pv = new Previews(() => "::1", () => {}, [spare]);
  try {
    const url = await pv.open({ port: dev.port, address: "127.0.0.1" });
    assert.ok(url.startsWith(`http://[::1]:${spare}/`), url);
    assert.equal(await pv.open({ port: dev.port, address: "127.0.0.1" }), url, "повторно — тот же прокси");
    assert.equal(await pv.open({ port: 3000, address: "0.0.0.0" }), "http://[::1]:3000/");
    await assert.rejects(new Previews(() => undefined).open({ port: 1, address: "127.0.0.1" }), /Tailscale/);
  } finally {
    await pv.close();
    await new Promise((r) => busy.close(r));
    dev.wss.close();
    await new Promise((r) => dev.server.close(r));
  }
});
