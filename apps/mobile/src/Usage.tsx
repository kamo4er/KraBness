// Расход токенов на телефоне: итог за период, календарь месяца (дни раскрашены по расходу, два нажатия — свой период),
// столбцы по дням, по моделям и сессиям. Так же, как в вебе (apps/web/src/Usage.tsx).
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { fmtCost, fmtTokens, localDay, locale, t, type UsageReport, type UsageTotals } from "@kamharn/client";
import { client, useHub } from "./store.ts";
import { go } from "./nav.ts";
import { Btn } from "./ui.tsx";
import { C, S } from "./theme.ts";

/** ступени тепловой карты (один синий; на тёмном фоне больше — светлее), проверены валидатором палитры */
const HEAT = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
const BAR = "#3987e5";

type Preset = "today" | "week" | "month30" | "thisMonth" | "custom";

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => parseDay(day).toLocaleDateString(locale(), opts);

function presetRange(p: Exclude<Preset, "custom">): { from: string; to: string } {
  const now = new Date();
  const to = localDay(now);
  if (p === "today") return { from: to, to };
  if (p === "week") return { from: localDay(addDays(now, -6)), to };
  if (p === "month30") return { from: localDay(addDays(now, -29)), to };
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = parseDay(from); localDay(d) <= to && out.length < 400; d = addDays(d, 1)) out.push(localDay(d));
  return out;
}

