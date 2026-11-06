// Живые артефакты: блок ```html в ответе агента показывается работающей страницей (веб — iframe-песочница,
// приложение — WebView). Общее для обоих клиентов: что считать артефактом и как собрать документ.
import { t } from "./i18n.ts";

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
 * Сам запускается только целая страница или блок со скриптом/графикой. Кусок вёрстки (агент показывает правку шаблона)
 * — это код: карточка показывает его кодом с кнопкой «Запустить», иначе вместо кода была бы белая страница с обрывком.
 */
export const isRunnablePage = (src: string): boolean => /<!doctype\s+html|<html[\s>]|<body[\s>]|<script[\s>]|<canvas[\s>]|<svg[\s>]/i.test(src);

/**
 * Перехватчик ошибок страницы: текст ошибки уходит карточке (веб — postMessage родителю, приложение — мост WebView).
 * Наружу только строка; странице по-прежнему не видны ни токен, ни хаб. Синтаксис старый: WebView на старых Android — Chrome 68.
 */
const ERROR_HOOK =
  '<script>(function(){var n=0;function s(m){if(++n>20)return;var d={krabArtifactError:String(m).slice(0,400)};' +
  'try{parent.postMessage(d,"*")}catch(e){}try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(d))}catch(e){}}' +
  'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s("Failed to load: "+(t.src||t.href));return}' +
  's((e.message||"Error")+(e.lineno?" (line "+e.lineno+")":""))},true);' +
  'window.addEventListener("unhandledrejection",function(e){var r=e.reason;s("Unhandled rejection: "+((r&&r.message)||r))})})();</script>';

/** Сообщение от страницы (объект из postMessage или JSON-строка из моста WebView) → текст ошибки. */
/** столько знаков ошибки видно в карточке и уходит агенту — ровно одно и то же, без скрытого хвоста */
export const ARTIFACT_ERROR_MAX = 400;

export function artifactError(data: unknown): string | undefined {
  let d = data;
  if (typeof d === "string") {
    // мост WebView: страница может слать что угодно и сколько угодно — огромное не разбираем
    if (d.length > 4 * ARTIFACT_ERROR_MAX) return undefined;
    try {
      d = JSON.parse(d);
    } catch {
      return undefined;
    }
  }
  const m = d && typeof d === "object" ? (d as { krabArtifactError?: unknown }).krabArtifactError : undefined;
  return typeof m === "string" && m ? m.slice(0, ARTIFACT_ERROR_MAX) : undefined;
}

/** Что уходит агенту по кнопке «Отправить агенту». Текст — со страницы, поэтому ``` в нём не закроет блок. */
export const artifactFixPrompt = (error: string): string => {
  const e = error.replace(/`{3,}/g, "'''");
  return t(
    `Живая страница из твоего ответа упала с ошибкой:\n\n\`\`\`\n${e}\n\`\`\`\n\nПочини и пришли страницу заново целиком, одним блоком.`,
    `The live page from your answer failed with an error:\n\n\`\`\`\n${e}\n\`\`\`\n\nFix it and send the whole page again, in one block.`,
  );
};

/**
 * Документ для запуска: фрагмент без <html>/<body> оборачиваем в страницу; кодировка и viewport — если их нет
 * (без viewport на телефоне страница рисуется «как на ПК» и мелко); перехватчик ошибок — всегда, первым в <head>.
 */
export function artifactDocument(src: string): string {
  const head = [/<meta[^>]+charset/i.test(src) ? "" : '<meta charset="utf-8">', /<meta[^>]+name=["']?viewport/i.test(src) ? "" : '<meta name="viewport" content="width=device-width,initial-scale=1">', ERROR_HOOK].join("");
  if (/<html[\s>]/i.test(src)) return /<head[\s>]/i.test(src) ? src.replace(/<head([^>]*)>/i, `<head$1>${head}`) : src.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body style="margin:0">${src}</body></html>`;
}
