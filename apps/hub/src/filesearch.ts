// Поиск файлов и папок проекта для «@» в поле ввода.
// Список берётся из git (учитывает .gitignore, видит новые файлы), без git — обходом папок с лимитом.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileHit } from "@kamharn/protocol";
import { git } from "./worktree.ts";

/** без git это не нужно никому: зависимости, сборки, кэши */
const SKIP = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target", ".next", ".nuxt", ".expo", ".gradle", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".cache", ".turbo", ".idea", ".vs", "coverage"]);
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 10;
const TTL = 20_000;

type Entry = FileHit & { lower: string; base: string; depth: number };
const cache = new Map<string, { at: number; list: Promise<Entry[]> }>();

function entry(path: string, dir: boolean): Entry {
  const lower = path.toLowerCase();
  return { path, ...(dir ? { dir: true } : {}), lower, base: lower.slice(lower.lastIndexOf("/") + 1), depth: path.split("/").length - 1 };
}

async function fromGit(dir: string): Promise<Entry[]> {
  // -z: имена как есть (без \ooo для кириллицы); -co: отслеживаемые и новые, --exclude-standard: без игнорируемых
  const out = await git(dir, ["-c", "core.quotepath=off", "ls-files", "-z", "-co", "--exclude-standard"]);
  const files = out.split("\0").filter(Boolean).slice(0, MAX_ENTRIES);
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  return [...[...dirs].map((d) => entry(d, true)), ...files.map((f) => entry(f, false))];
}

/** обход в ширину: при лимите верхние уровни уже есть */
async function walk(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let level = [""];
  for (let depth = 0; depth <= MAX_DEPTH && level.length && out.length < MAX_ENTRIES; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      const items = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
      for (const it of items) {
        if (out.length >= MAX_ENTRIES) break;
        const path = rel ? `${rel}/${it.name}` : it.name;
        if (it.isDirectory()) {
          if (SKIP.has(it.name) || it.name.endsWith(".worktrees")) continue;
          out.push(entry(path, true));
          next.push(path);
        } else if (it.isFile()) out.push(entry(path, false));
      }
    }
    level = next;
  }
  return out;
}

function list(dir: string): Promise<Entry[]> {
  const c = cache.get(dir);
  if (c && Date.now() - c.at < TTL) return c.list;
  const p = fromGit(dir).catch(() => walk(dir));
  cache.set(dir, { at: Date.now(), list: p });
  p.catch(() => cache.delete(dir));
  return p;
}

/** Насколько имя подходит к запросу; 0 — не подходит. */
function nameScore(e: Entry, q: string): number {
  if (!q) return 1;
  if (e.base === q) return 100;
  if (e.base.startsWith(q)) return 80;
  if (e.base.includes(q)) return 60;
  if (e.lower.includes(q)) return 40;
  // буквы по порядку: «sbt» → «sessionbot.ts»; в имени ценнее, чем по всему пути
  return subseq(e.base, q) ? 30 : subseq(e.lower, q) ? 10 : 0;
}

function subseq(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

/**
 * Файлы и папки под запрос. Пустой — верхний уровень. «src/» — содержимое src, «src/ses» — ищем внутри src.
 * Пути относительно папки сессии, через «/».
 */
export async function searchFiles(dir: string, query: string, limit = 50): Promise<FileHit[]> {
  const q = query.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
  const all = await list(dir);
  const slash = q.lastIndexOf("/");
  const prefix = slash >= 0 ? q.slice(0, slash + 1) : "";
  const name = q.slice(slash + 1);
  const baseDepth = prefix ? prefix.split("/").length - 1 : 0;
  const scored: Array<{ e: Entry; s: number }> = [];
  for (const e of all) {
    if (prefix && !e.lower.startsWith(prefix)) continue;
    // без запроса — только ближайший уровень, иначе первыми шли бы случайные глубокие файлы
    if (!name && e.depth !== baseDepth) continue;
    const s = nameScore(e, prefix ? name : q);
    if (!s) continue;
    // без имени — как в проводнике: папки, потом файлы, по алфавиту;
    // с именем — ближе к папке и короче выше, папки чуть выше файлов с тем же счётом
    scored.push({ e, s: name ? s - (e.depth - baseDepth) * 2 + (e.dir ? 0.5 : 0) - e.path.length / 1000 : e.dir ? 1 : 0 });
  }
  // по коду символа, а не localeCompare: порядок одинаковый на любой машине
  scored.sort((a, b) => b.s - a.s || (a.e.lower < b.e.lower ? -1 : a.e.lower > b.e.lower ? 1 : 0));
  return scored.slice(0, limit).map(({ e }) => ({ path: e.path, ...(e.dir ? { dir: true } : {}) }));
}

/** для тестов: сбросить кэш списков */
export function clearFileSearchCache(): void {
  cache.clear();
}
