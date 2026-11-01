// CLI при --resume игнорирует новый --append-system-prompt: изменённые строки хаб дошлёт скрытым началом сообщения, один раз.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelRef, SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine, systemDiff } from "../../src/engines/claude.ts";

const haiku: ModelRef = { providerId: "anthropic", modelId: "claude-haiku-5-5" };

function engine(dataDir: string, hasHistory: boolean) {
  const e = new ClaudeEngine({ dataDir, mcpBaseUrl: () => "", idleKillMs: 0 });
  const events: SessionEvent[] = [];
  const written: string[] = [];
  const i = e as unknown as { sink: unknown; ensureProc: (s: { proc?: unknown; hasHistory: boolean }) => unknown; killProc: (s: { proc?: unknown }) => void; sessions: Map<string, { busy: boolean }> };
  i.sink = { event: (_: string, ev: SessionEvent) => events.push(ev), delta: () => {} };
  i.ensureProc = (s) => {
    s.hasHistory = true;
    return (s.proc ??= { exitCode: null, stdin: { write: (l: string) => (written.push(l), true), end: () => {} } });
  };
  i.killProc = (s) => void (s.proc = undefined);
  e.attach("s1", { directory: "C:\\work", model: haiku, permissionMode: "auto", hasHistory });
  const send = async (text: string, system?: string) => {
    await e.prompt("s1", { text, files: [], model: haiku, ...(system ? { system } : {}) });
    i.sessions.get("s1")!.busy = false;
    return JSON.parse(written.at(-1)!).message.content[0].text as string;
  };
  return { e, send, events };
}

const dir = () => mkdtempSync(join(tmpdir(), "kh-system-"));

test("systemDiff: только новые и убранные строки; без изменений — пусто", () => {
  assert.equal(systemDiff("а\nб", "а\nб"), "");
  assert.equal(systemDiff("а\nб", "б\nа\n\n"), "", "порядок и пустые строки — не изменение");
  const add = systemDiff("а\nб", "а\nб\nв");
  assert.match(add, /<system-reminder>/);
  assert.match(add, /\nв\n/);
  assert.doesNotMatch(add, /\nа\n/, "старое заново не шлём");
  assert.doesNotMatch(add, /Больше не действует/);
  assert.match(systemDiff("а\nб", "а"), /Больше не действует:\n\nб/);
});

test("новая сессия: промпт даёт сам CLI, обновления нет; смена — одна новая строка и один раз; в ленте её нет", async () => {
  const { send, events } = engine(dir(), false);
  assert.equal(await send("раз", "правило 1"), "раз");
  assert.equal(await send("два", "правило 1"), "два", "без смены");
  const three = await send("три", "правило 1\nправило 2");
  assert.match(three, /^<system-reminder>[\s\S]*правило 2[\s\S]*<\/system-reminder>\n\nтри$/);
  assert.doesNotMatch(three, /правило 1/);
  assert.equal(await send("четыре", "правило 1\nправило 2"), "четыре", "второй раз не шлём");
  const shown = events.flatMap((x) => (x.type === "part.upserted" && x.part.type === "text" ? [x.part.text] : []));
  assert.deepEqual(shown, ["раз", "два", "три", "четыре"], "пользователь видит своё");
});

test("старая сессия без записи получает промпт целиком один раз; рестарт хаба не повторяет", async () => {
  const d = dir();
  const a = engine(d, true);
  const first = await a.send("раз", "правило 1\nправило 2");
  assert.match(first, /правило 1\nправило 2/);
  assert.equal(await a.send("два", "правило 1\nправило 2"), "два");
  // рестарт хаба: новый движок, тот же файл
  const b = engine(d, true);
  assert.equal(await b.send("три", "правило 1\nправило 2"), "три");
  assert.match(await b.send("четыре", "правило 1"), /Больше не действует:\n\nправило 2/);
});

test("сессия без системного промпта и команды CLI не трогаются", async () => {
  const { send } = engine(dir(), true);
  assert.equal(await send("раз"), "раз");
  // команда идёт как есть, обновление придёт со следующим обычным сообщением
  assert.equal(await send("/compact", "правило"), "/compact");
  assert.match(await send("два", "правило"), /правило[\s\S]*два$/);

});
