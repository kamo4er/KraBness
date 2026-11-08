// CI: the hub's unit tests file by file, each with its own time limit. node --test waits for a file's process
// to exit, so a file that keeps a handle open hangs the whole job without saying which one; here it is named.
//   node scripts/ci/test-files.mjs [--parallel 3] [--timeout 240]
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const PARALLEL = arg("parallel", 3);
const TIMEOUT = arg("timeout", 240) * 1000;
const hub = resolve(import.meta.dirname, "..", "..", "apps", "hub");
const files = readdirSync(join(hub, "test", "unit")).filter((f) => f.endsWith(".test.ts")).sort();

const results = [];
async function run(file) {
  const t0 = Date.now();
  const p = spawn(process.execPath, ["--env-file=test/unit/test.env", "--import", "tsx", "--test", "--test-timeout=120000", `test/unit/${file}`], { cwd: hub, env: process.env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, TIMEOUT);
  const code = await new Promise((r) => p.on("exit", (c) => r(c)));
  clearTimeout(timer);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const status = timedOut ? "HUNG" : code === 0 ? "ok" : "FAIL";
  results.push({ file, status, sec, out });
  console.log(`${status.padEnd(4)} ${file} (${sec} s)`);
  if (status !== "ok") console.log(out.split("\n").slice(-80).join("\n").replace(/^/gm, "    | "));
}

const queue = [...files];
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (queue.length) await run(queue.shift());
}));
const bad = results.filter((r) => r.status !== "ok");
console.log(`\n${files.length - bad.length}/${files.length} files ok${bad.length ? `; not ok: ${bad.map((b) => `${b.file} (${b.status})`).join(", ")}` : ""}`);
process.exit(bad.length ? 1 : 0);
