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

/** Токены коротко: 640, 85 тыс, 1,2 млн, 2,7 млрд. */
export function fmtTokens(n: number): string {
  const loc = locale();
  const f1 = (x: number) => x.toLocaleString(loc, { maximumFractionDigits: x < 10 ? 1 : 0 });
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return t(`${f1(n / 1e3)} тыс`, `${f1(n / 1e3)}K`);
  if (n < 1e9) return t(`${f1(n / 1e6)} млн`, `${f1(n / 1e6)}M`);
  return t(`${f1(n / 1e9)} млрд`, `${f1(n / 1e9)}B`);
}

/** Доллары: центы — только до $10, дальше целые (в колонке таблицы суммы читаются одинаково). */
export function fmtCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return "$" + usd.toLocaleString("en-US", { maximumFractionDigits: usd < 10 ? 2 : 0, minimumFractionDigits: usd < 10 ? 2 : 0 });
}

/** Локальная дата YYYY-MM-DD (как дни в отчёте хаба). */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
