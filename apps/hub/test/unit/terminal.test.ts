// Мини-терминал: вывод (с кириллицей) кусками по смещению, код выхода, «Стоп», одна команда за раз, история.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

const win = process.platform === "win32";

test("терминал: команда в папке сессии, вывод по смещению, код выхода, стоп, история", { skip: !win && "команды Windows" }, async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const dir = join(base, "Projects", "app");
  mkdirSync(dir, { recursive: true });
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [join(base, "Projects")], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  const now = Date.now();
  hub.db.insertSession({ id: "s1", engine: "claude", engineSessionId: "e1", directory: dir, title: "t", model: { providerId: "a", modelId: "m" }, permissionMode: "auto", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(hub.urls[0] + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  const runToEnd = async (command: string) => {
    const { json } = await api("POST", "/api/sessions/s1/term", { command });
    let out = "";
    let from = 0;
    for (let i = 0; i < 200; i++) {
      const r = (await api("GET", `/api/term/${json.runId}?from=${from}`)).json as { data: string; next: number; done: boolean; exitCode?: number };
      out += r.data;
      from = r.next;
      if (r.done) return { out, exitCode: r.exitCode, runId: String(json.runId) };
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error("команда не закончилась");
  };
  try {
    const a = await runToEnd("echo привет && cd && echo ошибка 1>&2");
    assert.match(a.out, /привет/);
    assert.match(a.out, /ошибка/, "stderr тоже виден");
    assert.ok(a.out.toLowerCase().includes(dir.toLowerCase()), "команда выполнилась в папке сессии");
    assert.equal(a.exitCode, 0);
    // повторное чтение с нуля отдаёт всё, с конца — пусто
    assert.equal(((await api("GET", `/api/term/${a.runId}?from=0`)).json as { data: string }).data, a.out);
    assert.equal(((await api("GET", `/api/term/${a.runId}?from=999999`)).json as { data: string }).data, "");

    assert.equal((await runToEnd("exit /b 3")).exitCode, 3);

    const long = await api("POST", "/api/sessions/s1/term", { command: "ping -n 30 127.0.0.1" });
    const busy = await api("POST", "/api/sessions/s1/term", { command: "echo 2" });
    assert.equal(busy.status, 409, "вторая команда, пока идёт первая — нельзя");
    const info = (await api("GET", "/api/sessions/s1/term")).json as { running?: { runId: string }; history: string[] };
    assert.equal(info.running?.runId, long.json.runId);
    await api("POST", `/api/term/${long.json.runId}/stop`, {});
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      done = ((await api("GET", `/api/term/${long.json.runId}`)).json as { done: boolean }).done;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(done, "«Стоп» останавливает команду");
    assert.deepEqual(info.history.slice(0, 3), ["ping -n 30 127.0.0.1", "exit /b 3", "echo привет && cd && echo ошибка 1>&2"]);
    assert.equal((await api("POST", "/api/sessions/s1/term", { command: "  " })).status, 409);
    assert.equal((await api("GET", "/api/term/nope")).status, 404);
  } finally {
    await hub.close();
  }
});
