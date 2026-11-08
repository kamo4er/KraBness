// Автопродолжение после лимита Claude: время сброса, таймер, отмена, пуши, миграция БД.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { ClaudeLimits, SessionEvent, SessionInfo, StoredEvent } from "@kamharn/protocol";
import { AutoResume, isLimitError, resumeTime, resumeText } from "../../src/autoresume.ts";
import { Notifier } from "../../src/notifier.ts";
import { Db } from "../../src/db.ts";
import type { PushMessage } from "../../src/push.ts";

const MSG = "You've hit your session limit · resets 10:30pm (Europe/Moscow)";

test("isLimitError: лимиты Claude — да, прочие ошибки — нет", () => {
  assert.ok(isLimitError(MSG));
  assert.ok(isLimitError("You've hit your weekly limit · resets Oct 25, 5am"));
  assert.ok(!isLimitError("Процесс Claude завершился (код 1)"));
  assert.ok(!isLimitError("API Error: 500"));
});

test("resumeTime: по исчерпанному окну, по отказу, по тексту, запасной вариант", () => {
  const now = new Date(2026, 9, 21, 21, 38).getTime();
  const fresh = (l: Omit<ClaudeLimits, "updatedAt">): ClaudeLimits => ({ ...l, updatedAt: now - 1000 });
  const fiveReset = now + 52 * 60_000;
  // окно 5 часов на 100% — его сброс + минута
  assert.equal(resumeTime(MSG, fresh({ fiveHour: { utilization: 1, resetsAt: fiveReset }, sevenDay: { utilization: 0.4, resetsAt: now + 3 * 86400_000 } }), now), fiveReset + 60_000);
  // неделя на 100% важнее: ждать дольше
  const weekReset = now + 2 * 86400_000;
  assert.equal(resumeTime(MSG, fresh({ fiveHour: { utilization: 1, resetsAt: fiveReset }, sevenDay: { utilization: 1, resetsAt: weekReset } }), now), weekReset + 60_000);
  // отказ без 100% — по самому загруженному окну
  assert.equal(resumeTime(MSG, fresh({ fiveHour: { utilization: 0.97, resetsAt: fiveReset }, sevenDay: { utilization: 0.5, resetsAt: weekReset }, status: "rejected" }), now), fiveReset + 60_000);
  // лимиты старые — по тексту: 10:30pm сегодня
  const stale = { fiveHour: { utilization: 1, resetsAt: fiveReset }, updatedAt: now - 3600_000 };
  assert.equal(resumeTime(MSG, stale, now), new Date(2026, 9, 21, 22, 30).getTime() + 60_000);
  // время из текста уже прошло — значит завтра
  assert.equal(resumeTime("You've hit your session limit · resets 9am", undefined, now), new Date(2026, 9, 22, 9, 0).getTime() + 60_000);
  // ничего не понятно — через 30 минут
  assert.equal(resumeTime("You've hit your session limit", undefined, now), now + 30 * 60_000);
});

