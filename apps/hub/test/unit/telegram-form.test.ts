// Файл через прокси Telegram: настоящий undici + локальный HTTP-прокси (CONNECT). Раньше FormData Node'а уходила
// строкой «[object FormData]», и Telegram отвечал «there is no document in the request».
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { telegramHttp } from "../../src/telegram.ts";

test("telegramHttp через прокси: multipart с файлом доходит целиком", async (t) => {
  const got: { ct?: string; body: Buffer }[] = [];
  const target = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d)).on("end", () => {
      got.push({ ...(req.headers["content-type"] ? { ct: req.headers["content-type"] } : {}), body: Buffer.concat(parts) });
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  }).listen(0, "127.0.0.1");
  let tunnels = 0;
  const socks: Socket[] = [];
  // http-цель undici может слать прокси и без CONNECT (абсолютный URL) — пересылаем оба вида
  const proxy = createServer((req, res) => {
    tunnels++;
    const up = request(String(req.url), { method: req.method, headers: req.headers }, (r) => (res.writeHead(r.statusCode ?? 502, r.headers), r.pipe(res)));
    req.pipe(up);
  }).on("connect", (req: IncomingMessage, sock, head) => {
    tunnels++;
    socks.push(sock as Socket);
    const [host, port] = String(req.url).split(":");
    const up = connect(Number(port), host!, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(sock).pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  }).listen(0, "127.0.0.1");
  await Promise.all([once(target, "listening"), once(proxy, "listening")]);
  const net = telegramHttp({ type: "http", host: "127.0.0.1", port: (proxy.address() as AddressInfo).port });
  t.after(() => {
    net.close();
    for (const s of socks) s.destroy();
    target.closeAllConnections();
    target.close();
    proxy.close();
  });

  const form = new FormData();
  form.set("chat_id", "42");
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4 "), Buffer.alloc(5000, 7)]);
  form.set("document", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "обменная карта.pdf");
  const r = await net.fetch(`http://127.0.0.1:${(target.address() as AddressInfo).port}/botX/sendDocument`, { method: "POST", body: form });
  assert.equal(r.status, 200);
  assert.ok(tunnels >= 1, "шло через прокси");
  const { ct, body } = got[0]!;
  assert.match(ct ?? "", /^multipart\/form-data; boundary=/);
  const text = body.toString("latin1");
  assert.ok(text.includes('name="chat_id"') && text.includes("42"));
  assert.ok(text.includes('name="document"'), "есть часть с файлом");
  assert.ok(body.includes(pdf), "файл целиком");
});
