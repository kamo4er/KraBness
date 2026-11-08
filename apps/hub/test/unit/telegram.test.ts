// Telegram-бот: токен проверяется, чат привязывается по коду, уведомления с кнопками, нажатие отвечает агенту,
// реплай на уведомление уходит в сессию, чужие чаты игнорируются. Bot API — поддельный.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { TelegramBot } from "../../src/telegram.ts";

const TOKEN = "123456:ABCdefGhIJKlmNoPQRsTUVwxyZ-1234567890";

function fakeTelegram() {
  const sent: Array<{ method: string; body: Record<string, any> }> = [];
  const queue: Record<string, any>[] = [];
  let id = 0;
  let msgId = 100;
  const http = (async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return url.includes(TOKEN) ? ok({ username: "kamharn_test_bot" }) : new Response(JSON.stringify({ ok: false, description: "Unauthorized" }));
    if (method === "getUpdates") {
      await new Promise((r) => setTimeout(r, 10));
      return ok(queue.splice(0).map((u) => ({ update_id: ++id, ...u })));
    }
    sent.push({ method, body });
    return ok(method === "sendMessage" ? { message_id: ++msgId } : true);
  }) as typeof fetch;
  return { http, sent, push: (u: Record<string, any>) => queue.push(u) };
}

const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("telegram: привязка по коду, кнопки подтверждения, реплай агенту, чужие чаты не слушаем", async () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  const tg = fakeTelegram();
  const replies: string[] = [];
  const prompts: string[] = [];
  const bot = new TelegramBot(
    config,
    {
      replyPermission: async (sid, rid, reply) => {
        if (rid === "gone") throw new Error("нет запроса");
        replies.push(`${sid} ${rid} ${reply}`);
      },
      prompt: async (sid, text) => void prompts.push(`${sid}: ${text}`),
    },
    () => {},
    () => ({ fetch: tg.http, close() {} }),
    0,
  );
  try {
    await assert.rejects(bot.setToken("не токен"), /BotFather/);
    await assert.rejects(bot.setToken("999:" + "x".repeat(35)), /не принял/);
    const st = await bot.setToken(TOKEN);
    assert.equal(st.bot, "kamharn_test_bot");
    assert.equal(st.bound, false);
    assert.match(st.code!, /^\d{6}$/);

    // неверный код — отказ; верный — чат привязан и сохранён в конфиг
    tg.push({ message: { message_id: 1, chat: { id: 777 }, text: "/start 000000" } });
    await wait();
    assert.match(tg.sent.at(-1)!.body.text, /Код не подходит/);
    // группу не привязать даже верным кодом: там «Разрешить» нажал бы любой участник
    tg.push({ message: { message_id: 4, chat: { id: -100, type: "group" }, text: `/start ${st.code}` } });
    await wait();
    assert.match(tg.sent.at(-1)!.body.text, /личный чат/);
    assert.equal(config.config.telegram!.chatId, undefined);
    // перебор: после 5 неверных кодов подряд код меняется
    for (let i = 0; i < 4; i++) tg.push({ message: { message_id: 10 + i, chat: { id: 777, type: "private" }, text: "/start 000000" } });
    await wait();
    assert.notEqual(bot.status().code, st.code, "код заменён после 5 промахов");
    st.code = bot.status().code;
    tg.push({ message: { message_id: 2, chat: { id: 555, type: "private" }, text: `/start ${st.code}` } });
    await wait();
    assert.equal(config.config.telegram!.chatId, 555);
    assert.equal(bot.status().bound, true);
    assert.equal(bot.status().code, undefined);

    // уведомление о подтверждении — с кнопками
    bot.notify({ sessionId: "ks_1", title: "Игра <3>", message: "Нужно подтверждение: Bash · npm test", kind: "permission", requestId: "cp_9" });
    await wait();
    const msg = tg.sent.at(-1)!;
    assert.equal(msg.body.chat_id, 555);
    assert.equal(msg.body.text, "<b>Игра &lt;3&gt;</b>\nНужно подтверждение: Bash · npm test");
    assert.deepEqual(msg.body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data), ["p|ks_1|cp_9|once", "p|ks_1|cp_9|reject"]);
    const notifId = 100 + tg.sent.filter((s) => s.method === "sendMessage").length;

    // нажатие «Разрешить» → агенту; устаревший запрос — «Уже не актуально»
    tg.push({ callback_query: { id: "q1", data: "p|ks_1|cp_9|once", message: { message_id: notifId, chat: { id: 555 }, text: "Игра" } } });
    tg.push({ callback_query: { id: "q2", data: "p|ks_1|gone|reject", message: { message_id: notifId, chat: { id: 555 }, text: "Игра" } } });
    await wait();
    assert.deepEqual(replies, ["ks_1 cp_9 once"]);
    const answers = tg.sent.filter((s) => s.method === "answerCallbackQuery").map((s) => s.body.text);
    assert.deepEqual(answers, ["✅ Разрешено", "Уже не актуально"]);

    // реплай на уведомление — текст уходит агенту в ту же сессию
    tg.push({ message: { message_id: 3, chat: { id: 555 }, text: "делай без тестов", reply_to_message: { message_id: notifId } } });
    await wait();
    assert.deepEqual(prompts, ["ks_1: делай без тестов"]);

    // чужой чат: ни кнопки, ни сообщения не действуют
    tg.push({ callback_query: { id: "q3", data: "p|ks_1|cp_9|reject", message: { message_id: notifId, chat: { id: 666 } } } });
    tg.push({ message: { message_id: 4, chat: { id: 666 }, text: "привет", reply_to_message: { message_id: notifId } } });
    await wait();
    assert.deepEqual(replies, ["ks_1 cp_9 once"]);
    assert.equal(prompts.length, 1);

    bot.remove();
    assert.equal(config.config.telegram, undefined);
    assert.equal(bot.status().configured, false);
  } finally {
    bot.stop();
  }
});

test("WS: уведомление приходит подключённым приложениям (показать самим, без Firebase)", async () => {
  const { createHub } = await import("../../src/hub.ts");
  const { mkdirSync } = await import("node:fs");
  const WebSocket = (await import("ws")).default;
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const now = Date.now();
  hub.db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: join(base, "Projects"), title: "Игра", model: { providerId: "a", modelId: "m" }, permissionMode: "manual", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  const ws = new WebSocket(hub.urls[0]!.replace(/^http/, "ws") + "/ws");
  const got: any[] = [];
  ws.on("message", (m) => {
    const j = JSON.parse(String(m));
    if (j.t === "notify") got.push(j.notice);
  });
  try {
    await new Promise((res, rej) => (ws.once("open", res), ws.once("error", rej)));
    await wait(50);
    (hub.sessions as any).append("s1", { type: "permission.asked", request: { id: "cp_1", tool: "Bash", title: "npm test", canAlways: true } });
    await wait(100);
    assert.deepEqual(got, [{ sessionId: "s1", title: "Игра", message: "Нужно подтверждение: Bash · npm test", kind: "permission", requestId: "cp_1", tag: "perm-cp_1" }]);
    // пользователь за ПК в вебе — уведомлений нет нигде
    hub.presence.set({}, true);
    (hub.sessions as any).append("s1", { type: "permission.asked", request: { id: "cp_2", tool: "Bash", title: "ls", canAlways: true } });
    await wait(100);
    assert.equal(got.length, 1);
  } finally {
    ws.terminate();
    await hub.close();
  }
});
