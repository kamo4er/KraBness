// Бот сессии в Telegram: поддельный Bot API — привязка по одноразовому коду, чужие чаты, альбом файлов одним промптом,
// «печатает…», итоговый ответ с разметкой, файл от агента документом, кнопки подтверждения; ответ — только тому, кто спросил.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PermissionReply, SessionEvent } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore, FILE_MARKER } from "../../src/files.ts";
import { SessionManager } from "../../src/sessions.ts";
import { SessionBots, chunks, mdToTelegram } from "../../src/sessionbot.ts";
import type { Engine, EngineSink, PromptFile } from "../../src/engines/types.ts";

const TOKEN = "123456:" + "A".repeat(35);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("разметка ответа агента → HTML Telegram; длинный текст — кусками по абзацам", () => {
  assert.equal(mdToTelegram("## Итог\n**Важно:** пить `воду` <много>\n- раз\n- два"), "<b>Итог</b>\n<b>Важно:</b> пить <code>воду</code> &lt;много&gt;\n• раз\n• два");
  assert.equal(mdToTelegram("```\na < b\n```"), "<pre>a &lt; b</pre>");
  assert.equal(mdToTelegram("[анализ](https://x.ru/a)"), '<a href="https://x.ru/a">анализ</a>');
  const long = Array.from({ length: 30 }, (_, i) => `абзац ${i} ` + "я".repeat(200)).join("\n\n");
  const parts = chunks(long, 1000);
  assert.ok(parts.length > 5 && parts.every((p) => p.length <= 1000));
  assert.equal(parts.join("\n\n"), long);
});

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "kh-sbot-"));
  const root = join(base, "Projects");
  mkdirSync(join(root, "Alisa"), { recursive: true });
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  let sink!: EngineSink;
  const prompts: Array<{ text: string; files: PromptFile[] }> = [];
  const replies: Array<[string, PermissionReply]> = [];
  const engine: Engine = {
    id: "opencode",
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1",
    attach: () => {},
    prompt: async (_e, o) => void prompts.push({ text: o.text, files: o.files }),
    abort: async () => {},
    replyPermission: async (_e, rid, reply) => void replies.push([rid, reply]),
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const s = await sessions.create({ engine: "opencode", directory: join(root, "Alisa"), title: "Алиса" });

  // поддельный Bot API: очередь входящих апдейтов, журнал вызовов, файлы для скачивания
  const updates: unknown[] = [];
  const calls: Array<{ method: string; body: any }> = [];
  const tgFiles: Record<string, Buffer> = { f_photo: Buffer.from("JPEGDATA"), f_doc: Buffer.from("%PDF-1.4 анализ") };
  let uid = 1;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const fm = /\/file\/bot[^/]+\/(.+)$/.exec(u);
    if (fm) return new Response(new Uint8Array(tgFiles[fm[1]!]!));
    const method = /\/bot[^/]+\/(\w+)$/.exec(u)![1]!;
    const body = init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "getUpdates") calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === "getMe") return ok({ username: "alisa_health_bot" });
    if (method === "getUpdates") {
      await tick(10);
      return ok(updates.splice(0).map((x) => ({ update_id: uid++, ...(x as object) })));
    }
    if (method === "getFile") return ok({ file_path: body.file_id });
    if (method === "sendMessage") return ok({ message_id: 1000 + calls.length });
    return ok(true);
  }) as unknown as typeof fetch;
  const bots = new SessionBots(config, sessions, files, () => {}, () => ({ fetch: fakeFetch, close: () => {} }), 0);
  const me = { id: 11, first_name: "Дима" };
  const msg = (chat: number, extra: object, from: object = me) => updates.push({ message: { message_id: uid * 10, date: 1761500000, chat: { id: chat, type: "private" }, from, ...extra } });
  const sent = (method: string) => calls.filter((c) => c.method === method);
  const waitFor = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return;
      await tick(20);
    }
    throw new Error(`не дождался: ${what}`);
  };
  return { base, root, config, sessions, files, bots, s, sink: () => sink, prompts, replies, msg, sent, calls, waitFor, me };
}

