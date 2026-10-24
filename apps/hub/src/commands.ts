// Слэш-команды для меню «/» в поле ввода: скиллы Claude (пользователя, проекта, встроенные из init)
// и несколько встроенных команд, которые имеют смысл в режиме `claude -p`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand } from "@kamharn/protocol";
import { L } from "./lang.ts";

/** встроенные команды CLI, полезные из чата (проверено: /context в stream-json отвечает текстом) */
const BUILTIN = (): SlashCommand[] => [
  { name: "compact", description: L("Сжать историю разговора, чтобы освободить контекст", "Compact the conversation history to free up context"), kind: "command" },
  { name: "context", description: L("Сколько контекста занято и чем", "How much context is used and by what"), kind: "command" },
  { name: "init", description: L("Создать CLAUDE.md с описанием проекта", "Create CLAUDE.md describing the project"), kind: "command" },
  { name: "security-review", description: L("Проверить изменения на проблемы безопасности", "Review the changes for security issues"), kind: "command" },
];

/** description из YAML-заголовка, иначе — первая строка текста (не заголовок). */
export function describe(md: string): { name?: string; description?: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const field = (k: string) => {
    const m = fm && new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm[1]!);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  const body = fm ? md.slice(fm[0].length) : md;
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const description = field("description") ?? line;
  return { ...(field("name") ? { name: field("name")! } : {}), ...(description ? { description: description.slice(0, 200) } : {}) };
}

/** Скиллы (<dir>/skills/<name>/SKILL.md) и свои команды (<dir>/commands/<name>.md) из папки .claude. */
export function readClaudeDir(dir: string): SlashCommand[] {
  const out: SlashCommand[] = [];
  const skills = join(dir, "skills");
  if (existsSync(skills)) {
    for (const d of readdirSync(skills, { withFileTypes: true })) {
      const f = join(skills, d.name, "SKILL.md");
      if (!d.isDirectory() || !existsSync(f)) continue;
      const m = describe(readFileSync(f, "utf8"));
      out.push({ name: m.name ?? d.name, ...(m.description ? { description: m.description } : {}), kind: "skill" });
    }
  }
  const commands = join(dir, "commands");
  if (existsSync(commands)) {
    for (const f of readdirSync(commands)) {
      if (!f.endsWith(".md")) continue;
      const m = describe(readFileSync(join(commands, f), "utf8"));
      out.push({ name: f.slice(0, -3), ...(m.description ? { description: m.description } : {}), kind: "command" });
    }
  }
  return out;
}

/**
 * Команды для сессии Claude в папке cwd: проектные и пользовательские скиллы с описаниями,
 * скиллы из последнего init (встроенные и из плагинов — без описаний), полезные встроенные команды.
 */
export function claudeCommands(cwd: string, home: string, initSkills: string[] = []): SlashCommand[] {
  const seen = new Set<string>();
  const out: SlashCommand[] = [];
  const add = (c: SlashCommand) => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    out.push(c);
  };
  for (const c of readClaudeDir(join(cwd, ".claude"))) add(c);
  for (const c of readClaudeDir(join(home, ".claude"))) add(c);
  for (const name of initSkills) add({ name, kind: "skill" });
  for (const c of BUILTIN()) add(c);
  return out;
}
