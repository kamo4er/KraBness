// Отдача файлов с докачкой (HTTP Range).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../../src/hub.ts";

test("файл отдаётся целиком и кусками по Range", async () => {
  const base = mkdtempSync(join(tmpdir(), "kamharn-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  writeFileSync(join(root, "data.bin"), body);
  const hub = await createHub({
    configPath: join(base, "kamharn.json"),
    overrides: { listen: ["127.0.0.1"], port: 0, dataDir: join(base, "data"), roots: [root], engines: { opencode: { enabled: false, port: 0 }, claude: { enabled: false } } },
    log: () => {},
  });
  try {
    const f = await hub.files.registerOutgoing(join(root, "data.bin"), null);
    const url = `${hub.urls[0]}/api/files/${f.id}`;

    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), body);

    // докачка с места обрыва
    const tail = await fetch(url, { headers: { range: "bytes=600-" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), "bytes 600-999/1000");
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), body.subarray(600));

    const mid = await fetch(url, { headers: { range: "bytes=10-19" } });
    assert.equal(mid.headers.get("content-length"), "10");
    assert.deepEqual(Buffer.from(await mid.arrayBuffer()), body.subarray(10, 20));

    const last = await fetch(url, { headers: { range: "bytes=-5" } });
    assert.deepEqual(Buffer.from(await last.arrayBuffer()), body.subarray(995));

    const bad = await fetch(url, { headers: { range: "bytes=5000-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */1000");

    // докачка как у Android DownloadManager: без ETag он падает с ERROR_CANNOT_RESUME (1008)
    const etag = full.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(full.headers.get("last-modified"));
    const resume = await fetch(url, { headers: { range: "bytes=600-", "if-match": etag! } });
    assert.equal(resume.status, 206);
    assert.deepEqual(Buffer.from(await resume.arrayBuffer()), body.subarray(600));
    assert.equal((await fetch(url, { headers: { range: "bytes=600-", "if-match": '"old"' } })).status, 412, "файл поменялся — докачивать нельзя");
    const ifRange = await fetch(url, { headers: { range: "bytes=600-", "if-range": '"old"' } });
    assert.equal(ifRange.status, 200, "If-Range с чужим ETag — файл целиком");
    assert.equal((await ifRange.arrayBuffer()).byteLength, 1000);
  } finally {
    await hub.close();
  }
});
