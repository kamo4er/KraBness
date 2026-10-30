// Живые артефакты: что считается блоком-страницей, как собирается документ; подсказка агенту про артефакты
// стоит перед промптом группы и выключается настройкой.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactDocument, artifactSource, isArtifactFile, isArtifactLang } from "@kamharn/client";
import { ConfigStore } from "../../src/config.ts";
import { Db } from "../../src/db.ts";
import { FileStore } from "../../src/files.ts";
import { artifactsHint, SessionManager } from "../../src/sessions.ts";
import type { Engine } from "../../src/engines/types.ts";

test("что считается артефактом", () => {
  for (const l of ["html", "HTML", "htm", "xhtml", " html "]) assert.equal(isArtifactLang(l), true, l);
  for (const l of [undefined, "", "js", "htmlx", "mermaid", "svg"]) assert.equal(isArtifactLang(l), false, String(l));
  assert.equal(artifactSource("language-html", "<p>hi</p>"), "<p>hi</p>");
  assert.equal(artifactSource("language-HTM extra", ["<b>", "x</b>"]), "<b>x</b>");
  assert.equal(artifactSource("language-js", "x"), undefined);
  assert.equal(artifactSource(undefined, "<p>"), undefined);
  assert.equal(artifactSource("language-html", ["<p>", 1]), undefined);
  assert.equal(isArtifactFile("site/index.html"), true);
  assert.equal(isArtifactFile("a.HTM"), true);
  assert.equal(isArtifactFile("a.html.txt"), false);
});

test("документ артефакта: фрагмент оборачивается, кодировка и viewport — если их нет", () => {
  const frag = artifactDocument("<canvas></canvas>");
  assert.match(frag, /^<!doctype html><html><head><meta charset="utf-8"><meta name="viewport"[^>]+><\/head><body style="margin:0"><canvas><\/canvas><\/body><\/html>$/);
  const full = artifactDocument('<!doctype html><html lang="ru"><head><title>x</title></head><body>b</body></html>');
  assert.match(full, /<head><meta charset="utf-8"><meta name="viewport"[^>]+><title>x<\/title>/);
  const own = '<html><head><meta charset="windows-1251"><meta name="viewport" content="width=500"></head><body></body></html>';
  assert.equal(artifactDocument(own), own, "свои charset и viewport не трогаем");
  assert.match(artifactDocument("<html><body>x</body></html>"), /^<html><head><meta charset="utf-8">/);
});

test("подсказка агенту: перед промптом группы, без группы — одна, выключается настройкой", async () => {
  const base = mkdtempSync(join(tmpdir(), "kh-art-"));
  const root = join(base, "Projects");
  mkdirSync(root);
  const config = new ConfigStore(join(base, "cfg.json"), { roots: [root], dataDir: join(base, "data") });
  const db = new Db(join(base, "t.db"));
  const sessions = new SessionManager(db, config, new FileStore(db, config));
  const sent: Array<string | undefined> = [];
  const engine: Engine = {
    id: "opencode",
    start: async () => {},
    stop: async () => {},
    info: async () => ({ id: "opencode", available: true, models: [], defaultModel: { providerId: "p", modelId: "m" } }),
    createSession: async () => "es",
    attach: () => {},
    prompt: async (_e, o) => void sent.push(o.system),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    setPermissionMode: async () => {},
    forget: () => {},
  };
  await sessions.addEngine(engine);
  const g = sessions.createGroup({ name: "Дом", prompt: "Ты врач" });
  const plain = await sessions.create({ engine: "opencode", directory: root });
  const inGroup = await sessions.create({ engine: "opencode", directory: root, groupId: g.id });
  await sessions.prompt(plain.id, "раз");
  await sessions.prompt(inGroup.id, "два");
  config.config.artifactsHint = false;
  await sessions.prompt(plain.id, "три");
  await sessions.prompt(inGroup.id, "четыре");
  assert.deepEqual(sent, [artifactsHint(), `${artifactsHint()}\n\nТы врач`, undefined, "Ты врач"]);
  assert.match(artifactsHint(), /```html/);
  assert.match(artifactsHint(), /```mermaid/);
});