export function UsagePage() {
  const [preset, setPreset] = useState<Preset>("thisMonth");
  const [range, setRange] = useState(() => presetRange("thisMonth"));
  const [pending, setPending] = useState<string>();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [report, setReport] = useState<UsageReport>();
  const [monthDays, setMonthDays] = useState<Record<string, UsageTotals>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    client?.usageReport(range.from, range.to).then(
      (r) => alive && (setReport(r), setError(undefined)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [range.from, range.to]);

  useEffect(() => {
    let alive = true;
    client?.usageReport(localDay(month), localDay(new Date(month.getFullYear(), month.getMonth() + 1, 0))).then(
      (r) => alive && setMonthDays(Object.fromEntries(r.days.map((d) => [d.day, d]))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [month]);

  const pick = (p: Exclude<Preset, "custom">) => {
    setPreset(p);
    setPending(undefined);
    const r = presetRange(p);
    setRange(r);
    setMonth(new Date(parseDay(r.to).getFullYear(), parseDay(r.to).getMonth(), 1));
  };
  const tapDay = (day: string) => {
    setPreset("custom");
    if (!pending) {
      setPending(day);
      setRange({ from: day, to: day });
    } else {
      setRange(pending < day ? { from: pending, to: day } : { from: day, to: pending });
      setPending(undefined);
    }
  };

  const total = report?.total;
  const title = range.from === range.to ? fmtDay(range.from, { day: "numeric", month: "long", year: "numeric" }) : `${fmtDay(range.from)} — ${fmtDay(range.to)}`;
  const presets: Array<[Exclude<Preset, "custom">, string]> = [
    ["today", t("Сегодня", "Today")],
    ["week", t("7 дней", "7 days")],
    ["month30", t("30 дней", "30 days")],
    ["thisMonth", t("Месяц", "Month")],
  ];

  return (
    <View style={{ gap: 12 }}>
      <View style={st.row}>
        {presets.map(([id, label]) => (
          <Btn key={id} small kind={preset === id ? "primary" : undefined} title={label} onPress={() => pick(id)} />
        ))}
      </View>
      <Text style={S.h3}>{title}</Text>
      {error ? <Text style={S.error}>{error}</Text> : null}
      <View style={st.tiles}>
        <Tile label={t("Новые токены", "New tokens")} value={total ? fmtTokens(total.tokens) : "…"} hint={total ? t(`ввод ${fmtTokens(total.input)} · вывод ${fmtTokens(total.output)} · в кэш ${fmtTokens(total.cacheWrite)}`, `in ${fmtTokens(total.input)} · out ${fmtTokens(total.output)} · cache write ${fmtTokens(total.cacheWrite)}`) : ""} wide />
        <Tile label={t("Из кэша", "From cache")} value={total ? fmtTokens(total.cacheRead) : "…"} hint={t("контекст, перечитанный за ходы", "context re-read every turn")} />
        <Tile label={t("Как по API", "At API prices")} value={total ? fmtCost(total.cost) : "…"} hint={total?.costUnknown ? t("часть моделей без цены", "some models have no price") : t("ориентир, не счёт", "a reference, not a bill")} />
      </View>

      <Calendar month={month} setMonth={setMonth} days={monthDays} range={range} pending={pending} onDay={tapDay} />

      {report && range.from !== range.to ? (
        <>
          <Text style={S.h3}>{t("По дням", "By day")}</Text>
          <Bars days={daysBetween(range.from, range.to)} data={Object.fromEntries(report.days.map((d) => [d.day, d]))} />
        </>
      ) : null}

      {report ? (
        <>
          <Text style={S.h3}>{t("По моделям", "By model")}</Text>
          {report.models.length ? (
            report.models.map((m) => (
              <View key={m.engine + m.model} style={st.line}>
                <Text style={[S.text, { flex: 1 }]} numberOfLines={1}>
                  {m.model || "?"} <Text style={S.muted}>{m.engine}</Text>
                </Text>
                <Text style={st.num}>{fmtTokens(m.tokens)}</Text>
                <Text style={[st.num, st.cost]}>{m.costUnknown && !m.cost ? "—" : fmtCost(m.cost)}</Text>
              </View>
            ))
          ) : (
            <Text style={S.muted}>{t("За этот период расхода нет.", "No usage in this period.")}</Text>
          )}
        </>
      ) : null}

      {report && report.sessions.length ? (
        <>
          <Text style={S.h3}>{t("По сессиям", "By session")}</Text>
          {report.sessions.map((s) => (
            <Pressable key={s.sessionId} disabled={s.deleted} onPress={() => go({ page: "session", id: s.sessionId })} style={st.line}>
              <Text style={[s.deleted ? S.muted : S.text, { flex: 1 }]} numberOfLines={1}>
                {s.deleted ? t("(сессия удалена)", "(session deleted)") : s.title || s.sessionId}
              </Text>
              <Text style={st.num}>{fmtTokens(s.tokens)}</Text>
              <Text style={[st.num, st.cost]}>{fmtCost(s.cost)}</Text>
            </Pressable>
          ))}
        </>
      ) : null}

      <Text style={S.muted}>
        {t(
          "Считаются сессии KraBness; Claude Code в VS Code или терминале — нет. «Как по API» — ориентир: по подписке платишь фиксированно.",
          "Only KraBness sessions are counted; Claude Code in VS Code or a terminal isn't. “At API prices” is a reference: a subscription is a flat fee.",
        )}
      </Text>
    </View>
  );
}

function Tile({ label, value, hint, wide }: { label: string; value: string; hint: string; wide?: boolean }) {
  return (
    <View style={[st.tile, wide ? { flexBasis: "100%" } : null]}>
      <Text style={S.muted}>{label}</Text>
      <Text style={st.tileValue}>{value}</Text>
      {hint ? <Text style={[S.muted, { fontSize: 12 }]}>{hint}</Text> : null}
    </View>
  );
}

function Calendar({
  month,
  setMonth,
  days,
  range,
  pending,
  onDay,
}: {
  month: Date;
  setMonth: (d: Date) => void;
  days: Record<string, UsageTotals>;
  range: { from: string; to: string };
  pending?: string;
  onDay: (day: string) => void;
}) {
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7;
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => localDay(new Date(month.getFullYear(), month.getMonth(), i + 1)))];
  }, [month]);
  const max = Math.max(0, ...Object.values(days).map((d) => d.tokens));
  const level = (v: number) => (v <= 0 || max <= 0 ? -1 : Math.min(HEAT.length - 1, Math.floor((v / max) * HEAT.length)));
  const today = localDay(new Date());
  const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 26 + i).toLocaleDateString(locale(), { weekday: "short" }));
  const [tip, setTip] = useState<string>();
  const tipDay = tip && days[tip];
  return (
    <View style={st.cal}>
      <View style={st.calHead}>
        <Btn small kind="ghost" title="‹" onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
        <Text style={[S.text, { fontWeight: "600" }]}>{month.toLocaleDateString(locale(), { month: "long", year: "numeric" })}</Text>
        <Btn small kind="ghost" title="›" disabled={month >= thisMonth} onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
      </View>
      <View style={st.grid}>
        {weekdays.map((w) => (
          <Text key={w} style={[st.cell, S.muted, { textAlign: "center", fontSize: 11 }]}>
            {w}
          </Text>
        ))}
        {cells.map((day, i) => {
          if (!day) return <View key={`e${i}`} style={st.cell} />;
          const lv = level(days[day]?.tokens ?? 0);
          const inRange = day >= range.from && day <= range.to;
          return (
            <View key={day} style={st.cell}>
              <Pressable
                disabled={day > today}
                onPress={() => (setTip(day), onDay(day))}
                style={[st.day, lv >= 0 ? { backgroundColor: HEAT[lv] } : null, !inRange || day > today ? { opacity: 0.4 } : null, day === pending ? { borderColor: C.warn } : null]}
              >
                <Text style={{ color: lv >= 3 ? "#0b1220" : C.text, fontSize: 13, fontWeight: day === today ? "700" : "400", textDecorationLine: day === today ? "underline" : "none" }}>{parseDay(day).getDate()}</Text>
              </Pressable>
            </View>
          );
        })}
      </View>
      <Text style={[S.muted, { fontSize: 12 }]}>
        {tip ? `${fmtDay(tip, { day: "numeric", month: "long" })}: ${tipDay ? `${fmtTokens(tipDay.tokens)} · ${fmtCost(tipDay.cost)}` : t("нет расхода", "no usage")}. ` : ""}
        {pending ? t("Нажми второй день — получится период.", "Tap a second day to make a period.") : t("Нажми день, потом второй — свой период.", "Tap a day, then another — your own period.")}
      </Text>
      <View style={[st.row, { alignItems: "center", gap: 3 }]}>
        <Text style={[S.muted, { fontSize: 12 }]}>{t("меньше", "less")}</Text>
        {HEAT.map((c) => (
          <View key={c} style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: c }} />
        ))}
        <Text style={[S.muted, { fontSize: 12 }]}>{t("больше", "more")}</Text>
      </View>
    </View>
  );
}

