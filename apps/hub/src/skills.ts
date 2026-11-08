// Скиллы в ~/.claude/skills/<имя>/SKILL.md: их видят Claude везде (KamHarn, VS Code, терминал) и opencode
// (он тоже читает .claude/skills). Создать в редакторе, загрузить SKILL.md или zip, поставить папку из GitHub.
// Архивы распаковывает встроенный в Windows tar (bsdtar): он сам не пускает «..» и абсолютные пути, плюс проверяем список заранее.
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import type { SkillInfo } from "@kamharn/protocol";
import { describe } from "./commands.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** папки, положенные руками: любые буквы, цифры, «._-», без слэшей; не «.» и не «..» */
const EXISTING = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,99}$/u;
const MAX_ARCHIVE = 50 * 1024 * 1024;
const MAX_UNPACKED = 100 * 1024 * 1024;
/** строка `tar -tv`: права, ссылки, владелец, группа, РАЗМЕР, месяц (в локальной кодировке), день, время|год, ИМЯ */
const LISTING = /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d{1,2}:\d{2}|\d{4})\s(.*)$/;

/** bsdtar из Windows (умеет zip); у git-bash в PATH бывает GNU tar, который zip не знает */
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out))),
  );
}

/** Тело ответа, но не больше max байт: большой монорепозиторий не должен целиком лечь в память. */
async function readLimited(r: Response, max: number): Promise<Buffer> {
  if (Number(r.headers.get("content-length") ?? 0) > max) throw new HttpError(413, L("Архив репозитория больше 50 МБ", "The repository archive is larger than 50 MB"));
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = r.body?.getReader();
  if (!reader) return Buffer.from(await r.arrayBuffer());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, L("Архив репозитория больше 50 МБ", "The repository archive is larger than 50 MB"));
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Размер папки и число файлов (без симлинков). */
function measure(dir: string): { files: number; size: number } {
  let files = 0;
  let size = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files++;
    size += statSync(join(e.parentPath, e.name)).size;
  }
  return { files, size };
}

/** Папка со SKILL.md: сам корень или единственная папка внутри (так обычно упакован zip). */
function skillRoot(dir: string): string | undefined {
  if (existsSync(join(dir, "SKILL.md"))) return dir;
  const subs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== "__MACOSX");
  if (subs.length === 1 && existsSync(join(dir, subs[0]!.name, "SKILL.md"))) return join(dir, subs[0]!.name);
  return undefined;
}

/** Проверка SKILL.md: заголовок с description; name, если есть, — допустимый. */
function checkSkillMd(text: string): { name?: string; description: string } {
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) throw new HttpError(400, L("SKILL.md должен начинаться с заголовка --- name: … description: … ---", "SKILL.md must start with a header --- name: … description: … ---"));
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)![1]!;
  if (!/^description:\s*\S/m.test(fm)) throw new HttpError(400, L("В заголовке SKILL.md нужно поле description — по нему агент решает, когда брать скилл", "The SKILL.md header needs a description field — the agent uses it to decide when to use the skill"));
  const d = describe(text);
  if (d.name !== undefined && !NAME.test(d.name)) throw new HttpError(400, L(`name «${d.name}»: строчная латиница, цифры и дефис`, `name “${d.name}”: lowercase latin letters, digits and hyphens`));
  return { ...(d.name ? { name: d.name } : {}), description: d.description ?? "" };
}

