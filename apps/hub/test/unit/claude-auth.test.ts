// Вход в Claude Code: реальный поток без входа (фикстура claude 2.1.302) → понятная ошибка; статус входа у настоящего CLI
// с пустой папкой конфига; свой API-ключ (проверка у поддельного Anthropic, наружу не отдаётся); окно входа на ПК.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionEvent } from "@kamharn/protocol";
import { ClaudeEngine, resolveClaudeBin } from "../../src/engines/claude.ts";
import { createHub } from "../../src/hub.ts";

const lines = readFileSync(join(import.meta.dirname, "../fixtures/claude-auth-failed.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
// настоящий claude есть только на машинах разработчиков; без него статус не проверить
const bin = resolveClaudeBin();
const hasClaude = existsSync(bin) || !!process.env.PATH?.split(";").some((d) => existsSync(join(d, "claude.exe")) || existsSync(join(d, "claude.cmd")));

test("нет входа: вместо реплики «Not logged in» — ошибка с подсказкой, сессия idle", () => {
  const evs: SessionEvent[] = [];
  const engine = new ClaudeEngine({ dataDir: "unused", mcpBaseUrl: () => "", idleKillMs: 0 });
  (engine as unknown as { sink: unknown }).sink = { event: (_: string, ev: SessionEvent) => evs.push(ev), delta: () => {} };
  engine.attach("s1", { directory: "C:\\work", model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual", hasHistory: true });
  for (const l of lines) engine.handle("s1", l);
  assert.ok(!evs.some((e) => e.type === "part.upserted" && e.part.type === "text" && /Not logged in/.test(e.part.text)), "текст CLI не показываем репликой");
  const err = evs.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && /Claude Code/.test(err.message) && /(Движки|Engines)/.test(err.message), JSON.stringify(err));
  assert.ok(evs.some((e) => e.type === "session.updated" && e.patch.status === "idle"));
});

test("статус входа и свой API-ключ через хаб", { skip: !hasClaude && "claude CLI не установлен" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-cauth-"));
  // пустая папка конфига Claude: для CLI это ПК, где вход не выполнен (настоящий вход не трогаем)
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(base, "claude-config");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  const seen: string[] = [];
  const anthropic = createServer((req, res) => {
    seen.push(String(req.headers["x-api-key"]));
    res.statusCode = req.headers["x-api-key"] === "sk-ant-good" ? 200 : 401;
    res.end("{}");
  });
  await new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", r));
  const opened: string[] = [];
  mkdirSync(join(base, "Projects"));
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    skillsDir: null,
    claudeLogin: { api: `http://127.0.0.1:${(anthropic.address() as { port: number }).port}`, openTerminal: (b) => opened.push(b) },
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: true } } },
    log: () => {},
  });
  const url = hub.urls[0]!;
  const api = async (method: string, path: string, body?: unknown) => {
    // как HubClient: content-type только с телом
    const r = await fetch(url + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: r.status, j: (await r.json()) as Record<string, unknown> };
  };
  try {
    const st = await api("GET", "/api/claude/auth");
    assert.equal(st.j.installed, true);
    assert.equal(st.j.loggedIn, false);
    assert.equal(st.j.apiKey, false);

    // без входа сессию Claude не создать: сразу понятная ошибка
    const create = await api("POST", "/api/sessions", { engine: "claude", directory: join(base, "Projects") });
    assert.equal(create.status, 409);
    assert.match(String(create.j.error), /Claude Code/);

    // окно входа открывается на ПК с путём к claude
    assert.equal((await api("POST", "/api/claude/login", {})).status, 200);
    assert.equal(opened.length, 1);

    // ключ: не похож на ключ / Anthropic не принял — не сохраняем
    assert.equal((await api("PUT", "/api/claude/key", { key: "abc" })).status, 400);
    assert.equal((await api("PUT", "/api/claude/key", { key: "sk-ant-bad" })).status, 400);
    assert.equal(hub.config.config.engines.claude.apiKey, undefined);

    // хороший ключ: сохранён, CLI видит его (ANTHROPIC_API_KEY), сам ключ наружу не уходит
    const ok = await api("PUT", "/api/claude/key", { key: "sk-ant-good" });
    assert.equal(ok.status, 200, JSON.stringify(ok.j));
    assert.deepEqual([ok.j.loggedIn, ok.j.method, ok.j.apiKey], [true, "apiKey", true]);
    assert.equal(hub.config.config.engines.claude.apiKey, "sk-ant-good");
    const engines = await (await fetch(url + "/api/engines")).text();
    assert.ok(!engines.includes("sk-ant-good"), "ключ не в списке движков");
    assert.ok(!JSON.stringify((await api("GET", "/api/claude/auth")).j).includes("sk-ant-good"));

    // убрать ключ — снова без входа
    const off = await api("DELETE", "/api/claude/key");
    assert.deepEqual([off.j.loggedIn, off.j.apiKey], [false, false]);
    assert.equal(hub.config.config.engines.claude.apiKey, undefined);
    assert.deepEqual(seen, ["sk-ant-bad", "sk-ant-good"]);
  } finally {
    await hub.close();
    anthropic.close();
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
