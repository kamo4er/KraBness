// «Разбудить ПК»: на экране «нет связи» (compact=false) и в настройках.
import { Text, View } from "react-native";
import { useWake, wakeLabel } from "./wake.ts";
import { Btn } from "./ui.tsx";
import { S } from "./theme.ts";
import { t } from "@kamharn/client";

export function WakePanel({ hint }: { hint?: string }) {
  const w = useWake();
  if (!w.available) return null;
  const busy = w.phase === "sending" || w.phase === "waiting" || w.phase === "awake";
  return (
    <View style={{ gap: 6 }}>
      {hint ? <Text style={S.text}>{hint}</Text> : null}
      <Btn kind="primary" title={t("Разбудить ПК", "Wake PC")} busy={busy} disabled={busy} onPress={() => void w.wake()} />
      {busy ? <Text style={S.muted}>{wakeLabel(w.phase)}</Text> : null}
      {w.error ? <Text style={S.error}>{w.error}</Text> : null}
    </View>
  );
}
