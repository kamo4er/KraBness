// Свои MCP-серверы: проверка ввода, секреты не утекают и не теряются, конфиги для Claude и opencode,
// перезапуск только затронутого движка, статус из init Claude, mcp-файл сессии Claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@kamharn/protocol";
import { ConfigStore } from "../../src/config.ts";
import { McpRegistry, claudeEntries, launch, normalize, opencodeEntries } from "../../src/usermcp.ts";
import { ClaudeEngine } from "../../src/engines/claude.ts";

const pw: McpServer = { name: "playwright", enabled: true, engines: "both", type: "stdio", command: "npx", args: ["-y", "@playwright/mcp"], env: { API_KEY: "s3cret" } };
const remote: McpServer = { name: "ctx", enabled: true, engines: "opencode", type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer tok" } };

test("mcp: проверка ввода и секреты при правке", () => {
  assert.throws(() => normalize({ ...pw, name: "плохое имя" }), /Имя/);
  assert.throws(() => normalize({ ...pw, name: "KamHarn" }), /занято/);
  assert.throws(() => normalize({ ...pw, command: " " }), /команду/);
  assert.throws(() => normalize({ ...remote, url: "ftp://x" }), /http или https/);
  assert.throws(() => normalize({ ...remote, url: "не адрес" }), /полный URL/);
  assert.throws(() => normalize({ ...pw, env: { "BAD KEY": "1" } }), /недопустимое имя/);
  assert.throws(() => normalize({ ...pw, type: "ws" as any }), /Тип/);
  // правка без значения — прежний секрет; новый ключ без значения — пустой; удалённый ключ пропадает
  const edited = normalize({ ...pw, env: { API_KEY: "", OTHER: "" } }, pw);
  assert.deepEqual(edited.env, { API_KEY: "s3cret", OTHER: "" });
  assert.equal(normalize({ ...pw, env: {} }, pw).env, undefined);
  assert.deepEqual(normalize({ ...remote, headers: { Authorization: "" } }, remote).headers, { Authorization: "Bearer tok" });
  // адрес или команда сменились — прежние секреты туда не уходят
  assert.deepEqual(normalize({ ...remote, url: "https://evil.example/mcp", headers: { Authorization: "" } }, remote).headers, { Authorization: "" });
  assert.deepEqual(normalize({ ...pw, command: "node", env: { API_KEY: "" } }, pw).env, { API_KEY: "" });
  assert.deepEqual(normalize({ ...pw, args: ["-y", "", "@playwright/mcp"] }).args, ["-y", "@playwright/mcp"]);
});

test("mcp: npx на Windows — через cmd /c, на остальных как есть", () => {
  assert.deepEqual(launch("npx", ["-y", "x"], "win32"), ["cmd", "/c", "npx", "-y", "x"]);
  assert.deepEqual(launch("tool.cmd", [], "win32"), ["cmd", "/c", "tool.cmd"]);
  assert.deepEqual(launch("uvx", ["x"], "win32"), ["uvx", "x"]);
  assert.deepEqual(launch("npx", ["-y", "x"], "linux"), ["npx", "-y", "x"]);
});

test("mcp: конфиги для Claude и opencode — только включённые и свои для движка", () => {
  const off: McpServer = { ...pw, name: "off", enabled: false };
  const onlyClaude: McpServer = { name: "sse1", enabled: true, engines: "claude", type: "sse", url: "http://127.0.0.1:9000/sse" };
  const list = [pw, remote, off, onlyClaude];
  const c = claudeEntries(list);
  assert.deepEqual(Object.keys(c).sort(), ["playwright", "sse1"]);
  assert.deepEqual(c.playwright, { type: "stdio", command: launch("npx")[0], args: launch("npx", ["-y", "@playwright/mcp"]).slice(1), env: { API_KEY: "s3cret" } });
  assert.deepEqual(c.sse1, { type: "sse", url: "http://127.0.0.1:9000/sse" });
  const o = opencodeEntries(list);
  assert.deepEqual(Object.keys(o).sort(), ["ctx", "playwright"]);
  assert.deepEqual(o.playwright, { type: "local", command: launch("npx", ["-y", "@playwright/mcp"]), enabled: true, environment: { API_KEY: "s3cret" } });
  assert.deepEqual(o.ctx, { type: "remote", url: "https://mcp.example.com/mcp", enabled: true, oauth: false, headers: { Authorization: "Bearer tok" } });
});

test("mcp: реестр — значения не отдаёт, перезапускает только затронутый движок, статус из init", async () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  const calls: string[] = [];
  const reg = new McpRegistry(config, {
    claudeChanged: () => void calls.push("claude"),
    opencodeChanged: async () => void calls.push("opencode"),
    opencodeStatus: async () => ({ ctx: { status: "failed", error: "401" }, playwright: { status: "connected" } }),
    claudeUser: () => ({ enabled: false, servers: ["blender"] }),
  });
  let ov = await reg.save(undefined, pw);
  assert.deepEqual(calls, ["claude", "opencode"]);
  assert.ok(!JSON.stringify(ov).includes("s3cret"), "секрет не уходит клиенту");
  assert.deepEqual(ov.servers[0]!.envKeys, ["API_KEY"]);
  assert.deepEqual(ov.claude, { enabled: false, servers: ["blender"] });

  calls.length = 0;
  ov = await reg.save(undefined, remote);
  assert.deepEqual(calls, ["opencode"], "сервер только для opencode — Claude не трогаем");
  assert.deepEqual(ov.servers.find((s) => s.name === "ctx")!.status.opencode?.error, "401");
  await assert.rejects(reg.save(undefined, { ...remote, name: "CTX" }), /уже есть/);

  reg.noteClaudeInit([{ name: "playwright", status: "connected", source: "dynamic" }, { name: "kamharn", status: "connected" }]);
  ov = await reg.overview();
  const p = ov.servers.find((s) => s.name === "playwright")!;
  assert.equal(p.status.claude?.status, "connected");
  assert.equal(p.status.opencode?.status, "connected");

  // правка с пустым секретом и переименованием: ключ сохранился, имя новое
  calls.length = 0;
  await reg.save("playwright", { ...pw, name: "pw", env: { API_KEY: "" } });
  assert.deepEqual(config.config.mcpServers!.map((s) => s.name), ["pw", "ctx"]);
  assert.equal(config.config.mcpServers![0]!.env!.API_KEY, "s3cret");
  // выключили — оба движка перезапускаются, удалили — сервер пропал
  calls.length = 0;
  await reg.save("pw", { ...pw, name: "pw", enabled: false });
  assert.deepEqual(calls, ["claude", "opencode"]);
  await reg.remove("ctx");
  await assert.rejects(reg.remove("nope"), /нет/);
  assert.deepEqual(config.config.mcpServers!.map((s) => s.name), ["pw"]);
});

