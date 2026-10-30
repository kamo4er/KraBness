// Живые артефакты: блок ```html в ответе агента показывается работающей страницей (веб — iframe-песочница,
// приложение — WebView). Общее для обоих клиентов: что считать артефактом и как собрать документ.

/** Язык блока кода, который запускаем как страницу. */
export const isArtifactLang = (lang: string | undefined): boolean => /^(html?|xhtml)$/i.test((lang ?? "").trim());

/** Блок из react-markdown (`className="language-html"`, children — текст) → исходник или undefined. */
export function artifactSource(className: unknown, children: unknown): string | undefined {
  if (typeof className !== "string") return undefined;
  const lang = /(?:^|\s)language-([\w-]+)/i.exec(className)?.[1];
  if (!isArtifactLang(lang)) return undefined;
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((c) => typeof c === "string")) return children.join("");
  return undefined;
}

/** Файл, который можно запустить как страницу. */
export const isArtifactFile = (path: string): boolean => /\.x?html?$/i.test(path);

/**
 * Документ для запуска: фрагмент без <html>/<body> оборачиваем в страницу; кодировка и viewport — если их нет
 * (без viewport на телефоне страница рисуется «как на ПК» и мелко).
 */
export function artifactDocument(src: string): string {
  const head = [/<meta[^>]+charset/i.test(src) ? "" : '<meta charset="utf-8">', /<meta[^>]+name=["']?viewport/i.test(src) ? "" : '<meta name="viewport" content="width=device-width,initial-scale=1">'].join("");
  if (/<html[\s>]/i.test(src)) return /<head[\s>]/i.test(src) ? src.replace(/<head([^>]*)>/i, `<head$1>${head}`) : src.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body style="margin:0">${src}</body></html>`;
}