/** github.com/<o>/<r>[/tree|blob/<ветка>/<путь>] → что скачать и какую папку взять. */
export function parseGithub(url: string): { owner: string; repo: string; ref?: string; path: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new HttpError(400, L("Нужна ссылка вида https://github.com/<владелец>/<репозиторий>/tree/<ветка>/<папка скилла>", "A link like https://github.com/<owner>/<repo>/tree/<branch>/<skill folder> is required"));
  }
  if (u.hostname !== "github.com") throw new HttpError(400, L("Поддерживаются только ссылки на github.com", "Only github.com links are supported"));
  const [owner, repo, kind, ref, ...rest] = u.pathname.split("/").filter(Boolean);
  if (!owner || !repo) throw new HttpError(400, L("В ссылке нет владельца и репозитория", "The link has no owner and repository"));
  if (!kind) return { owner, repo: repo.replace(/\.git$/, ""), path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) throw new HttpError(400, L("Ссылка должна вести на папку (/tree/…) или на SKILL.md (/blob/…)", "The link must point to a folder (/tree/…) or to SKILL.md (/blob/…)"));
  let path = rest.join("/");
  // ссылка на сам SKILL.md — берём его папку
  if (kind === "blob") path = /(^|\/)SKILL\.md$/i.test(path) ? posix.dirname(path).replace(/^\.$/, "") : path;
  if (path.split("/").includes("..")) throw new HttpError(400, L("Недопустимый путь в ссылке", "Invalid path in the link"));
  return { owner, repo, ref, path };
}

export class Skills {
  constructor(
    readonly dir: string = join(homedir(), ".claude", "skills"),
    private http: typeof fetch = fetch,
    private maxUnpacked = MAX_UNPACKED,
  ) {}

  list(): SkillInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: SkillInfo[] = [];
    for (const e of readdirSync(this.dir, { withFileTypes: true })) {
      // .имя.new-… / .имя.old-… — недоделанная замена
      if (e.name.startsWith(".")) continue;
      const md = join(this.dir, e.name, "SKILL.md");
      if (!e.isDirectory() || !existsSync(md)) continue;
      // один битый или залоченный скилл не должен ронять весь список
      try {
        const d = describe(readFileSync(md, "utf8"));
        // describe() режет описание до 200 символов (для меню «/»)
        const description = d.description && d.description.length >= 200 ? `${d.description}…` : d.description;
        out.push({ name: e.name, ...(description ? { description } : {}), ...measure(join(this.dir, e.name)), updatedAt: statSync(md).mtimeMs });
      } catch {
        /* пропускаем */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Папка скилла. Новые — строго по правилам имён; уже существующие (положены руками) — любое имя без слэшей и «..». */
  private path(name: string, strict = false): string {
    if (!(strict ? NAME : EXISTING).test(name)) throw new HttpError(400, L("Имя скилла: строчная латиница, цифры и дефис (до 64 символов)", "Skill name: lowercase latin letters, digits and hyphens (up to 64 characters)"));
    return join(this.dir, name);
  }

  read(name: string): { name: string; text: string } {
    const md = join(this.path(name), "SKILL.md");
    if (!existsSync(md)) throw new HttpError(404, L(`Скилла «${name}» нет`, `No skill “${name}”`));
    return { name, text: readFileSync(md, "utf8") };
  }

  /** Записать SKILL.md (создать скилл или заменить текст существующего); create — не затирать чужой с тем же именем. */
  write(name: string, text: string, create: boolean): SkillInfo {
    const dir = this.path(name, create);
    const fm = checkSkillMd(text);
    // у существующих бывает name, отличный от папки (поставлены руками) — их не ломаем
    if (create && fm.name && fm.name !== name) throw new HttpError(400, L(`name в заголовке («${fm.name}») должен совпадать с именем скилла «${name}»`, `name in the header (“${fm.name}”) must match the skill name “${name}”`));
    if (create && existsSync(dir)) throw new HttpError(409, L(`Скилл «${name}» уже есть`, `Skill “${name}” already exists`));
    if (!create && !existsSync(dir)) throw new HttpError(404, L(`Скилла «${name}» нет`, `No skill “${name}”`));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), text);
    return this.list().find((s) => s.name === name)!;
  }

  remove(name: string): void {
    const dir = this.path(name);
    if (!existsSync(dir)) throw new HttpError(404, L(`Скилла «${name}» нет`, `No skill “${name}”`));
    rmSync(dir, { recursive: true, force: true });
  }

