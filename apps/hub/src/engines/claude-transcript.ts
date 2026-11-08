// Транскрипты Claude Code (~/.claude/projects/<папка>/<sessionId>.jsonl): список для импорта и перевод
// истории в события KamHarn. Формат — строки user/assistant/attachment/...; блоки одного ответа
// лежат отдельными строками с общим message.id.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeTranscript, MessageInfo, Part, SessionEvent } from "@kamharn/protocol";
import { toolTitle } from "./claude.ts";
import { L } from "../lang.ts";

type Json = Record<string, any>;

/** Текст сообщения пользователя без служебных вставок; undefined — это не реплика пользователя. */
export function userText(line: Json): string | undefined {
  if (line.type !== "user" || line.isMeta || line.isSidechain) return undefined;
  const c = line.message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: Json) => b.type === "tool_result")) return undefined;
    text = c.filter((b: Json) => b.type === "text").map((b: Json) => String(b.text ?? "")).join("\n");
  } else return undefined;
  // вставки VS Code (<ide_opened_file>, <ide_selection>) — контекст редактора, а не слова пользователя
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<(ide_[a-z_]+)>[\s\S]*?<\/\1>/g, "").trim();
  // обёртки слэш-команд и вывода локальных команд — не реплики
  if (!text || /^<(command-|local-command-|bash-|task-notification)/.test(text)) return undefined;
  return text;
}

function readHead(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Транскрипты, которые можно продолжить в KamHarn: свежие сначала.
 * allowed(cwd) — путь внутри разрешённых папок (иначе undefined); exclude — id уже известных хабу сессий.
 */
export function listTranscripts(projectsDir: string, allowed: (cwd: string) => string | undefined, exclude: Set<string>, limit = 40, only?: Set<string>): ClaudeTranscript[] {
  let files: Array<{ id: string; path: string; mtime: number; size: number }> = [];
  try {
    for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const d = join(projectsDir, dir.name);
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".jsonl")) continue;
        const id = f.slice(0, -6);
        if (exclude.has(id) || (only && !only.has(id))) continue;
        const st = statSync(join(d, f));
        files.push({ id, path: join(d, f), mtime: st.mtimeMs, size: st.size });
      }
    }
  } catch {
    return [];
  }
  files = files.sort((a, b) => b.mtime - a.mtime);
  const out: ClaudeTranscript[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    let cwd: string | undefined;
    let title: string | undefined;
    let entry: string | undefined;
    let origin: string | undefined;
    // первая реплика обычно в начале файла, но перед ней бывают большие вложения
    for (const line of readHead(f.path, 512 * 1024).split("\n")) {
      if (!line.trim()) continue;
      let j: Json;
      try {
        j = JSON.parse(line);
      } catch {
        continue; // обрезанная последняя строка
      }
      cwd ??= typeof j.cwd === "string" ? j.cwd : undefined;
      entry ??= typeof j.entrypoint === "string" ? j.entrypoint : undefined;
      if (origin === undefined && userText(j) !== undefined) origin = typeof j.turnOrigin === "string" ? j.turnOrigin : (j.origin?.kind ?? "");
      title ??= userText(j);
      if (cwd && title && entry) break;
    }
    // claude -p: так его запускают сам хаб, тесты и скрипты — продолжать там нечего. entrypoint бывает
    // унаследован от VS Code (CLAUDE_CODE_ENTRYPOINT в окружении), поэтому смотрим и на turnOrigin первой реплики
    if (entry?.startsWith("sdk") || origin === "sdk") continue;
    const dir = cwd && allowed(cwd);
    if (!dir || !title) continue;
    const source = entry === undefined ? undefined : entry.includes("vscode") ? "vscode" : "cli";
    // «c:\…» от VS Code и «C:\…» из терминала — одна папка
    const directory = dir.replace(/^[a-z]:/, (d) => d.toUpperCase());
    out.push({ id: f.id, directory, title: title.replace(/\s+/g, " ").slice(0, 160), updatedAt: f.mtime, size: f.size, ...(source ? { source } : {}) });
  }
  return out;
}

