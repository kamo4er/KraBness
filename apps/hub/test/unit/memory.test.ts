// Долгая память: три слоя, закрытые группы, дневник, карта проектов. Модели поддельные: векторы — по словам, дневник — заготовка.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineId } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { Dispatcher } from "../../src/dispatcher.ts";
import type { Engine, EngineSink } from "../../src/engines/types.ts";
import { FileStore } from "../../src/files.ts";
import { Memory, parseDays, parseDiary, queryStems } from "../../src/memory.ts";
import { SessionManager } from "../../src/sessions.ts";

const NOW = new Date(2026, 10, 1, 21, 0).getTime(); // воскресенье

function fakeEngine(id: EngineId) {
  let sink!: EngineSink;
  let n = 0;
  const engine: Engine = {
    id,
    start: async (s) => void (sink = s),
    stop: async () => {},
    info: async () => ({ id, available: true, models: [{ engine: id, providerId: "p", modelId: "m", name: "M", tools: true }], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => `${id}-${++n}`,
    attach: () => {},
    prompt: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  return { engine, sink: () => sink };
}

/** Подделка LM Studio: вектор — какие из опорных слов встретились; синонимы считаются одним словом. */
const SYN: Record<string, string> = { крипта: "биткоин", биткоин: "биткоин", монета: "биткоин", шмотки: "одежда", одежда: "одежда", наряд: "одежда" };
function fakeLm(o: { loaded?: boolean; diary?: string; calls?: string[] } = {}): typeof fetch {
  const dims = ["биткоин", "одежда", "танец", "почта"];
  const unknown = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7); // незнакомое ни на что не похоже
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/api/v0/models")) return json({ data: [{ id: "bge", state: o.loaded === false ? "not-loaded" : "loaded" }, { id: "qwen", state: o.loaded === false ? "not-loaded" : "loaded" }] });
    const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; messages?: Array<{ content: string }> };
    if (u.endsWith("/embeddings")) {
      o.calls?.push("embed");
      return json({
        data: body.input!.map((t) => {
          const low = t.toLowerCase();
          const v = dims.map((d) => (Object.entries(SYN).some(([w, c]) => c === d && low.includes(w)) || low.includes(d) ? 1 : 0));
          const rest = new Array(997).fill(0);
          if (!v.some(Boolean)) rest[unknown(t) % 997] = 1;
          return { embedding: [...v, ...rest] };
        }),
      });
    }
    o.calls?.push(body.messages?.[1]?.content ?? "");
    return json({ choices: [{ message: { content: o.diary ?? "ДНЕВНИК:\n- Чинили сайт магазина.\n\nФАКТЫ:\n- Любит кофе без сахара.\n\nМЕСТА:\n- Магазин лежит в C:\\Projects\\Shop." } }] });
  }) as typeof fetch;
}

async function setup(o: { fetch?: typeof fetch; memory?: Record<string, unknown> } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kh-mem-"));
  const root = join(base, "Projects");
  mkdirSync(join(root, "Shop"), { recursive: true });
  mkdirSync(join(root, "Empty"), { recursive: true });
  writeFileSync(join(root, "Shop", "README.md"), "# Магазин\n\nИнтернет-магазин варежек на React.\n");
  const config = new ConfigStore(join(base, "cfg.json"), {
    roots: [root],
    dataDir: join(base, "data"),
    artifactsHint: false,
    memory: { embeddings: { url: "http://lm/v1", model: "bge" }, writer: { url: "http://lm/v1", model: "qwen" }, ...o.memory },
  });
  const db = new Db(join(base, "t.db"));
  const files = new FileStore(db, config);
  const sessions = new SessionManager(db, config, files);
  const claude = fakeEngine("claude");
  await sessions.addEngine(claude.engine);
  let now = NOW;
  const memory = new Memory({ db, sessions, config, fetch: o.fetch ?? fakeLm(), now: () => now });
  sessions.groupClosing = (id, closed) => memory.setGroupClosed(id, closed);
  sessions.on("session.deleted", (id) => memory.deleteSession(id));
  memory.start();
  const say = (esid: string, id: string, role: "user" | "assistant", text: string, ts = now) => {
    const s = claude.sink();
    s.event(esid, { type: "message.upserted", message: { id, role, createdAt: ts } });
    s.event(esid, { type: "part.upserted", messageId: id, part: { type: "text", id: `${id}t`, text } });
  };
  // журнал ставит время сам: для прошлых дней пишем напрямую
  const past = (daysAgo: number, key: string, text: string, source = "app", role = "user") => memory.put({ key, kind: "chat", source, role, ts: NOW - daysAgo * 86_400_000, text });
  return { base, root, config, db, sessions, memory, claude, say, past, setNow: (t: number) => (now = t), files, close: () => { memory.close(); db.close(); } };
}

