// Язык: одна настройка на хабе; смена сразу рассылается подключённым клиентам и меняет язык сообщений хаба.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { pickLang, plural, resolveLang, type StoredEvent } from "@kamharn/protocol";
import { createHub } from "../../src/hub.ts";
import { L, hubLang } from "../../src/lang.ts";
import { Notifier } from "../../src/notifier.ts";
import type { Db } from "../../src/db.ts";

test("язык: по локали системы, явный выбор, множественное число", () => {
  assert.equal(pickLang("ru-RU"), "ru");
  assert.equal(pickLang("ru"), "ru");
  assert.equal(pickLang("en-US"), "en");
  assert.equal(pickLang("de-DE"), "en");
  assert.equal(pickLang("rus"), "en");
  assert.equal(resolveLang("auto", "ru-RU"), "ru");
  assert.equal(resolveLang("en", "ru-RU"), "en");
  assert.equal(resolveLang(undefined, "fr"), "en");
  const f = (n: number, l: "ru" | "en") => plural(l, n, ["файл", "файла", "файлов"], ["file", "files"]);
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map((n) => f(n, "ru")), ["файл", "файла", "файлов", "файлов", "файл", "файла", "файлов"]);
  assert.deepEqual([1, 2, 5].map((n) => f(n, "en")), ["file", "files", "files"]);
});

test("язык: настройка хаба, рассылка по WebSocket, сообщения хаба", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/ws");
  const got: unknown[] = [];
  ws.on("message", (m) => got.push(JSON.parse(String(m))));
  const put = (language: string) => fetch(url + "/api/language", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ language }) });
  try {
    await new Promise((r) => ws.once("open", r));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((got[0] as { t: string; language: string }).language, "auto", "hello несёт настройку");
    assert.equal(((await (await fetch(url + "/api/hub")).json()) as { language: string }).language, "auto");

    assert.equal((await put("en")).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(got.at(-1), { t: "language", language: "en" });
    assert.equal(hubLang(), "en");
    assert.equal(L("Привет", "Hello"), "Hello");
    const err = async () => ((await (await fetch(url + "/api/skills")).json()) as { error: string }).error;
    assert.equal(await err(), "Skills are unavailable", "ошибки хаба — на языке настройки");
    // уведомление об ошибке агента
    const notices: string[] = [];
    const n = new Notifier({ getSession: () => undefined, listDevices: () => [] } as unknown as Db, { enabled: false, send: async () => "ok" });
    n.subscribe((x) => notices.push(x.message));
    const fail = () => n.onEvent({ seq: 1, sessionId: "s1", at: 0, event: { type: "error", message: "boom" } } as unknown as StoredEvent);
    fail();
    assert.equal(notices.at(-1), "Error: boom");

    assert.equal((await put("ru")).status, 200);
    assert.equal(L("Привет", "Hello"), "Привет");
    assert.equal(await err(), "Скиллы недоступны");
    fail();
    assert.equal(notices.at(-1), "Ошибка: boom");
    assert.equal((await put("de")).status, 400);
    assert.equal(((await (await fetch(url + "/api/hub")).json()) as { language: string }).language, "ru");
  } finally {
    ws.terminate();
    await hub.close();
  }
});
