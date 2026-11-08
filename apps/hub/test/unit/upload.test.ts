// Загрузка вложений сохраняет байты как есть при любом content-type
// (регресс 2026-10-19: .json и .txt превращались в «[object Object]» — их разбирал встроенный парсер Fastify).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("JSON, текст и двоичный файл загружаются без искажений", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-up-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [root], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  try {
    const now = Date.now();
    hub.db.insertSession({ id: "ks_up", engine: "claude", engineSessionId: "e1", directory: root, title: "t", model: { providerId: "a", modelId: "m" }, permissionMode: "manual", status: "idle", createdAt: now, updatedAt: now, lastSeq: 0 });
    const cases: Array<[string, string, Buffer]> = [
      ["key.json", "application/json", Buffer.from('{"type":"service_account","private_key":"-----BEGIN"}\n')],
      ["note.txt", "text/plain; charset=utf-8", Buffer.from("привет\nмир\n")],
      ["bin.dat", "application/octet-stream", Buffer.from([0, 1, 2, 255, 0])],
    ];
    for (const [name, type, body] of cases) {
      const r = await fetch(`${hub.urls[0]}/api/sessions/ks_up/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(body) });
      assert.equal(r.status, 200, name);
      const { fileId, size } = (await r.json()) as { fileId: string; size: number };
      assert.equal(size, body.length, name);
      assert.deepEqual(readFileSync(hub.files.get(fileId)!.path), body, `${name}: байты совпадают`);
    }
    // обычные JSON-роуты по-прежнему разбирают тело
    const q = await fetch(`${hub.urls[0]}/api/quick-prompts`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompts: ["А"] }) });
    assert.deepEqual(await q.json(), ["А"]);
  } finally {
    await hub.close();
  }
});