const embedAll = async (m: Memory) => {
  while ((await m.embedTick()) > 0);
};

test("даты в вопросе: вчера, позавчера, N дней назад, число, день недели, прошлая неделя", () => {
  assert.deepEqual(parseDays("что мы делали вчера?", NOW), ["2026-10-31"]);
  assert.deepEqual(parseDays("а позавчера", NOW), ["2026-10-30"]);
  assert.deepEqual(parseDays("сегодня утром", NOW), ["2026-11-01"]);
  assert.deepEqual(parseDays("3 дня назад", NOW), ["2026-10-29"]);
  assert.deepEqual(parseDays("неделю назад", NOW), ["2026-10-25"]);
  assert.deepEqual(parseDays("что было 3 октября", NOW), ["2026-10-03"]);
  assert.deepEqual(parseDays("что было 28 декабря", NOW), ["2025-12-28"], "будущее — прошлый год");
  assert.deepEqual(parseDays("запись от 15.10", NOW), ["2026-10-15"]);
  assert.deepEqual(parseDays("2026-10-20", NOW), ["2026-10-20"]);
  assert.deepEqual(parseDays("в прошлый вторник", NOW), ["2026-10-27"]);
  assert.deepEqual(parseDays("в воскресенье", NOW), ["2026-10-25"], "сегодня воскресенье: прошлое");
  assert.equal(parseDays("на прошлой неделе", NOW).length, 7);
  for (const none of ["как дела", "у меня 3 кота", "открой почту", "2 3"]) assert.deepEqual(parseDays(none, NOW), [], none);
});

test("слова запроса: без служебных, без русских окончаний", () => {
  assert.deepEqual(queryStems("Что мы делали с машиной?"), ["машин"]);
  assert.deepEqual(queryStems("где лежит KraBness"), ["леж", "krabness"]);
  assert.deepEqual(queryStems("да нет ну"), []);
});

test("находит точные слова и то же другими словами; без векторов — только слова", async () => {
  const t = await setup();
  try {
    t.past(5, "a", "Биткоин сегодня подорожал на 3 процента");
    t.past(5, "b", "Давай подберём тебе наряд на вечер");
    t.past(5, "c", "Открой почту и найди письмо от банка");
    await embedAll(t.memory);
    const r = await t.memory.recall("сколько стоила крипта");
    assert.match(r.items[0]!.text, /Биткоин/, "другими словами");
    assert.match((await t.memory.recall("шмотки")).items[0]!.text, /наряд/);
    assert.match((await t.memory.recall("письмо от банка")).items[0]!.text, /почту/, "точные слова");
    const none = await t.memory.recall("абракадабра");
    assert.equal(none.items.length, 0, "ничего похожего — ничего и не выдаёт");
    assert.equal((await t.memory.stats()).withVector, 3);
  } finally {
    t.close();
  }
  const off = await setup({ memory: { embeddings: undefined } });
  try {
    off.past(5, "a", "Биткоин сегодня подорожал");
    assert.equal(await off.memory.embedTick(), 0);
    assert.match((await off.memory.recall("биткоина курс")).items[0]!.text, /Биткоин/, "слова работают и без модели, с окончаниями");
    assert.equal((await off.memory.recall("крипта")).items.length, 0);
  } finally {
    off.close();
  }
});

test("незагруженную модель не трогает: иначе она вытеснила бы разговорную из видеопамяти", async () => {
  const calls: string[] = [];
  const t = await setup({ fetch: fakeLm({ loaded: false, calls }) });
  try {
    t.past(5, "a", "Биткоин сегодня подорожал на 3 процента");
    assert.equal(await t.memory.embedTick(), 0);
    assert.equal(await t.memory.diaryTick(), undefined);
    assert.match((await t.memory.recall("биткоин подорожал")).items[0]!.text, /Биткоин/);
    assert.deepEqual(calls, [], "ни одного запроса к модели");
  } finally {
    t.close();
  }
});

test("вопрос с датой: дневник того дня и записи только за него; без слов — начало дня", async () => {
  const t = await setup();
  try {
    t.past(1, "y1", "Вчера чинили корзину в магазине");
    t.past(2, "z1", "Позавчера чинили корзину в другой раз");
    t.memory.put({ key: "diary:2026-10-31", kind: "diary", source: "diary", ts: NOW - 86_400_000, text: "Чинили корзину" });
    const r = await t.memory.recall("что мы чинили вчера");
    assert.deepEqual(r.days, ["2026-10-31"]);
    assert.equal(r.diaries[0]!.text, "Чинили корзину");
    assert.equal(r.items.length, 1);
    assert.match(r.items[0]!.text, /^Вчера/);
    const bare = await t.memory.recall("вчера");
    assert.match(bare.items[0]!.text, /^Вчера/, "слов нет, а день есть");
    const before = await t.memory.recall("чинили корзину", { before: NOW - 1.5 * 86_400_000 });
    assert.ok(before.items.every((h) => h.text.startsWith("Позавчера")), "что и так в разговоре, не возвращает");
  } finally {
    t.close();
  }
});

