// Форматирование для списков (веб и приложение): «2 ч назад», имя проекта из пути.
import { locale, t } from "./i18n.ts";

export function ago(ts: number, now = Date.now()): string {
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return t("только что", "just now");
  if (min < 60) return t(`${min} мин назад`, `${min} min ago`);
  const h = Math.floor(min / 60);
  if (h < 24) return t(`${h} ч назад`, `${h} h ago`);
  const d = Math.floor(h / 24);
  if (d === 1) return t("вчера", "yesterday");
  if (d < 7) return t(`${d} дн назад`, `${d} days ago`);
  return new Date(ts).toLocaleDateString(locale(), { day: "numeric", month: "short" });
}

/** последняя папка пути: C:\work\KraBness → KraBness */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
