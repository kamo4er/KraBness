// Передача работы бесплатной модели: выжимка сессии из журнала (без LLM — квоту не тратим) и промпт ревью диффа.
import type { Part, SessionInfo, StoredEvent } from "@kamharn/protocol";
import { L } from "./lang.ts";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Механическая выжимка: последние реплики, итоги ответов, затронутые файлы и команды. */
export function sessionDigest(info: SessionInfo, events: StoredEvent[], maxChars = 12_000): string {
  // состояние частей по последнему upsert
  const roles = new Map<string, "user" | "assistant">();
  const parts = new Map<string, { messageId: string; part: Part; order: number }>();
  let order = 0;
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "message.upserted") roles.set(ev.message.id, ev.message.role);
    if (ev.type === "part.upserted") {
      const prev = parts.get(ev.part.id);
      parts.set(ev.part.id, { messageId: ev.messageId, part: ev.part, order: prev?.order ?? order++ });
    }
  }
  const all = [...parts.values()].sort((a, b) => a.order - b.order);
  const users = all.filter((p) => roles.get(p.messageId) === "user" && p.part.type === "text").map((p) => (p.part.type === "text" ? p.part.text : ""));
  const replies = all.filter((p) => roles.get(p.messageId) === "assistant" && p.part.type === "text").map((p) => (p.part.type === "text" ? p.part.text : ""));
  const edited = new Set<string>();
  const read = new Set<string>();
  const commands: string[] = [];
  for (const { part } of all) {
    if (part.type !== "tool") continue;
    const i = (part.input ?? {}) as Record<string, unknown>;
    const file = i.file_path ?? i.filePath ?? i.path;
    if (typeof file === "string") (/edit|write|patch/i.test(part.tool) ? edited : read).add(file);
    if (typeof i.command === "string") commands.push(i.command);
  }
  for (const f of edited) read.delete(f);

  const out: string[] = [
    L(`Сессия «${info.title}», папка ${info.directory}, модель была ${info.model.modelId}.`, `Session “${info.title}”, folder ${info.directory}, the model was ${info.model.modelId}.`),
    "",
    L("Последние запросы пользователя (старые → новые):", "Latest user requests (old → new):"),
    ...users.slice(-8).map((t, i) => `${i + 1}. ${clip(t.trim(), 1500)}`),
    "",
    L("Последние ответы ассистента (старые → новые):", "Latest assistant replies (old → new):"),
    ...replies.slice(-5).map((t) => `— ${clip(t.trim(), 1500)}`),
  ];
  if (edited.size) out.push("", L("Изменённые файлы:", "Changed files:"), ...[...edited].slice(-30).map((f) => `- ${f}`));
  if (read.size) out.push("", L("Просмотренные файлы:", "Viewed files:"), ...[...read].slice(-20).map((f) => `- ${f}`));
  if (commands.length) out.push("", L("Последние команды:", "Latest commands:"), ...commands.slice(-10).map((c) => `$ ${clip(c, 300)}`));
  const text = out.join("\n");
  return text.length > maxChars ? "…" + text.slice(text.length - maxChars) : text;
}

export function handoffPrompt(digest: string): string {
  return [
    L(
      "Продолжаем работу из другой сессии (там закончился лимит модели). Ниже выжимка того, что уже было сделано.",
      "We're continuing the work from another session (the model limit ran out there). Below is a summary of what was already done.",
    ),
    L(
      "Прочитай её. Пока ничего не делай и не меняй — коротко (2–3 строки) скажи, на чём остановились, и жди задачу.",
      "Read it. Don't do or change anything yet — briefly (2–3 lines) say where we stopped, and wait for a task.",
    ),
    "",
    L("<выжимка>", "<summary>"),
    digest,
    L("</выжимка>", "</summary>"),
  ].join("\n");
}

export function reviewPrompt(diff: string, files: Array<{ status: string; path: string }>, truncated: boolean): string {
  return [
    L("Сделай ревью незакоммиченных изменений. Дифф ниже — ничего не запускай и файлы не меняй.", "Review the uncommitted changes. The diff is below — don't run anything and don't change files."),
    L(
      "Ищи: баги и ошибки логики, необработанные ошибки, проблемы безопасности, гонки, забытые случаи. Мелкий стиль не трогай.",
      "Look for: bugs and logic errors, unhandled errors, security issues, races, missed cases. Skip minor style.",
    ),
    L(
      "Ответ списком по важности: `файл:строка — проблема — как исправить`. Если всё чисто — так и скажи.",
      "Answer as a list by severity: `file:line — problem — how to fix`. If everything is clean, say so.",
    ),
    "",
    files.length ? `${L("Изменённые файлы", "Changed files")}: ${files.map((f) => `${f.path} (${f.status})`).join(", ")}` : "",
    truncated ? L("(дифф обрезан — показана начальная часть)", "(the diff is truncated — showing the beginning)") : "",
    "",
    "```diff",
    diff,
    "```",
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join("\n");
}
