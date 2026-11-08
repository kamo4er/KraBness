// CI on a Mac: "Update" from the UI end to end — a fake GitHub, signed release zips, the supervisor installs,
// and a release that crashes on start is rolled back.
//   node scripts/ci/mac-update.mjs prepare <out>             before install.sh: test key, base/new/crashing zips
//   node scripts/ci/mac-update.mjs run <out> <install dir>  after install.sh: update to the new one, then to the crashing one
// The real signing key never leaves the author's PC: here a throwaway key replaces RELEASE_KEY in the test copies.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

const [mode, outArg, installArg] = process.argv.slice(2);
const out = resolve(outArg ?? "e2e");
const root = resolve(import.meta.dirname, "..", "..");
const NEW = "99.0.0";
const CRASH = "99.0.1";

function prepare() {
  mkdirSync(out, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const base = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  for (const [version, crash] of [[base, false], [NEW, false], [CRASH, true]]) {
    const dir = join(out, `v${version}`);
    rmSync(dir, { recursive: true, force: true });
    for (const f of files) {
      if (!existsSync(join(root, f))) continue;
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(root, f), join(dir, f));
    }
    const upd = join(dir, "apps", "hub", "src", "updates.ts");
    const src = readFileSync(upd, "utf8");
    if (!/export const RELEASE_KEY = "[^"]+";/.test(src)) throw new Error("RELEASE_KEY not found in updates.ts");
    writeFileSync(upd, src.replace(/export const RELEASE_KEY = "[^"]+";/, `export const RELEASE_KEY = "${pub}";`));
    const pkgFile = join(dir, "package.json");
    writeFileSync(pkgFile, JSON.stringify({ ...JSON.parse(readFileSync(pkgFile, "utf8")), version }, null, 2) + "\n");
    writeFileSync(join(dir, "release.json"), JSON.stringify({ version, versionCode: 1 }) + "\n");
    if (crash) {
      const main = join(dir, "apps", "hub", "src", "main.ts");
      writeFileSync(main, 'throw new Error("ci: this version crashes on start");\n' + readFileSync(main, "utf8"));
    }
    const zip = join(out, `krabness-${version}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-qr", zip, "."], { cwd: dir });
    writeFileSync(`${zip}.sig`, sign(null, readFileSync(zip), privateKey).toString("base64") + "\n");
    rmSync(dir, { recursive: true, force: true });
    console.log(`zip ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
  }
  writeFileSync(join(out, "base.txt"), base);
}

async function run() {
  const dir = resolve(installArg);
  const hub = "http://127.0.0.1:7420";
  let latest = NEW;
  // a fake api.github.com: the latest release and its two assets (zip and signature)
  const gh = createServer((req, res) => {
    const zip = join(out, `krabness-${latest}.zip`);
    if (req.url.endsWith("/releases/latest")) {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          tag_name: `v${latest}`,
          html_url: `https://github.com/kamo4er/KraBness/releases/tag/v${latest}`,
          body: `## English\n- ci release ${latest}\n\n## Русский\n- проверочный выпуск ${latest}`,
          assets: [
            { id: 1, name: `krabness-${latest}.zip`, size: statSync(zip).size },
            { id: 2, name: `krabness-${latest}.zip.sig`, size: statSync(`${zip}.sig`).size },
          ],
        }),
      );
    }
    if (req.url.endsWith("/assets/1")) return res.end(readFileSync(zip));
    if (req.url.endsWith("/assets/2")) return res.end(readFileSync(`${zip}.sig`));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => gh.listen(7471, "127.0.0.1", r));

  const api = async (method, path) => {
    const r = await fetch(hub + path, { method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const version = async () => (await api("GET", "/api/hub").catch(() => ({}))).version;
  const waitVersion = async (want, sec) => {
    for (let i = 0; i < sec; i++) {
      if ((await version()) === want) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };
  let pass = 0;
  const check = (ok, what) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) process.exit(1);
    pass++;
  };

  // the installed hub looks for releases on the fake GitHub
  const cfgFile = join(dir, "config", "kamharn.json");
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
  mkdirSync(dirname(cfgFile), { recursive: true });
  writeFileSync(cfgFile, JSON.stringify({ ...cfg, updates: { ...cfg.updates, api: "http://127.0.0.1:7471" } }, null, 2));
  execFileSync(join(dir, "scripts", "krabness"), ["restart"], { stdio: "inherit" });
  const base = readFileSync(join(out, "base.txt"), "utf8").trim();
  check(await waitVersion(base, 90), `hub ${base} is back with the fake GitHub`);

  let st = await api("POST", "/api/update/check");
  check(st.latest?.version === NEW && st.canInstall === true, `sees ${NEW}, can install (reason: ${st.reason ?? "-"})`);
  await api("POST", "/api/update/install");
  check(await waitVersion(NEW, 600), `updated to ${NEW} (npm ci and the web build ran under the supervisor)`);
  check(existsSync(join(dir, "runtime", "node", "bin", "node")), "own Node survived the update");

  latest = CRASH;
  st = await api("POST", "/api/update/check");
  check(st.latest?.version === CRASH, `sees ${CRASH}`);
  await api("POST", "/api/update/install");
  // the crashing version exits at once, the supervisor rolls back to the previous one
  await new Promise((r) => setTimeout(r, 20_000));
  check(await waitVersion(NEW, 900), `the crashing ${CRASH} was rolled back to ${NEW}`);
  const result = JSON.parse(readFileSync(join(dir, "data", "updates", "result.json"), "utf8"));
  check(result.rolledBack === NEW, `result.json says rolled back: ${JSON.stringify(result)}`);
  console.log(`${pass} update checks passed`);
  gh.close();
  process.exit(0);
}

if (mode === "prepare") prepare();
else if (mode === "run") await run();
else {
  console.log("usage: mac-update.mjs prepare <out> | run <out> <install dir>");
  process.exit(2);
}
