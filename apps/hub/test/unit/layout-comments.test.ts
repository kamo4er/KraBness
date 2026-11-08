// Замечания по вёрстке: прокси превью в режиме замечаний вставляет панель в HTML (сжатый и нет), не трогает остальное,
// обслуживает /__krab/* сам, принимает замечания только с подписанной кукой и своим заголовком; хаб отдаёт их агенту.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { injectOverlay, Previews } from "../../src/preview.ts";
import { layoutPrompt, parseLayoutComments, sendLayoutComments } from "../../src/comments.ts";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import type { Engine, PromptFile } from "../../src/engines/types.ts";

const PAGE = "<!doctype html><html><head><title>Каталог</title></head><body><button class=buy>Купить</button></body></html>";
// 1×1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("вставка панели: перед </head>, иначе перед </body>, иначе в конец", () => {
  assert.equal(injectOverlay("<html><head></head><body></body></html>", "/x.js"), '<html><head><script src="/x.js" defer></script></head><body></body></html>');
  assert.equal(injectOverlay("<body>hi</BODY>", "/x.js"), '<body>hi<script src="/x.js" defer></script></BODY>');
  assert.equal(injectOverlay("<p>hi", "/x.js"), '<p>hi<script src="/x.js" defer></script>');
});

test("текст для агента: селектор, HTML, размеры, стили, снимок; мусор отбрасывается", () => {
  assert.throws(() => parseLayoutComments({ items: [] }), /Нет замечаний|No comments/);
  assert.throws(() => parseLayoutComments({ items: [{ text: "  " }] }), /пустое|empty/);
  assert.throws(() => parseLayoutComments({ items: Array.from({ length: 21 }, () => ({ text: "x" })) }), /20/);
  const c = parseLayoutComments({
    url: "http://localhost:5173/catalog",
    title: "Каталог",
    viewport: { w: 390, h: 844, dpr: 3 },
    items: [
      { text: "Кнопка налезает на текст", selector: "button.buy", html: "<button class=buy>Купить</button>", rect: { x: 10.4, y: 300, w: 120, h: 40 }, styles: { "font-size": "14px", color: "rgb(255, 255, 255)" }, image: PNG },
      { text: "Слишком мелко", selector: "p", html: "<p>…</p>", rect: { x: 0, y: 0, w: 1, h: 1 }, styles: {}, image: "javascript:alert(1)" },
    ],
  });
  assert.equal(c.items[0]!.rect.x, 10);
  assert.equal(c.items[1]!.image, undefined, "не картинка — выброшена");
  const text = layoutPrompt(c, ["layout-1.png", undefined]);
  assert.match(text, /http:\/\/localhost:5173\/catalog \(«Каталог»\), экран 390×844, масштаб 3/);
  assert.match(text, /1\. «Кнопка налезает на текст» — `button\.buy`/);
  assert.match(text, /120×40 в \(10, 300\) · font-size: 14px; color: rgb\(255, 255, 255\)/);
  assert.match(text, /снимок: layout-1\.png/);
  assert.match(text, /2\. «Слишком мелко»/);
  assert.equal(text.match(/снимок/g)?.length, 1, "у второго снимка нет");
});

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "kh-notes-"));
  const proj = join(base, "Projects", "shop");
  mkdirSync(proj, { recursive: true });
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [join(base, "Projects")], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  const prompts: Array<{ text: string; files: PromptFile[] }> = [];
  const engine: Engine = {
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async (_e, o) => void prompts.push({ text: o.text, files: o.files }),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: proj });
  const overlay = join(base, "krab-overlay.js");
  writeFileSync(overlay, "/*panel*/");
  return { base, sessions, files, s, prompts, overlay };
}