function fakeSessions(status: SessionInfo["status"] = "idle") {
  const s: SessionInfo = { id: "s1", engine: "claude", directory: "C:\\p", title: "Игра", model: { providerId: "a", modelId: "m" }, permissionMode: "auto", status, createdAt: 1, updatedAt: 1, lastSeq: 0 };
  const prompts: string[] = [];
  let seq = 0;
  let ar: AutoResume;
  const emit = (event: SessionEvent) => {
    if (event.type === "session.updated") Object.assign(s, event.patch);
    ar.onEvent({ seq: ++seq, sessionId: "s1", ts: Date.now(), event });
  };
  const api = {
    list: () => [{ ...s }],
    get: () => ({ ...s, engineSessionId: "e1" }),
    setResumeAt: (_id: string, at: number) => {
      if ((s.resumeAt ?? 0) !== at) emit({ type: "session.updated", patch: { resumeAt: at } });
    },
    prompt: async (_id: string, text: string) => {
      prompts.push(text);
      emit({ type: "message.upserted", message: { id: `u${seq}`, role: "user", createdAt: Date.now() } });
    },
  };
  return { s, prompts, emit, api, bind: (a: AutoResume) => (ar = a) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("AutoResume: лимит → ждём → «Продолжай» и пуш; resumeAt снят", async () => {
  const f = fakeSessions();
  const notes: string[] = [];
  const limits: ClaudeLimits = { fiveHour: { utilization: 1, resetsAt: Date.now() + 150 }, updatedAt: Date.now() };
  // запас после сброса в тесте нулевой — иначе ждать минуту
  const ar = new AutoResume(f.api as never, () => limits, (_sid, m) => notes.push(m), () => {}, Date.now, 0);
  f.bind(ar);
  f.emit({ type: "error", message: "You've hit your session limit" });
  assert.equal(f.s.resumeAt, limits.fiveHour!.resetsAt, "назначено на сброс окна");
  assert.deepEqual(f.prompts, [], "раньше сброса не продолжаем");
  await wait(400);
  assert.deepEqual(f.prompts, [resumeText()]);
  assert.equal(f.s.resumeAt, 0);
  assert.deepEqual(notes, ["Лимит сбросился — продолжаю работу"]);
  ar.close();
});

test("AutoResume: отмена кнопкой и ручное сообщение снимают ожидание; рестарт поднимает таймер", async () => {
  const f = fakeSessions();
  const ar = new AutoResume(f.api as never, () => undefined, () => {}, () => {});
  f.bind(ar);
  f.emit({ type: "error", message: MSG });
  assert.ok(f.s.resumeAt);
  f.api.setResumeAt("s1", 0); // «Не продолжать»
  assert.equal(f.s.resumeAt, 0);

  f.emit({ type: "error", message: MSG });
  assert.ok(f.s.resumeAt);
  f.emit({ type: "message.upserted", message: { id: "u-manual", role: "user", createdAt: Date.now() } });
  assert.equal(f.s.resumeAt, 0, "пользователь написал сам");
  ar.close();

  // рестарт хаба: resumeAt уже в прошлом — продолжаем сразу после start()
  const g = fakeSessions();
  g.s.resumeAt = Date.now() - 1000;
  const ar2 = new AutoResume(g.api as never, () => undefined, () => {}, () => {});
  g.bind(ar2);
  ar2.start();
  await wait(100);
  assert.deepEqual(g.prompts, [resumeText()]);
  ar2.close();
});

test("AutoResume: не трогает opencode и сессию, которая уже работает", async () => {
  const f = fakeSessions("busy");
  const ar = new AutoResume(f.api as never, () => undefined, () => {}, () => {});
  f.bind(ar);
  f.s.resumeAt = Date.now() - 1;
  ar.start();
  await wait(100);
  assert.deepEqual(f.prompts, [], "уже работает — «Продолжай» не шлём");
  assert.equal(f.s.resumeAt, 0);
  ar.close();

  const o = fakeSessions();
  o.s.engine = "opencode";
  const ar3 = new AutoResume(o.api as never, () => undefined, () => {}, () => {});
  o.bind(ar3);
  o.emit({ type: "error", message: MSG });
  assert.equal(o.s.resumeAt, undefined);
  ar3.close();
});

test("Notifier: при лимите вместо «Ошибка» и «Готово» — один пуш со временем продолжения", async () => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), "kamharn-")), "t.db"));
  const now = Date.now();
  db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: "C:\\w", title: "Игра", model: { providerId: "a", modelId: "m" }, permissionMode: "auto", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  db.insertDevice({ id: "d1", name: "phone", tokenHash: "h", createdAt: now, lastSeen: now, fcmToken: "tok" });
  const sent: PushMessage[] = [];
  const n = new Notifier(db, { enabled: true, send: async (_t, m) => (sent.push(m), "ok") });
  let seq = 0;
  const ev = (event: SessionEvent): StoredEvent => ({ seq: ++seq, sessionId: "s1", ts: now, event });
  n.onEvent(ev({ type: "session.updated", patch: { status: "busy" } }));
  n.onEvent(ev({ type: "error", message: MSG }));
  const at = new Date(2026, 9, 21, 22, 31).getTime();
  n.onEvent(ev({ type: "session.updated", patch: { resumeAt: at } }));
  n.onEvent(ev({ type: "session.updated", patch: { status: "idle" } }));
  await wait(20);
  assert.deepEqual(sent.map((m) => m.message), ["Упёрлись в лимит Claude — продолжу сам в 22:31"]);
});

test("БД: старая база без resume_at открывается, колонка добавляется", () => {
  const file = join(mkdtempSync(join(tmpdir(), "kamharn-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, engine TEXT NOT NULL, engine_session_id TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, model_json TEXT NOT NULL, permission_mode TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0)`);
  old.exec(`INSERT INTO sessions VALUES ('s1','claude','e1','C:\\p','t','{"providerId":"a","modelId":"m"}','auto','idle',1,1,0)`);
  old.close();
  const db = new Db(file);
  assert.equal(db.getSession("s1")?.resumeAt, undefined);
  db.updateSession("s1", { resumeAt: 123 });
  assert.equal(db.getSession("s1")?.resumeAt, 123);
  db.updateSession("s1", { resumeAt: 0 });
  assert.equal(db.getSession("s1")?.resumeAt, undefined);
});
