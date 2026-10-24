import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { Auth } from "../../src/auth.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kamharn-"));
}

test("allowlist: внутри root — ок, снаружи и через .. — отказ", () => {
  const base = tmp();
  const root = join(base, "Projects");
  mkdirSync(join(root, "app", "src"), { recursive: true });
  mkdirSync(join(base, "secret"));
  writeFileSync(join(base, "secret", "key.txt"), "x");
  const cfg = new ConfigStore(join(base, "cfg.json"), { roots: [root] });

  assert.ok(cfg.resolveAllowed(join(root, "app", "src")).toLowerCase().endsWith(join("app", "src").toLowerCase()));
  assert.ok(cfg.resolveAllowed(root));
  assert.throws(() => cfg.resolveAllowed(join(base, "secret")), /вне разрешённых/);
  assert.throws(() => cfg.resolveAllowed(join(root, "app", "..", "..", "secret", "key.txt")), /вне разрешённых/);
  assert.throws(() => cfg.resolveAllowed(root + "-evil"), /не существует|вне/);
  assert.throws(() => cfg.resolveAllowed("relative\\path"), /абсолютный/);
});

test("allowlist: добавление и удаление папки сохраняется в конфиг", () => {
  const base = tmp();
  const extra = join(base, "Docs");
  mkdirSync(extra);
  const path = join(base, "cfg.json");
  const cfg = new ConfigStore(path, { roots: [] });
  assert.throws(() => cfg.resolveAllowed(extra));
  cfg.addRoot(extra);
  cfg.addRoot(extra); // без дублей
  assert.equal(cfg.config.roots.length, 1);
  assert.ok(new ConfigStore(path).config.roots.length === 1, "записано на диск");
  assert.ok(cfg.resolveAllowed(extra));
  cfg.removeRoot(extra);
  assert.throws(() => cfg.resolveAllowed(extra));
});

test("журнал событий: seq монотонный, eventsAfter отдаёт хвост", () => {
  const db = new Db(join(tmp(), "t.db"));
  db.insertSession({
    id: "s1", engine: "opencode", engineSessionId: "e1", directory: "C:\\x", title: "t",
    model: { providerId: "p", modelId: "m" }, permissionMode: "acceptEdits", status: "idle",
    createdAt: 1, updatedAt: 1, lastSeq: 0,
  });
  for (let i = 0; i < 5; i++) db.appendEvent("s1", { type: "error", message: String(i) });
  assert.deepEqual(db.eventsAfter("s1", 0).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(db.eventsAfter("s1", 3).map((e) => e.seq), [4, 5]);
  assert.equal(db.getSession("s1")?.lastSeq, 5);
  db.close();
});

test("pairing: код одноразовый, токен работает, localhost доверенный", () => {
  const db = new Db(join(tmp(), "a.db"));
  const auth = new Auth(db);
  assert.equal(auth.authenticate("127.0.0.1", undefined), "local");
  assert.equal(auth.authenticate("100.64.0.5", undefined), undefined);
  const { code } = auth.startPairing();
  const r = auth.completePairing(code, "Pixel");
  assert.ok(r);
  assert.equal(auth.completePairing(code, "again"), undefined, "второй раз код не работает");
  assert.equal(auth.authenticate("100.64.0.5", r.token), r.deviceId);
  assert.equal(auth.authenticate("100.64.0.5", "wrong"), undefined);
  db.close();
});

test("pairing: перебор кода сжигает активные коды", () => {
  const db = new Db(join(tmp(), "b.db"));
  const auth = new Auth(db);
  const { code } = auth.startPairing();
  for (let i = 0; i < 5; i++) auth.completePairing(code === "000000" ? "000001" : "000000", "x");
  assert.equal(auth.completePairing(code, "x"), undefined);
  db.close();
});

test("быстрые кнопки: по умолчанию, сохранение с чисткой, проверки", () => {
  const path = join(tmp(), "cfg.json");
  const cfg = new ConfigStore(path, { roots: [] });
  assert.ok(cfg.quickPrompts.includes("Продолжай"));
  assert.deepEqual(cfg.setQuickPrompts(["  Продолжай ", "", "Тесты", "Тесты"]), ["Продолжай", "Тесты"]);
  assert.deepEqual(new ConfigStore(path).quickPrompts, ["Продолжай", "Тесты"], "записано на диск");
  assert.throws(() => cfg.setQuickPrompts("x"), /массив/);
  assert.throws(() => cfg.setQuickPrompts(Array.from({ length: 21 }, (_, i) => `k${i}`)), /20/);
});

test("MCP пользователя в Claude: переключатель сохраняется в конфиг", () => {
  const path = join(tmp(), "cfg.json");
  const cfg = new ConfigStore(path, { roots: [] });
  assert.ok(!cfg.config.engines.claude.userMcp);
  cfg.setClaudeUserMcp(true);
  assert.equal(new ConfigStore(path).config.engines.claude.userMcp, true);
});
