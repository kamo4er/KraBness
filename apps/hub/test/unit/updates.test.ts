// Обновления: проверка выпусков на поддельном GitHub, скачивание и подготовка установки, сама установка и откат (scripts/apply-update.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { Updates, newer, releaseNotes } from "../../src/updates.ts";

const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";
const APPLY = join(import.meta.dirname, "../../../../scripts/apply-update.mjs");

function tree(dir: string, files: Record<string, string>): string {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

test("версии и «что нового» по языкам", () => {
  assert.ok(newer("0.1.31", "0.1.30"));
  assert.ok(newer("0.2.0", "0.1.99"));
  assert.ok(!newer("0.1.30", "0.1.30"));
  assert.ok(!newer("0.1.9", "0.1.10"));
  const n = releaseNotes("## English\n- drafts\n\n## Русский\n- черновики\n");
  assert.deepEqual(n, { ru: "- черновики", en: "- drafts" });
  assert.deepEqual(releaseNotes("just text"), { ru: "just text", en: "just text" });
});

test("проверка, скачивание, подготовка установки; из git и без сторожа — не ставим; свой APK не затираем", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-upd-"));
  // выпуск 0.2.0: zip с исходниками и APK
  const src = tree(join(base, "src"), {
    "package.json": JSON.stringify({ name: "kamharn", version: "0.2.0" }),
    "release.json": JSON.stringify({ version: "0.2.0", versionCode: 40 }),
    "scripts/apply-update.mjs": "// stub\n",
    "apps/hub/x.ts": "export {};\n",
  });
  const zip = join(base, "krabness-0.2.0.zip");
  execFileSync(TAR, ["-a", "-cf", zip, "-C", src, "package.json", "release.json", "scripts", "apps"]);
  const apk = Buffer.from("fake apk");
  // подпись выпуска: свой ключ в тесте вместо ключа автора
  const keys = generateKeyPairSync("ed25519");
  const pub = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let sigText = sign(null, readFileSync(zip), keys.privateKey).toString("base64");
  const seen: string[] = [];
  const srv = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    if (req.url === "/repos/me/kb/releases/latest") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          tag_name: "v0.2.0",
          html_url: "https://github.com/me/kb/releases/tag/v0.2.0",
          published_at: "2026-10-24T10:00:00Z",
          body: "## English\n- new things\n## Русский\n- новое",
          assets: [
            { id: 1, name: "krabness-0.2.0.zip", size: readFileSync(zip).length },
            { id: 2, name: "KraBness-0.2.0.apk", size: apk.length },
            { id: 3, name: "krabness-0.2.0.zip.sig", size: sigText.length },
          ],
        }),
      );
    }
    if (req.url === "/repos/me/kb/releases/assets/1") return res.end(readFileSync(zip));
    if (req.url === "/repos/me/kb/releases/assets/2") return res.end(apk);
    if (req.url === "/repos/me/kb/releases/assets/3") return res.end(sigText);
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const root = mkdtempSync(join(base, "root-"));
    const config = new ConfigStore(join(base, "kamharn.json"), { dataDir: join(base, "data"), updates: { repo: "me/kb", token: "tok" } });
    let restarts = 0;
    const mk = (supervised: boolean, r = root, publicKey = pub) =>
      new Updates({ config, current: "0.1.30", root: r, dataDir: config.config.dataDir, supervised, restart: () => restarts++, api, publicKey, log: () => {} });

    // архив с чужой подписью (или не тем ключом) не ставится — даже угнанный аккаунт GitHub не подсунет своё
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const wrongKey = mk(true, root, other);
    await wrongKey.check();
    await assert.rejects(wrongKey.install(), /подпись выпуска не сходится|signature doesn't match/);
    const good = sigText;
    sigText = sign(null, Buffer.from("другой архив"), keys.privateKey).toString("base64");
    const forged = mk(true);
    await forged.check();
    await assert.rejects(forged.install(), /подпись выпуска не сходится|signature doesn't match/);
    sigText = good;
    assert.equal(restarts, 0, "с неверной подписью — без перезапуска");

    const u = mk(true);
    const st = await u.check();
    assert.equal(st.available, true);
    assert.equal(st.latest?.version, "0.2.0");
    assert.deepEqual(st.latest?.notes, { en: "- new things", ru: "- новое" });
    assert.equal(st.canInstall, true);
    assert.match(seen[0]!, /Bearer tok$/, "токен для закрытого репозитория");

    // проверка запомнилась: новый экземпляр (после рестарта) знает о выпуске без запроса
    assert.equal(mk(true).status().available, true);

    // из папки git и без сторожа — только плашка
    mkdirSync(join(base, "gitroot", ".git"), { recursive: true });
    assert.equal(mk(true, join(base, "gitroot")).status().reason, "git");
    await assert.rejects(mk(true, join(base, "gitroot")).install(), /git pull/);
    assert.equal(mk(false).status().reason, "manual");
    await assert.rejects(mk(false).install(), /сторожа|supervisor/);

    // своя сборка APK на хабе (без source: github) — APK выпуска не качаем
    tree(join(config.config.dataDir, "apk"), { "latest.json": JSON.stringify({ version: "0.1.30", file: "mine.apk" }) });
    await u.install();
    assert.equal(restarts, 1, "после скачивания — перезапуск для установки");
    const pending = JSON.parse(readFileSync(join(config.config.dataDir, "updates", "pending.json"), "utf8")) as { version: string; from: string; stage: string; apk?: string };
    assert.equal(pending.version, "0.2.0");
    assert.equal(pending.from, "0.1.30");
    assert.equal(pending.apk, undefined, "свой APK не затираем");
    assert.ok(existsSync(join(pending.stage, "apps", "hub", "x.ts")));
    assert.equal(u.status().state, "restarting");
    assert.ok(!seen.some((s) => s.includes("/assets/2")));

    // APK с GitHub — обновляется вместе с хабом
    tree(join(config.config.dataDir, "apk"), { "latest.json": JSON.stringify({ version: "0.1.30", file: "x.apk", source: "github" }) });
    await mk(true).install();
    const p2 = JSON.parse(readFileSync(join(config.config.dataDir, "updates", "pending.json"), "utf8")) as { apk?: string };
    assert.ok(p2.apk && readFileSync(p2.apk).equals(apk));
  } finally {
    srv.close();
  }
});

