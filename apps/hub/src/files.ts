// Файлы: входящие (телефон → папка сессии/.kamharn/inbox) и исходящие (агент → пользователь).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { ConfigStore } from "./config.ts";
import type { Db, FileRow } from "./db.ts";
import { L } from "./lang.ts";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** маркер в выводе send_file_to_user, по нему хаб прикрепляет файл к сообщению */
export const FILE_MARKER = "kamharn-file:";

const MIME: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".log": "text/plain",
  ".html": "text/html", ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
  ".pdf": "application/pdf", ".zip": "application/zip", ".7z": "application/x-7z-compressed",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".heic": "image/heic", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".apk": "application/vnd.android.package-archive",
};

export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (base || "file").slice(0, 120);
}

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
}

export class FileStore {
  constructor(private db: Db, private config: ConfigStore) {}

  get(id: string): FileRow | undefined {
    return this.db.getFile(id);
  }

  /** Агент отдаёт файл пользователю. Путь обязан быть внутри разрешённых папок. */
  async registerOutgoing(path: string, sessionId: string | null): Promise<FileRow> {
    const real = this.config.resolveAllowed(path);
    const st = statSync(real);
    if (!st.isFile()) throw new Error(`${L("Это не файл", "Not a file")}: ${path}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(L(`Файл больше ${MAX_FILE_BYTES / 1024 / 1024} МБ`, `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`));
    const name = basename(real);
    const row: FileRow = {
      id: "kf_" + randomUUID().replace(/-/g, "").slice(0, 16),
      sessionId,
      direction: "out",
      name,
      mime: mimeOf(name),
      size: st.size,
      path: real,
      sha256: await sha256File(real),
      createdAt: Date.now(),
    };
    this.db.insertFile(row);
    return row;
  }

  /** Пользователь прислал файл в сессию: сохраняем в <папка сессии>/.kamharn/inbox. */
  async saveIncoming(sessionId: string, directory: string, name: string, body: Readable, mime?: string): Promise<FileRow> {
    const inbox = join(directory, ".kamharn", "inbox");
    mkdirSync(inbox, { recursive: true });
    const gi = join(directory, ".kamharn", ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
    const clean = safeName(name);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const path = join(inbox, `${stamp}-${clean}`);
    const h = createHash("sha256");
    let size = 0;
    const out = createWriteStream(path);
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      h.update(chunk);
      if (size > MAX_FILE_BYTES) body.destroy(new Error(L("Файл слишком большой", "The file is too large")));
    });
    await pipeline(body, out);
    const row: FileRow = {
      id: "kf_" + randomUUID().replace(/-/g, "").slice(0, 16),
      sessionId,
      direction: "in",
      name: clean,
      mime: mime && mime !== "application/octet-stream" ? mime : mimeOf(clean),
      size,
      path,
      sha256: h.digest("hex"),
      createdAt: Date.now(),
    };
    this.db.insertFile(row);
    return row;
  }

  byPath(path: string): FileRow | undefined {
    return this.db.fileByPath(path);
  }
}
