// Пуши: отправка в FCM HTTP v1 (JWT-авторизация), правила уведомлений, регистрация токена устройства.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionEvent, StoredEvent } from "@kamharn/protocol";
import { PushSender, type PushMessage } from "../../src/push.ts";
import { Notifier } from "../../src/notifier.ts";
import { Db } from "../../src/db.ts";
import { createHub } from "../../src/hub.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "kamharn-push-"));
  const p = join(dir, "firebase-service-account.json");
  writeFileSync(p, JSON.stringify({ project_id: "proj-1", client_email: "svc@proj-1.iam", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth.test/token" }));
  return p;
}

test("PushSender: JWT подписан ключом, токен кэшируется, data-сообщение в формате expo-notifications", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let fcmStatus = 200;
  const http = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth.test/token") return new Response(JSON.stringify({ access_token: "at-1", expires_in: 3600 }), { status: 200 });
    return new Response(fcmStatus === 200 ? "{}" : '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: fcmStatus });
  }) as typeof fetch;
  const sender = new PushSender(keyFile(), () => {}, http);
  assert.equal(sender.enabled, true);
  const m: PushMessage = { title: "Сессия", message: "Нужно подтверждение: Bash · ls", categoryId: "permission", data: { kind: "permission", sessionId: "s1", requestId: "r1" } };

  assert.equal(await sender.send("dev-token", m), "ok");
  assert.equal(await sender.send("dev-token", m), "ok");
  assert.equal(calls.filter((c) => c.url === "https://oauth.test/token").length, 1, "OAuth-токен из кэша");

  // JWT: подпись проверяется публичным ключом, claims правильные
  const assertion = new URLSearchParams(String(calls[0]!.init.body)).get("assertion")!;
  const [h, c, sig] = assertion.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, "base64url")));
  const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
  assert.equal(claims.iss, "svc@proj-1.iam");
  assert.equal(claims.scope, "https://www.googleapis.com/auth/firebase.messaging");

  const fcm = calls[1]!;
  assert.equal(fcm.url, "https://fcm.googleapis.com/v1/projects/proj-1/messages:send");
  assert.equal((fcm.init.headers as Record<string, string>).authorization, "Bearer at-1");
  const msg = JSON.parse(String(fcm.init.body)).message;
  assert.equal(msg.token, "dev-token");
  assert.equal(msg.android.priority, "high");
  assert.deepEqual(msg.data, { title: "Сессия", message: "Нужно подтверждение: Bash · ls", categoryId: "permission", channelId: "kamharn", body: '{"kind":"permission","sessionId":"s1","requestId":"r1"}' });
  assert.ok(Object.values(msg.data).every((v) => typeof v === "string"), "в FCM data только строки");

  fcmStatus = 404;
  assert.equal(await sender.send("old-token", m), "unregistered");
  assert.equal(new PushSender(join(tmpdir(), "нет-ключа.json")).enabled, false);
});

test("Notifier: подтверждение с кнопками, вопрос, «готово» с первой строкой ответа; устаревший токен снимается", async () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "kamharn-")), "t.db"));
  const now = Date.now();
  db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: "C:\\w", title: "Фича X", model: { providerId: "a", modelId: "m" }, permissionMode: "manual", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  db.insertDevice({ id: "d1", name: "phone", tokenHash: "h", createdAt: now, lastSeen: now, fcmToken: "tok-1" });
  db.insertDevice({ id: "d2", name: "old", tokenHash: "h2", createdAt: now, lastSeen: now, fcmToken: "tok-old" });
  db.insertDevice({ id: "d3", name: "browser", tokenHash: "h3", createdAt: now, lastSeen: now, fcmToken: null });
  const sent: Array<[string, PushMessage]> = [];
  const n = new Notifier(db, { enabled: true, send: async (t, m) => (sent.push([t, m]), t === "tok-old" ? "unregistered" : "ok") });
  let seq = 0;
  const ev = (event: SessionEvent): StoredEvent => ({ seq: ++seq, sessionId: "s1", ts: now, event });
  const flush = () => new Promise((r) => setTimeout(r, 10));

  n.onEvent(ev({ type: "session.updated", patch: { status: "busy" } }));
  n.onEvent(ev({ type: "permission.asked", request: { id: "r1", tool: "Bash", title: "npm test", canAlways: true } }));
  await flush();
  assert.equal(sent.length, 2, "обоим устройствам с токеном");
  assert.equal(sent[0]![1].title, "Фича X");
  assert.equal(sent[0]![1].categoryId, "permission");
  assert.deepEqual(sent[0]![1].data, { kind: "permission", sessionId: "s1", requestId: "r1" });
  assert.equal(db.listDevices().find((d) => d.id === "d2")!.fcmToken, null, "устаревший токен снят");

  sent.length = 0;
  n.onEvent(ev({ type: "message.upserted", message: { id: "a1", role: "assistant", createdAt: now } }));
  n.onEvent(ev({ type: "part.upserted", messageId: "a1", part: { type: "text", id: "a1:0", text: "\n**Кнопка готова**, тесты зелёные.\n```js\nsecret()\n```" } }));
  n.onEvent(ev({ type: "session.updated", patch: { status: "idle" } }));
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![1].message, "Готово: Кнопка готова, тесты зелёные.");
  assert.equal(sent[0]![1].categoryId, undefined);

  sent.length = 0;
  n.onEvent(ev({ type: "session.updated", patch: { status: "idle" } }));
  await flush();
  assert.equal(sent.length, 0, "idle без работы — не «готово»");
});

test("POST /api/devices/me/push: localhost получает запись и токен", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  try {
    const r = await fetch(hub.urls[0] + "/api/devices/me/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "fcm-abc" }) });
    assert.deepEqual(await r.json(), { ok: true, push: false });
    const d = hub.db.listDevices().find((x) => x.id === "local");
    assert.equal(d?.fcmToken, "fcm-abc");
    const list = await (await fetch(hub.urls[0] + "/api/devices")).json();
    assert.equal(list.find((x: { id: string }) => x.id === "local").push, true);
  } finally {
    await hub.close();
  }
});