  /** Поставить папку скилла (src со SKILL.md) под именем из заголовка или папки. */
  private install(src: string, fallbackName: string, overwrite: boolean): SkillInfo {
    const fm = checkSkillMd(readFileSync(join(src, "SKILL.md"), "utf8"));
    const name = fm.name ?? fallbackName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    const dir = this.path(name, true);
    const m = measure(src);
    if (m.size > this.maxUnpacked) throw new HttpError(400, L("Скилл больше 100 МБ — не ставлю", "The skill is larger than 100 MB — not installing"));
    const exists = existsSync(dir);
    if (exists && !overwrite) throw new HttpError(409, L(`Скилл «${name}» уже есть`, `Skill “${name}” already exists`));
    mkdirSync(this.dir, { recursive: true });
    // копируем рядом и меняем переименованием: если копирование упадёт (место, антивирус), старый скилл цел
    const stamp = `${process.pid}-${Date.now()}`;
    const fresh = join(this.dir, `.${name}.new-${stamp}`);
    const old = join(this.dir, `.${name}.old-${stamp}`);
    try {
      cpSync(src, fresh, { recursive: true, filter: (p) => !basename(p).startsWith(".git") && basename(p) !== "__MACOSX" });
      if (exists) renameSync(dir, old);
      try {
        renameSync(fresh, dir);
      } catch (e) {
        if (exists) renameSync(old, dir);
        throw e;
      }
    } catch (e) {
      rmSync(fresh, { recursive: true, force: true });
      throw new HttpError(500, L(`Не удалось поставить скилл: ${(e as Error).message}`, `Failed to install the skill: ${(e as Error).message}`));
    }
    rmSync(old, { recursive: true, force: true });
    return this.list().find((s) => s.name === name)!;
  }

  /** Список записей архива с проверкой путей. */
  private async entries(archive: string, gz: boolean): Promise<string[]> {
    const entries = (await run(TAR, [gz ? "-tzf" : "-tf", archive]).catch((e: Error) => {
      throw new HttpError(400, L(`Архив не читается: ${e.message}`, `Can't read the archive: ${e.message}`));
    })).split(/\r?\n/).filter(Boolean);
    if (entries.some((e) => /^([a-z]:|[\\/])/i.test(e) || e.split(/[\\/]/).includes(".."))) throw new HttpError(400, L("В архиве недопустимые пути (.. или абсолютные) — не распаковываю", "The archive has invalid paths (.. or absolute) — not unpacking"));
    return entries;
  }

