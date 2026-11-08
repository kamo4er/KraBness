// Расход токенов: итог за период, календарь месяца (дни раскрашены по расходу, два нажатия — свой период),
// столбцы по дням, разбивка по моделям и сессиям. Главная цифра — новые токены; чтение из кэша — отдельно.
import { useEffect, useMemo, useState } from "react";
import { fmtCost, fmtTokens, localDay, locale, t, type UsageReport, type UsageTotals } from "@kamharn/client";
import { client, go, useHub } from "./hub.ts";

/** ступени тепловой карты (один синий; на тёмном фоне больше — светлее), проверены валидатором палитры */
const HEAT = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
const BAR = "#3987e5";

type Preset = "today" | "week" | "month30" | "thisMonth" | "custom";

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

function presetRange(p: Exclude<Preset, "custom">): { from: string; to: string } {
  const now = new Date();
  const to = localDay(now);
  if (p === "today") return { from: to, to };
  if (p === "week") return { from: localDay(addDays(now, -6)), to };
  if (p === "month30") return { from: localDay(addDays(now, -29)), to };
  return { from: localDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
}

/** все дни периода (дни без расхода — нулём, иначе столбцы съезжают) */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = parseDay(from); localDay(d) <= to && out.length < 400; d = addDays(d, 1)) out.push(localDay(d));
  return out;
}