test("бот сессии: привязка по одноразовому коду, чужие и группы — мимо, альбом — одним промптом", async (t) => {
  const { config, bots, s, prompts, msg, sent, waitFor, me } = await setup();
  t.after(() => bots.close());
  // токен бота уведомлений сессии отдать нельзя
  config.setTelegram({ token: TOKEN });
  await assert.rejects(bots.setToken(s.id, TOKEN), /уведомления|notifications/);
  config.setTelegram(undefined);
  await assert.rejects(bots.setToken(s.id, "nope"), /токен|token/);

  const info = await bots.setToken(s.id, TOKEN);
  assert.equal(info.bot, "alisa_health_bot");
  const code = info.code!;
  assert.match(code, /^\d{6}$/);
  assert.equal(JSON.stringify(config.config.sessionBots).includes(TOKEN), true, "токен в конфиге");
  assert.equal(JSON.stringify(bots.info(s.id)).includes(TOKEN), false, "токен наружу не отдаётся");

  msg(11, { text: "/start 000000" });
  msg(11, { text: "привет" }); // ещё не привязан — игнор
  msg(-500, { text: `/start ${code}`, chat: { id: -500, type: "group" } });
  await waitFor(() => sent("sendMessage").length >= 2, "ответов на неверный код и группу");
  assert.match(JSON.stringify(sent("sendMessage")), /Код не подходит|Wrong code/);
  assert.match(JSON.stringify(sent("sendMessage")), /личный чат|private chat/);
  assert.equal(prompts.length, 0);

  msg(11, { text: `/start ${code}` });
  await waitFor(() => bots.info(s.id).chats.length === 1, "привязки");
  assert.deepEqual(bots.info(s.id).chats, [{ id: 11, name: "Дима" }]);
  assert.notEqual(bots.info(s.id).code, code, "код одноразовый");
  // жена по старому коду не войдёт, по новому — да
  msg(22, { text: `/start ${code}` }, { id: 22, first_name: "Аня" });
  msg(22, { text: `/start ${bots.info(s.id).code}` }, { id: 22, first_name: "Аня" });
  await waitFor(() => bots.info(s.id).chats.length === 2, "второго человека");

  // альбом: фото с подписью и документ — агенту одним сообщением с двумя вложениями
  msg(11, { photo: [{ file_id: "f_small", file_size: 10 }, { file_id: "f_photo", file_size: 8 }], caption: "Анализ крови от 20.10", media_group_id: "g1" }, me);
  msg(11, { document: { file_id: "f_doc", file_name: "выписка.pdf", file_size: 20, mime_type: "application/pdf" }, media_group_id: "g1" }, me);
  await waitFor(() => prompts.length === 1, "промпта");
  assert.equal(prompts[0]!.text, "[Telegram: Дима]" + String.fromCharCode(10) + "Анализ крови от 20.10", "агенту видно, кто пишет");
  const names = prompts[0]!.files.map((f) => f.name);
  assert.equal(names.length, 2);
  assert.ok(names.includes("выписка.pdf") && names.some((n) => /^photo-.*\.jpg$/.test(n)), names.join(", "));
  const photo = prompts[0]!.files.find((f) => f.name.startsWith("photo"))!;
  assert.equal(readFileSync(photo.path, "utf8"), "JPEGDATA", "скачано самое крупное фото");
  const pdf = prompts[0]!.files.find((f) => f.name === "выписка.pdf")!;
  assert.ok(pdf.path.includes(join("Alisa", ".kamharn", "inbox")), "файл в папке сессии");
  assert.equal(readFileSync(pdf.path, "utf8"), "%PDF-1.4 анализ");

  // большой файл — понятный отказ, не падение
  msg(11, { document: { file_id: "f_big", file_name: "видео.mp4", file_size: 25 * 1024 * 1024 } }, me);
  await waitFor(() => JSON.stringify(sent("sendMessage")).includes("20"), "отказа по размеру");

  // чужой чат пишет — тишина
  const before = prompts.length;
  msg(99, { text: "дай доступ" }, { id: 99, first_name: "Чужой" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(prompts.length, before);
});

test("бот сессии: «печатает», итоговый ответ с разметкой, файл от агента документом, кнопки подтверждения", async (t) => {
  const { root, bots, s, files, sink, replies, msg, sent, waitFor, prompts } = await setup();
  t.after(() => bots.close());
  const info = await bots.setToken(s.id, TOKEN);
  msg(11, { text: `/start ${info.code}` });
  await waitFor(() => bots.info(s.id).chats.length === 1, "привязки");
  msg(11, { text: "что с анализом?" });
  await waitFor(() => prompts.length === 1, "промпта");

  const ev = (e: SessionEvent) => sink().event("es1", e);
  ev({ type: "session.updated", patch: { status: "busy" } });
  await waitFor(() => sent("sendChatAction").length >= 1, "«печатает»");
  ev({ type: "message.upserted", message: { id: "a1", role: "assistant", createdAt: 1 } });
  ev({ type: "part.upserted", messageId: "a1", part: { type: "text", id: "t1", text: "Смотрю анализ…" } });
  // агент отдаёт файл через send_file_to_user
  const report = join(root, "Alisa", "Анализы", "кровь-2026-10-20.pdf");
  mkdirSync(join(root, "Alisa", "Анализы"), { recursive: true });
  writeFileSync(report, "%PDF отчёт");
  const f = await files.registerOutgoing(report, s.id);
  ev({ type: "part.upserted", messageId: "a1", part: { type: "tool", id: "tool1", tool: "mcp__kamharn__send_file_to_user", status: "completed", title: "send", output: `${FILE_MARKER}${f.id}` } as never });
  ev({ type: "message.upserted", message: { id: "a2", role: "assistant", createdAt: 2 } });
  ev({ type: "part.upserted", messageId: "a2", part: { type: "text", id: "t2", text: "**Гемоглобин** в норме, файл прислал." } });
  ev({ type: "session.updated", patch: { status: "idle" } });
  await waitFor(() => sent("sendDocument").length === 1, "файла");
  const answers = sent("sendMessage").filter((c) => c.body.parse_mode === "HTML");
  assert.deepEqual(answers.map((a) => a.body.text), ["<b>Гемоглобин</b> в норме, файл прислал."], "только итоговое сообщение хода, без промежуточного");
  const doc = sent("sendDocument")[0]!.body as FormData;
  assert.equal((doc.get("document") as File).name, "кровь-2026-10-20.pdf");
  assert.equal(doc.get("chat_id"), "11");

  // подтверждение (в ходе, начатом из Telegram) — кнопками; нажатие уходит движку
  msg(11, { text: "удали старый" });
  await waitFor(() => prompts.length === 2, "второго промпта");
  ev({ type: "session.updated", patch: { status: "busy" } });
  ev({ type: "permission.asked", request: { id: "per1", tool: "bash", title: "rm старый.txt", canAlways: false } });
  await waitFor(() => sent("sendMessage").some((c) => c.body.reply_markup), "кнопок");
  const ask = sent("sendMessage").find((c) => c.body.reply_markup)!;
  assert.match(JSON.stringify(ask.body.reply_markup), /p\|per1\|once/);
  // нажатие кнопки — апдейт callback_query; нажал чужой — мимо
  const push = (chat: number, data: string) =>
    (bots.botOf(s.id) as unknown as { handle: (u: unknown) => Promise<void> }).handle({ callback_query: { id: "cb" + chat, data, message: { chat: { id: chat }, message_id: 5 } } });
  await push(99, "p|per1|once");
  assert.equal(replies.length, 0);
  await push(11, "p|per1|once");
  assert.deepEqual(replies, [["per1", "once"]]);
  assert.ok(existsSync(report));
});

test("бот сессии: двое — у каждого своё имя, ответ только тому, кто спросил; ход из KraBness в Telegram не уходит", async (t) => {
  const { bots, s, sink, prompts, msg, sent, calls, waitFor } = await setup();
  t.after(() => bots.close());
  const info = await bots.setToken(s.id, TOKEN);
  msg(11, { text: `/start ${info.code}` });
  await waitFor(() => bots.info(s.id).chats.length === 1, "Димы");
  msg(22, { text: `/start ${bots.info(s.id).code}` }, { id: 22, first_name: "Marina_K" });
  await waitFor(() => bots.info(s.id).chats.length === 2, "Марины");
  // имя из профиля Telegram — какое есть; в KraBness правим
  assert.throws(() => bots.renameChat(s.id, 22, "  "), /Пустое|Empty/);
  assert.throws(() => bots.renameChat(s.id, 77, "Кто-то"), /Нет такого|No such/);
  assert.deepEqual(bots.renameChat(s.id, 22, " Марина ").chats, [{ id: 11, name: "Дима" }, { id: 22, name: "Марина" }]);

  const ev = (e: SessionEvent) => sink().event("es1", e);
  const answer = (id: string, text: string) => {
    ev({ type: "message.upserted", message: { id, role: "assistant", createdAt: 1 } });
    ev({ type: "part.upserted", messageId: id, part: { type: "text", id: id + "t", text } });
  };
  const to = (method: string) => sent(method).map((c) => c.body.chat_id);
  calls.length = 0;

  msg(22, { text: "Какая температура нормальная?" }, { id: 22, first_name: "Marina_K" });
  await waitFor(() => prompts.length === 1, "промпта Марины");
  assert.equal(prompts[0]!.text, "[Telegram: Марина]" + String.fromCharCode(10) + "Какая температура нормальная?");
  ev({ type: "session.updated", patch: { status: "busy" } });
  await waitFor(() => to("sendChatAction").length >= 1, "«печатает»");
  answer("a1", "До 37,5, Марина.");
  ev({ type: "session.updated", patch: { status: "idle" } });
  await waitFor(() => to("sendMessage").length === 1, "ответа");
  assert.deepEqual([...new Set(to("sendChatAction"))], [22], "«печатает» — только Марине");
  assert.deepEqual(to("sendMessage"), [22], "ответ — только Марине");

  // ход начат из KraBness (не из Telegram): ни «печатает», ни ответа, ни кнопок в Telegram
  calls.length = 0;
  ev({ type: "session.updated", patch: { status: "busy" } });
  ev({ type: "permission.asked", request: { id: "per9", tool: "bash", title: "ls", canAlways: false } });
  answer("a2", "Это для Димы в вебе.");
  ev({ type: "session.updated", patch: { status: "idle" } });
  await tick(300);
  assert.deepEqual(calls, [], "в Telegram ничего");

  // написали оба, пока агент думал, — итог получают оба; отключённый — нет
  msg(11, { text: "А мне?" });
  msg(22, { text: "И мне" }, { id: 22, first_name: "Marina_K" });
  await waitFor(() => prompts.length === 3, "двух промптов");
  ev({ type: "session.updated", patch: { status: "busy" } });
  bots.unlinkChat(s.id, 22);
  answer("a3", "Обоим.");
  ev({ type: "session.updated", patch: { status: "idle" } });
  await waitFor(() => to("sendMessage").length >= 1, "ответа Диме");
  await tick(200);
  assert.deepEqual(to("sendMessage"), [11]);
});

test("бот сессии: прокси Telegram из настроек, иначе запасной (свой сервер), иначе напрямую; сменились — новое соединение", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-sbotnet-"));
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [base], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  const made: unknown[] = [];
  let fallback: string | undefined;
  const bots = new SessionBots(config, sessions, files, () => {}, (p) => (made.push(p ?? "direct"), { fetch, close: () => {} }), 0, () => fallback);
  void bots.net;
  fallback = "http://127.0.0.1:62039";
  void bots.net;
  void bots.net; // тот же прокси — то же соединение
  config.setTelegramProxy({ type: "socks5", host: "1.2.3.4", port: 1080 });
  void bots.net;
  assert.deepEqual(made, ["direct", { type: "http", host: "127.0.0.1", port: 62039 }, { type: "socks5", host: "1.2.3.4", port: 1080 }]);
});

test("бот сессии: при старте нет связи — имя бота узнаётся, когда связь появилась", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "kh-sbotme-"));
  mkdirSync(join(base, "P"));
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [base], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  await sessions.addEngine({
    id: "opencode", start: async () => {}, stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es1", attach: () => {}, prompt: async () => {}, abort: async () => {},
    replyPermission: async () => {}, replyQuestion: async () => {}, setPermissionMode: async () => {}, forget: () => {},
  });
  const s = await sessions.create({ engine: "opencode", directory: join(base, "P") });
  config.setSessionBots([{ sessionId: s.id, token: TOKEN, chats: [] }]);
  let online = false;
  const fakeFetch = (async (url: string) => {
    if (!online) throw new Error("fetch failed");
    const method = /\/(\w+)$/.exec(String(url))![1];
    if (method === "getUpdates") await tick(10);
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "alisa_health_bot" } : [] }));
  }) as unknown as typeof fetch;
  const bots = new SessionBots(config, sessions, files, () => {}, () => ({ fetch: fakeFetch, close: () => {} }), 0);
  t.after(() => bots.close());
  bots.start();
  await tick(100);
  assert.equal(bots.info(s.id).bot, undefined);
  assert.match(bots.info(s.id).error ?? "", /fetch failed/);
  online = true;
  for (let i = 0; i < 400 && !bots.info(s.id).bot; i++) await tick(20);
  assert.equal(bots.info(s.id).bot, "alisa_health_bot");
  assert.equal(bots.info(s.id).error, undefined);
});
