// «Диспетчер» в настройках приложения: основной и запасной мозг, автопереключение, управление ПК у мозга на opencode.
import { useCallback, useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { brainDownText, brainOptions, computerHint, engineName, modelKey, parseModelKey, t, type BrainRef, type DispatcherBrains } from "@kamharn/client";
import { client, useEngines } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { EffortPicker } from "./effort.tsx";
import { Btn, Picker } from "./ui.tsx";
import { S } from "./theme.ts";

export function DispatcherSettings() {
  const engines = useEngines();
  const [b, setB] = useState<DispatcherBrains>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => void client?.dispatcherBrains().then(setB, (e: Error) => setError(e.message)), []);
  useEffect(load, [load]);
  // пока качается Windows-MCP, статус меняется сам
  useEffect(() => {
    if (b?.computer.warm !== "running") return;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [b?.computer.warm, load]);
  // старый хаб (до перезапуска) этой настройки не знает
  if (error) return <Text style={S.muted}>{t("Недоступно", "Unavailable")}: {error}. {t("Возможно, хаб нужно перезапустить.", "The hub may need a restart.")}</Text>;
  if (!b || !engines) return <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text>;

  const save = (next: Parameters<NonNullable<typeof client>["setDispatcherBrains"]>[0]) =>
    void client?.setDispatcherBrains(next).then(setB, (e: Error) => dialog(t("Не получилось", "Failed"), e.message));
  const options = brainOptions(engines);
  const picker = (title: string, cur: BrainRef | null, onChange: (v: BrainRef | null) => void, none?: string) => {
    const curKey = cur ? modelKey(cur.engine, cur.model) : "";
    return (
      <Picker
        title={title}
        value={curKey}
        options={[
          ...(none !== undefined ? [{ value: "", label: none }] : []),
          ...(cur && !options.some((o) => o.key === curKey) ? [{ value: curKey, label: cur.model.modelId }] : []),
          ...options.map((o, i) => ({
            value: o.key,
            label: o.model.name + (o.model.free ? " · free" : "") + (o.engine === "opencode" && !o.model.vision ? t(" · без зрения", " · no vision") : ""),
            ...(i === 0 || options[i - 1]!.engine !== o.engine ? { group: engineName(o.engine) } : {}),
          })),
        ]}
        onChange={(v) => onChange(parseModelKey(v) ?? null)}
      />
    );
  };
  const effort = (cur: BrainRef, onChange: (v: BrainRef) => void) => {
    const m = engines.find((e) => e.id === cur.engine)?.models.find((x) => x.providerId === cur.model.providerId && x.modelId === cur.model.modelId);
    return <EffortPicker efforts={m?.efforts ?? []} value={cur.effort ?? ""} onChange={(v) => onChange({ engine: cur.engine, model: cur.model, ...(v ? { effort: v } : {}) })} />;
  };
  const activeBrain = b.active === "fallback" && b.fallback ? b.fallback : b.primary;
  const onOpencode = b.primary.engine === "opencode" || b.fallback?.engine === "opencode";
  const hint = computerHint(b.computer);
  const until = b.until ? new Date(b.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <View style={{ gap: 10 }}>
      <Text style={S.muted}>{t("Помощник, который раздаёт работу сессиям и может управлять ПК. Чат один, а модель под ним можно менять.", "An assistant that hands out work to sessions and can control the PC. One chat, and the model under it can change.")}</Text>
      <Text style={S.text}>
        {t("Сейчас отвечает:", "Answering now:")} <Text style={{ fontWeight: "700" }}>{activeBrain.model.modelId}</Text>
        {b.active === "fallback" ? ` · ${brainDownText(b.reason)}${until ? ` ${t("до", "until")} ${until}` : ""}` : ""}
      </Text>
      {b.active === "fallback" ? <Btn small title={t("Вернуть на основной", "Back to the main one")} onPress={() => save({ backToPrimary: true })} /> : null}

      <Text style={[S.text, { fontWeight: "700" }]}>{t("Основной", "Main")}</Text>
      {picker(t("Основной мозг", "Main brain"), b.primary, (v) => v && save({ primary: v }))}
      {effort(b.primary, (v) => save({ primary: v }))}

      <Text style={[S.text, { fontWeight: "700" }]}>{t("Запасной", "Fallback")}</Text>
      {picker(t("Запасной мозг", "Fallback brain"), b.fallback, (v) => save({ fallback: v }), t("нет: ждать сброса лимита", "none: wait for the limit to reset"))}
      {b.fallback ? effort(b.fallback, (v) => save({ fallback: v })) : null}
      {b.fallback ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[S.text, { flex: 1 }]}>{t("Переключать самому и возвращать обратно", "Switch and come back automatically")}</Text>
            <Switch value={b.autoFallback} onValueChange={(v) => save({ autoFallback: v })} />
          </View>
          <Text style={S.muted}>
            {t(
              "Срабатывает, когда основной — Claude и он упёрся в лимит или нет входа. Лимиты других поставщиков переключение не запускают, их ошибка будет видна в чате.",
              "Works when the main one is Claude and it hit its limit or isn't signed in. Limits of other providers don't trigger it, their error shows in the chat.",
            )}
          </Text>
          <Text style={S.muted}>
            {t(
              "Разговор и снимки экрана уйдут поставщику запасной модели. У бесплатных моделей условия смотри у поставщика.",
              "The conversation and screenshots go to the fallback model's provider. For free models, check the provider's terms.",
            )}
          </Text>
        </>
      ) : null}

      {onOpencode ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={[S.text, { flex: 1, fontWeight: "700" }]}>{t("Управление ПК на моделях opencode", "PC control on opencode models")}</Text>
            <Switch disabled={!b.computer.available} value={b.computerOnOpencode && b.computer.available} onValueChange={(v) => save({ computerOnOpencode: v })} />
          </View>
          {hint ? <Text style={S.muted}>{hint}</Text> : null}
          <Text style={S.muted}>
            {t(
              "Снимки экрана и мышь идут без вопросов, ввод текста, клавиши, запуск программ и команды спрашивают каждый раз. Клик мышью по «Оплатить» или «Отправить» вопроса не вызовет: тут только просьба к модели спросить сама, а классификатора, как у Claude, нет.",
              "Screenshots and the mouse go without asking, typing, keys, launching programs and commands ask every time. A mouse click on “Pay” or “Send” won't ask: there is only a request to the model to ask first, and no classifier like Claude has.",
            )}
          </Text>
        </>
      ) : null}
    </View>
  );
}