function Bars({ days, data }: { days: string[]; data: Record<string, UsageTotals> }) {
  const [on, setOn] = useState<string>();
  const max = Math.max(1, ...days.map((d) => data[d]?.tokens ?? 0));
  const h = on && data[on];
  return (
    <View>
      <Text style={[S.muted, { fontSize: 12, minHeight: 18 }]}>
        {on ? `${fmtDay(on, { weekday: "short", day: "numeric", month: "long" })}: ${h ? `${fmtTokens(h.tokens)} · ${fmtCost(h.cost)}` : t("нет расхода", "no usage")}` : t(`максимум за день: ${fmtTokens(max)}`, `daily max: ${fmtTokens(max)}`)}
      </Text>
      <View style={st.plot}>
        {days.map((d) => {
          const v = data[d]?.tokens ?? 0;
          return (
            <Pressable key={d} onPress={() => setOn(d)} style={[st.col, on === d ? { backgroundColor: C.bg3 } : null]}>
              <View style={{ width: "100%", maxWidth: 24, height: `${(v / max) * 100}%`, backgroundColor: BAR, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
            </Pressable>
          );
        })}
      </View>
      <View style={[st.row, { justifyContent: "space-between" }]}>
        <Text style={[S.muted, { fontSize: 12 }]}>{fmtDay(days[0]!)}</Text>
        <Text style={[S.muted, { fontSize: 12 }]}>{fmtDay(days.at(-1)!)}</Text>
      </View>
    </View>
  );
}

/** Расход сессии коротко: новые токены (и $ в шапке чата). */
export function SessionUsage({ id, full }: { id: string; full?: boolean }) {
  const u = useHub().usage[id];
  if (!u || u.tokens + u.cacheRead <= 0) return null;
  return (
    <Text style={[S.muted, { fontSize: 12 }]} numberOfLines={1}>
      {fmtTokens(u.tokens)}
      {full ? ` · ${fmtCost(u.cost)}` : ""}
    </Text>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tile: { flexGrow: 1, flexBasis: "45%", backgroundColor: C.bg2, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 10, gap: 2 },
  tileValue: { color: C.text, fontSize: 24, fontWeight: "700", fontVariant: ["tabular-nums"] },
  cal: { backgroundColor: C.bg2, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 8, gap: 6 },
  calHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, padding: 1 },
  day: { aspectRatio: 1, borderRadius: 6, backgroundColor: C.bg3, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "transparent" },
  plot: { height: 120, flexDirection: "row", alignItems: "flex-end", gap: 2, borderBottomWidth: 1, borderBottomColor: C.line },
  col: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  line: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: C.line },
  num: { color: C.text, fontVariant: ["tabular-nums"], minWidth: 64, textAlign: "right" },
  cost: { minWidth: 52 },
});
