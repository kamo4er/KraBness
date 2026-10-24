// Язык интерфейса: русский или английский. Строки пишутся прямо в коде парой (ru, en) — без словарей с ключами.
// Настройка одна на хабе: "auto" — каждый берёт язык своей системы (хаб — Windows, клиент — устройства/браузера).

export type Lang = "ru" | "en";
export type LangSetting = "auto" | Lang;

/** язык по локали системы: русская — русский, любая другая — английский */
export function pickLang(locale?: string): Lang {
  return /^ru([-_]|$)/i.test(locale ?? "") ? "ru" : "en";
}

/** локаль системы, где запущен код (Node, браузер, Hermes) */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en";
  }
}

/** итоговый язык: явный выбор или язык системы */
export function resolveLang(setting: LangSetting | undefined, locale = systemLocale()): Lang {
  return setting === "ru" || setting === "en" ? setting : pickLang(locale);
}

/** для toLocaleString / toLocaleDateString */
export const dateLocale = (lang: Lang): string => (lang === "ru" ? "ru-RU" : "en-US");

/** 1 файл / 2 файла / 5 файлов — 1 file / 2 files */
export function plural(lang: Lang, n: number, ru: [string, string, string], en: [string, string]): string {
  if (lang === "en") return n === 1 ? en[0] : en[1];
  const d = n % 10;
  const h = n % 100;
  return d === 1 && h !== 11 ? ru[0] : d >= 2 && d <= 4 && (h < 12 || h > 14) ? ru[1] : ru[2];
}
