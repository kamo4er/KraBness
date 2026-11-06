// Выбор исполнителя и ревьюера задачи: любая модель любого доступного движка.
// Ключ варианта — «движок|провайдер/модель», одинаковый в вебе и в приложении.
import type { BrainDownReason, DispatcherBrains, EngineId, EngineInfo, ModelInfo, ModelRef, NewSessionPrefs } from "@kamharn/protocol";
import { t } from "./i18n.ts";

export interface EngineModelOption {
  key: string;
  engine: EngineId;
  model: ModelInfo;
}

/** Движок можно звать: запущен, а у Claude Code ещё и выполнен вход. */
export const engineUsable = (e: EngineInfo): boolean => e.available && !(e.auth?.installed && !e.auth.loggedIn);

export const engineName = (e: EngineId): string => (e === "claude" ? "Claude Code" : "opencode");

export const modelKey = (engine: EngineId, m: ModelRef): string => `${engine}|${m.providerId}/${m.modelId}`;

export function parseModelKey(key: string): { engine: EngineId; model: ModelRef } | undefined {
  const [engine, rest] = key.split("|");
  if ((engine !== "claude" && engine !== "opencode") || !rest) return undefined;
  const [providerId, ...model] = rest.split("/");
  if (!providerId || !model.length) return undefined;
  return { engine, model: { providerId, modelId: model.join("/") } };
}

/**
 * Все модели доступных движков. Локальные, чей сервер сейчас не отвечает, тоже в списке (`model.offline`):
 * их показываем серыми, а не прячем — иначе непонятно, куда делась запущенная минуту назад модель.
 */
export function modelOptions(engines: EngineInfo[] | undefined): EngineModelOption[] {
  return (engines ?? []).filter(engineUsable).flatMap((e) => e.models.map((m) => ({ key: modelKey(e.id, m), engine: e.id, model: m })));
}

/** Вариант можно выбрать: модель отвечает. */
export const optionReady = (options: EngineModelOption[], key: string): boolean => options.some((o) => o.key === key && !o.model.offline);

/**
 * Что выбрано по умолчанию: исполнитель — Claude, если он подключён (сильнее в коде), иначе opencode;
 * ревьюер — opencode (бесплатные модели есть у всех), без него — тот же движок, что у исполнителя.
 * Модель движка — из настройки «Движки», без неё — модель движка по умолчанию.
 */
export function defaultTaskModels(engines: EngineInfo[] | undefined, prefs?: NewSessionPrefs): { worker?: string; review?: string } {
  const opts = modelOptions(engines);
  const pick = (engine: EngineId): string | undefined => {
    const info = engines?.find((e) => e.id === engine);
    const want = prefs?.models?.[engine] ?? info?.defaultModel;
    const mine = opts.filter((o) => o.engine === engine && !o.model.offline);
    return (want && mine.find((o) => o.key === modelKey(engine, want))?.key) ?? mine[0]?.key;
  };
  const worker = pick("claude") ?? pick("opencode");
  const review = pick("opencode") ?? (worker ? pick(parseModelKey(worker)!.engine) : undefined);
  return { ...(worker ? { worker } : {}), ...(review ? { review } : {}) };
}

/** Модели, на которых может работать Диспетчер: с инструментами и запущенные. */
export const brainOptions = (engines: EngineInfo[] | undefined): EngineModelOption[] => modelOptions(engines).filter((o) => o.model.tools !== false && !o.model.offline);

/** Почему сейчас отвечает запасной мозг. */
export function brainDownText(reason?: BrainDownReason): string {
  if (reason === "limit") return t("Claude упёрся в лимит", "Claude hit its limit");
  if (reason === "auth") return t("в Claude Code нет входа", "Claude Code is not signed in");
  return t("основной недоступен", "the main one is unavailable");
}

/** Что сказать про управление ПК на этой машине. */
export function computerHint(c: DispatcherBrains["computer"]): string {
  if (c.reason === "no-uvx") return t("Нужен uv: выполни в терминале winget install astral-sh.uv и открой настройки снова.", "Needs uv: run winget install astral-sh.uv in a terminal and open the settings again.");
  if (c.reason === "not-windows") return t("Управление ПК работает только на Windows.", "PC control works on Windows only.");
  if (c.reason === "off") return t("Управление ПК выключено в конфиге хаба.", "PC control is turned off in the hub config.");
  if (c.warm === "running") return t("Готовлю управление ПК: первый раз качается Python и пакеты, это несколько минут.", "Preparing PC control: Python and packages download the first time, it takes a few minutes.");
  if (c.warm === "failed") return t("Не удалось подготовить управление ПК. Проверь сеть и попробуй выключить и включить снова.", "Couldn't prepare PC control. Check the network and try turning it off and on again.");
  return "";
}

const flat = (s: string) => s.trim().replace(/\s+/g, " ").replace(/\.$/, "");
/** Цель задачи не уместилась в заголовок (он — её первое предложение или обрезка): показать её отдельно. */
export const goalBeyondTitle = (task: { goal: string; title: string }): boolean => flat(task.goal) !== flat(task.title);

/** Значок файла в отчёте по статусу git: A и ?? — новый, D — удалён, остальное — изменён. */
export const fileKind = (status: string): "new" | "del" | "mod" => (/^(A|\?\?)/.test(status) ? "new" : status.includes("D") ? "del" : "mod");
