// Построчный дифф для карточек подтверждения: только изменённое и по 2 строки контекста.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, type DiffRow } from "@kamharn/client";

const show = (rows: DiffRow[]) => rows.map((r) => (r.kind === "gap" ? `… ${r.count}` : `${{ ctx: " ", del: "-", add: "+" }[r.kind]}${r.text}`));

test("добавление функции: старое не помечается удалённым", () => {
  const oldS = "export function addTodo(text) {\n  todos.push({ text, done: false });\n}";
  const newS = oldS + "\n\nexport function toggleTodo(index) {\n  const todo = todos[index];\n}";
  assert.deepEqual(show(lineDiff(oldS, newS)), [" export function addTodo(text) {", "   todos.push({ text, done: false });", " }", "+", "+export function toggleTodo(index) {", "+  const todo = todos[index];", "+}"]);
});

test("замена строки в середине: удаление над вставкой, далёкий контекст свёрнут", () => {
  const a = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const b = [...a];
  b[4] = "E";
  assert.deepEqual(show(lineDiff(a.join("\n"), b.join("\n"))), ["… 2", " c", " d", "-e", "+E", " f", " g", "… 2"]);
});

test("удаление и вставка в разных местах, контекст 0", () => {
  assert.deepEqual(show(lineDiff("x\ny\nz\nw", "y\nz\nw\nv", 0)), ["-x", "… 3", "+v"]);
});

test("пустые строки и CRLF", () => {
  assert.deepEqual(show(lineDiff("", "new")), ["+new"]);
  assert.deepEqual(show(lineDiff("old", "")), ["-old"]);
  assert.deepEqual(show(lineDiff("a\r\nb\r\n", "a\nb\n")), ["… 3"]);
  assert.deepEqual(lineDiff("", ""), []);
});

test("огромная правка — без LCS, целиком: удаление, потом вставка", () => {
  const big = (p: string) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join("\n");
  const rows = lineDiff(big("o"), big("n"));
  assert.equal(rows.length, 5000);
  assert.equal(rows[0]!.kind, "del");
  assert.equal(rows[4999]!.kind, "add");
});
