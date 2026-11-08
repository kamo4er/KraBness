// Публикует собранный release APK для обновления из приложения: <dataDir>/apk/KraBness-<версия>.apk + latest.json.
// Хаб отдаёт его на /api/app/latest и /api/app/apk. Запуск: npm run release (сборка + публикация).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(mobile, "../..");
const { expo } = JSON.parse(readFileSync(join(mobile, "app.json"), "utf8"));
const apk = join(mobile, "android/app/build/outputs/apk/release/app-release.apk");
if (!existsSync(apk)) throw new Error(`нет ${apk} — сначала npm run apk`);

// dataDir — как у хаба: из config/kamharn.json, по умолчанию <repo>/data
let dataDir = join(repo, "data");
try {
  dataDir = JSON.parse(readFileSync(join(repo, "config/kamharn.json"), "utf8")).dataDir ?? dataDir;
} catch {
  /* конфига нет */
}
const out = join(dataDir, "apk");
mkdirSync(out, { recursive: true });

const file = `KraBness-${expo.version}.apk`;
copyFileSync(apk, join(out, file));
const release = {
  version: expo.version,
  versionCode: expo.android.versionCode,
  file,
  size: statSync(join(out, file)).size,
  sha256: createHash("sha256").update(readFileSync(join(out, file))).digest("hex"),
  builtAt: statSync(apk).mtimeMs,
};
writeFileSync(join(out, "latest.json"), JSON.stringify(release, null, 2));
// старые сборки не копим
for (const f of readdirSync(out)) if (f.endsWith(".apk") && f !== file) rmSync(join(out, f));
console.log(`опубликовано: ${file} (versionCode ${release.versionCode}, ${(release.size / 1048576).toFixed(1)} МБ) → ${out}`);
