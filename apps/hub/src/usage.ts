// Расход токенов: записи по сообщениям/ходам в таблице usage, отчёты за период, история задним числом.
// Главная цифра — новые токены (ввод + вывод + запись в кэш); чтение из кэша — отдельно, оно у Claude огромное.
// Стоимость — «как по API»: по подписке за токены не платят, но видно, сколько бы это стоило.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { EngineId, SessionInfo, UsageReport, UsageTotals } from "@kamharn/protocol";
import type { Db } from "./db.ts";
import { findTranscript } from "./engines/claude-transcript.ts";

/** Одна запись расхода от движка. key — уникален в пределах источника: повтор той же записи её перезаписывает. */
export interface UsageRecord {
  key: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** $ как по API; нет — неизвестно (модель без цены) */
  cost?: number;
  /** когда (мс); нет — сейчас */
  ts?: number;
}

export interface UsageRow extends UsageRecord {
  sessionId: string;
  engine: EngineId;
  ts: number;
  day: string;
}

/** Локальная дата YYYY-MM-DD: дни в отчёте — по часам ПК, а не по UTC. */
export function dayOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const emptyTotals = (): UsageTotals => ({ tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });

/**
 * Цены Claude API, $ за миллион токенов (справочник claude-api, кэш 2026-10-06; сверено с суммой, которую считает сам CLI).
 * Запись в кэш: ×1.25 на 5 минут, ×2 на час. У Haiku 5.5 свыше 100K токенов запроса — дороже.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; long?: { over: number; input: number; output: number } }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, long: { over: 100_000, input: 0.5, output: 2.5 } },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  // прошлые модели (в истории сессий): чтение из кэша ×0.1
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/** Стоимость сообщения Claude по таблице цен (для истории — в транскриптах её нет). undefined — модель без цены. */
export function claudeCost(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const long = p.long && prompt > p.long.over;
  const input = long ? p.long!.input : p.input;
  const output = long ? p.long!.output : p.output;
  // у Haiku чтение кэша — ×0.1 от ввода, и в «длинной» цене тоже
  const read = p.long ? input * 0.1 : p.cacheRead;
  return (u.input * input + u.output * output + u.cacheRead * read + u.cacheWrite5m * input * 1.25 + u.cacheWrite1h * input * 2) / 1e6;
}

/** Итоги по строкам базы (суммы колонок). */
export function totalsOf(r: { input?: unknown; output?: unknown; cache_write?: unknown; cache_read?: unknown; cost?: unknown; unknown_cost?: unknown }): UsageTotals {
  const n = (v: unknown) => Number(v) || 0;
  const t: UsageTotals = { input: n(r.input), output: n(r.output), cacheWrite: n(r.cache_write), cacheRead: n(r.cache_read), cost: n(r.cost), tokens: 0 };
  t.tokens = t.input + t.output + t.cacheWrite;
  if (n(r.unknown_cost) > 0) t.costUnknown = true;
  return t;
}

/** Отчёт за период [from; to] (локальные даты, включительно). */
export function usageReport(db: Db, from: string, to: string, titleOf: (id: string) => { title: string; engine: EngineId } | undefined): UsageReport {
  const q = db.usageQuery(from, to);
  return {
    from,
    to,
    ...(q.firstDay ? { firstDay: q.firstDay } : {}),
    total: totalsOf(q.total),
    days: q.days.map((r) => ({ day: String(r.day), ...totalsOf(r) })),
    models: q.models.map((r) => ({ engine: String(r.engine) as EngineId, model: String(r.model), ...totalsOf(r) })),
    sessions: q.sessions.map((r) => {
      const id = String(r.session_id);
      const s = titleOf(id);
      return { sessionId: id, title: s?.title ?? "", engine: (s?.engine ?? String(r.engine)) as EngineId, ...(s ? {} : { deleted: true }), ...totalsOf(r) };
    }),
  };
}

type Json = Record<string, any>;

/**
 * История Claude из транскрипта: сообщения ассистента с создания сессии хаба до начала живого учёта.
 * Одно сообщение пишется несколькими строками (по блоку) с одним message.id — берём последнюю usage
 * и максимум вывода (в строках посреди потока вывод неполный). Читаем построчно: долгие сессии весят сотни МБ
 * (одна строка-файл не влезает в строку JS — 512 МБ).
 */