test("реплики сессий попадают сами; теги и служебное — нет; замена текста заменяет запись", async () => {
  const t = await setup();
  try {
    const s = await t.sessions.create({ engine: "claude", directory: t.root, title: "Магазин" });
    const esid = t.sessions.engineSessionIdOf(s.id)!;
    t.say(esid, "m1", "user", "Почини корзину в магазине варежек");
    t.say(esid, "m2", "assistant", "⇄ служебная отметка смены мозга");
    t.say(esid, "m3", "assistant", "короткий");
    t.claude.sink().event(esid, { type: "message.upserted", message: { id: "m4", role: "assistant", createdAt: NOW, summary: true } });
    t.claude.sink().event(esid, { type: "part.upserted", messageId: "m4", part: { type: "text", id: "m4t", text: "Пересказ разговора после сжатия контекста" } });
    const found = (await t.memory.recall("корзину варежек")).items;
    assert.equal(found[0]!.where, "Магазин");
    assert.equal((await t.memory.stats()).items, 1, "отметки, короткое и пересказ не запоминаются");
    t.claude.sink().event(esid, { type: "part.upserted", messageId: "m1", part: { type: "text", id: "m1t", text: "Почини оплату в магазине варежек" } });
    assert.equal((await t.memory.stats()).items, 1);
    assert.match((await t.memory.recall("оплату варежек")).items[0]!.text, /оплату/);

  } finally {
    t.close();
  }
});

test("закрытая группа: не запоминается, не находится, Диспетчер её не видит; закрыть задним числом стирает и дневник", async () => {
  const t = await setup();
  const open = await t.sessions.create({ engine: "claude", directory: t.root, title: "Открытая" });
  const group = t.sessions.createGroup({ name: "Дом" });
  const home = await t.sessions.create({ engine: "claude", directory: t.root, title: "Анализы", groupId: group.id });
  const homeE = t.sessions.engineSessionIdOf(home.id)!;
  t.say(homeE, "h1", "user", "Анализы крови у дочки в норме");
  assert.equal((await t.memory.recall("анализы крови")).items.length, 1, "пока открыта — помнит");
  // журнал ставит время сам: день записи настоящий, а не NOW
  const day = String((t.db.db.prepare("SELECT day FROM memory_items WHERE kind = 'chat' LIMIT 1").get() as { day: string }).day);
  t.memory.put({ key: `diary:${day}`, kind: "diary", source: "diary", ts: NOW, text: "Смотрели анализы крови" });

  t.sessions.updateGroup(group.id, { noMemory: true });
  assert.equal(t.sessions.groups().find((g) => g.id === group.id)!.noMemory, true);
  assert.equal((await t.memory.recall("анализы крови")).items.length, 0, "стёрто");
  assert.equal((await t.memory.recall("анализы", { day })).diaries.length, 0, "дневник того дня стёрт и напишется заново");
  t.say(homeE, "h2", "user", "Новые анализы крови тоже в норме");
  assert.equal((await t.memory.recall("анализы крови")).items.length, 0, "новое не запоминается");
  assert.equal(t.config.config.memory?.closedGroups?.includes(group.id), true, "флаг переживёт рестарт");

  const d = new Dispatcher({ sessions: t.sessions, config: t.config, files: t.files, memory: t.memory });
  try {
    assert.doesNotMatch(d.listSessions(), /Анализы/, "в списке нет");
    assert.match(d.listSessions(), /Открытая/);
    assert.throws(() => d.readSession(home.id), /закрытая группа/);
    await assert.rejects(d.send(home.id, "что там"), /закрытая группа/);
    assert.doesNotMatch(d.searchHistory("анализы"), /Анализы/, "и поиск по чатам");
    assert.match(await d.recall("анализы", undefined, 8), /ничего подходящего/);
    void open;
  } finally {
    d.close();
    t.close();
  }
});

