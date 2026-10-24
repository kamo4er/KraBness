// Просмотр проекта без агента: чтение файлов и git-изменения в папке сессии (бесплатно по лимитам).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { FileView, GitInfo } from "@kamharn/protocol";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".apk": "application/vnd.android.package-archive",
  ".zip": "application/zip",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Текст файла (до max байт) или пометка, что файл двоичный. */
export function readFileView(path: string, max = 512 * 1024): FileView {
  const size = statSync(path).size;
  const mime = mimeOf(path);
  const len = Math.min(size, max);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  // двоичный: картинки/архивы по расширению или нулевой байт в начале
  if (mime.startsWith("image/") || /pdf|zip|archive/.test(mime) || buf.subarray(0, 8192).includes(0)) {
    return { path, size, mime, binary: true };
  }
  const whole = size <= max;
  return { path, size, mime, text: buf.toString("utf8"), truncated: !whole, ...(whole ? { sha256: sha(buf) } : {}) };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Правка текстового файла руками. base — sha256 того, что открыли: если файл с тех пор поменялся
 * (например, агент поправил), не затираем — 409. Переводы строк остаются как были (CRLF/LF), иначе git покажет весь файл.
 */
export function writeTextFile(path: string, text: string, base: string | undefined, max = 512 * 1024): FileView {
  const cur = readFileSync(path);
  const view = readFileView(path, max);
  if (view.binary) throw new HttpError(400, L("Двоичный файл править нельзя", "Binary files can't be edited"));
  if (view.truncated) throw new HttpError(400, L("Файл слишком большой для правки здесь (больше 512 КБ)", "The file is too large to edit here (over 512 KB)"));
  if (!base || base !== sha(cur)) throw new HttpError(409, L("Файл изменился на диске, пока ты его правил (возможно, агент). Открой заново.", "The file changed on disk while you were editing it (maybe the agent). Open it again."));
  const s = cur.toString("utf8");
  const crlf = (s.match(/\r\n/g)?.length ?? 0) > (s.match(/(?<!\r)\n/g)?.length ?? 0);
  const lf = text.replace(/\r\n/g, "\n");
  writeFileSync(path, crlf ? lf.replace(/\n/g, "\r\n") : lf);
  return readFileView(path, max);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotepath=off", ...args], { cwd, timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** Ветка, изменённые файлы и дифф относительно HEAD — только внутри папки dir. */
export async function gitInfo(dir: string, maxDiff = 400 * 1024): Promise<GitInfo> {
  let status: string;
  try {
    status = await git(dir, ["status", "--porcelain=v1", "-b", "--", "."]);
  } catch {
    return { repo: false, files: [], diff: "", truncated: false };
  }
  const lines = status.split("\n").filter(Boolean);
  const head = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  const branch = head.split("...")[0]!.replace(/^No commits yet on /, "");
  const files = lines.map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));
  let diff = "";
  try {
    diff = await git(dir, ["diff", "HEAD", "--relative", "--no-color", "--", "."]);
  } catch {
    // ещё нет коммитов — показываем то, что добавлено в индекс
    diff = await git(dir, ["diff", "--cached", "--relative", "--no-color", "--", "."]).catch(() => "");
  }
  const truncated = diff.length > maxDiff;
  return { repo: true, ...(branch ? { branch } : {}), files, diff: truncated ? diff.slice(0, maxDiff) : diff, truncated };
}
