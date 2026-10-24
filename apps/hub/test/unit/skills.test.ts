// Скиллы: создать/изменить/удалить SKILL.md, загрузка .md и .zip (zip с «..» отклоняется), установка из GitHub
// (архив репозитория — поддельный ответ API), загрузка через HTTP хаба. Всё во временной папке, не в ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { crc32, gzipSync } from "node:zlib";
import { Skills, parseGithub } from "../../src/skills.ts";

const TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const md = (name: string, desc = "Делает что-то полезное") => `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\nИнструкция.\n`;
const tmp = () => mkdtempSync(join(tmpdir(), "kamharn-sk-"));

/** zip без сжатия из пар имя → данные (имена любые, в т. ч. с «..») */
function zipStore(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const n = Buffer.from(name);
    const d = Buffer.from(text);
    const crc = crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(d.length, 18);
    lh.writeUInt32LE(d.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(d.length, 20);
    ch.writeUInt32LE(d.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, d);
    centrals.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("скиллы: создать, прочитать, изменить, удалить; проверка SKILL.md", () => {
  const sk = new Skills(join(tmp(), "skills"));
  assert.deepEqual(sk.list(), [], "папки ещё нет — пустой список");
  assert.throws(() => sk.write("Bad Name", md("x"), true), /строчная латиница/);
  assert.throws(() => sk.write("notes", "# без заголовка", true), /начинаться с заголовка/);
  assert.throws(() => sk.write("notes", "---\nname: notes\n---\nтекст", true), /description/);
  assert.throws(() => sk.write("notes", md("other"), true), /должен совпадать/);
  const s = sk.write("notes", md("notes", "Заметки по проекту"), true);
  assert.equal(s.description, "Заметки по проекту");
  assert.equal(s.files, 1);
  assert.throws(() => sk.write("notes", md("notes"), true), /уже есть/);
  sk.write("notes", md("notes", "Новое описание"), false);
  assert.match(sk.read("notes").text, /Новое описание/);
  // заголовок без name — можно, имя берётся из папки
  sk.write("plain", "---\ndescription: Без имени\n---\nтекст", true);
  assert.deepEqual(sk.list().map((x) => x.name), ["notes", "plain"]);
  sk.remove("plain");
  assert.throws(() => sk.read("plain"), /нет/);
  assert.throws(() => sk.read("../x"), /строчная латиница/);
});

test("скиллы: загрузка SKILL.md и zip; zip с «..» не распаковывается", async () => {
  const base = tmp();
  const sk = new Skills(join(base, "skills"));
  await sk.upload("SKILL.md", Buffer.from(md("from-md")), false);
  assert.ok(existsSync(join(base, "skills", "from-md", "SKILL.md")));
  await assert.rejects(sk.upload("SKILL.md", Buffer.from("---\ndescription: x\n---\n"), false), /нет name/);
  await assert.rejects(sk.upload("skill.txt", Buffer.from("x"), false), /SKILL.md или .zip/);

  // zip с папкой скилла и скриптом (как обычно упаковывают)
  const src = join(base, "src", "pdf-tools");
  mkdirSync(join(src, "scripts"), { recursive: true });
  writeFileSync(join(src, "SKILL.md"), md("pdf-tools"));
  writeFileSync(join(src, "scripts", "split.py"), "print(1)\n");
  const zip = join(base, "pdf-tools.zip");
  execFileSync(TAR, ["-a", "-cf", zip, "-C", join(base, "src"), "pdf-tools"]);
  const s = await sk.upload("pdf-tools.zip", readFileSync(zip), false);
  assert.equal(s.name, "pdf-tools");
  assert.equal(s.files, 2);
  assert.equal(readFileSync(join(base, "skills", "pdf-tools", "scripts", "split.py"), "utf8"), "print(1)\n");
  await assert.rejects(sk.upload("pdf-tools.zip", readFileSync(zip), false), /уже есть/);
  await sk.upload("pdf-tools.zip", readFileSync(zip), true);

  const evil = zipStore([["evil/SKILL.md", md("evil")], ["../../escaped.txt", "pwned"]]);
  await assert.rejects(sk.upload("evil.zip", evil, false), /недопустимые пути/);
  assert.ok(!existsSync(join(base, "escaped.txt")) && !existsSync(join(base, "skills", "evil")));
  await assert.rejects(sk.upload("empty.zip", zipStore([["readme.txt", "x"]]), false), /нет SKILL.md/);
});

test("скиллы: ссылки GitHub и установка папки из архива репозитория", async () => {
  assert.deepEqual(parseGithub("https://github.com/anthropics/skills/tree/main/skills/pdf"), { owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
  assert.deepEqual(parseGithub("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"), { owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
  assert.deepEqual(parseGithub("https://github.com/me/my-skill"), { owner: "me", repo: "my-skill", path: "" });
  assert.throws(() => parseGithub("https://gitlab.com/a/b"), /github.com/);
  assert.throws(() => parseGithub("https://github.com/a/b/issues/1"), /папку/);

  // архив как у API GitHub: всё внутри <владелец>-<репо>-<коммит>/
  const base = tmp();
  const repo = join(base, "repo", "anthropics-skills-abc123");
  mkdirSync(join(repo, "skills", "pdf", "scripts"), { recursive: true });
  writeFileSync(join(repo, "skills", "pdf", "SKILL.md"), md("pdf", "Работа с PDF"));
  writeFileSync(join(repo, "skills", "pdf", "scripts", "fill.py"), "pass\n");
  writeFileSync(join(repo, "README.md"), "repo\n");
  const tgz = join(base, "repo.tar.gz");
  execFileSync(TAR, ["-czf", tgz, "-C", join(base, "repo"), "anthropics-skills-abc123"]);
  const urls: string[] = [];
  const http = (async (url: string) => {
    urls.push(String(url));
    return String(url).includes("/nope/") ? new Response("", { status: 404 }) : new Response(readFileSync(tgz));
  }) as typeof fetch;
  const sk = new Skills(join(base, "skills"), http);
  const s = await sk.fromGithub("https://github.com/anthropics/skills/tree/main/skills/pdf", false);
  assert.equal(urls[0], "https://api.github.com/repos/anthropics/skills/tarball/main");
  assert.equal(s.name, "pdf");
  assert.equal(s.files, 2);
  assert.ok(!existsSync(join(base, "skills", "pdf", "README.md")), "берём только папку скилла");
  await assert.rejects(sk.fromGithub("https://github.com/anthropics/skills/tree/main/skills", false), /нет SKILL.md/);
  await assert.rejects(sk.fromGithub("https://github.com/anthropics/nope/tree/main/x", false), /не найдены/);
});

/** tar.gz из записей: файлы и символьные ссылки (на Windows без прав симлинк на диске не создать — собираем руками) */
function tgzOf(entries: Array<{ name: string; text?: string; link?: string }>): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.text ?? "");
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write((e.link ? 0 : data.length).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(e.link ? "2" : "0", 156);
    if (e.link) h.write(e.link, 157, 100, "utf8");
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h);
    if (!e.link && data.length) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("скиллы: символьные ссылки в папке скилла — отказ; ссылки в другом месте репозитория не мешают", async () => {
  const tgz = tgzOf([
    { name: "me-repo-abc/skills/bad/SKILL.md", text: md("bad") },
    { name: "me-repo-abc/skills/bad/escape", link: "../../../../../Windows" },
    { name: "me-repo-abc/skills/good/SKILL.md", text: md("good") },
    { name: "me-repo-abc/docs/link", link: "/etc/passwd" },
  ]);
  const base = tmp();
  const sk = new Skills(join(base, "skills"), (async () => new Response(new Uint8Array(tgz))) as unknown as typeof fetch);
  await assert.rejects(sk.fromGithub("https://github.com/me/repo/tree/main/skills/bad", false), /символьные ссылки/);
  assert.ok(!existsSync(join(base, "skills", "bad")));
  const s = await sk.fromGithub("https://github.com/me/repo/tree/main/skills/good", false);
  assert.equal(s.name, "good");
  await assert.rejects(sk.fromGithub("https://github.com/me/repo/tree/main/skills/none", false), /нет папки skills\/none/);
});

test("скиллы: папка, положенная руками с «нестандартным» именем, открывается, правится и удаляется", () => {
  const base = tmp();
  mkdirSync(join(base, "skills", "My_Skill"), { recursive: true });
  writeFileSync(join(base, "skills", "My_Skill", "SKILL.md"), "---\nname: my-skill\ndescription: Руками\n---\nтекст\n");
  const sk = new Skills(join(base, "skills"));
  assert.deepEqual(sk.list().map((x) => x.name), ["My_Skill"]);
  assert.match(sk.read("My_Skill").text, /Руками/);
  sk.write("My_Skill", "---\nname: my-skill\ndescription: Поправил\n---\nтекст\n", false);
  assert.match(sk.read("My_Skill").text, /Поправил/);
  assert.throws(() => sk.write("My_Skill2", md("x"), true), /строчная латиница/, "новые — только по правилам");
  assert.throws(() => sk.read(".."), /строчная латиница/);
  sk.remove("My_Skill");
  assert.deepEqual(sk.list(), []);
});

test("скиллы: размер считается до распаковки (zip-бомба), только по папке скилла; замена без мусора; битый скилл не роняет список", async () => {
  const base = tmp();
  const zip = zipStore([["big/SKILL.md", md("big")], ["big/data.bin", "x".repeat(3000)]]);
  const sk = new Skills(join(base, "skills"), fetch, 2000);
  await assert.rejects(sk.upload("big.zip", zip, false), /В распакованном виде/);
  assert.ok(!existsSync(join(base, "skills", "big")));

  // GitHub: большой файл в другом месте репозитория не считается
  const tgz = tgzOf([
    { name: "me-repo-abc/skills/small/SKILL.md", text: md("small") },
    { name: "me-repo-abc/assets/huge.bin", text: "y".repeat(5000) },
  ]);
  const gh = new Skills(join(base, "skills"), (async () => new Response(new Uint8Array(tgz))) as unknown as typeof fetch, 2000);
  assert.equal((await gh.fromGithub("https://github.com/me/repo/tree/main/skills/small", false)).name, "small");

  // замена: новый текст, временных .small.new-/.old- не остаётся
  const tgz2 = tgzOf([{ name: "me-repo-abc/skills/small/SKILL.md", text: md("small", "Новая версия") }]);
  const gh2 = new Skills(join(base, "skills"), (async () => new Response(new Uint8Array(tgz2))) as unknown as typeof fetch);
  await gh2.fromGithub("https://github.com/me/repo/tree/main/skills/small", true);
  assert.match(gh2.read("small").text, /Новая версия/);
  assert.deepEqual(readdirSync(join(base, "skills")), ["small"]);

  // SKILL.md, который не читается (здесь — папка вместо файла), пропускается, остальные видны
  mkdirSync(join(base, "skills", "broken", "SKILL.md"), { recursive: true });
  mkdirSync(join(base, "skills", ".small.new-1"), { recursive: true });
  assert.deepEqual(gh2.list().map((s) => s.name), ["small"]);
});

test("скиллы: загрузка через HTTP хаба (сырое тело), список, удаление", async () => {
  const { createHub } = await import("../../src/hub.ts");
  const base = tmp();
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: join(base, "skills"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  try {
    let r = await fetch(`${url}/api/skills/upload?name=SKILL.md`, { method: "POST", headers: { "content-type": "text/markdown" }, body: md("via-http") });
    assert.equal(r.status, 200, await r.clone().text());
    r = await fetch(`${url}/api/skills/upload?name=SKILL.md`, { method: "POST", body: md("via-http") });
    assert.equal(r.status, 409);
    const list = (await (await fetch(`${url}/api/skills`)).json()) as Array<{ name: string }>;
    assert.deepEqual(list.map((x) => x.name), ["via-http"]);
    r = await fetch(`${url}/api/skills/new-one`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: md("new-one"), create: true }) });
    assert.equal(r.status, 200);
    r = await fetch(`${url}/api/skills/via-http`, { method: "DELETE" });
    assert.equal(r.status, 200);
    assert.deepEqual(((await (await fetch(`${url}/api/skills`)).json()) as Array<{ name: string }>).map((x) => x.name), ["new-one"]);
  } finally {
    await hub.close();
  }
});
