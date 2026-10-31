// Голос на ПК: хаб запускает сервис, читает его состояние, перезапускает после падения, гасит при выключении.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { VoiceService } from "../../src/voice.ts";

const until = async (f: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("не дождались");
    await new Promise((r) => setTimeout(r, 30));
  }
};

test("голос: запуск по настройке, состояние из STATE, перезапуск после падения, выключение", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-voice-"));
  const dir = join(base, "voice");
  mkdirSync(dir);
  writeFileSync(join(dir, "main.py"), "# placeholder");
  // подделка сервиса: слушает, второй запуск сразу «падает» не будет — счётчик запусков в файле
  const fake = join(base, "fake.mjs");
  const runs = join(base, "runs.txt");
  writeFileSync(
    fake,
    `import { appendFileSync, readFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(runs)}, "x");
const n = readFileSync(${JSON.stringify(runs)}, "utf8").length;
console.log("STATE loading");
console.log("100%|███| progress bar");
setTimeout(() => console.log("STATE listening"), 50);
if (n === 1) setTimeout(() => process.exit(3), 300);
else setInterval(() => {}, 1000);`,
  );
  const config = new ConfigStore(join(base, "cfg.json"), { dataDir: join(base, "data"), roots: [base] });
  const v = new VoiceService({ config, hubUrl: () => "http://127.0.0.1:1", dir, command: () => ({ cmd: process.execPath, args: [fake] }) });

  assert.equal(v.status().enabled, false);
  assert.equal(v.status().unavailable, undefined);
  v.start();
  assert.equal(v.status().state, "off", "выключен — не запускается");

  v.set({ enabled: true, device: "ME6S" });
  assert.equal(config.config.voice?.device, "ME6S");
  await until(() => v.status().state === "listening");
  // первый запуск падает с кодом 3 — хаб поднимает снова
  await until(() => existsSync(runs) && readFileSync(runs, "utf8").length === 2, 10_000);
  await until(() => v.status().state === "listening");
  const log = v.status().log.join("\n");
  assert.match(log, /exit 3/);
  assert.doesNotMatch(log, /progress bar/, "прогресс-бары в лог не идут");
  assert.ok(existsSync(join(base, "data", "logs", "voice.log")));

  v.set({ enabled: false });
  assert.equal(v.status().state, "off");
  assert.equal(config.config.voice?.enabled, false);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(readFileSync(runs, "utf8").length, 2, "выключенный не перезапускается");
  v.close();

  // без сервиса рядом — понятная причина
  const bare = new VoiceService({ config, hubUrl: () => "", dir: join(base, "nope"), command: () => ({ cmd: "x", args: [] }) });
  assert.match(bare.status().unavailable ?? "", /voice/);
});
