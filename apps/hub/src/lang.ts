// Язык сообщений хаба (ошибки, уведомления, бот, промпты агенту). Один на процесс: хаб обслуживает одного человека.
import { resolveLang, type Lang, type LangSetting } from "@kamharn/protocol";

let lang: Lang = resolveLang(undefined);

export const hubLang = (): Lang => lang;

/** "auto" или пусто — язык Windows */
export function setHubLang(setting?: LangSetting): void {
  lang = resolveLang(setting);
}

/** строка на языке хаба: L("Нет папки", "No such folder") */
export const L = (ru: string, en: string): string => (lang === "ru" ? ru : en);
