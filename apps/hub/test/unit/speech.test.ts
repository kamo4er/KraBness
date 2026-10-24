// Озвучка ответа: вслух — только текст, без кода, путей, ссылок и разметки.
import { test } from "node:test";
import assert from "node:assert/strict";
import { speakableText, SPEECH_MAX } from "@kamharn/client";

test("speakableText: убирает код, пути, ссылки и markdown, оставляет смысл", () => {
  const md = [
    "Итак, **сделал**. Файл `C:\\work\\DemoGame\\src\\App.tsx` поправил.",
    "",
    "## Что изменилось",
    "- кнопки считаются по `ширине`",
    "- обложка ограничена, см. [доку](https://example.com/docs)",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "| Проверка | Итог |",
    "|---|---|",
    "| тесты | ✓ |",
    "",
    "Лог лежит в ./tmp/logs/run.txt и `npm run test:unit`.",
  ].join("\n");
  const s = speakableText(md);
  assert.equal(
    s,
    ["Итак, сделал. Файл поправил.", "Что изменилось", "кнопки считаются по ширине", "обложка ограничена, см. доку", "Проверка, Итог", "тесты", "Лог лежит в и ."].join("\n"),
  );
  for (const bad of ["```", "const x", "C:\\", "https", "**", "##", "npm run"]) assert.ok(!s.includes(bad), bad);
});

test("speakableText: длинный текст режется по слову под лимит TTS", () => {
  const long = Array.from({ length: 1000 }, (_, i) => `слово${i}`).join(" ");
  const s = speakableText(long);
  assert.ok(s.length <= SPEECH_MAX + 1);
  assert.ok(s.endsWith("…"));
  assert.ok(/слово\d+…$/.test(s), "не посреди слова");
});
