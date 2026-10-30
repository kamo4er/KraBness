// Общий адрес превью (своё имя за NAS → порт хаба): клиент по имени получает ссылку на него, браузер запоминает порт кукой,
// HTTP и WebSocket уходят на dev-сервер; хаб перехватывает такие запросы раньше своего API, остальное — как было.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import { type AddressInfo, type Socket } from "node:net";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket, { WebSocketServer } from "ws";
import { Previews } from "../../src/preview.ts";

const SHARED = "https://preview.krab.example.org";
const HOST = "preview.krab.example.org";

/** запрос с нужным Host (fetch его не даёт подменить) */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: HOST, ...headers } }, (m) => {
      let body = "";
      m.on("data", (d) => (body += d)).on("end", () => res({ status: m.statusCode ?? 0, headers: m.headers, body }));
    });
    r.on("error", rej);
    r.end();
  });
}
const cookiesOf = (h: IncomingMessage["headers"]) => (h["set-cookie"] ?? []).map((c) => c.split(";")[0]!).join("; ");

test("общий адрес: по имени — ссылка на него, кука порта, HTTP и WebSocket до dev-сервера; по IP — как раньше", async () => {
  const dev = createServer((req, res) => res.writeHead(200, { "content-type": "text/plain" }).end(`dev ${req.url} host=${req.headers.host}`));
  const wss = new WebSocketServer({ server: dev });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo ${m}`)));
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", () => r()));
  const devPort = (dev.address() as AddressInfo).port;
  const pv = new Previews(() => "::1", () => {}, [0], undefined, () => SHARED);
  // «хаб»: запросы с общим именем — в превью, остальное — «API хаба»
  const hub = createServer((req, res) => (pv.isShared(req) ? pv.handleShared(req, res) : res.writeHead(200).end("hub api")));
  hub.on("upgrade", (req, sock, head) => (pv.isShared(req) ? pv.upgradeShared(req, sock as Socket, head) : sock.destroy()));
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", () => r()));
  const hubPort = (hub.address() as AddressInfo).port;
  try {
    // до открытия из чата общий адрес ничего не показывает
    assert.equal((await get(hubPort, "/")).status, 404);

    const link = await pv.open({ port: devPort, address: "127.0.0.1" }, { via: "https://krab.example.org" });
    assert.ok(link.startsWith(`${SHARED}/?`), link);
    const u = new URL(link);
    assert.equal(u.searchParams.get("kh_port"), String(devPort));
    // по IP (дома, Tailscale) — по-прежнему отдельный порт прокси
    assert.match(await pv.open({ port: devPort, address: "127.0.0.1" }, { via: "http://100.101.102.103:7420" }), /^http:\/\/\[::1\]:\d+\/\?kh_preview=/);

    const first = await get(hubPort, u.pathname + u.search);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, "/");
    const cookie = cookiesOf(first.headers);
    assert.match(cookie, new RegExp(`kh_pv=${devPort}`));
    assert.equal((await get(hubPort, "/")).status, 404, "без куки — не знаем, чей порт");

    const page = await get(hubPort, "/src/main.ts", { cookie: `${cookie}; theme=dark` });
    assert.equal(page.body, `dev /src/main.ts host=localhost:${devPort}`);
    // чужой порт в куке без ключа к нему — нельзя
    const other = await get(hubPort, "/", { cookie: cookie.replace(`kh_pv=${devPort}`, "kh_pv=1") });
    assert.equal(other.status, 404);

    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/hmr`, { headers: { host: HOST, cookie } });
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    ws.send("ping");
    assert.equal(await new Promise<string>((res) => ws.once("message", (m) => res(String(m)))), "echo ping");
    ws.close();

    // обычное имя хаба — его API, превью не вмешивается
    assert.equal((await get(hubPort, "/api/x", { host: "krab.example.org" })).body, "hub api");
  } finally {
    await pv.close();
    wss.close();
    await new Promise((r) => hub.close(r));
    await new Promise((r) => dev.close(r));
  }
});

test("хаб: запросы с именем превью перехватываются до API, остальные — как раньше", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-pvshared-"));
  mkdirSync(join(base, "Projects"));
  const { createHub } = await import("../../src/hub.ts");
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { language: "ru", listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], previewUrl: SHARED, engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  try {
    const port = Number(new URL(hub.urls[0]!).port);
    const pv = await get(port, "/api/hub");
    assert.equal(pv.status, 404);
    assert.match(pv.body, /Превью не открыто|No preview open/);
    const api = await get(port, "/api/hub", { host: `127.0.0.1:${port}` });
    assert.equal(api.status, 200);
    assert.ok(JSON.parse(api.body).urls, "API хаба на своём имени работает");
  } finally {
    await hub.close();
  }
});
