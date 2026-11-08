import { test } from "node:test";
import assert from "node:assert/strict";
import { mermaidSource } from "../../../web/src/mermaid.ts";

test("блок language-mermaid распознаётся как диаграмма", () => {
  const source = "flowchart LR\n  A[Вопрос] --> B{Готово?}\n";
  assert.equal(mermaidSource("language-mermaid", source), source);
  assert.equal(mermaidSource("language-MERMAID extra", ["flowchart TD\n", "A --> B"]), "flowchart TD\nA --> B");
});

test("другие блоки и inline-код не становятся диаграммами", () => {
  for (const className of [undefined, "", "language-mermaidjs", "language-js", "notlanguage-mermaid"]) {
    assert.equal(mermaidSource(className, "graph TD; A-->B"), undefined, className);
  }
  assert.equal(mermaidSource("language-mermaid", undefined), undefined);
  assert.equal(mermaidSource("language-mermaid", ["graph TD", 42]), undefined);
});
