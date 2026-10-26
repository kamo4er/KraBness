// Форматирование списков: «2 ч назад» и имя проекта из пути.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, baseName, applyLangSetting } from "@kamharn/client";

applyLangSetting("ru"); // язык фиксирован, иначе строки зависят от локали машины
const NOW = 1_700_000_000_000;
const min = (n: number) => NOW - n * 60_000;
const hour = (n: number) => NOW - n * 3_600_000;
const day = (n: number) => NOW - n * 86_400_000;

test("ago(): только что, минуты, часы, вчера, дни", () => {
  assert.equal(ago(NOW, NOW), "только что");
  assert.equal(ago(NOW - 30_000, NOW), "только что", "меньше минуты");
  assert.equal(ago(min(1), NOW), "1 мин назад");
  assert.equal(ago(min(30), NOW), "30 мин назад");
  assert.equal(ago(min(59), NOW), "59 мин назад");
  assert.equal(ago(hour(1), NOW), "1 ч назад");
  assert.equal(ago(hour(23), NOW), "23 ч назад");
  assert.equal(ago(day(1), NOW), "вчера");
  assert.equal(ago(day(2), NOW), "2 дн назад");
  assert.equal(ago(day(6), NOW), "6 дн назад");
});

test("ago(): 7 дней и больше — дата без «назад»", () => {
  for (const n of [7, 10, 30, 200]) {
    const s = ago(day(n), NOW);
    assert.ok(s.length > 0, "пустая строка");
    assert.ok(!s.includes("назад"), `для ${n} дн expected дата, got ${s}`);
  }
});

test("baseName(): последняя папка пути", () => {
  assert.equal(baseName("C:\\work\\KraBness"), "KraBness");
  assert.equal(baseName("C:\\work\\KraBness\\"), "KraBness", "слеш на конце");
  assert.equal(baseName("/home/u/projects/KraBness"), "KraBness");
  assert.equal(baseName("C:\\work\\KraBness/"), "KraBness", "смешанные разделители");
  assert.equal(baseName("KraBness"), "KraBness", "без папок");
  assert.equal(baseName(""), "", "пустой путь остаётся пустым");
});
