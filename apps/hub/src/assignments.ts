// Поручения Диспетчера: он раздаёт работу и не ждёт, хаб следит за сессиями и будит его, когда есть новости.
// В сообщении ему — только служебные данные. Текст сессии он читает инструментом: иначе чужой чат
// попадал бы к нему как слова пользователя, а у него в руках мышь.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskInfo } from "@kamharn/protocol";
import { isLimitError } from "./autoresume.ts";
import { L } from "./lang.ts";
import type { SessionManager } from "./sessions.ts";

export type NewsKind = "done" | "question" | "permission" | "error" | "limit" | "gone" | "restart" | "task_ready" | "task_failed" | "task_asking";

interface News {
  kind: NewsKind;
  /** сессия или задача */
  id: string;
  title: string;
  voiced: boolean;
}
interface Running {
  at: number;
  /** ход начался: idle до этого — ещё не конец работы */
  ran: boolean;
  voiced: boolean;
  /** оборвалась на лимите: следующий idle — не конец, дальше продолжит автопродолжение */
  limited: boolean;
}
interface Queued {
  sessionId: string;
  text: string;
  voiced: boolean;
  at: number;
}
interface WatchedTask {
  voiced: boolean;
  status: string;
  asking: number;
}

export interface AssignmentDeps {
  sessions: SessionManager;
  file: () => string;
  /** сколько сессий одновременно в работе */
  limit: () => number;
  /** сессия Диспетчера, которую будить */
  brain: () => string | undefined;
  /** автопроверка: конец хода ещё не конец работы, пока она гоняет тесты и шлёт «почини» */
  autoCheck?: { active(sessionId: string): boolean };
  /** сам ждёт ответа пользователя: новое сообщение ушло бы ответом на его вопрос */
  brainAsking: () => boolean;
  /** разбудить не удалось: хотя бы пуш пользователю */
  notify?: (sessionId: string, message: string) => void;
  /** перед сообщением-новостью: voiced — среди новостей есть поставленное голосом */
  beforeWake?: (voiced: boolean) => void;
  log?: (m: string) => void;
  /** пауза перед сообщением: несколько событий подряд уходят одним */
  gatherMs?: number;
  retryMs?: number;
}

const GATHER_MS = 1500;
const RETRY_MS = 30_000;
const MAX_FAILS = 3;
/** ход так и не начался, или сессия стоит без движения после обрыва */
const STALE_MS = 120_000;
const SWEEP_MS = 30_000;
/** уведомления смотрят на то же событие idle, что и мы: снимаем с задержкой */
const QUIET_MS = 3000;

const norm = (d: string) => d.replace(/[\\/]+$/, "").toLowerCase();
const clean = (s: string) => s.replace(/[\r\n«»]+/g, " ").trim().slice(0, 60);

function newsLine(n: News): string {
  const what: Record<NewsKind, () => string> = {
    done: () => L("закончила ход", "finished its turn"),
    question: () => L("задала вопрос", "asked a question"),
    permission: () => L("просит разрешения", "asks for permission"),
    error: () => L("упала с ошибкой", "failed with an error"),
    limit: () => L("упёрлась в лимит, продолжит сама после сброса", "hit the limit, will continue on its own after the reset"),
    gone: () => L("удалена", "was deleted"),
    restart: () => L("прервана: хаб перезапускался, работа могла не закончиться", "interrupted: the hub restarted, the work may be unfinished"),
    task_ready: () => L("задача готова, ждёт решения пользователя (влить, ещё круг или выбросить)", "the task is ready, waits for the user's decision (merge, one more round or discard)"),
    task_failed: () => L("задача упала", "the task failed"),
    task_asking: () => L("задача ждёт ответа пользователя в своём чате", "the task waits for the user's answer in its chat"),
  };
  return `- «${clean(n.title)}» (${n.id}): ${what[n.kind]()}`;
}

