// Живые артефакты: блок ```html в ответе агента показывается работающей страницей (веб — iframe-песочница,
// приложение — WebView). Общее для обоих клиентов: что считать артефактом и как собрать документ.
// что считать страницей — в protocol: это нужно и хабу (бот сессии в Telegram)
import { isArtifactLang, pageDocument } from "@kamharn/protocol";
import { t } from "./i18n.ts";
export { isArtifactLang, isRunnablePage } from "@kamharn/protocol";

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
 * Перехватчик ошибок страницы: текст ошибки уходит карточке (веб — postMessage родителю, приложение — мост WebView).
 * Наружу только строка; странице по-прежнему не видны ни токен, ни хаб. Синтаксис старый: WebView на старых Android — Chrome 68.
 */
const ERROR_HOOK =
  '<script>(function(){var n=0;function s(m){if(++n>20)return;var d={krabArtifactError:String(m).slice(0,400)};' +
  'try{parent.postMessage(d,"*")}catch(e){}try{window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(d))}catch(e){}}' +
  'window.addEventListener("error",function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href)){s("Failed to load: "+(t.src||t.href));return}' +
  's((e.message||"Error")+(e.lineno?" (line "+e.lineno+")":""))},true);' +
  'window.addEventListener("unhandledrejection",function(e){var r=e.reason;s("Unhandled rejection: "+((r&&r.message)||r))});' +
  // высота документа — только родителю (веб подстраивает карточку); в мост телефона не шлём: там высота фиксирована
  // мерим низ body и низ всех элементов (не больше 3000): высота документа не бывает меньше окна, карточка только росла бы;
  // а у сцены с position:fixed или вёрстки на absolute body пустой, по одному body карточка схлопнулась бы.
  // Телефону (parent === window) высота не нужна — там и таймер не заводим
  'if(parent!==window){var last=0;var bot=function(el){var r=el.getBoundingClientRect();return r.bottom+(window.pageYOffset||0)};' +
  'var h=function(){var b=document.body;if(!b)return;var v=bot(b)+(parseFloat(getComputedStyle(b).marginBottom)||0),m=b.getElementsByTagName("*");' +
  'for(var i=0;i<m.length&&i<3000;i++)v=Math.max(v,bot(m[i]));v=Math.ceil(v);' +
  'if(v&&Math.abs(v-last)>4){last=v;try{parent.postMessage({krabArtifactHeight:v},"*")}catch(e){}}};' +
  'window.addEventListener("load",h);window.addEventListener("resize",h);setInterval(h,700)}})();</script>';

/** Сообщение от страницы → её высота (веб подстраивает под неё карточку). */
export function artifactHeight(data: unknown): number | undefined {
  const v = data && typeof data === "object" ? (data as { krabArtifactHeight?: unknown }).krabArtifactHeight : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

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
export const artifactDocument = (src: string): string => pageDocument(src, ERROR_HOOK);
