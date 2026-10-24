// Базовые элементы: кнопка, выбор из списка (вместо <select>), бейдж движка, индикатор связи.
import { useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { limitView, type ClaudeLimits, type ConnState, type EngineId, t } from "@kamharn/client";
import { C } from "./theme.ts";

type Kind = "default" | "primary" | "danger" | "ghost";

export function Btn(props: {
  title?: string;
  children?: ReactNode;
  onPress?: () => void;
  kind?: Kind;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const kind = props.kind ?? "default";
  const off = props.disabled || props.busy;
  return (
    <Pressable
      onPress={off ? undefined : props.onPress}
      style={({ pressed }) => [b.btn, b[kind], props.small && b.small, off && b.off, pressed && !off && b.pressed, props.style]}
    >
      {props.busy ? <ActivityIndicator size="small" color={C.text} /> : null}
      {props.title !== undefined ? <Text style={[b.label, props.small && b.labelSmall]}>{props.title}</Text> : props.children}
    </Pressable>
  );
}

const b = StyleSheet.create({
  btn: { flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, minHeight: 42 },
  default: { backgroundColor: C.bg3, borderWidth: 1, borderColor: C.line },
  primary: { backgroundColor: C.accent },
  danger: { backgroundColor: "#3a1d22", borderWidth: 1, borderColor: "#5b2630" },
  ghost: { backgroundColor: "transparent" },
  small: { paddingHorizontal: 10, paddingVertical: 6, minHeight: 32, borderRadius: 8 },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  label: { color: C.text, fontSize: 15, fontWeight: "600" },
  labelSmall: { fontSize: 13 },
});

export interface Option {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  /** заголовок группы перед этим пунктом */
  group?: string;
}

/** Компактный выбор: показывает текущее значение, по нажатию — список снизу. */
export function Picker(props: { value?: string; options: Option[]; onChange: (v: string) => void; placeholder?: string; style?: StyleProp<ViewStyle>; title?: string }) {
  const [open, setOpen] = useState(false);
  const cur = props.options.find((o) => o.value === props.value);
  return (
    <>
      <Pressable style={[p.field, props.style]} onPress={() => setOpen(true)}>
        <Text style={p.value} numberOfLines={1}>
          {cur?.label ?? props.placeholder ?? "—"}
        </Text>
        <Text style={p.caret}>▾</Text>
      </Pressable>
      <ListSheet
        visible={open}
        title={props.title}
        options={props.options}
        value={props.value}
        onClose={() => setOpen(false)}
        onPick={(v) => v !== props.value && props.onChange(v)}
      />
    </>
  );
}

/** Список выбора снизу экрана (используют Picker и меню). */
export function ListSheet(props: { visible: boolean; title?: string; options: Option[]; value?: string; empty?: string; onPick: (v: string) => void; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={p.backdrop} onPress={props.onClose}>
        <View style={[p.sheet, { paddingBottom: insets.bottom + 8 }]}>
          {props.title ? <Text style={p.title}>{props.title}</Text> : null}
          {!props.options.length && props.empty ? <Text style={[p.hint, { padding: 16 }]}>{props.empty}</Text> : null}
          <FlatList
            data={props.options}
            keyExtractor={(o) => o.value}
            renderItem={({ item }) => (
              <>
                {item.group ? <Text style={p.group}>{item.group}</Text> : null}
                <Pressable
                  style={({ pressed }) => [p.item, item.value === props.value && p.itemOn, pressed && p.pressed, item.disabled && p.disabled]}
                  onPress={() => {
                    if (item.disabled) return;
                    props.onClose();
                    props.onPick(item.value);
                  }}
                >
                  <Text style={p.itemText}>{item.label}</Text>
                  {item.hint ? <Text style={p.hint}>{item.hint}</Text> : null}
                </Pressable>
              </>
            )}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

const p = StyleSheet.create({
  field: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: C.bg3, borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 10, paddingVertical: 6, minHeight: 34 },
  value: { color: C.text, fontSize: 13, flexShrink: 1 },
  caret: { color: C.muted, fontSize: 12 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,.55)", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.bg2, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%", paddingTop: 8 },
  title: { color: C.muted, fontSize: 13, fontWeight: "600", paddingHorizontal: 18, paddingVertical: 8, textTransform: "uppercase" },
  group: { color: C.muted, fontSize: 12, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 4 },
  item: { paddingHorizontal: 18, paddingVertical: 13 },
  itemOn: { backgroundColor: C.bg3 },
  itemText: { color: C.text, fontSize: 15 },
  hint: { color: C.muted, fontSize: 12, marginTop: 2 },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
});

export function EngineBadge({ engine }: { engine: EngineId }) {
  const color = engine === "claude" ? C.claude : C.opencode;
  return (
    <View style={[eb.badge, { borderColor: color }]}>
      <Text style={[eb.text, { color }]}>{engine.toUpperCase()}</Text>
    </View>
  );
}

const eb = StyleSheet.create({
  badge: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  text: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
});

const CONN_COLOR: Record<ConnState, string> = { online: C.ok, connecting: C.warn, offline: C.err, unauthorized: C.err };
/** состояние связи словами — на текущем языке */
export const connLabel = (c: ConnState): string =>
  ({ online: t("на связи", "online"), connecting: t("подключаюсь…", "connecting…"), offline: t("нет связи", "offline"), unauthorized: t("нужно подключение", "pairing needed") })[c];

export function ConnDot({ conn }: { conn: ConnState }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: CONN_COLOR[conn] }} />;
}

/** Лимиты подписки Claude: окна 5 часов и неделя в процентах (по последнему ответу Claude). */
export function Limits({ limits, style }: { limits?: ClaudeLimits; style?: StyleProp<ViewStyle> }) {
  const v = limitView(limits);
  if (!v) return null;
  const color = v.level === "danger" ? C.err : v.level === "warn" ? C.warn : C.muted;
  const reset = [v.fiveHourReset && `${t("сброс", "resets")} ${v.fiveHourReset}`, v.sevenDayReset && `${t("нед.", "wk")} ${v.sevenDayReset}`].filter(Boolean).join(", ");
  return (
    <View style={style}>
      <Text style={{ color, fontSize: 12 }} numberOfLines={1}>
        Claude: {t("5ч", "5h")} {v.fiveHour ?? "—"}% · {t("неделя", "week")} {v.sevenDay ?? "—"}%{reset ? <Text style={{ color: C.muted }}> · {reset}</Text> : null}
      </Text>
    </View>
  );
}