export async function claudeHistory(path: string, from: number, until: number): Promise<UsageRecord[]> {
  const byId = new Map<string, UsageRecord & { w5: number; w1: number }>();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let j: Json;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const m = j.message;
    if (j.type !== "assistant" || !m?.id || !m.usage) continue;
    // синтетические ответы CLI (ошибки, «нет входа») — не запросы к модели
    if (m.model === "<synthetic>") continue;
    const ts = Date.parse(j.timestamp);
    if (!(ts >= from && ts < until)) continue;
    const u = m.usage;
    const prev = byId.get(m.id);
    const w1 = Number(u.cache_creation?.ephemeral_1h_input_tokens) || 0;
    const cw = Number(u.cache_creation_input_tokens) || 0;
    byId.set(m.id, {
      key: `claude-msg:${m.id}`,
      model: String(m.model ?? ""),
      input: Number(u.input_tokens) || 0,
      output: Math.max(Number(u.output_tokens) || 0, prev?.output ?? 0),
      cacheWrite: cw,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      w1,
      w5: Math.max(0, cw - w1),
      ts: prev?.ts ?? ts,
    });
  }
  return [...byId.values()].map(({ w5, w1, ...r }) => {
    const cost = claudeCost(r.model, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 });
    return cost === undefined ? r : { ...r, cost };
  });
}

/** История opencode из его API (GET /session/{id}/message): ключи те же, что вживую, — повтор не задвоит. */
export function opencodeHistory(messages: Json[], from: number, until: number): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const msg of messages) {
    const info = msg.info ?? msg;
    if (info.role !== "assistant" || !info.tokens || !info.time?.completed) continue;
    const ts = Number(info.time.created) || 0;
    if (!(ts >= from && ts < until)) continue;
    const r = opencodeRecord(info);
    if (r) out.push(r);
  }
  return out;
}

/** Запись расхода из info сообщения opencode (вывод = вывод + рассуждения: они оплачиваются как вывод). */
export function opencodeRecord(info: Json): UsageRecord | undefined {
  const t = info.tokens;
  if (!t || !info.id) return undefined;
  const r: UsageRecord = {
    key: `oc:${info.id}`,
    model: String(info.modelID ?? info.model?.modelID ?? ""),
    input: Number(t.input) || 0,
    output: (Number(t.output) || 0) + (Number(t.reasoning) || 0),
    cacheWrite: Number(t.cache?.write) || 0,
    cacheRead: Number(t.cache?.read) || 0,
    ...(typeof info.cost === "number" ? { cost: info.cost } : {}),
    ...(info.time?.created ? { ts: Number(info.time.created) } : {}),
  };
  return r.input + r.output + r.cacheWrite + r.cacheRead > 0 ? r : undefined;
}

/**
 * История задним числом — один раз. Берётся только то, что было до начала живого учёта (since),
 * и только с момента создания сессии хаба (у продолженных сессий Claude Code в транскрипте и чужая история).
 */
export async function backfillUsage(o: {
  db: Db;
  sessions: SessionInfo[];
  engineSessionId: (id: string) => string | undefined;
  claudeProjectsDir: string;
  opencodeMessages?: (engineSessionId: string, directory: string) => Promise<Json[]>;
  log?: (m: string) => void;
}): Promise<number> {
  const since = Number(o.db.getMeta("usage.since")) || Date.now();
  let n = 0;
  for (const s of o.sessions) {
    if (s.createdAt >= since) continue;
    const esid = o.engineSessionId(s.id);
    if (!esid) continue;
    try {
      let recs: UsageRecord[] = [];
      if (s.engine === "claude") {
        const tr = findTranscript(o.claudeProjectsDir, esid);
        if (tr) recs = await claudeHistory(tr.path, s.createdAt, since);
      } else if (o.opencodeMessages) {
        recs = opencodeHistory(await o.opencodeMessages(esid, s.directory), s.createdAt, since);
      }
      for (const r of recs) o.db.putUsage({ ...r, sessionId: s.id, engine: s.engine, ts: r.ts ?? s.createdAt, day: dayOf(r.ts ?? s.createdAt) });
      n += recs.length;
    } catch (e) {
      o.log?.(`[usage] ${s.id}: ${(e as Error).message}`);
    }
  }
  return n;
}
