// Прокси до Telegram: настоящие SOCKS5 (с логином/паролем) и HTTP-прокси на localhost; настройка прокси в боте —
// проверка перед сохранением, пароль не отдаётся и не теряется при правке, нерабочий прокси не сохраняется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer as createNet, connect, type AddressInfo, type Server } from "node:net";
import { createServer as createHttp, request } from "node:http";
import type { TelegramProxy } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { TelegramBot, telegramHttp } from "../../src/telegram.ts";

const TOKEN = "123456:ABCdefGhIJKlmNoPQRsTUVwxyZ-1234567890";
const listen = async (s: Server) => (await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)), (s.address() as AddressInfo).port);

/** «Bot API» на localhost */
async function botApi() {
  const s = createHttp((req, res) => res.end(JSON.stringify({ ok: true, result: { username: "via_proxy", path: req.url } })));
  return { port: await listen(s), close: () => s.close() };
}

/** SOCKS5 с авторизацией по логину/паролю (RFC 1928/1929) */
async function socks5(user: string, pass: string) {
  const seen = { auth: "", dest: "" };
  const s = createNet((c) => {
    c.once("data", (greet) => {
      if (![...greet.subarray(2, 2 + greet[1]!)].includes(2)) return void c.end(Buffer.from([5, 0xff]));
      c.write(Buffer.from([5, 2]));
      c.once("data", (a) => {
        const ul = a[1]!;
        const u = a.subarray(2, 2 + ul).toString();
        const p = a.subarray(3 + ul, 3 + ul + a[2 + ul]!).toString();
        seen.auth = `${u}:${p}`;
        if (u !== user || p !== pass) return void c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        c.once("data", (r) => {
          let host: string;
          let off: number;
          if (r[3] === 1) (host = [...r.subarray(4, 8)].join(".")), (off = 8);
          else if (r[3] === 3) (host = r.subarray(5, 5 + r[4]!).toString()), (off = 5 + r[4]!);
          else return void c.destroy();
          const port = r.readUInt16BE(off);
          seen.dest = `${host}:${port}`;
          const up = connect(port, host, () => {
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            c.pipe(up).pipe(c);
          });
          up.on("error", () => c.destroy());
        });
      });
    });
    c.on("error", () => {});
  });
  return { port: await listen(s), seen, close: () => s.close() };
}

