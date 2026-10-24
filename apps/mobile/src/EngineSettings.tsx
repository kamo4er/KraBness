// «Движки» в настройках приложения: какие показывать в новой сессии и что выбрано по умолчанию.
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { t, type EngineId, type ModelRef, type NewSessionPrefs } from "@kamharn/client";
import { client, useEngines } from "./store.ts";
import { dialog } from "./dialog.tsx";
import { Btn, Picker } from "./ui.tsx";
import { S } from "./theme.ts";
import { ClaudeAuthBox } from "./ClaudeAuth.tsx";

const NAME: Record<EngineId, string> = { opencode: "opencode", claude: "Claude Code" };
const hint = (e: EngineId) => (e === "opencode" ? t("локальные, бесплатные и подключённые модели", "local, free and connected models") : t("нужна подписка Claude и Claude Code на ПК", "needs a Claude subscription and Claude Code on the PC"));
const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

export function EngineSettings() {
  const engines = useEngines();
  const [p, setP] = useState<NewSessionPrefs>();
  const [error, setError] = useState<string>();
  useEffect(() => void client?.newSessionPrefs().then(setP, (e: Error) => setError(e.message)), []);
  // старый хаб (до перезапуска) этой настройки не знает
  if (error) return <Text style={S.muted}>{t("Недоступно", "Unavailable")}: {error}. {t("Возможно, хаб нужно перезапустить.", "The hub may need a restart.")}</Text>;
  if (!p || !engines) return <Text style={S.muted}>{t("Загрузка…", "Loading…")}</Text>;

  const save = (next: Partial<NewSessionPrefs>) =>
    client?.saveNewSessionPrefs({ ...p, ...next }).then(setP, (e: Error) => dialog(t("Не получилось", "Failed"), e.message));

  return (
    <View style={{ gap: 12 }}>
      <Text style={S.muted}>{t("Какие движки показывать в «Новой сессии» и что там выбрано сразу. Открытые сессии продолжают работать.", "Which engines to show in “New session” and what is preselected there. Open sessions keep working.")}</Text>
      {engines.map((e) => {
        const on = p.engines.includes(e.id);
        const models = e.models.filter((m) => !m.offline);
        return (
          <View key={e.id} style={{ gap: 6, opacity: on ? 1 : 0.6 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={[S.text, { fontWeight: "700" }]}>{NAME[e.id]}</Text>
                <Text style={S.muted}>{e.available || e.auth ? hint(e.id) : `${t("недоступен", "unavailable")}: ${e.error ?? t("не запущен", "not running")}`}</Text>
              </View>
              <Switch value={on} onValueChange={(v) => void save({ engines: v ? [...p.engines, e.id] : p.engines.filter((x) => x !== e.id) })} />
            </View>
            {e.auth ? <ClaudeAuthBox initial={{ ...e.auth, ...(e.error ? { error: e.error } : {}) }} /> : null}
            {on ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Btn small kind={p.engine === e.id ? "primary" : "default"} title={p.engine === e.id ? t("✓ по умолчанию", "✓ default") : t("по умолчанию", "default")} onPress={() => void save({ engine: e.id })} />
                <Picker
                  title={t(`Модель ${NAME[e.id]} по умолчанию`, `Default ${NAME[e.id]} model`)}
                  value={p.models[e.id] ? key(p.models[e.id]!) : ""}
                  style={{ flex: 1 }}
                  options={[
                    { value: "", label: `${t("как в движке", "engine default")}${e.defaultModel ? ` (${e.defaultModel.modelId})` : ""}` },
                    ...models.map((m, i) => ({
                      value: key(m),
                      label: m.name + (m.free ? " · free" : ""),
                      ...(i === 0 || models[i - 1]!.providerId !== m.providerId ? { group: m.providerId } : {}),
                    })),
                  ]}
                  onChange={(v) => {
                    const m = models.find((x) => key(x) === v);
                    const next = { ...p.models };
                    if (m) next[e.id] = { providerId: m.providerId, modelId: m.modelId };
                    else delete next[e.id];
                    void save({ models: next });
                  }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
