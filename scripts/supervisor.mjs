// Сторож хаба для macOS (и Linux): держит хаб запущенным, ставит скачанное обновление между запусками,
// откатывает версию, которая сразу упала. То же, что scripts/hub-service.ps1 на Windows.
// Сам сторож держит launchd (~/Library/LaunchAgents/dev.krabness.hub.plist, KeepAlive) — отдельный watchdog не нужен.
//   node scripts/supervisor.mjs [--data <dataDir>]
// Перезапуск из интерфейса: хаб выходит с кодом 75, сторож сразу поднимает его снова.
// SIGTERM (launchctl bootout, krabness stop): хаб получает SIGTERM, сторож ждёт его и выходит.
// Только встроенные модули node: при обновлении node_modules меняется.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

const RESTART = 75;
const root = resolve(import.meta.dirname, "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};
const cfg = readJson(process.env.KAMHARN_CONFIG ?? join(root, "config", "kamharn.json")) ?? {};
const dataDir = resolve(arg("data") ?? cfg.dataDir ?? join(root, "data"));
const port = Number(cfg.port ?? 7420);
const logDir = join(dataDir, "logs");
mkdirSync(logDir, { recursive: true });
const hubLog = join(logDir, "hub.log");
const supLog = join(logDir, "supervisor.log");

const stamp = () => new Date().toLocaleString("sv-SE");
function log(m) {
  const line = `${stamp()} [supervisor] ${m}\n`;
  appendFileSync(supLog, line);
  appendFileSync(hubLog, line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** кто-то уже слушает порт хаба (хаб, запущенный руками) — ждём, а не падаем на bind */
const portBusy = () =>
  new Promise((res) => {
    const s = connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    s.setTimeout(2000, () => (s.destroy(), res(false)));
  });

let stopping = false;
let hub;
const stop = () => {
  if (stopping) return;
  stopping = true;
  log("stop requested");
  if (hub && hub.exitCode === null) hub.kill("SIGTERM");
  else process.exit(0);
  // хаб сам страхуется 10 с; не ушёл за 20 — добиваем
  setTimeout(() => hub?.kill("SIGKILL"), 20_000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

function applyUpdate(mode) {
  let script = join(root, "scripts", "apply-update.mjs");
  // новая версия может уметь ставить себя лучше старой: её apply-update.mjs из stage, если есть
  if (mode === "apply") {
    const stage = readJson(join(dataDir, "updates", "pending.json"))?.stage;
    if (stage && existsSync(join(stage, "scripts", "apply-update.mjs"))) script = join(stage, "scripts", "apply-update.mjs");
  }
  const r = spawnSync(process.execPath, [script, mode, "--root", root, "--data", dataDir], { encoding: "utf8", env: process.env });
  for (const l of `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n")) if (l.trim()) log(l);
  return r.status === 0;
}

log(`started (node ${process.version}, pid ${process.pid}, port ${port})`);
let fast = 0;
while (!stopping) {
  for (let waited = 0; await portBusy(); waited += 5) {
    if (stopping) process.exit(0);
    if (waited % 60 === 0) log(`port ${port} is busy, waiting`);
    await sleep(5000);
  }
  if (existsSync(hubLog) && statSync(hubLog).size > 10 << 20) renameSync(hubLog, `${hubLog}.1`);

  let justUpdated = false;
  if (existsSync(join(dataDir, "updates", "pending.json"))) {
    log("installing update");
    justUpdated = applyUpdate("apply");
    log(justUpdated ? "update installed" : "update failed, the previous version is back");
  }

  log("starting hub");
  const started = Date.now();
  const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const out = appendFileSync.bind(null, hubLog);
  hub = spawn(process.execPath, [tsx, "src/main.ts"], { cwd: join(root, "apps", "hub"), env: { ...process.env, KAMHARN_SUPERVISED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.on("data", out);
  hub.stderr.on("data", out);
  const code = await new Promise((res) => {
    hub.once("error", (e) => (log(`can't start the hub: ${e.message}`), res(1)));
    hub.once("exit", (c, sig) => res(c ?? (sig ? 128 : 1)));
  });
  const ran = (Date.now() - started) / 1000;
  log(`hub exited with code ${code} after ${Math.round(ran)} s`);
  if (stopping) break;
  if (justUpdated && code !== RESTART && ran < 90) {
    log("the new version exited right after start, rolling back");
    applyUpdate("rollback");
  }
  let pause = 1;
  if (code === RESTART || ran > 30) fast = 0;
  else {
    fast++;
    pause = Math.min(60, 2 ** fast);
    log(`crashed quickly ${fast} time(s) in a row, next start in ${pause} s`);
  }
  await sleep(pause * 1000);
}
log("supervisor exits");
process.exit(0);

