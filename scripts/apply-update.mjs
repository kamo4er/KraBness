// Установка обновления KraBness между запусками хаба (вызывает сторож scripts/hub-service.ps1).
//   node apply-update.mjs apply    --root <папка установки> --data <dataDir>
//   node apply-update.mjs rollback --root <папка установки> --data <dataDir>   (новый хаб сразу упал)
// apply: data/updates/pending.json (его пишет хаб, скачав выпуск) → старые файлы в data/updates/backup,
// новые из stage на место, npm ci, сборка веба, APK в data/apk. Любая ошибка — откат.
// Только встроенные модули node: node_modules в этот момент меняется.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const mode = process.argv[2];
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const root = resolve(arg("root") ?? ".");
const data = resolve(arg("data") ?? join(root, "data"));
const dir = join(data, "updates");
const backup = join(dir, "backup");
// это не трогаем никогда: данные, настройки, рабочие папки
const KEEP = new Set(["data", "config", "tmp", ".git", ".env", "node_modules"]);
// своё внутри заменяемых папок: ключ подписи и Firebase, сборка приложения
const PRESERVE = ["apps/mobile/credentials", "apps/mobile/node_modules", "apps/mobile/android"];

const log = (m) => console.log(`${new Date().toISOString()} [update] ${m}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJson = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return fallback;
  }
};

/** rename с повторами: антивирус и индексатор ненадолго держат свежие файлы */
function move(from, to) {
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 15 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code)) throw e;
      sleep(1000);
    }
  }
}

function run(cmd, args) {
  log(`${cmd} ${args.join(" ")}`);
  // npm на Windows — npm.cmd, нужна оболочка; аргументы простые, склеиваем сами (иначе node предупреждает DEP0190)
  const r = process.platform === "win32" ? spawnSync([cmd, ...args].join(" "), { cwd: root, stdio: "inherit", shell: true, timeout: 15 * 60_000 }) : spawnSync(cmd, args, { cwd: root, stdio: "inherit", timeout: 15 * 60_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: code ${r.status ?? r.signal ?? r.error?.message}`);
}

const result = (r) => writeFileSync(join(dir, "result.json"), JSON.stringify({ at: Date.now(), ...r }));

/** Вернуть прежнюю версию: новое убрать, своё (PRESERVE) отложить обратно, старое — на место. */
function restore(applied) {
  for (const p of PRESERVE) {
    if (existsSync(join(root, p)) && !existsSync(join(backup, p)) && existsSync(join(backup, p.split("/")[0]))) move(join(root, p), join(backup, p));
  }
  for (const e of new Set([...applied.entries, "node_modules"])) rmSync(join(root, e), { recursive: true, force: true });
  for (const e of applied.old) if (existsSync(join(backup, e))) move(join(backup, e), join(root, e));
  writeFileSync(join(dir, "installed.json"), JSON.stringify({ version: applied.from, entries: applied.prevEntries }));
}

/** APK из выпуска — туда, откуда хаб раздаёт его телефонам (как scripts/publish-apk.mjs), с пометкой source: github. */
function placeApk(file) {
  const rel = readJson(join(root, "release.json"), {});
  const out = join(data, "apk");
  mkdirSync(out, { recursive: true });
  const name = basename(file);
  copyFileSync(file, join(out, name));
  const buf = readFileSync(join(out, name));
  const info = { version: rel.version, versionCode: rel.versionCode, file: name, size: statSync(join(out, name)).size, sha256: createHash("sha256").update(buf).digest("hex"), builtAt: Date.now(), source: "github" };
  if (rel.apkSha256 && rel.apkSha256 !== info.sha256) throw new Error("APK checksum mismatch");
  writeFileSync(join(out, "latest.json"), JSON.stringify(info, null, 2));
  for (const f of readdirSync(out)) if (f.endsWith(".apk") && f !== name) rmSync(join(out, f));
  rmSync(file, { force: true });
}

function apply() {
  const p = readJson(join(dir, "pending.json"));
  if (!p) return log("nothing to apply");
  // сразу убираем: если что-то пойдёт совсем не так, сторож не будет ставить по кругу
  rmSync(join(dir, "pending.json"), { force: true });
  const stage = p.stage;
  const entries = readdirSync(stage).filter((e) => !KEEP.has(e));
  const prevEntries = readJson(join(dir, "installed.json"), {}).entries ?? [];
  // убрать: всё, что приходит в выпуске, и то, что было в прошлом выпуске (удалённые файлы), плюс node_modules
  const old = [...new Set([...entries, ...prevEntries, "node_modules"])].filter((e) => (e === "node_modules" || !KEEP.has(e)) && existsSync(join(root, e)));
  rmSync(backup, { recursive: true, force: true });
  mkdirSync(backup, { recursive: true });
  const applied = { version: p.version, from: p.from, entries, old, prevEntries, at: Date.now() };
  writeFileSync(join(dir, "applied.json"), JSON.stringify(applied));
  log(`${p.from} -> ${p.version}`);
  try {
    for (const e of old) move(join(root, e), join(backup, e));
    for (const e of entries) move(join(stage, e), join(root, e));
    for (const pth of PRESERVE) if (existsSync(join(backup, pth)) && !existsSync(join(root, pth))) move(join(backup, pth), join(root, pth));
    if (!arg("skip-npm")) {
      run("npm", ["ci", "--no-audit", "--no-fund"]);
      run("npm", ["run", "web:build"]);
    }
  } catch (e) {
    log(`failed: ${e.message}; rolling back to ${p.from}`);
    try {
      restore(applied);
    } catch (e2) {
      log(`ROLLBACK FAILED: ${e2.message}. Old files are in ${backup}`);
    }
    result({ version: p.version, ok: false, error: e.message, rolledBack: p.from });
    process.exit(1);
  }
  writeFileSync(join(dir, "installed.json"), JSON.stringify({ version: p.version, entries }));
  if (p.apk) {
    try {
      placeApk(p.apk);
    } catch (e) {
      log(`apk not placed: ${e.message}`);
    }
  }
  rmSync(stage, { recursive: true, force: true });
  result({ version: p.version, ok: true });
  log(`installed ${p.version}`);
}

function rollback() {
  const applied = readJson(join(dir, "applied.json"));
  if (!applied || !existsSync(backup)) return log("nothing to roll back");
  log(`rolling back ${applied.version} -> ${applied.from}`);
  restore(applied);
  rmSync(join(dir, "applied.json"), { force: true });
  result({ version: applied.version, ok: false, error: "the new version exited right after start", rolledBack: applied.from });
  log(`rolled back to ${applied.from}`);
}

if (mode === "apply") apply();
else if (mode === "rollback") rollback();
else {
  console.log("usage: node apply-update.mjs apply|rollback --root <dir> --data <dataDir>");
  process.exit(2);
}
