// Текущий язык клиента (веб, приложение). Настройка приходит от хаба (hello / {t:"language"});
// "auto" — язык устройства/браузера. Строки в коде парой: t("Новая сессия", "New session").
import { dateLocale, plural, resolveLang, type Lang, type LangSetting } from "@kamharn/protocol";

let setting: LangSetting = "auto";
let lang: Lang = resolveLang("auto");
const listeners = new Set<() => void>();

export const getLang = (): Lang => lang;
export const getLangSetting = (): LangSetting => setting;

/** применить настройку (от хаба или из сохранённого на устройстве) */
export function applyLangSetting(s: LangSetting | undefined): void {
  const next = s ?? "auto";
  const nextLang = resolveLang(next);
  if (next === setting && nextLang === lang) return;
  setting = next;
  lang = nextLang;
  for (const l of listeners) l();
}

export function onLangChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** строка на текущем языке */
export const t = (ru: string, en: string): string => (lang === "ru" ? ru : en);

/** 1 файл / 2 файла / 5 файлов — 1 file / 2 files (вместе с числом) */
export const tn = (n: number, ru: [string, string, string], en: [string, string]): string => `${n} ${plural(lang, n, ru, en)}`;

/** локаль для дат и чисел */
export const locale = (): string => dateLocale(lang);
