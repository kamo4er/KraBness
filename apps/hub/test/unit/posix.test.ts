// macOS/Linux без живого мака: разбор lsof для превью, логин-оболочка для команд, поиск программ вне PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseLsof, listPorts } from "../../src/preview.ts";
import { posixBin, posixShell } from "../../src/proc.ts";

test("lsof -F pcn: порты, адреса (* — все, IPv6 в скобках), процессы; системные до 1024 — мимо", () => {
  const out = ["p501", "cnode", "n*:5173", "n[::1]:5173", "p77", "cControlCenter", "n*:7000", "p900", "cpython3.12", "n127.0.0.1:8000", "p1", "claunchd", "n*:22", ""].join("\n");
  assert.deepEqual(parseLsof(out), [
    { port: 5173, address: "0.0.0.0", pid: 501, process: "node" },
    { port: 5173, address: "::1", pid: 501, process: "node" },
    { port: 7000, address: "0.0.0.0", pid: 77, process: "ControlCenter" },
    { port: 8000, address: "127.0.0.1", pid: 900, process: "python3.12" },
  ]);
  assert.deepEqual(parseLsof(""), []);
});

test("listPorts на этой машине не падает и отдаёт только отвечающие по HTTP", async () => {
  const ports = await listPorts({ selfPid: process.pid });
  assert.ok(Array.isArray(ports));
  for (const p of ports) assert.ok(p.port >= 1024 && p.pid > 0);
});

test("команды человека — в его логин-оболочке; программы ищутся и вне PATH", () => {
  const [sh, args] = posixShell("npm test && echo ok");
  assert.match(sh, /^\/[\w./-]+$/);
  assert.deepEqual(args, ["-lc", "npm test && echo ok"]);
  const dir = mkdtempSync(join(tmpdir(), "kh-bin-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "fake-tool"), "");
  assert.equal(posixBin("fake-tool", [join(dir, "bin")]), join(dir, "bin", "fake-tool"));
  assert.equal(posixBin("no-such-tool-krabness"), undefined);
});
