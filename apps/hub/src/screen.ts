// Снимок экрана ПК (все мониторы) — посмотреть с телефона, что там происходит.
// Через ffmpeg (gdigrab): самодельный снимок на PowerShell Defender блокирует как шпионский (AMSI), и это правильно.
// JPEG: PNG рабочего стола весит мегабайты.
import { execFile } from "node:child_process";
import { L } from "./lang.ts";

/** JPEG всех мониторов. Хаб должен работать в сессии пользователя (иначе снимок чёрный). */
export function captureScreen(ffmpeg = "ffmpeg"): Promise<Buffer> {
  if (process.platform !== "win32") return Promise.reject(new Error(L("Снимок экрана есть только на Windows", "Screenshots are only available on Windows")));
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