test("mcp: переименование не тащит старый статус; сбой перезапуска opencode — не ошибка сохранения", async () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  let fail = false;
  const reg = new McpRegistry(config, {
    claudeChanged: () => {},
    opencodeChanged: async () => {
      if (fail) throw new Error("порт занят");
    },
    claudeUser: () => ({ enabled: false, servers: [] }),
  });
  await reg.save(undefined, { ...pw, engines: "claude" });
  reg.noteClaudeInit([{ name: "playwright", status: "connected" }]);
  let ov = await reg.save("playwright", { ...pw, engines: "claude", name: "browser", env: { API_KEY: "" } });
  assert.equal(ov.servers[0]!.name, "browser");
  assert.equal(ov.servers[0]!.status.claude, undefined, "у нового имени статуса ещё нет");
  // и если вернуть старое имя — давний статус не воскресает
  ov = await reg.save("browser", { ...pw, engines: "claude", name: "playwright", env: { API_KEY: "" } });
  assert.equal(ov.servers[0]!.status.claude, undefined);

  fail = true;
  ov = await reg.save(undefined, remote);
  assert.match(ov.opencodeError!, /не перезапустился: порт занят/);
  assert.ok(config.config.mcpServers!.some((s) => s.name === "ctx"), "сохранено, несмотря на сбой перезапуска");
});

test("mcp: свои серверы попадают в mcp-файл сессии Claude рядом со служебным kamharn", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kamharn-"));
  mkdirSync(join(dataDir, "claude-mcp"));
  const engine = new ClaudeEngine({
    bin: join(dataDir, "нет-такого-claude.exe"),
    dataDir,
    mcpBaseUrl: () => "http://127.0.0.1:1/mcp/x",
    extraMcp: () => claudeEntries([pw, { ...pw, name: "kamharn" }]),
    idleKillMs: 0,
  });
  engine.attach("s1", { directory: dataDir, model: { providerId: "anthropic", modelId: "claude-haiku-5-5" }, permissionMode: "manual" });
  const s = (engine as any).sessions.get("s1");
  try {
    (engine as any).ensureProc(s)?.on?.("error", () => {});
  } catch {
    /* бинарника нет — нам нужен только файл */
  }
  const file = JSON.parse(readFileSync(join(dataDir, "claude-mcp", "s1.json"), "utf8"));
  assert.deepEqual(Object.keys(file.mcpServers).sort(), ["kamharn", "playwright"]);
  assert.equal(file.mcpServers.kamharn.url, "http://127.0.0.1:1/mcp/x/s1", "служебный сервер не подменить своим с тем же именем");
  assert.equal(file.mcpServers.playwright.env.API_KEY, "s3cret");
  engine.forget("s1");
});
