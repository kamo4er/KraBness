// Автопродолжение после лимита подписки Claude: сессия упёрлась в лимит — ждём сброса и сами пишем «Продолжай».
// Время ожидания хранится в сессии (resumeAt), поэтому переживает рестарт хаба и видно в клиентах.
import type { ClaudeLimits, StoredEvent } from "@kamharn/protocol";
import type { SessionManager } from "./sessions.ts";
import { L } from "./lang.ts";

/** что хаб пишет агенту после сброса лимита — на языке хаба */
export const resumeText = (): string => L("Продолжай", "Continue");
/** запас после сброса: окно на стороне Anthropic обновляется не мгновенно */
const MARGIN_MS = 60_000;
/** лимиты считаем свежими, если пришли недавно (иначе это не тот лимит) */
const FRESH_MS = 30 * 60_000;
const FALLBACK_MS = 30 * 60_000;

export function isLimitError(message: string): boolean {
  return /you'?ve hit your .*limit|usage limit reached|limit reached.*resets/i.test(message);
}

/**
 * Когда лимит сбросится. Сначала по свежим лимитам (окно на 100% или отказ), потом по тексту
 * «resets 10:30pm», иначе — через 30 минут (если опять упрёмся, назначим заново).
 */
export function resumeTime(message: string, limits: ClaudeLimits | undefined, now = Date.now(), margin = MARGIN_MS): number {
  if (limits && now - limits.updatedAt < FRESH_MS) {
    const wins = [limits.fiveHour, limits.sevenDay].filter((w): w is NonNullable<typeof w> => !!w && w.resetsAt > now);
    const full = wins.filter((w) => w.utilization >= 0.99);
    if (full.length) return Math.max(...full.map((w) => w.resetsAt)) + margin;
    if (limits.status === "rejected" && wins.length) {
      const top = wins.reduce((a, b) => (b.utilization > a.utilization ? b : a));
      return top.resetsAt + margin;
    }
  }
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(message);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3]!.toLowerCase() === "pm") h += 12;
    const d = new Date(now);
    d.setHours(h, Number(m[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime() + margin;
  }
  return now + FALLBACK_MS;
}

export class AutoResume {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private sessions: Pick<SessionManager, "list" | "get" | "setResumeAt" | "prompt">,
    private limits: () => ClaudeLimits | undefined,
    private notify: (sessionId: string, message: string) => void,
    private log: (m: string) => void = () => {},
    private now: () => number = Date.now,
    private marginMs = MARGIN_MS,
  ) {}

  /** после старта хаба: поднять таймеры сессий, которые ждали лимит */
  start(): void {
    for (const s of this.sessions.list()) if (s.resumeAt) this.arm(s.id, s.resumeAt);
  }

  onEvent(e: StoredEvent): void {
    const ev = e.event;
    if (ev.type === "error" && isLimitError(ev.message)) {
      const s = this.sessions.get(e.sessionId);
      if (s.engine !== "claude") return;
      const at = resumeTime(ev.message, this.limits(), this.now(), this.marginMs);
      this.sessions.setResumeAt(s.id, at);
      this.log(L(`[hub] лимит в «${s.title}»: продолжу в ${new Date(at).toLocaleTimeString("ru")}`, `[hub] limit in “${s.title}”: will continue at ${new Date(at).toLocaleTimeString("en-US")}`));
    } else if (ev.type === "session.updated" && ev.patch.resumeAt !== undefined) {
      if (ev.patch.resumeAt) this.arm(e.sessionId, ev.patch.resumeAt);
      else this.disarm(e.sessionId);
    } else if (ev.type === "message.upserted" && ev.message.role === "user") {
      // пользователь сам написал — он рулит; наш «Продолжай» идёт уже после снятия resumeAt
      if (this.timers.has(e.sessionId)) this.sessions.setResumeAt(e.sessionId, 0);
    }
  }

  close(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private arm(id: string, at: number): void {
    this.disarm(id);
    // setTimeout держит не больше ~24 дней; лимиты — максимум неделя
    this.timers.set(id, setTimeout(() => void this.fire(id), Math.max(0, at - this.now())));
  }

  private disarm(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private async fire(id: string): Promise<void> {
    this.timers.delete(id);
    try {
      const s = this.sessions.get(id);
      if (!s.resumeAt) return;
      this.sessions.setResumeAt(id, 0);
      if (s.status === "busy" || s.status === "retry") return; // уже работает — не мешаем
      await this.sessions.prompt(id, resumeText());
      this.notify(id, L("Лимит сбросился — продолжаю работу", "The limit reset — continuing the work"));
      this.log(L(`[hub] «${s.title}»: продолжил после лимита`, `[hub] “${s.title}”: continued after the limit`));
    } catch (e) {
      this.log(`[hub] ${L("автопродолжение", "auto-resume")} ${id}: ${(e as Error).message}`);
    }
  }
}
