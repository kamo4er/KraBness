// Файлы: загрузка вложений в сессию, скачивание файлов от агента в кэш, открыть/поделиться/сохранить.
import { Directory, File, Paths, UploadType } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { ApiError, type SkillInfo, type UploadedFile, t } from "@kamharn/client";
import { client } from "./store.ts";

export interface Picked {
  uri: string;
  name: string;
  mime: string;
  size: number;
}

const safeName = (n: string) => n.replace(/[\\/:*?"<>|]/g, "_") || "file";

// ---------- выбор ----------

/** Имя без расширения (бывает у content://) — добавляем по mime, чтобы агент понял тип файла. */
function withExt(name: string, mime: string): string {
  if (/\.[a-z0-9]{1,6}$/i.test(name)) return name;
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf", "text/plain": "txt", "video/mp4": "mp4" }[mime];
  return ext ? `${name}.${ext}` : name;
}

export async function pickFiles(): Promise<Picked[]> {
  // document-picker отдаёт настоящее имя файла (DISPLAY_NAME), File.pickFileAsync — только id документа
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
  if (r.canceled) return [];
  return r.assets.map((a) => {
    const mime = a.mimeType || "application/octet-stream";
    return { uri: a.uri, name: withExt(a.name, mime), mime, size: a.size ?? new File(a.uri).size };
  });
}

function fromAssets(r: ImagePicker.ImagePickerResult): Picked[] {
  if (r.canceled) return [];
  return r.assets.map((a, i) => {
    const mime = a.mimeType || "image/jpeg";
    return {
      uri: a.uri,
      name: withExt(a.fileName || `photo-${Date.now()}-${i}`, mime),
      mime,
      size: a.fileSize ?? new File(a.uri).size,
    };
  });
}

export async function takePhoto(): Promise<Picked[]> {
  const p = await ImagePicker.requestCameraPermissionsAsync();
  if (!p.granted) throw new Error(t("Нет доступа к камере", "No camera access"));
  return fromAssets(await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 }));
}

export async function pickPhotos(): Promise<Picked[]> {
  return fromAssets(await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], allowsMultipleSelection: true, quality: 0.85 }));
}

// ---------- загрузка в сессию ----------

