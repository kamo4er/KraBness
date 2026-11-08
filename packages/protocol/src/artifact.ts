// Живые страницы: что считать страницей. Общее для клиентов (карточка в чате) и хаба (бот сессии в Telegram шлёт её файлом).

/** Язык блока кода, который запускаем как страницу. */
export const isArtifactLang = (lang: string | undefined): boolean => /^(html?|xhtml)$/i.test((lang ?? "").trim());

/**
 * Сам запускается только целая страница или блок со скриптом/графикой. Кусок вёрстки (агент показывает правку шаблона)
 * — это код: карточка показывает его кодом с кнопкой «Запустить», иначе вместо кода была бы белая страница с обрывком.
 */
export const isRunnablePage = (src: string): boolean => /<!doctype\s+html|<html[\s>]|<body[\s>]|<script[\s>]|<canvas[\s>]|<svg[\s>]/i.test(src);

/**
 * Страница целиком: фрагмент без <html>/<body> оборачиваем; кодировка и viewport — если их нет (без viewport на телефоне
 * страница рисуется «как на ПК» и мелко). extraHead — в начало <head>, после них (клиенты кладут туда перехватчик ошибок).
 * Замена функцией: «$&», «$1» в тексте страницы не должны срабатывать как шаблон замены.
 */
export function pageDocument(src: string, extraHead = ""): string {
  const head = [/<meta[^>]+charset/i.test(src) ? "" : '<meta charset="utf-8">', /<meta[^>]+name=["']?viewport/i.test(src) ? "" : '<meta name="viewport" content="width=device-width,initial-scale=1">', extraHead].join("");
  if (/<html[\s>]/i.test(src)) return /<head[\s>]/i.test(src) ? src.replace(/<head[^>]*>/i, (m) => m + head) : src.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body style="margin:0">${src}</body></html>`;
}