test("дневник: пишется за прошедшие дни по порядку, раз в день, факты и места отдельно; сегодняшний не трогает", async () => {
  const calls: string[] = [];
  const t = await setup({ fetch: fakeLm({ calls }) });
  try {
    t.past(0, "today", "Сегодняшний день ещё идёт и не кончился");
    t.past(1, "y1", "Вчера чинили корзину в магазине");
    t.past(3, "o1", "Давно обсуждали дизайн главной страницы");
    assert.equal(await t.memory.diaryTick(), "2026-10-29", "самый старый первым");
    assert.match(calls[0]!, /2026-10-29/);
    assert.match(calls[0]!, /дизайн главной/);
    assert.doesNotMatch(calls[0]!, /корзину/, "только этот день");
    assert.equal(await t.memory.diaryTick(), "2026-10-31");
    assert.equal(await t.memory.diaryTick(), undefined, "сегодняшний день ещё не кончился");
    const b = t.memory.brief();
    assert.equal(b.lastDay!.day, "2026-10-31");
    assert.match(b.lastDay!.text, /Чинили сайт/);
    assert.deepEqual(b.facts, ["Любит кофе без сахара."], "тот же факт дважды не записан");
    assert.equal(b.places.length, 1);
    const text = t.memory.dispatcherText();
    for (const want of [/Чинили сайт/, /кофе без сахара/, /C:\\Projects\\Shop/, /Интернет-магазин варежек/]) assert.match(text, want);
    assert.match((await t.memory.recall("где лежит магазин")).items.map((h) => h.text).join(" "), /C:\\Projects\\Shop/, "места находятся");
  } finally {
    t.close();
  }
});

test("неудачный дневник не крутится вечно; мусор без заголовков всё равно становится дневником", async () => {
  const broken = (async (url: string | URL) => {
    if (String(url).endsWith("/api/v0/models")) return new Response(JSON.stringify({ data: [{ id: "qwen", state: "loaded" }] }));
    return new Response("упало", { status: 500 });
  }) as typeof fetch;
  const t = await setup({ fetch: broken });
  try {
    t.past(1, "y1", "Вчера чинили корзину в магазине");
    for (let i = 0; i < 3; i++) assert.equal(await t.memory.diaryTick(), undefined);
    assert.equal(t.db.getMeta("memory.diary.fail.2026-10-31"), "3");
    const n = t.db.getMeta("memory.diary.fail.2026-10-31");
    await t.memory.diaryTick();
    assert.equal(t.db.getMeta("memory.diary.fail.2026-10-31"), n, "больше не пробует");
  } finally {
    t.close();
  }
  assert.equal(parseDiary("Просто текст про день").diary, "Просто текст про день");
  const p = parseDiary("<think>хм</think>\n**ДНЕВНИК:**\n- Сделали А.\n\nФАКТЫ:\nнет\n\nМЕСТА:\n1. Путь к проекту C:\\x\n");
  assert.equal(p.diary, "- Сделали А.");
  assert.deepEqual(p.facts, []);
  assert.deepEqual(p.places, ["Путь к проекту C:\\x"]);
});

test("забыть: стирает найденное и из слов, и из векторов", async () => {
  const t = await setup();
  try {
    t.past(2, "a", "Биткоин сегодня подорожал на 3 процента");
    t.past(2, "b", "Открой почту и найди письмо");
    await embedAll(t.memory);
    await t.memory.recall("биткоин");
    const gone = await t.memory.forget("биткоин подорожал");
    assert.equal(gone.length, 1);
    assert.equal((await t.memory.recall("биткоин подорожал")).items.length, 0);
    assert.equal((await t.memory.recall("крипта")).items.length, 0, "и другими словами тоже");
    assert.equal((await t.memory.stats()).items, 1);
  } finally {
    t.close();
  }
});

test("удалённая сессия уходит из памяти; карта проектов: что это и что там делали", async () => {
  const t = await setup();
  try {
    const s = await t.sessions.create({ engine: "claude", directory: join(t.root, "Shop"), title: "Корзина" });
    t.say(t.sessions.engineSessionIdOf(s.id)!, "m1", "user", "Почини корзину в магазине варежек");
    const map = t.memory.projectMap();
    assert.match(map, /Shop — Интернет-магазин варежек на React\. \(последнее: «Корзина»/);
    assert.match(map, /Empty/);
    // документы закрытой группы лежат не там, где её сессия: папка упомянута в промпте группы
    mkdirSync(join(t.root, "Secret"));
    writeFileSync(join(t.root, "Secret", "README.md"), "Медицинская карта\n");
    mkdirSync(join(t.root, "Home"));
    const g = t.sessions.createGroup({ name: "Дом", prompt: `Документы веди в папке Projects\\Secret, там всё.` });
    t.sessions.updateGroup(g.id, { noMemory: true });
    await t.sessions.create({ engine: "claude", directory: join(t.root, "Home"), groupId: g.id });
    t.setNow(NOW + 86_400_000);
    const closedMap = t.memory.projectMap();
    assert.doesNotMatch(closedMap, /Secret|Медицинская/, "папка из промпта закрытой группы");
    assert.doesNotMatch(closedMap, /Home/, "папка её сессии");
    assert.match(closedMap, /Shop/);
    t.setNow(NOW);
    assert.ok(map.indexOf("Shop") < map.indexOf("Empty"), "недавнее выше");
    t.sessions.delete(s.id);
    assert.equal((await t.memory.recall("корзину варежек")).items.length, 0);
  } finally {
    t.close();
  }
});