/** HTTP-прокси: и обычный запрос по абсолютному адресу, и CONNECT */
async function httpProxy(user: string, pass: string) {
  const want = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const seen = { auth: "", dest: "" };
  const s = createHttp((req, res) => {
    seen.auth = String(req.headers["proxy-authorization"] ?? "");
    seen.dest = String(req.url);
    if (seen.auth !== want) return void res.writeHead(407).end();
    const up = request(String(req.url), { method: req.method, headers: req.headers }, (r) => (res.writeHead(r.statusCode!, r.headers), r.pipe(res)));
    req.pipe(up);
  });
  s.on("connect", (req, sock, head) => {
    seen.auth = String(req.headers["proxy-authorization"] ?? "");
    seen.dest = String(req.url);
    if (seen.auth !== want) return void sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    const [h, p] = String(req.url).split(":");
    const up = connect(Number(p), h!, () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on("error", () => sock.destroy());
  });
  return { port: await listen(s), seen, close: () => s.close() };
}

test("прокси: запросы к Bot API идут через SOCKS5 с логином/паролем", async () => {
  const api = await botApi();
  const px = await socks5("vps", "s3cret");
  try {
    const net = telegramHttp({ type: "socks5", host: "127.0.0.1", port: px.port, username: "vps", password: "s3cret" });
    const j = (await (await net.fetch(`http://127.0.0.1:${api.port}/botX/getMe`)).json()) as any;
    assert.equal(j.result.path, "/botX/getMe");
    assert.equal(px.seen.auth, "vps:s3cret");
    assert.equal(px.seen.dest, `127.0.0.1:${api.port}`);
    net.close();
    // неверный пароль — прокси не пускает, запрос падает
    const bad = telegramHttp({ type: "socks5", host: "127.0.0.1", port: px.port, username: "vps", password: "nope" });
    await assert.rejects(bad.fetch(`http://127.0.0.1:${api.port}/botX/getMe`));
    bad.close();
  } finally {
    api.close();
    px.close();
  }
});

test("прокси: HTTP-прокси с Basic-авторизацией", async () => {
  const api = await botApi();
  const px = await httpProxy("vps", "pa:ss");
  try {
    const net = telegramHttp({ type: "http", host: "127.0.0.1", port: px.port, username: "vps", password: "pa:ss" });
    const j = (await (await net.fetch(`http://127.0.0.1:${api.port}/botX/getMe`)).json()) as any;
    assert.equal(j.result.path, "/botX/getMe");
    assert.equal(px.seen.auth, `Basic ${Buffer.from("vps:pa:ss").toString("base64")}`);
    net.close();
  } finally {
    api.close();
    px.close();
  }
});

test("прокси в боте: проверка перед сохранением, пароль не отдаётся и не теряется", async () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  const calls: string[] = [];
  // «Telegram»: через прокси с host=dead соединения нет, остальные отвечают
  const makeHttp = (p?: TelegramProxy) => ({
    fetch: (async (url: string) => {
      const via = p ? p.host : "direct";
      const method = url.split("/").pop()!;
      calls.push(`${via} ${method}`);
      if (via === "dead") throw Object.assign(new Error("fetch failed"), { cause: new Error("connect ECONNREFUSED 10.0.0.1:1080") });
      if (method === "getUpdates") await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : { username: "kamharn_test_bot" } }));
    }) as typeof fetch,
    close() {},
  });
  const bot = new TelegramBot(config, { replyPermission: async () => {}, prompt: async () => {} }, () => {}, makeHttp, 0);
  try {
    // без бота прокси сохраняется без проверки (токен потом проверится уже через него)
    let st = await bot.setProxy({ type: "socks5", host: "1.2.3.4", port: 1080 });
    assert.deepEqual(st.proxy, { type: "socks5", host: "1.2.3.4", port: 1080, hasPassword: false });
    calls.length = 0;
    await bot.setToken(TOKEN);
    assert.equal(calls[0], "1.2.3.4 getMe");

    await assert.rejects(bot.setProxy({ type: "socks5", host: "1.2.3.4:1080", port: 1080 }), /только IP или домен/);
    await assert.rejects(bot.setProxy({ type: "socks5", host: "socks5://1.2.3.4", port: 1080 }), /только IP или домен/);
    await assert.rejects(bot.setProxy({ type: "socks5", host: "1.2.3.4", port: 70000 }), /Порт/);
    await assert.rejects(bot.setProxy({ type: "socks4" as any, host: "1.2.3.4", port: 1080 }), /Тип прокси/);

    // нерабочий прокси не сохраняется, старый остаётся
    await assert.rejects(bot.setProxy({ type: "socks5", host: "dead", port: 1080 }), /Через этот прокси Telegram недоступен: connect ECONNREFUSED/);
    assert.equal(config.config.telegramProxy!.host, "1.2.3.4");

    st = await bot.setProxy({ type: "http", host: "5.6.7.8", port: 3128, username: "vps", password: "s3cret" });
    assert.deepEqual(st.proxy, { type: "http", host: "5.6.7.8", port: 3128, username: "vps", hasPassword: true });
    assert.ok(!JSON.stringify(st).includes("s3cret"));
    // правка без пароля у того же прокси (адрес, порт, логин) — пароль прежний;
    // другой адрес или логин — пароль сброшен: прежний не должен уйти на новый сервер
    await bot.setProxy({ type: "http", host: "5.6.7.8", port: 3128, username: "vps" });
    assert.equal(config.config.telegramProxy!.password, "s3cret");
    await bot.setProxy({ type: "http", host: "5.6.7.9", port: 3128, username: "vps" });
    assert.equal(config.config.telegramProxy!.password, "");
    await bot.setProxy({ type: "http", host: "5.6.7.9", port: 3128, username: "vps", password: "s3cret" });
    await bot.setProxy({ type: "http", host: "5.6.7.9", port: 3128, username: "other" });
    assert.equal(config.config.telegramProxy!.password, "");

    // опрос обновлений идёт уже через новый прокси
    calls.length = 0;
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(calls.length > 0 && calls.every((c) => c === "5.6.7.9 getUpdates"), calls.join(", "));

    // выключить прокси — проверка напрямую, потом прокси убран из конфига
    st = await bot.setProxy(null);
    assert.equal(st.proxy, undefined);
    assert.equal(config.config.telegramProxy, undefined);
    // смена бота прокси не сбрасывает
    await bot.setProxy({ type: "socks5", host: "1.2.3.4", port: 1080 });
    bot.remove();
    assert.equal(config.config.telegramProxy!.host, "1.2.3.4");
  } finally {
    bot.close();
  }
});