const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) => parseDay(day).toLocaleDateString(locale(), opts);

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
    client.usageReport(range.from, range.to).then(
      (r) => alive && (setReport(r), setError(undefined)),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [range.from, range.to]);

  // раскраска календаря — по своему месяцу, независимо от выбранного периода
  useEffect(() => {
    let alive = true;
    const from = localDay(month);
    const to = localDay(new Date(month.getFullYear(), month.getMonth() + 1, 0));
    client.usageReport(from, to).then(
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
  const title =
    range.from === range.to ? fmtDay(range.from, { day: "numeric", month: "long", year: "numeric" }) : `${fmtDay(range.from)} — ${fmtDay(range.to, { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <>
      <section>
        <div className="row usage__presets">
          {(
            [
              ["today", t("Сегодня", "Today")],
              ["week", t("7 дней", "7 days")],
              ["month30", t("30 дней", "30 days")],
              ["thisMonth", t("Этот месяц", "This month")],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={`btn btn--small ${preset === id ? "btn--on" : ""}`} onClick={() => pick(id)}>
              {label}
            </button>
          ))}
        </div>
        <h3 className="usage__period">{title}</h3>
        {error && <p className="error">{error}</p>}
        <div className="usage__tiles">
          <Tile label={t("Новые токены", "New tokens")} value={total ? fmtTokens(total.tokens) : "…"} hint={total ? t(`ввод ${fmtTokens(total.input)} · вывод ${fmtTokens(total.output)} · в кэш ${fmtTokens(total.cacheWrite)}`, `input ${fmtTokens(total.input)} · output ${fmtTokens(total.output)} · cache write ${fmtTokens(total.cacheWrite)}`) : ""} />
          <Tile label={t("Прочитано из кэша", "Read from cache")} value={total ? fmtTokens(total.cacheRead) : "…"} hint={t("контекст, который модель перечитывает каждый ход", "context the model re-reads every turn")} />
          <Tile
            label={t("Как по API", "At API prices")}
            value={total ? fmtCost(total.cost) : "…"}
            hint={total?.costUnknown ? t("часть моделей без цены — сумма занижена", "some models have no price — the sum is low") : t("по подписке платишь фиксированно, это ориентир", "a subscription is a flat fee, this is a reference")}
          />
        </div>
      </section>

      <section>
        <Calendar month={month} setMonth={setMonth} days={monthDays} range={range} pending={pending} onDay={tapDay} />
      </section>

      {report && range.from !== range.to && (
        <section>
          <h3>{t("По дням", "By day")}</h3>
          <Bars days={daysBetween(range.from, range.to)} data={Object.fromEntries(report.days.map((d) => [d.day, d]))} />
        </section>
      )}

      {report && (
        <section>
          <h3>{t("По моделям", "By model")}</h3>
          {report.models.length ? (
            <table className="usage__table">
              <thead>
                <tr>
                  <th>{t("Модель", "Model")}</th>
                  <th>{t("Новые", "New")}</th>
                  <th>{t("Из кэша", "Cache read")}</th>
                  <th>$</th>
                </tr>
              </thead>
              <tbody>
                {report.models.map((m) => (
                  <tr key={m.engine + m.model}>
                    <td>
                      {m.model || "?"} <span className="muted">{m.engine}</span>
                    </td>
                    <td>{fmtTokens(m.tokens)}</td>
                    <td>{fmtTokens(m.cacheRead)}</td>
                    <td>{m.costUnknown && !m.cost ? "—" : fmtCost(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">{t("За этот период расхода нет.", "No usage in this period.")}</p>
          )}
        </section>
      )}

      {report && report.sessions.length > 0 && (
        <section>
          <h3>{t("По сессиям", "By session")}</h3>
          <table className="usage__table">
            <tbody>
              {report.sessions.map((s) => (
                <tr key={s.sessionId}>
                  <td>
                    {s.deleted ? (
                      <span className="muted">{t("(сессия удалена)", "(session deleted)")}</span>
                    ) : (
                      <button className="linkish" onClick={() => go({ page: "session", id: s.sessionId })}>
                        {s.title || s.sessionId}
                      </button>
                    )}
                  </td>
                  <td>{fmtTokens(s.tokens)}</td>
                  <td>{fmtCost(s.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="muted">
        {t(
          "Считаются сессии KraBness. Claude Code, запущенный в VS Code или терминале, сюда не попадает. История до включения учёта поднята из транскриптов Claude и истории opencode.",
          "Only KraBness sessions are counted. Claude Code run in VS Code or a terminal isn't included. History from before tracking was turned on was imported from Claude transcripts and opencode history.",
        )}
      </p>
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="usage__tile">
      <span className="muted">{label}</span>
      <b>{value}</b>
      <span className="muted usage__tilehint">{hint}</span>
    </div>
  );
}

/** Календарь месяца: дни раскрашены по новым токенам, выбранный период обведён. */
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
    const lead = (first.getDay() + 6) % 7; // неделя с понедельника
    const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return [...Array<null>(lead).fill(null), ...Array.from({ length: count }, (_, i) => localDay(new Date(month.getFullYear(), month.getMonth(), i + 1)))];
  }, [month]);
  const max = Math.max(0, ...Object.values(days).map((d) => d.tokens));
  const level = (v: number) => (v <= 0 || max <= 0 ? -1 : Math.min(HEAT.length - 1, Math.floor((v / max) * HEAT.length)));
  const today = localDay(new Date());
  const thisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 26 + i).toLocaleDateString(locale(), { weekday: "short" }));
  return (
    <div className="cal">
      <div className="cal__head">
        <button className="btn btn--icon" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} title={t("Раньше", "Earlier")}>
          ‹
        </button>
        <b>{month.toLocaleDateString(locale(), { month: "long", year: "numeric" })}</b>
        <button className="btn btn--icon" disabled={month >= thisMonth} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} title={t("Позже", "Later")}>
          ›
        </button>
      </div>
      <div className="cal__grid">
        {weekdays.map((w) => (
          <span key={w} className="cal__wd muted">
            {w}
          </span>
        ))}
        {cells.map((day, i) => {
          if (!day) return <span key={`e${i}`} />;
          const d = days[day];
          const lv = level(d?.tokens ?? 0);
          const inRange = day >= range.from && day <= range.to;
          return (
            <button
              key={day}
              className={`cal__day ${inRange ? "" : "cal__day--out"} ${day === pending ? "cal__day--pending" : ""} ${day === today ? "cal__day--today" : ""}`}
              style={lv >= 0 ? { background: HEAT[lv], color: lv >= 3 ? "#0b1220" : "#e6e8ee" } : undefined}
              disabled={day > today}
              title={`${fmtDay(day, { day: "numeric", month: "long" })}: ${d ? `${fmtTokens(d.tokens)} · ${fmtCost(d.cost)}` : t("нет расхода", "no usage")}`}
              onClick={() => onDay(day)}
            >
              {parseDay(day).getDate()}
            </button>
          );
        })}
      </div>
      <div className="cal__legend muted">
        <span>{pending ? t("Нажми второй день — получится период", "Tap a second day to make a period") : t("Нажми день, потом второй — свой период", "Tap a day, then another — your own period")}</span>
        <span className="cal__scale">
          {t("меньше", "less")}
          {HEAT.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
          {t("больше", "more")}
        </span>
      </div>
    </div>
  );
}

/** Столбцы по дням: одна величина (новые токены), подсказка по наведению/нажатию. */
function Bars({ days, data }: { days: string[]; data: Record<string, UsageTotals> }) {
  const [hover, setHover] = useState<string>();
  const max = Math.max(1, ...days.map((d) => data[d]?.tokens ?? 0));
  const h = hover && data[hover];
  return (
    <div className="bars">
      <div className="bars__tip muted">
        {hover ? (
          <>
            <b>{fmtDay(hover, { weekday: "short", day: "numeric", month: "long" })}</b>: {h ? `${fmtTokens(h.tokens)} · ${t("из кэша", "cache")} ${fmtTokens(h.cacheRead)} · ${fmtCost(h.cost)}` : t("нет расхода", "no usage")}
          </>
        ) : (
          t(`максимум за день: ${fmtTokens(max)}`, `daily max: ${fmtTokens(max)}`)
        )}
      </div>
      <div className="bars__plot" onMouseLeave={() => setHover(undefined)}>
        {days.map((d) => {
          const v = data[d]?.tokens ?? 0;
          return (
            <div key={d} className={`bars__col ${hover === d ? "bars__col--on" : ""}`} onMouseEnter={() => setHover(d)} onClick={() => setHover(d)}>
              <div className="bars__bar" style={{ height: `${(v / max) * 100}%`, background: BAR }} />
            </div>
          );
        })}
      </div>
      <div className="bars__axis muted">
        <span>{fmtDay(days[0]!)}</span>
        <span>{fmtDay(days.at(-1)!)}</span>
      </div>
    </div>
  );
}

/** Расход сессии коротко: в списке — только новые токены, в шапке чата — ещё и $. Подробности — в подсказке. */
export function SessionUsage({ id, full }: { id: string; full?: boolean }) {
  const u = useHub().usage[id];
  if (!u || u.tokens + u.cacheRead <= 0) return null;
  const hint = t(
    `Новые токены: ${fmtTokens(u.tokens)} (ввод ${fmtTokens(u.input)}, вывод ${fmtTokens(u.output)}, в кэш ${fmtTokens(u.cacheWrite)})\nИз кэша: ${fmtTokens(u.cacheRead)}\nКак по API: ${fmtCost(u.cost)}`,
    `New tokens: ${fmtTokens(u.tokens)} (input ${fmtTokens(u.input)}, output ${fmtTokens(u.output)}, cache write ${fmtTokens(u.cacheWrite)})\nFrom cache: ${fmtTokens(u.cacheRead)}\nAt API prices: ${fmtCost(u.cost)}`,
  );
  return (
    <span className="usage__badge" title={hint}>
      {fmtTokens(u.tokens)}
      {full ? ` · ${fmtCost(u.cost)}` : ""}
    </span>
  );
}
