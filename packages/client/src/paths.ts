// Пути к файлам в ответах агента (`apps/hub/src/x.ts:42`, `C:\proj\README.md`, ссылки [x](docs/a.md)):
// по ним в чате можно кликнуть и открыть файл в просмотре проекта. Относительные — от папки сессии.

export interface FileRef {
  /** как написано, без :строки */
  path: string;
  line?: number;
  /** оканчивается на / — это папка */
  dir?: boolean;
}

const WIN_ABS = /^[A-Za-z]:[\\/]/;
// :42, :42-50, :42:7 в конце
const LINE = /:(\d+)(?:[-:]\d+)?$/;

/**
 * Похоже ли содержимое `кода` на путь к файлу. Нужен разделитель (иначе `npm`, `node.exe` стали бы ссылками)
 * и расширение у последней части; без расширения — только папка со слешем на конце.
 * `/api/...` (маршруты), `~/...`, URL и команды с пробелами — не пути.
 */
export function parseFileRef(raw: string): FileRef | undefined {
  let s = raw.trim();
  if (!s || s.length > 400 || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return undefined;
  const abs = WIN_ABS.test(s);
  // пробелы бывают только в абсолютных путях Windows (Program Files)
  if (!abs && /\s/.test(s)) return undefined;
  if (/[*?"<>|`$(){}=,;]/.test(s) || s.startsWith("~") || s.startsWith("-")) return undefined;
  let line: number | undefined;
  const m = LINE.exec(s);
  if (m) {
    line = Number(m[1]);
    s = s.slice(0, m.index);
  }
  if (!abs && (s.startsWith("/") || s.startsWith("\\"))) return undefined;
  if (!/[\\/]/.test(s)) return undefined;
  const dir = /[\\/]$/.test(s);
  const last = s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (!last || last === "." || last === "..") return undefined;
  if (!dir && !/\.[A-Za-z0-9_-]{1,10}$/.test(last)) return undefined;
  if (dir && line) return undefined;
  return { path: s, ...(line ? { line } : {}), ...(dir ? { dir } : {}) };
}

/** Абсолютный путь: относительный склеиваем с папкой сессии её же разделителем. */
export function resolveFileRef(ref: FileRef, directory: string): string {
  const p = ref.path.replace(/[\\/]+$/, "");
  if (WIN_ABS.test(p) || p.startsWith("/")) return p;
  const win = directory.includes("\\") || WIN_ABS.test(directory);
  const sep = win ? "\\" : "/";
  const rel = p.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);
  return directory.replace(/[\\/]+$/, "") + sep + rel;
}