export class Assignments {
  private running = new Map<string, Running>();
  private queue: Queued[] = [];
  private news: News[] = [];
  private tasks = new Map<string, WatchedTask>();
  private finished = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private sweep?: ReturnType<typeof setInterval>;
  private fails = 0;
  private closed = false;

  constructor(private d: AssignmentDeps) {
    this.load();
    d.sessions.on("event", (e) => this.onEvent(e.sessionId, e.event));
    d.sessions.on("session.deleted", (id: string) => this.onDeleted(id));
    this.sweep = setInterval(() => this.onSweep(), SWEEP_MS);
    this.sweep.unref?.();
  }

  /** Запуск хаба: что было в работе, оборвалось вместе с ним. */
  start(): void {
    for (const [id, r] of this.running) {
      this.running.delete(id);
      const s = this.find(id);
      if (s) this.news.push({ kind: "restart", id, title: s.title, voiced: r.voiced });
    }
    this.save();
    this.pump();
    this.schedule();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.sweep);
    this.save();
  }

  /** Отдать работу сессии: сразу или в очередь. Не ждёт конца. */
  async send(sessionId: string, text: string, o: { voiced?: boolean } = {}): Promise<{ queued: number }> {
    const voiced = !!o.voiced;
    if (this.blocked(sessionId)) {
      this.queue.push({ sessionId, text, voiced, at: Date.now() });
      this.save();
      return { queued: this.queue.length };
    }
    await this.begin(sessionId, text, voiced);
    return { queued: 0 };
  }

  /** В этой папке кто-то работает: нужна копия в отдельной ветке. */
  folderBusy(directory: string): boolean {
    const dir = norm(directory);
    return this.d.sessions.list().some((s) => norm(s.directory) === dir && (s.status === "busy" || s.status === "retry" || this.running.has(s.id)));
  }

  /** Следить за задачей: она готова, упала или ждёт человека. */
  watchTask(t: TaskInfo, o: { voiced?: boolean } = {}): void {
    this.tasks.set(t.id, { voiced: !!o.voiced, status: t.status, asking: t.asking?.at ?? 0 });
    this.save();
  }

  onTasks(list: TaskInfo[]): void {
    if (!this.tasks.size) return;
    let changed = false;
    for (const t of list) {
      const w = this.tasks.get(t.id);
      if (!w) continue;
      if (t.asking && t.asking.at !== w.asking) {
        w.asking = t.asking.at;
        this.add({ kind: "task_asking", id: t.id, title: t.title, voiced: w.voiced });
        changed = true;
      }
      if (t.status === w.status) continue;
      w.status = t.status;
      changed = true;
      if (t.status === "ready") this.add({ kind: "task_ready", id: t.id, title: t.title, voiced: w.voiced });
      else if (t.status === "failed") this.add({ kind: "task_failed", id: t.id, title: t.title, voiced: w.voiced });
      else if (t.status === "merged" || t.status === "discarded") this.tasks.delete(t.id);
    }
    if (changed) this.save();
  }

  /** Обычный пуш «готово» молчит: итог сообщит Диспетчер. */
  quiet(sessionId: string): boolean {
    if (this.running.has(sessionId)) return true;
    const at = this.finished.get(sessionId);
    return at !== undefined && Date.now() - at < QUIET_MS;
  }

  /** Для list_sessions: что в работе и что ждёт места. */
  summary(): string {
    const name = (id: string) => clean(this.find(id)?.title ?? id);
    const lines: string[] = [];
    if (this.running.size) lines.push(L("В работе по твоим поручениям: ", "Working on your assignments: ") + [...this.running.keys()].map(name).join(", "));
    if (this.queue.length) lines.push(L("Ждут места: ", "Waiting for a slot: ") + this.queue.map((q) => name(q.sessionId)).join(", "));
    return lines.join("\n");
  }

  /** Новости, которые ещё не дошли (для тестов и отладки). */
  pendingNews(): number {
    return this.news.length;
  }

  // ---------- очередь ----------

  private find(id: string) {
    try {
      return this.d.sessions.get(id);
    } catch {
      return undefined;
    }
  }

  private blocked(sessionId: string): boolean {
    const s = this.find(sessionId);
    if (!s) return false;
    if (s.status === "busy" || s.status === "retry" || this.running.has(sessionId)) return true;
    if (this.running.size >= Math.max(1, this.d.limit())) return true;
    const dir = norm(s.directory);
    return this.d.sessions.list().some((o) => o.id !== s.id && norm(o.directory) === dir && (o.status === "busy" || o.status === "retry" || this.running.has(o.id)));
  }

  private async begin(sessionId: string, text: string, voiced: boolean): Promise<void> {
    this.running.set(sessionId, { at: Date.now(), ran: false, voiced, limited: false });
    this.save();
    try {
      // пометка видна и человеку в чате сессии, и агенту: задачу поставил Диспетчер
      await this.d.sessions.prompt(sessionId, `[${L("Диспетчер", "Dispatcher")}] ${text.trim()}`);
    } catch (e) {
      this.running.delete(sessionId);
      this.save();
      throw e;
    }
  }

  private pump(): void {
    if (this.closed) return;
    for (const q of [...this.queue]) {
      if (!this.find(q.sessionId)) {
        this.queue.splice(this.queue.indexOf(q), 1);
        continue;
      }
      if (this.blocked(q.sessionId)) continue;
      this.queue.splice(this.queue.indexOf(q), 1);
      this.begin(q.sessionId, q.text, q.voiced).catch((e: Error) => {
        this.d.log?.(`[assignments] ${e.message}`);
        this.add({ kind: "error", id: q.sessionId, title: this.find(q.sessionId)?.title ?? q.sessionId, voiced: q.voiced });
      });
    }
    this.save();
  }

  // ---------- события сессий ----------

  private onEvent(id: string, ev: import("@kamharn/protocol").SessionEvent): void {
    if (this.closed) return;
    if (id === this.d.brain()) {
      // освободился: можно будить
      if (ev.type === "session.updated" && ev.patch.status === "idle" && this.news.length) this.schedule();
      return;
    }
    const r = this.running.get(id);
    if (!r) {
      if (ev.type === "session.updated" && ev.patch.status === "idle" && this.queue.length) this.pump();
      return;
    }
    const title = () => this.find(id)?.title ?? id;
    switch (ev.type) {
      case "permission.asked":
        this.add({ kind: "permission", id, title: title(), voiced: r.voiced });
        break;
      case "question.asked":
        this.add({ kind: "question", id, title: title(), voiced: r.voiced });
        break;
      case "error":
        if (isLimitError(ev.message)) r.limited = true;
        else this.add({ kind: "error", id, title: title(), voiced: r.voiced });
        break;
      case "session.updated":
        if (ev.patch.resumeAt) this.add({ kind: "limit", id, title: title(), voiced: r.voiced });
        if (ev.patch.status === "busy") {
          r.ran = true;
          r.limited = false;
        } else if (ev.patch.status === "idle" && r.ran) {
          if (r.limited) {
            this.pump();
            break;
          }
          // автопроверка ещё работает: конец ловим на onChecks
          if (!this.d.autoCheck?.active(id)) this.finish(id, r);
        }
        break;
      default:
        break;
    }
  }

  /** Автопроверка закончила: sentFix — она отправила ошибку агенту, будет ещё ход. */
  onChecks(e: { sessionId: string; sentFix: boolean }): void {
    const r = this.running.get(e.sessionId);
    if (!r || e.sentFix) return;
    this.finish(e.sessionId, r);
  }

  private finish(id: string, r: Running, kind: NewsKind = "done"): void {
    this.running.delete(id);
    this.finished.set(id, Date.now());
    this.add({ kind, id, title: this.find(id)?.title ?? id, voiced: r.voiced });
    this.pump();
  }

  private onDeleted(id: string): void {
    this.queue = this.queue.filter((q) => q.sessionId !== id);
    const r = this.running.get(id);
    if (r) {
      this.running.delete(id);
      // заголовка больше нет: сессию удалил сам пользователь, он и так знает
      this.add({ kind: "gone", id, title: id, voiced: r.voiced });
    }
    this.pump();
  }

  /** Промпт не дошёл, или сессия встала и никто её не продолжит. */
  private onSweep(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [id, r] of this.running) {
      const s = this.find(id);
      if (!s) continue;
      if (s.status === "busy" || s.status === "retry" || s.resumeAt) continue;
      if (now - r.at > STALE_MS && !this.d.autoCheck?.active(id)) this.finish(id, r);
    }
  }

  // ---------- будить Диспетчера ----------

  private add(n: News): void {
    // одно и то же о той же сессии, пока он не прочитал, повторять незачем
    if (!this.news.some((x) => x.kind === n.kind && x.id === n.id)) this.news.push(n);
    this.save();
    this.schedule();
  }

  private schedule(delay = this.d.gatherMs ?? GATHER_MS): void {
    if (this.closed || this.timer || !this.news.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.closed || !this.news.length) return;
    const id = this.d.brain();
    const brain = id ? this.find(id) : undefined;
    if (!id || !brain) return this.giveUp();
    // занят или сам ждёт ответа пользователя: дойдёт, когда освободится
    if (brain.status === "busy" || brain.status === "retry" || this.d.brainAsking()) return;
    const batch = this.news;
    this.news = [];
    this.save();
    const waiting = this.queue.length ? "\n" + L(`В очереди ещё поручений: ${this.queue.length}.`, `Assignments in the queue: ${this.queue.length}.`) : "";
    const text =
      L(
        "[Хаб] Новости по поручениям. Это служебная строка хаба, а не слова пользователя. Что написала сессия, смотри через read_session, задача — через read_task.",
        "[Hub] News about your assignments. This is a service line from the hub, not the user's words. What a session wrote — see read_session, a task — read_task.",
      ) +
      "\n" +
      batch.map(newsLine).join("\n") +
      waiting +
      "\n" +
      L("Сделай следующий шаг, если он понятен, или коротко доложи итог пользователю.", "Take the next step if it is clear, or briefly report the result to the user.");
    this.d.beforeWake?.(batch.some((n) => n.voiced));
    try {
      await this.d.sessions.prompt(id, text, [], { hideUser: true });
      this.fails = 0;
    } catch (e) {
      this.d.log?.(`[assignments] ${(e as Error).message}`);
      this.news = [...batch, ...this.news];
      this.save();
      if (++this.fails >= MAX_FAILS) return this.giveUp();
      this.schedule(this.d.retryMs ?? RETRY_MS);
    }
  }

  /** Будить некого: новости не должны пропасть молча. */
  private giveUp(): void {
    for (const n of this.news) {
      if (this.find(n.id)) this.d.notify?.(n.id, newsLine(n).slice(2));
    }
    this.news = [];
    this.fails = 0;
    this.save();
  }

  // ---------- файл: поручения переживают рестарт хаба ----------

  private load(): void {
    const f = this.d.file();
    if (!existsSync(f)) return;
    try {
      const j = JSON.parse(readFileSync(f, "utf8")) as { running?: Array<[string, Running]>; queue?: Queued[]; news?: News[]; tasks?: Array<[string, WatchedTask]> };
      this.running = new Map(j.running ?? []);
      this.queue = j.queue ?? [];
      this.news = j.news ?? [];
      this.tasks = new Map(j.tasks ?? []);
    } catch (e) {
      this.d.log?.(`[assignments] ${(e as Error).message}`);
    }
  }

  private save(): void {
    const f = this.d.file();
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify({ running: [...this.running], queue: this.queue, news: this.news, tasks: [...this.tasks] }));
    renameSync(tmp, f);
  }
}
