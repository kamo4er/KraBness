// Выбор исполнителя и ревьюера задачи: любая модель любого доступного движка.
// Ключ варианта — «движок|провайдер/модель», одинаковый в вебе и в приложении.
import type { EngineId, EngineInfo, ModelInfo, ModelRef, NewSessionPrefs } from "@kamharn/protocol";

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

/** Все модели доступных движков (локальные серверы, которые сейчас не отвечают, — мимо). */
export function modelOptions(engines: EngineInfo[] | undefined): EngineModelOption[] {
  return (engines ?? []).filter(engineUsable).flatMap((e) => e.models.filter((m) => !m.offline).map((m) => ({ key: modelKey(e.id, m), engine: e.id, model: m })));
}

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
    const mine = opts.filter((o) => o.engine === engine);
    return (want && mine.find((o) => o.key === modelKey(engine, want))?.key) ?? mine[0]?.key;
  };
  const worker = pick("claude") ?? pick("opencode");
  const review = pick("opencode") ?? (worker ? pick(parseModelKey(worker)!.engine) : undefined);
  return { ...(worker ? { worker } : {}), ...(review ? { review } : {}) };
}