  /**
   * Распаковать архив (only — только эта папка внутри) во временную папку.
   * Символьные ссылки не ставим: они могут вести за пределы скилла (bsdtar без прав их и не создаёт — падает).
   */
  private async unpack(archive: string, gz: boolean, only?: string): Promise<string> {
    if (!only) await this.entries(archive, gz);
    // zip-бомба: 50 МБ архива могут развернуться в гигабайты — считаем размер по оглавлению до распаковки
    const listing = await run(TAR, [gz ? "-tvzf" : "-tvf", archive]).catch(() => "");
    let total = 0;
    for (const line of listing.split(/\r?\n/)) {
      const m = LISTING.exec(line);
      if (!m) continue;
      if (only && m[2] !== only && !m[2]!.startsWith(`${only}/`)) continue;
      total += Number(m[1]);
    }
    if (total > this.maxUnpacked) throw new HttpError(400, L("В распакованном виде скилл больше 100 МБ — не ставлю", "Unpacked, the skill is larger than 100 MB — not installing"));
    const out = mkdtempSync(join(tmpdir(), "kamharn-skill-"));
    try {
      await run(TAR, [gz ? "-xzf" : "-xf", archive, "-C", out, ...(only ? [only] : [])]);
      if (readdirSync(out, { withFileTypes: true, recursive: true }).some((e) => e.isSymbolicLink()))
        throw new HttpError(400, L("В скилле есть символьные ссылки — не ставлю", "The skill contains symbolic links — not installing"));
      return out;
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      if (e instanceof HttpError) throw e;
      const msg = (e as Error).message;
      throw new HttpError(400, /symlink|Can't create|Invalid argument/i.test(msg) ? L("В скилле есть символьные ссылки — не ставлю", "The skill contains symbolic links — not installing") : L(`Не удалось распаковать архив: ${msg.slice(0, 300)}`, `Failed to unpack the archive: ${msg.slice(0, 300)}`));
    }
  }

  /** Загруженный файл: SKILL.md или .zip с папкой скилла. */
  async upload(fileName: string, data: Buffer, overwrite: boolean): Promise<SkillInfo> {
    if (data.length > MAX_ARCHIVE) throw new HttpError(413, L("Файл больше 50 МБ", "The file is larger than 50 MB"));
    const work = mkdtempSync(join(tmpdir(), "kamharn-skill-"));
    try {
      if (/\.md$/i.test(fileName)) {
        const text = data.toString("utf8");
        const fm = checkSkillMd(text);
        const src = join(work, "skill");
        mkdirSync(src);
        writeFileSync(join(src, "SKILL.md"), text);
        if (!fm.name) throw new HttpError(400, L("В заголовке SKILL.md нет name — по нему называется папка скилла", "The SKILL.md header has no name — the skill folder is named after it"));
        return this.install(src, fm.name, overwrite);
      }
      if (!/\.zip$/i.test(fileName)) throw new HttpError(400, L("Нужен SKILL.md или .zip с папкой скилла", "A SKILL.md or a .zip with the skill folder is required"));
      const zip = join(work, "skill.zip");
      writeFileSync(zip, data);
      const out = await this.unpack(zip, false);
      try {
        const root = skillRoot(out);
        if (!root) throw new HttpError(400, L("В архиве нет SKILL.md (ни в корне, ни в единственной папке)", "No SKILL.md in the archive (neither at the root nor in a single folder)"));
        return this.install(root, root === out ? fileName.replace(/\.zip$/i, "") : basename(root), overwrite);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Папка скилла из репозитория GitHub (архив ветки через API, берём только нужную папку). */
  async fromGithub(url: string, overwrite: boolean): Promise<SkillInfo> {
    const g = parseGithub(url);
    const api = `https://api.github.com/repos/${g.owner}/${g.repo}/tarball${g.ref ? `/${encodeURIComponent(g.ref)}` : ""}`;
    const r = await this.http(api, { headers: { "user-agent": "KraBness", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(120_000) }).catch((e: Error) => {
      throw new HttpError(502, L(`GitHub недоступен: ${e.message}`, `GitHub is unreachable: ${e.message}`));
    });
    if (r.status === 404) throw new HttpError(404, L("Репозиторий или ветка не найдены (приватные не поддерживаются)", "Repository or branch not found (private ones aren't supported)"));
    if (!r.ok) throw new HttpError(502, L(`GitHub ответил ${r.status}`, `GitHub answered ${r.status}`));
    const data = await readLimited(r, MAX_ARCHIVE);
    const work = mkdtempSync(join(tmpdir(), "kamharn-skill-"));
    try {
      const tgz = join(work, "repo.tar.gz");
      writeFileSync(tgz, data);
      // в архиве всё лежит в одной папке <владелец>-<репо>-<коммит>; распаковываем только папку скилла
      const top = (await this.entries(tgz, true))[0]?.split("/")[0];
      if (!top) throw new HttpError(400, L("Пустой архив репозитория", "Empty repository archive"));
      const inner = g.path.split("/").filter(Boolean);
      const out = await this.unpack(tgz, true, [top, ...inner].join("/")).catch((e: unknown) => {
        // нужной папки в архиве нет — tar ругается «Not found in archive»
        if (e instanceof HttpError && /not found/i.test(e.message)) throw new HttpError(400, L(`В репозитории нет папки ${g.path}`, `No folder ${g.path} in the repository`));
        throw e;
      });
      try {
        const src = join(out, top, ...inner);
        if (!existsSync(join(src, "SKILL.md"))) throw new HttpError(400, L(`В ${g.path || "корне репозитория"} нет SKILL.md — дай ссылку на папку скилла`, `No SKILL.md in ${g.path || "the repository root"} — give a link to the skill folder`));
        return this.install(src, g.path ? posix.basename(g.path) : g.repo, overwrite);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
