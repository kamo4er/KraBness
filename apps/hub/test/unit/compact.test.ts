// Сжатие контекста: реальные потоки claude 2.1.302 (/compact в режиме -p) и opencode 1.19 (summarize) → отметка compaction и свёрнутый пересказ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, emptyView, type Part, type SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine, compactSummary } from "../../src/engines/claude.ts";
import { OpencodeEngine } from "../../src/engines/opencode.ts";

const lines = (f: string) => readFileSync(join(import.meta.dirname, "../fixtures", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

function view(evs: SessionEvent[]) {
  const v = emptyView();
  evs.forEach((event, i) => applyEvent(v, { seq: i + 1, sessionId: "s", ts: i + 1, event }));
  return v;
}

test("claude /compact: отметка «контекст сжат» с токенами, пересказ отдельным свёрнутым сообщением", () => {
  const evs: SessionEvent[] = [];
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  (engine as unknown as { sink: unknown }).sink = { event: (_: string, ev: SessionEvent) => evs.push(ev), delta: () => {} };
  engine.attach("s1", { directory: "C:\\work", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual", hasHistory: true });
  for (const l of lines("claude-compact.jsonl")) engine.handle("s1", l);
  const v = view(evs);
  const comp = v.messages.flatMap((m) => m.parts).find((p): p is Extract<Part, { type: "compaction" }> => p.type === "compaction");
  assert.deepEqual(comp && [comp.trigger, comp.preTokens, comp.postTokens], ["manual", 19585, 2002]);
  const summary = v.messages.find((m) => m.info.summary);
  assert.ok(summary, "пересказ помечен summary");
  const text = summary.parts.find((p) => p.type === "text");
  assert.ok(text && text.type === "text" && text.text.includes("4217") && !text.text.startsWith("This session"), "в пересказе — суть, без вступления CLI");
  // пересказ идёт после отметки
  assert.ok(v.messages.indexOf(summary) > v.messages.findIndex((m) => m.parts.some((p) => p.type === "compaction")));
  // служебное «Compacted» CLI в чат не попадает
  assert.ok(!v.messages.some((m) => m.parts.some((p) => p.type === "text" && /local-command-stdout|Compacted/.test(p.text))));
  assert.ok(evs.some((e) => e.type === "session.updated" && e.patch.status === "idle"));
});

test("opencode summarize: отметка из части compaction, пересказ помечен summary", () => {
  const evs: SessionEvent[] = [];
  const raw = lines("opencode-compact.jsonl");
  const sid = raw[0]!.properties.sessionID as string;
  const engine = new OpencodeEngine({ port: 0 });
  (engine as unknown as { sink: unknown }).sink = { event: (_: string, ev: SessionEvent) => evs.push(ev), delta: () => {} };
  engine.attach(sid, { directory: "C:\\work\\sandbox", permissionMode: "acceptEdits" });
  for (const e of raw) engine.handle(e);
  const v = view(evs);
  const comp = v.messages.flatMap((m) => m.parts).find((p) => p.type === "compaction");
  assert.ok(comp && comp.type === "compaction" && comp.trigger === "manual");
  const summary = v.messages.find((m) => m.info.summary);
  assert.ok(summary && summary.info.role === "assistant");
  assert.ok(summary.parts.some((p) => p.type === "text" && p.text.includes("4217")));
  // у сообщения пользователя opencode summary — объект { diffs }, его не путаем с пересказом
  assert.equal(v.messages.filter((m) => m.info.summary).length, 1);
});

test("пересказ claude без служебных абзацев CLI — и с «Summary:», и без него", () => {
  const noise =
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";
  const tail =
    "If you need specific details from before compaction (like exact code snippets), read the full transcript at: C:/work/x.jsonl Continue the conversation from where it left off.\n\nThe messages after this summary are the most recent messages from before compaction, kept verbatim.";
  assert.equal(compactSummary(`${noise}\n\nSummary:\n1. Число 4217\n2. Дальше\n\n${tail}`), "1. Число 4217\n2. Дальше");
  assert.equal(compactSummary(`${noise}\n\nЧисло 4217, ответ 4\n\n${tail}`), "Число 4217, ответ 4");
  assert.equal(compactSummary("просто текст"), "просто текст");
});