test("установка между запусками: файлы заменены, своё сохранено, откат возвращает прежнее", () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-apply-"));
  const root = tree(join(base, "root"), {
    "package.json": JSON.stringify({ version: "0.1.30" }),
    "apps/hub/old.ts": "old",
    "apps/mobile/credentials/keystore.properties": "mine",
    "apps/removed-in-new/a.txt": "gone",
    "node_modules/m/index.js": "old modules",
    "config/kamharn.json": "{}",
    "my-notes.txt": "не из выпуска",
  });
  const data = join(root, "data");
  const stage = tree(join(data, "updates", "stage"), {
    "package.json": JSON.stringify({ version: "0.2.0" }),
    "release.json": JSON.stringify({ version: "0.2.0", versionCode: 40 }),
    "apps/hub/new.ts": "new",
    "scripts/apply-update.mjs": "// new",
  });
  tree(join(data, "updates"), {
    "installed.json": JSON.stringify({ version: "0.1.30", entries: ["package.json", "apps"] }),
    "KraBness-0.2.0.apk": "apk",
    "pending.json": JSON.stringify({ version: "0.2.0", from: "0.1.30", stage, apk: join(data, "updates", "KraBness-0.2.0.apk") }),
  });
  const run = (mode: string) => spawnSync(process.execPath, [APPLY, mode, "--root", root, "--data", data, "--skip-npm", "1"], { encoding: "utf8" });

  const r = run("apply");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(root, "apps/hub/new.ts")));
  assert.ok(!existsSync(join(root, "apps/hub/old.ts")));
  assert.ok(!existsSync(join(root, "apps/removed-in-new")), "файлы, которых нет в новом выпуске, убраны");
  assert.equal(readFileSync(join(root, "apps/mobile/credentials/keystore.properties"), "utf8"), "mine", "ключ подписи остался");
  assert.equal(readFileSync(join(root, "config/kamharn.json"), "utf8"), "{}");
  assert.ok(existsSync(join(root, "my-notes.txt")), "чужие файлы не трогаем");
  assert.ok(!existsSync(join(root, "node_modules")), "старые node_modules — в бэкап (npm ci ставит новые)");
  assert.ok(!existsSync(join(data, "updates", "pending.json")));
  assert.ok(!existsSync(stage));
  const apk = JSON.parse(readFileSync(join(data, "apk", "latest.json"), "utf8")) as { version: string; versionCode: number; source: string };
  assert.deepEqual([apk.version, apk.versionCode, apk.source], ["0.2.0", 40, "github"]);
  assert.equal((JSON.parse(readFileSync(join(data, "updates", "result.json"), "utf8")) as { ok: boolean }).ok, true);

  // новый хаб упал сразу после старта — сторож откатывает
  mkdirSync(join(root, "node_modules"));
  const rb = run("rollback");
  assert.equal(rb.status, 0, rb.stdout + rb.stderr);
  assert.ok(existsSync(join(root, "apps/hub/old.ts")));
  assert.ok(!existsSync(join(root, "apps/hub/new.ts")));
  assert.ok(existsSync(join(root, "apps/removed-in-new/a.txt")));
  assert.ok(!existsSync(join(root, "scripts")), "то, что пришло с выпуском, убрано");
  assert.equal(readFileSync(join(root, "node_modules/m/index.js"), "utf8"), "old modules");
  assert.equal(readFileSync(join(root, "apps/mobile/credentials/keystore.properties"), "utf8"), "mine");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.1.30");
  const res = JSON.parse(readFileSync(join(data, "updates", "result.json"), "utf8")) as { ok: boolean; rolledBack: string };
  assert.deepEqual([res.ok, res.rolledBack], [false, "0.1.30"]);
  assert.deepEqual(readdirSync(join(root, "config")), ["kamharn.json"]);
});

test("установка: сбой сборки — откат сразу, хаб стартует на прежней версии", () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-apply-"));
  const lock = (v: string) => JSON.stringify({ name: "x", version: v, lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: v } } });
  const root = tree(join(base, "root"), {
    "package.json": JSON.stringify({ name: "x", version: "0.1.30", scripts: { "web:build": "node -e \"\"" } }),
    "package-lock.json": lock("0.1.30"),
    "apps/hub/old.ts": "old",
  });
  const data = join(base, "data");
  const stage = tree(join(data, "updates", "stage"), {
    "package.json": JSON.stringify({ name: "x", version: "0.2.0", scripts: { "web:build": "node -e \"process.exit(3)\"" } }),
    "package-lock.json": lock("0.2.0"),
    "apps/hub/new.ts": "new",
  });
  tree(join(data, "updates"), { "pending.json": JSON.stringify({ version: "0.2.0", from: "0.1.30", stage }) });
  const r = spawnSync(process.execPath, [APPLY, "apply", "--root", root, "--data", data], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(existsSync(join(root, "apps/hub/old.ts")));
  assert.ok(!existsSync(join(root, "apps/hub/new.ts")));
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "0.1.30");
  const res = JSON.parse(readFileSync(join(data, "updates", "result.json"), "utf8")) as { ok: boolean; error: string; rolledBack: string };
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, "0.1.30");
  assert.match(res.error, /web:build/);
});
