// Ветка на сессию (git worktree): агент работает в своей копии проекта и не мешает другим сессиям в том же репозитории.
// Копия лежит рядом с проектом (Projects\DemoGame.worktrees\<имя>), ветка kamharn/<имя>.
// «Влить» — squash одним коммитом в основную ветку; после этого копия сбрасывается на основную ветку,
// и сессия может работать дальше (Claude привязывает историю к папке — удалять копию нельзя).
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeInfo, WorktreeStatus } from "@kamharn/protocol";
import { L } from "./lang.ts";

export class GitError extends Error {}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out, stderr) => {
      if (err) return rej(new GitError((stderr || err.message).trim().split("\n").slice(0, 6).join("\n")));
      res(out);
    });
  });
}

const RU: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };

/** «Детская игра: кнопки» → «detskaya-igra-knopki» (для имени ветки и папки) */
export function slugify(s: string): string {
  return [...s.toLowerCase()]
    .map((c) => RU[c] ?? c)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
}

/** Новая копия проекта для сессии. directory — папка сессии (может быть подпапкой репозитория). */
export async function createWorktree(directory: string, title: string, sessionId: string): Promise<{ worktree: WorktreeInfo; directory: string }> {
  let top: string;
  try {
    top = resolve((await git(directory, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new GitError(L("Папка не в git-репозитории — отдельная ветка невозможна", "The folder isn't a git repository — a separate branch isn't possible"));
  }
  const base = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (!base || base === "HEAD") throw new GitError(L("В репозитории нет коммитов или HEAD отсоединён — нужна обычная ветка", "The repository has no commits or HEAD is detached — a regular branch is needed"));
  const name = `${slugify(title) || "session"}-${sessionId.slice(-6)}`;
  const branch = `kamharn/${name}`;
  const path = join(dirname(top), `${basename(top)}.worktrees`, name);
  await git(top, ["worktree", "add", "-b", branch, path, base]);
  // без зависимостей в копии не идут ни тесты, ни tsc; не вышло — агент разберётся сам
  await linkDeps(top, path).catch(() => {});
  return { worktree: { repo: top, path, branch, base }, directory: join(path, relative(top, resolve(directory))) };
}

/** Метка в node_modules копии: эту папку собрали мы, внутри только ссылки. */
const LINKED = ".krabness-linked";

/** Папки node_modules проекта (корень и подпроекты до 3 уровней), пути относительно корня. */
function depDirs(top: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(join(top, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules") out.push(join(rel, e.name));
      else if (depth < 3 && !e.name.startsWith(".")) walk(join(rel, e.name), depth + 1);
    }
  };
  walk("", 0);
  return out;
}

const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return !!r && !r.startsWith("..") && !isAbsolute(r);
};

/**
 * Подключить node_modules основного проекта в копию — ссылками по одному пакету.
 * Не одной ссылкой на всю папку: пакеты рабочей области (npm workspaces) — ссылки внутрь основного
 * проекта, и копия проверялась бы на чужом коде. Их ведём на те же папки внутри копии.
 */
export async function linkDeps(top: string, path: string): Promise<number> {
  const kind = process.platform === "win32" ? "junction" : "dir";
  let linked = 0;
  for (const rel of depDirs(top)) {
    const dst = join(path, rel);
    // подпроект есть в копии (он в git), своих зависимостей там нет, и git их не видит (.gitignore)
    if (!existsSync(dirname(dst)) || existsSync(dst)) continue;
    // слеш на конце: папки ещё нет, и без него git не знает, что это папка (правило «node_modules/»)
    if (!(await git(path, ["check-ignore", "-q", rel.split(sep).join("/") + "/"]).then(() => true, () => false))) continue;
    mkdirSync(dst);
    writeFileSync(join(dst, LINKED), "");
    const link = (src: string, to: string) => {
      let target = src;
      try {
        if (lstatSync(src).isSymbolicLink()) {
          const real = realpathSync(src);
          target = real;
          // пакет рабочей области → его копия рядом
          if (inside(real, top) && !real.split(sep).includes("node_modules")) {
            const own = join(path, relative(top, real));
            if (existsSync(own)) target = own;
          }
        } else if (!lstatSync(src).isDirectory()) return; // служебные файлы npm не нужны
        symlinkSync(target, to, kind);
        linked++;
      } catch {
        /* битая ссылка в основном проекте — пропускаем */
      }
    };
    for (const e of readdirSync(join(top, rel), { withFileTypes: true })) {
      const src = join(top, rel, e.name);
      if (e.name.startsWith("@") && e.isDirectory()) {
        mkdirSync(join(dst, e.name));
        for (const p of readdirSync(src)) link(join(src, p), join(dst, e.name, p));
      } else link(src, join(dst, e.name));
    }
  }
  return linked;
}

/** Есть ли в копии зависимости, подключённые нами. */
export function hasLinkedDeps(path: string): boolean {
  return depDirs(path).some((rel) => existsSync(join(path, rel, LINKED)));
}

/** Убрать ссылки на зависимости из копии. Трогаем только папки с нашей меткой и только ссылки в них. */
export function unlinkDeps(path: string): void {
  for (const rel of depDirs(path)) {
    const dir = join(path, rel);
    if (!existsSync(join(dir, LINKED))) continue;
    const drop = (p: string) => {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) unlinkSync(p); // только ссылка, сам пакет в основном проекте остаётся
      else if (st.isDirectory() && p !== dir) {
        for (const x of readdirSync(p)) drop(join(p, x));
        rmdirSync(p);
      }
    };
    try {
      for (const x of readdirSync(dir)) if (x !== LINKED) drop(join(dir, x));
      unlinkSync(join(dir, LINKED));
      rmdirSync(dir);
    } catch {
      /* агент положил туда что-то своё — оставляем как есть */
    }
  }
}

export async function worktreeStatus(wt: WorktreeInfo): Promise<WorktreeStatus> {
  const [count, porcelain] = await Promise.all([git(wt.repo, ["rev-list", "--count", `${wt.base}..${wt.branch}`]), git(wt.path, ["status", "--porcelain"])]);
  const files = porcelain.split("\n").filter(Boolean);
  return { branch: wt.branch, base: wt.base, ahead: Number(count.trim()) || 0, dirty: files.length, files: files.slice(0, 30) };
}

/** Влить работу сессии одним коммитом в основную ветку; копия после этого совпадает с основной. */
export async function mergeWorktree(wt: WorktreeInfo, title: string): Promise<{ commit: string; files: number }> {
  if ((await git(wt.path, ["status", "--porcelain"])).trim()) {
    await git(wt.path, ["add", "-A"]);
    await git(wt.path, ["commit", "-m", L(`Работа сессии «${title}»`, `Work of session “${title}”`)]);
  }
  const subjects = (await git(wt.repo, ["log", "--format=%s", `${wt.base}..${wt.branch}`])).split("\n").filter(Boolean);
  if (!subjects.length) throw new GitError(L("Вливать нечего: в ветке сессии нет изменений", "Nothing to merge: the session branch has no changes"));
  const current = (await git(wt.repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (current !== wt.base) throw new GitError(L(`Основной проект сейчас на ветке «${current}», а вливать нужно в «${wt.base}». Переключи его обратно.`, `The main project is on branch “${current}” now, but the merge target is “${wt.base}”. Switch it back.`));
  try {
    await git(wt.repo, ["merge", "--squash", wt.branch]);
  } catch (e) {
    await git(wt.repo, ["reset", "--merge"]).catch(() => {});
    throw new GitError(
      L(
        `Не влилось — изменения пересекаются с основной веткой или с незакоммиченным в основном проекте.\nПопроси агента в этой сессии сделать «git merge ${wt.base}» и разрешить конфликты, потом нажми «Влить» снова.`,
        `Merge failed — the changes conflict with the main branch or with uncommitted work in the main project.\nAsk the agent in this session to run “git merge ${wt.base}” and resolve the conflicts, then press “Merge” again.`,
      ) + `\n\n${(e as Error).message}`,
    );
  }
  const body = L(`Сессия KraBness, ветка ${wt.branch}:\n`, `KraBness session, branch ${wt.branch}:\n`) + subjects.reverse().map((s) => `- ${s}`).join("\n");
  const files = (await git(wt.repo, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean).length;
  await git(wt.repo, ["commit", "-m", title, "-m", body]);
  const commit = (await git(wt.repo, ["rev-parse", "--short", "HEAD"])).trim();
  // ветка сессии = основная: следующий «Влить» понесёт только новое
  await git(wt.path, ["reset", "--hard", wt.base]);
  return { commit, files };
}

/** Выбросить всё, что сделано в копии после последнего вливания. */
export async function discardWorktree(wt: WorktreeInfo): Promise<void> {
  await git(wt.path, ["reset", "--hard", wt.base]);
  await git(wt.path, ["clean", "-fd"]);
}

/** Удалить копию и ветку (сессию удалили). Ошибки не важны — копию могли удалить руками. */
export async function removeWorktree(wt: WorktreeInfo): Promise<void> {
  // сначала ссылки на зависимости: git папку с ними не удаляет
  if (existsSync(wt.path)) unlinkDeps(wt.path);
  if (existsSync(wt.path)) await git(wt.repo, ["worktree", "remove", "--force", wt.path]).catch(() => {});
  await git(wt.repo, ["worktree", "prune"]).catch(() => {});
  await git(wt.repo, ["branch", "-D", wt.branch]).catch(() => {});
}