/** Файл транскрипта по id сессии и её рабочая папка. */
export function findTranscript(projectsDir: string, id: string): { path: string; cwd?: string; title?: string } | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const path = join(projectsDir, d, `${id}.jsonl`);
    let head: string;
    try {
      head = readHead(path, 512 * 1024);
    } catch {
      continue;
    }
    let cwd: string | undefined;
    let title: string | undefined;
    for (const line of head.split("\n")) {
      try {
        const j = JSON.parse(line);
        cwd ??= typeof j.cwd === "string" ? j.cwd : undefined;
        title ??= userText(j);
      } catch {
        /* пусто или обрезано */
      }
      if (cwd && title) break;
    }
    return { path, ...(cwd ? { cwd } : {}), ...(title ? { title } : {}) };
  }
  return undefined;
}

export interface TranscriptHistory {
  events: SessionEvent[];
  /** модель последнего ответа */
  model?: string;
  /** сколько ранних сообщений не перенесено */
  skipped: number;
}

function resultText(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) s = content.map((c: Json) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  else s = JSON.stringify(content ?? "");
  return s.length > 20_000 ? s.slice(0, 20_000) + L("\n…(обрезано)", "\n…(truncated)") : s;
}

/** История транскрипта как события KamHarn (последние maxTurns ходов). */
export function transcriptHistory(path: string, maxTurns = 40): TranscriptHistory {
  const lines: Json[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      const j = JSON.parse(raw);
      if ((j.type === "user" || j.type === "assistant") && !j.isSidechain) lines.push(j);
    } catch {
      /* битая строка */
    }
  }

  // сообщения по порядку; ответ ассистента собирается из нескольких строк с одним message.id
  interface Msg {
    info: MessageInfo;
    parts: Part[];
  }
  const msgs: Msg[] = [];
  const byId = new Map<string, Msg>();
  const tools = new Map<string, { msg: Msg; index: number }>();
  let model: string | undefined;

  for (const j of lines) {
    const ts = Date.parse(j.timestamp) || 0;
    const text = userText(j);
    if (text !== undefined) {
      const id = "u_" + String(j.uuid ?? ts);
      msgs.push({ info: { id, role: "user", createdAt: ts }, parts: [{ type: "text", id: `${id}:t`, text }] });
      continue;
    }
    if (j.type === "assistant") {
      const m = j.message as Json;
      if (!m?.id) continue;
      if (typeof m.model === "string" && m.model.startsWith("claude-")) model = m.model;
      let msg = byId.get(m.id);
      if (!msg) {
        msg = { info: { id: m.id, role: "assistant", createdAt: ts, ...(model ? { model: { providerId: "anthropic", modelId: model } } : {}) }, parts: [] };
        byId.set(m.id, msg);
        msgs.push(msg);
      }
      for (const b of (m.content ?? []) as Json[]) {
        const pid = `${m.id}:i${msg.parts.length}`;
        if (b.type === "text" && b.text) msg.parts.push({ type: "text", id: pid, text: b.text });
        else if (b.type === "thinking" && b.thinking) msg.parts.push({ type: "reasoning", id: pid, text: b.thinking });
        else if (b.type === "tool_use") {
          tools.set(b.id, { msg, index: msg.parts.length });
          msg.parts.push({ type: "tool", id: pid, tool: b.name, status: "running", title: toolTitle(b.name, b.input), input: b.input });
        }
      }
      continue;
    }
    // результаты инструментов
    const c = j.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Json[]) {
      if (b.type !== "tool_result") continue;
      const t = tools.get(b.tool_use_id);
      if (!t) continue;
      const part = t.msg.parts[t.index];
      if (part?.type !== "tool") continue;
      const out = resultText(b.content);
      t.msg.parts[t.index] = { ...part, status: b.is_error ? "error" : "completed", ...(b.is_error ? { error: out } : { output: out }) };
    }
  }

  // последние maxTurns ходов: реплика пользователя и всё, что после неё
  const all = msgs.filter((m) => m.parts.length);
  const userIdx = all.flatMap((m, i) => (m.info.role === "user" ? [i] : []));
  const from = userIdx.length > maxTurns ? userIdx[userIdx.length - maxTurns]! : 0;
  const kept = all.slice(from);
  const skipped = from;
  const events: SessionEvent[] = [];
  for (const m of kept) {
    events.push({ type: "message.upserted", message: m.info });
    // инструмент без результата (сессию прервали) — не висит «в работе»
    for (const p of m.parts) events.push({ type: "part.upserted", messageId: m.info.id, part: p.type === "tool" && p.status === "running" ? { ...p, status: "error", error: L("нет результата в транскрипте", "no result in the transcript") } : p });
  }
  return { events, ...(model ? { model } : {}), skipped };
}