test("превью с замечаниями: панель в HTML (gzip, br, без сжатия), остальное без изменений, /__krab/* — сам прокси, замечания → агенту", async () => {
  const { sessions, files, s, prompts, overlay } = await setup();
  const seen: string[] = [];
  const dev = createServer((req, res) => {
    seen.push(`${req.url} ae=${req.headers["accept-encoding"] ?? ""}`);
    const enc = new URL(req.url!, "http://x").searchParams.get("enc");
    if (req.url!.startsWith("/app.js")) return res.writeHead(200, { "content-type": "text/javascript" }).end("console.log('</head>')");
    // как сервер, который жмёт, даже если просили без сжатия
    if (enc === "gzip") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" }).end(gzipSync(PAGE));
    if (enc === "br") return res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(brotliCompressSync(PAGE));
    res.writeHead(200, { "content-type": "text/html", "content-length": Buffer.byteLength(PAGE), etag: '"1"' }).end(PAGE);
  });
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", () => r()));
  const port = (dev.address() as AddressInfo).port;
  const pv = new Previews(() => "::1", () => {}, undefined, { overlay: () => overlay, onComments: (sid, body) => sendLayoutComments(sessions, files, sid, body) });
  try {
    // dev-сервер на всех адресах: без замечаний — напрямую, с замечаниями — через прокси (иначе панель некуда вставить)
    assert.equal(await pv.open({ port, address: "0.0.0.0" }), `http://[::1]:${port}/`);
    const link = await pv.open({ port, address: "0.0.0.0" }, { session: s.id });
    assert.match(link, new RegExp(`kh_note=${s.id}\\.[0-9a-f]{32}`));
    const r = await fetch(link, { redirect: "manual" });
    assert.equal(r.status, 302);
    const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]!);
    assert.equal(cookies.length, 2);
    const cookie = cookies.join("; ");
    const origin = new URL(link).origin;
    const html = { headers: { cookie, accept: "text/html,application/xhtml+xml" } };

    for (const enc of ["", "gzip", "br"]) {
      const p = await fetch(`${origin}/?enc=${enc}`, html);
      const body = await p.text();
      assert.match(body, /<script src="\/__krab\/overlay\.js\?lang=(ru|en)" defer><\/script><\/head>/, `панель вставлена (${enc || "без сжатия"})`);
      assert.equal(p.headers.get("content-encoding"), null);
      assert.equal(Number(p.headers.get("content-length")), Buffer.byteLength(body));
      assert.equal(p.headers.get("etag"), null, "старый etag к изменённой странице не подходит");
    }
    assert.ok(seen.every((x) => !x.startsWith("/?") || x.endsWith("ae=identity")), "страницу просим без сжатия");
    // скрипт с «</head>» внутри — не страница, не трогаем
    assert.equal(await (await fetch(`${origin}/app.js`, { headers: { cookie, accept: "*/*" } })).text(), "console.log('</head>')");
    // без режима замечаний (кука только доступа) — страница как есть
    const plain = await fetch(`${origin}/`, { headers: { cookie: cookies[0]!, accept: "text/html" } });
    assert.equal(await plain.text(), PAGE);

    // /__krab/* до dev-сервера не доходит
    const before = seen.length;
    assert.equal(await (await fetch(`${origin}/__krab/overlay.js`, { headers: { cookie } })).text(), "/*panel*/");
    assert.equal((await fetch(`${origin}/__krab/overlay.js`, { headers: { cookie: cookies[0]! } })).status, 403, "без режима замечаний");
    assert.equal(seen.length, before);

    const payload = {
      url: "http://localhost/",
      viewport: { w: 390, h: 844, dpr: 3 },
      items: [{ text: "Кнопка мелкая", selector: "button.buy", html: "<button class=buy>Купить</button>", rect: { x: 1, y: 2, w: 3, h: 4 }, styles: {}, image: PNG }],
    };
    const post = (headers: Record<string, string>) => fetch(`${origin}/__krab/comments`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
    assert.equal((await post({ cookie })).status, 403, "без x-krab — не наша панель");
    assert.equal((await post({ cookie: cookies[0]!, "x-krab": "1" })).status, 403, "без куки режима замечаний");
    // подделанная сессия в куке
    const forged = cookies[1]!.replace(s.id, "ks_other");
    assert.equal((await post({ cookie: `${cookies[0]}; ${forged}`, "x-krab": "1" })).status, 403);
    assert.equal(prompts.length, 0);

    const ok = await post({ cookie, "x-krab": "1" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, count: 1 });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!.text, /«Кнопка мелкая» — `button\.buy`/);
    assert.equal(prompts[0]!.files.length, 1);
    assert.equal(prompts[0]!.files[0]!.name, "layout-1.png");
    assert.equal(prompts[0]!.files[0]!.mime, "image/png");
    assert.ok(readFileSync(prompts[0]!.files[0]!.path).subarray(1, 4).toString() === "PNG", "снимок сохранён картинкой");

    // кривое тело — понятная ошибка, хаб жив
    const bad = await fetch(`${origin}/__krab/comments`, { method: "POST", headers: { cookie, "x-krab": "1" }, body: "{" });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${origin}/__krab/comments`, { method: "POST", headers: { cookie, "x-krab": "1" }, body: JSON.stringify({ items: [] }) });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /Нет замечаний|No comments/);

    // обычная ссылка после режима замечаний выключает его (кука стирается)
    const off = await fetch(`${origin}/?kh_preview=${pv.keyFor(port)}`, { redirect: "manual" });
    assert.ok(off.headers.getSetCookie().some((c) => /^kh_note_\d+=;/.test(c) && /Max-Age=0/.test(c)));
  } finally {
    await pv.close();
    await new Promise((r) => dev.close(r));
  }
});