export async function upload(sessionId: string, f: Picked): Promise<UploadedFile> {
  const c = client!;
  const r = await new File(f.uri).upload(`${c.baseUrl}/api/sessions/${sessionId}/files?name=${encodeURIComponent(f.name)}`, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "content-type": f.mime, ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
  });
  let j: { error?: string } & Partial<UploadedFile> = {};
  try {
    j = JSON.parse(r.body);
  } catch {
    /* не JSON */
  }
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`);
  return j as UploadedFile;
}

/** Скилл с телефона: SKILL.md или zip → ~/.claude/skills на ПК. 409 — такой уже есть (повторить с overwrite). */
export async function uploadSkill(f: Picked, overwrite = false): Promise<SkillInfo> {
  const c = client!;
  const r = await new File(f.uri).upload(`${c.baseUrl}/api/skills/upload?name=${encodeURIComponent(f.name)}${overwrite ? "&overwrite=1" : ""}`, {
    httpMethod: "POST",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "content-type": "application/octet-stream", ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) },
  });
  let j: { error?: string } & Partial<SkillInfo> = {};
  try {
    j = JSON.parse(r.body);
  } catch {
    /* не JSON */
  }
  if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, j.error ?? `HTTP ${r.status}`);
  return j as SkillInfo;
}

/** Один файл (для скилла): SKILL.md или zip. */
export async function pickOne(): Promise<Picked | undefined> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
  if (r.canceled || !r.assets[0]) return undefined;
  const a = r.assets[0];
  return { uri: a.uri, name: a.name, mime: a.mimeType || "application/octet-stream", size: a.size ?? new File(a.uri).size };
}

// ---------- файлы от агента ----------

export interface FileRef {
  fileId: string;
  name: string;
  mime: string;
  size: number;
}

export type Progress = (fraction: number) => void;

/**
 * Скачивает url в dir/name. Готовым считается только файл ожидаемого размера:
 * качаем во временный .part (нативная загрузка при обрыве оставляет обрывок) и переименовываем.
 */
export async function download(url: string, dir: Directory, fileName: string, size: number, onProgress?: Progress): Promise<File> {
  const name = safeName(fileName);
  const done = new File(dir, name);
  if (done.exists && done.size === size) return done;
  if (!dir.exists) dir.create({ intermediates: true });
  if (done.exists) done.delete();

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const part = new File(dir, name + ".part");
    if (part.exists) part.delete();
    const task = File.createDownloadTask(url, part);
    const sub = onProgress && task.addListener("progress", (p) => onProgress(size ? p.bytesWritten / size : 0));
    try {
      await task.downloadAsync();
      const got = new File(dir, name + ".part");
      if (got.size === size) {
        await got.move(done);
        return new File(dir, name);
      }
      lastError = t(`скачалось ${got.size} из ${size} байт`, `downloaded ${got.size} of ${size} bytes`);
    } catch (e) {
      lastError = (e as Error).message;
    } finally {
      sub?.remove();
      task.release();
    }
  }
  throw new Error(`${t("Файл не скачался (связь обрывается)", "The file didn't download (connection drops)")}: ${lastError}`);
}

/** Снимок экрана ПК: скачать свежий и открыть в системном просмотрщике (там есть зум). */
export async function openScreen(): Promise<void> {
  const f = new File(Paths.cache, "kamharn-screen.jpg");
  if (f.exists) f.delete();
  const task = File.createDownloadTask(client!.screenUrl(), f);
  try {
    await task.downloadAsync();
  } finally {
    task.release();
  }
  const got = new File(Paths.cache, "kamharn-screen.jpg");
  // хаб при ошибке отвечает JSON, а не картинкой
  if (!got.exists || got.size < 1000) throw new Error(t("Снимок не получился (хаб без доступа к экрану или нет ffmpeg)", "Couldn't take a screenshot (no screen access for the hub or no ffmpeg)"));
  await got.preview({ mimeType: "image/jpeg", title: t("Экран ПК", "PC screen") });
}

/** Файл хаба в кэше (скачивается один раз). */
export function fetchFile(ref: FileRef, onProgress?: Progress): Promise<File> {
  return download(client!.fileUrl(ref.fileId), new Directory(Paths.cache, "kamharn", ref.fileId), ref.name, ref.size, onProgress);
}

export async function openFile(ref: FileRef, onProgress?: Progress): Promise<void> {
  const f = await fetchFile(ref, onProgress);
  if (!(await f.canPreview({ mimeType: ref.mime }))) throw new Error(t("Нет приложения, которое умеет открывать такой файл. Попробуй «Поделиться».", "No app can open this file. Try “Share”."));
  await f.preview({ mimeType: ref.mime, title: ref.name });
}

export async function shareFile(ref: FileRef, onProgress?: Progress): Promise<void> {
  const f = await fetchFile(ref, onProgress);
  await Sharing.shareAsync(f.uri, { mimeType: ref.mime, dialogTitle: ref.name });
}

/** Сохранить в папку, выбранную пользователем (Загрузки и т.п.). false — выбор отменён. */
export async function saveFile(ref: FileRef, onProgress?: Progress): Promise<boolean> {
  const f = await fetchFile(ref, onProgress);
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return false;
  }
  const out = dir.createFile(safeName(ref.name), ref.mime);
  // кусками: большой файл целиком в память JS не тащим
  const h = f.open();
  try {
    for (;;) {
      const chunk = await h.readBytes(1024 * 1024);
      if (!chunk.length) break;
      await out.write(chunk, { append: true });
    }
  } finally {
    h.close();
  }
  return true;
}

/** Картинка из кэша для превью в чате (uri) — скачивается при первом показе. */
export async function imageUri(ref: FileRef): Promise<string> {
  return (await fetchFile(ref)).uri;
}
