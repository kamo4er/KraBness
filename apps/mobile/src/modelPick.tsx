// Выбор модели opencode перед ревью и «→ opencode»: лист снизу, тап по модели — старт.
// Последний выбор запоминается и подсвечивается в следующий раз.
import { useSyncExternalStore } from "react";
import { t, type ModelRef } from "@kamharn/client";
import { recall, remember, useEngines } from "./store.ts";
import { ListSheet } from "./ui.tsx";

interface Ask {
  title: string;
  done: (m: ModelRef | undefined) => void;
}

let current: Ask | undefined;
const listeners = new Set<() => void>();
const set = (a: Ask | undefined) => {
  current = a;
  for (const l of listeners) l();
};
const KEY = "opencode.pickModel";
const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

/** Спросить модель opencode; undefined — передумали. */
export function pickOpencodeModel(title: string): Promise<ModelRef | undefined> {
  current?.done(undefined);
  return new Promise((resolve) => {
    // повторный done (закрытие после выбора) ничего не меняет и не трогает следующий запрос
    const a: Ask = { title, done: (m) => (current === a && set(undefined), resolve(m)) };
    set(a);
  });
}

export function ModelPickHost() {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current,
  );
  const oc = useEngines()?.find((e) => e.id === "opencode");
  const models = oc?.models.filter((m) => !m.offline) ?? [];
  const last = recall<string>(KEY);
  const value = [last, oc?.defaultModel && key(oc.defaultModel)].find((k) => k && models.some((m) => key(m) === k));
  return (
    <ListSheet
      visible={!!ask}
      title={ask?.title}
      value={value}
      empty={oc?.available === false ? `${t("opencode не запущен", "opencode is not running")}${oc.error ? `: ${oc.error}` : ""}` : t("Нет моделей — подключи провайдера в «Настройки → Модели»", "No models — connect a provider in “Settings → Models”")}
      options={models.map((m, i) => ({
        value: key(m),
        label: m.name + (m.free ? " · free" : ""),
        ...(i === 0 || models[i - 1]!.providerId !== m.providerId ? { group: m.providerId } : {}),
      }))}
      onPick={(v) => {
        const m = models.find((x) => key(x) === v);
        if (!m) return;
        remember(KEY, v);
        ask?.done({ providerId: m.providerId, modelId: m.modelId });
      }}
      // ListSheet зовёт onClose раньше onPick — отмену откладываем, чтобы выбор успел ответить первым
      onClose={() => setTimeout(() => ask?.done(undefined), 0)}
    />
  );
}
