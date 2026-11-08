// Регресс: подключённый WebSocket (телефон через Tailscale-адрес) не должен вешать выключение хаба.
// Раньше server.close() ждал закрытия WS вечно — хаб не выходил, сторож его не перезапускал.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { createHub } from "../../src/hub.ts";

test("close() завершается, даже когда к хабу подключены WebSocket-клиенты на обоих адресах", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kamharn-shutdown-"));
  // 127.0.0.2 — второй loopback-адрес: для хаба это «чужое» устройство (как телефон через Tailscale)
  const hub = await createHub({
    configPath: join(tmp, "kamharn.json"),
    overrides: {
      listen: ["127.0.0.1", "127.0.0.2"],
      port: 0,
      dataDir: join(tmp, "data"),
      roots: [tmp],
      engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } },
    },
    log: () => {},
  });
  const [local, remote] = hub.urls;
  assert.ok(remote?.includes("127.0.0.2"), "хаб слушает второй адрес: " + hub.urls.join(", "));

  const { code } = await (await fetch(local + "/api/pair/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const { token } = await (
    await fetch(remote + "/api/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "phone" }) })
  ).json();

  const open = (url: string) =>
    new Promise<WebSocket>((res, rej) => {
      const ws = new WebSocket(url);
      ws.once("message", () => res(ws)); // hello
      ws.once("error", rej);
    });
  const wsRemote = await open(remote!.replace("http", "ws") + "/ws?token=" + token);
  const wsLocal = await open(local!.replace("http", "ws") + "/ws");
  const closed = Promise.all([wsRemote, wsLocal].map((ws) => new Promise((r) => ws.once("close", r))));

  const t0 = Date.now();
  await Promise.race([hub.close(), new Promise((_, rej) => setTimeout(() => rej(new Error("hub.close() завис")), 5000))]);
  assert.ok(Date.now() - t0 < 5000);
  await closed; // клиенты получили разрыв и смогут переподключиться к новому хабу
});
