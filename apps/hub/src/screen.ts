// Снимок экрана ПК (все мониторы) — посмотреть с телефона, что там происходит.
// Windows: ffmpeg (gdigrab) — самодельный снимок на PowerShell Defender блокирует как шпионский (AMSI), и это правильно.
// macOS: встроенный screencapture; без разрешения «Запись экрана» он отдаёт только обои, поэтому подсказка про него.
// JPEG: PNG рабочего стола весит мегабайты.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { L } from "./lang.ts";

/** JPEG всех мониторов. Хаб должен работать в сессии пользователя (иначе снимок чёрный). */
export function captureScreen(ffmpeg = "ffmpeg"): Promise<Buffer> {
  if (process.platform === "darwin") return captureMac();
  if (process.platform !== "win32") return Promise.reject(new Error(L("Снимок экрана есть только на Windows и macOS", "Screenshots are only available on Windows and macOS")));
  return new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-f", "gdigrab", "-i", "desktop", "-frames:v", "1", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", "pipe:1"],
      { windowsHide: true, timeout: 20_000, encoding: "buffer", maxBuffer: 64 << 20 },
      (err, out, stderr) => {
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return reject(new Error(L("Для снимка экрана нужен ffmpeg: winget install Gyan.FFmpeg", "Screenshots need ffmpeg: winget install Gyan.FFmpeg")));
        if (err || !out.length) return reject(new Error(`${L("Снимок не получился", "Screenshot failed")}: ${stderr.toString().trim().split("\n")[0] || err?.message}`));
        resolve(out);
      },
    );
  });
}

const PERMISSION = () =>
  L(
    "Разреши запись экрана: Системные настройки → Конфиденциальность и безопасность → Запись экрана (и звука) → включи node или Терминал, потом перезапусти KraBness",
    "Allow screen recording: System Settings → Privacy & Security → Screen (& System Audio) Recording → turn on node or Terminal, then restart KraBness",
  );

/** screencapture пишет только в файл; несколько мониторов — один файл на монитор, берём главный (первый) */
function captureMac(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "krabness-screen-"));
  const file = join(dir, "screen.jpg");
  return new Promise<Buffer>((resolve, reject) => {
    // -x без звука затвора, -m только главный монитор, -t jpg
    execFile("screencapture", ["-x", "-m", "-t", "jpg", file], { timeout: 20_000 }, (err, _out, stderr) => {
      let buf: Buffer | undefined;
      try {
        buf = readFileSync(file);
      } catch {
        /* файла нет */
      }
      if (buf?.length) return resolve(buf);
      const why = String(stderr ?? "").trim() || err?.message || "";
      // без разрешения screencapture молчит или говорит «could not create image from display»
      reject(new Error(`${L("Снимок не получился", "Screenshot failed")}${why ? `: ${why}` : ""}. ${PERMISSION()}`));
    });
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}
