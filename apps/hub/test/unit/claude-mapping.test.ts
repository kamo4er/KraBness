// Маппинг реального stream-json от claude 2.1.302 (Read + Bash + ответ) в протокол KamHarn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDelta, applyEvent, emptyView, type PartDelta, type SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine, toolTitle } from "../../src/engines/claude.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/claude-turn.json"), "utf8")) as {
  sessionId: string;
  lines: Array<Record<string, any>>;
};

function run() {
  const out: Array<{ kind: "ev"; ev: SessionEvent } | { kind: "delta"; d: PartDelta }> = [];
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  (engine as any).sink = {
    event: (_: string, ev: SessionEvent) => out.push({ kind: "ev", ev }),
    delta: (_: string, d: PartDelta) => out.push({ kind: "delta", d }),
  };
  engine.attach(fixture.sessionId, { directory: "C:\\work\\sandbox", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual", hasHistory: true });
  for (const l of fixture.lines) engine.handle(fixture.sessionId, l);
  return out;
}

test("tool-вызовы Read и Bash: pending → running → completed с выводом", () => {
  const evs = run().flatMap((x) => (x.kind === "ev" ? [x.ev] : []));
  const tools = evs.flatMap((e) => (e.type === "part.upserted" && e.part.type === "tool" ? [e.part] : []));
  const read = tools.filter((t) => t.type === "tool" && t.tool === "Read");
  assert.deepEqual(read.map((t) => t.type === "tool" && t.status), ["pending", "running", "completed"]);
  const bash = tools.filter((t) => t.type === "tool" && t.tool === "Bash").at(-1);
  assert.ok(bash && bash.type === "tool" && bash.status === "completed" && bash.output === "claude-ok");
  assert.equal(bash.type === "tool" && bash.title, "echo claude-ok");
  // один и тот же tool-part обновляется по одному id
  assert.equal(new Set(read.map((t) => t.id)).size, 1);
});

test("итоговое состояние: текст ответа собран, статус idle", () => {
  const out = run();
  const view = emptyView();
  let seq = 0;
  for (const x of out) {
    if (x.kind === "ev") applyEvent(view, { seq: ++seq, sessionId: "s", ts: seq, event: x.ev });
    else applyDelta(view, x.d);
  }
  const assistant = view.messages.filter((m) => m.info.role === "assistant");
  assert.equal(assistant.length, 2, "два сообщения ассистента: с тулзами и с ответом");
  const text = assistant[1]!.parts.find((p) => p.type === "text");
  assert.ok(text && text.type === "text" && text.text.length > 10);
  const last = out.filter((x) => x.kind === "ev").at(-1);
  assert.deepEqual(last && last.kind === "ev" && last.ev, { type: "session.updated", patch: { status: "idle" } });
});

test("пустой thinking (без дельт) не показывается", () => {
  const evs = run().flatMap((x) => (x.kind === "ev" ? [x.ev] : []));
  assert.ok(!evs.some((e) => e.type === "part.upserted" && e.part.type === "reasoning" && e.part.text === ""));
});

test("toolTitle берёт самое осмысленное поле", () => {
  assert.equal(toolTitle("Bash", { command: "npm test" }), "npm test");
  assert.equal(toolTitle("Write", { file_path: "C:\\a.txt", content: "x" }), "C:\\a.txt");
  assert.equal(toolTitle("X", { a: 1 }), '{"a":1}');
});
