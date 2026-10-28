// Бот сессии: свой Telegram-бот на одну сессию — пишешь ему, и это уходит агенту; файлы ложатся в папку сессии;
// в конце хода итоговый ответ и файлы, которые агент отправил (send_file_to_user), приходят тому, кто спросил.
// Подключить можно несколько человек: каждый пишет боту «/start <код>», код одноразовый.
// Сообщение агенту подписывается именем человека (его можно поменять в KraBness) — агент знает, кому отвечает.
// Чужие чаты бот игнорирует. Где Telegram заблокирован — через тот же прокси, что и бот уведомлений.
import { randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebStream } from "node:stream/web";
import type { QuestionRequest, SessionBotInfo, StoredEvent } from "@kamharn/protocol";
import type { ConfigStore, SessionBotConfig } from "./config.ts";
import type { FileStore } from "./files.ts";
import { L } from "./lang.ts";
import type { SessionManager } from "./sessions.ts";
import { telegramHttp, type TelegramHttp } from "./telegram.ts";

type Json = Record<string, any>;

/** Bot API отдаёт ботам файлы до 20 МБ */
const TG_FILE_MAX = 20 * 1024 * 1024;
/** сообщения альбома приходят по одному — ждём, пока соберутся, и отдаём агенту одним промптом */
const GATHER_MS = 1200;
const TG_TEXT_MAX = 4000;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown ответа агента → HTML, который понимает Telegram (жирный, код, ссылки, заголовки; списки — точками). */
export function mdToTelegram(md: string): string {
  const blocks: string[] = [];
  let s = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
    blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!);
}

/** Разбить длинный текст по абзацам/строкам под лимит сообщения Telegram. */
export function chunks(text: string, max = TG_TEXT_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

interface Pending {
  texts: string[];
  fileIds: string[];
  timer?: NodeJS.Timeout;
}

/** Один бот, привязанный к одной сессии. */
class SessionBot {
  code: string = String(randomInt(100000, 1000000));
  botName?: string;
  lastError?: string;
  private misses = 0;
  private offset = 0;
  private ac?: AbortController;
  private pending = new Map<number, Pending>();
  private typing?: NodeJS.Timeout;
  /** с какого seq начался ход (busy) — по нему собираем итог хода */
  private turnFrom?: number;
  /** кто из Telegram написал с прошлого итога: ответ, «печатает…» и кнопки — только им. Написали из KraBness — в Telegram ничего. */
  private askers = new Set<number>();
  /** запрос подтверждения/вопрос → id сообщений с кнопками (чтобы отметить ответ) */
  private asks = new Map<string, Array<{ chat: number; message: number }>>();

  constructor(
    private parent: SessionBots,
    public cfg: SessionBotConfig,
  ) {}

  private get http(): TelegramHttp {
    return this.parent.net;
  }

  async api(method: string, body: Json = {}, signal?: AbortSignal): Promise<any> {
    const r = await this.http.fetch(`https://api.telegram.org/bot${this.cfg.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const j = (await r.json().catch(() => ({}))) as Json;
    if (!j.ok) throw new Error(j.description ?? `Telegram ${r.status}`);
    return j.result;
  }

  start(): void {
    if (this.ac) return;
    const ac = new AbortController();
    this.ac = ac;
    void (async () => {
      while (!ac.signal.aborted) {
        try {
          // имя бота нужно для ссылки t.me/<бот>; при старте хаба связи может ещё не быть (туннель) — спрашиваем, пока не узнаем
          if (!this.botName) {
            this.botName = await this.api("getMe", {}, ac.signal).then((m: Json) => m.username as string);
            this.lastError = undefined;
          }
          const updates: Json[] = await this.api("getUpdates", { offset: this.offset, timeout: this.parent.pollTimeoutSec, allowed_updates: ["message", "callback_query"] }, ac.signal);
          this.lastError = undefined;
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.handle(u).catch((e: Error) => this.parent.log(`[sessionbot] ${e.message}`));
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          this.lastError = (e as Error).message;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  stop(): void {
    this.ac?.abort();
    this.ac = undefined;
    if (this.typing) clearInterval(this.typing);
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
  }

  private allowed(chat: number): boolean {
    return this.cfg.chats.some((c) => c.id === chat);
  }

  private async handle(u: Json): Promise<void> {
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    if (!m) return;
    const chat = m.chat.id as number;
    const text = String(m.text ?? m.caption ?? "").trim();
    const start = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text);
    if (start) return this.link(m, start[1]!);
    // чужие чаты молча игнорируем
    if (!this.allowed(chat)) return;
    if (/^\/start\b/.test(text)) return;

    const p = this.pending.get(chat) ?? { texts: [], fileIds: [] };
    this.pending.set(chat, p);
    if (text) p.texts.push(text);
    const file = this.fileOf(m);
    if (file) {
      try {
        p.fileIds.push(await this.download(file));
      } catch (e) {
        await this.api("sendMessage", { chat_id: chat, text: `⚠️ ${(e as Error).message}`, reply_to_message_id: m.message_id }).catch(() => {});
      }
    }
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => void this.flush(chat), GATHER_MS);
  }

  /** Что за файл в сообщении: документ, самое крупное фото, видео, аудио, голосовое. */
  private fileOf(m: Json): { id: string; name: string; size?: number; mime?: string } | undefined {
    const stamp = new Date((m.date ?? Date.now() / 1000) * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, "");
    if (m.document) return { id: m.document.file_id, name: m.document.file_name ?? `file-${stamp}`, size: m.document.file_size, mime: m.document.mime_type };
    if (Array.isArray(m.photo) && m.photo.length) {
      const big = m.photo.at(-1);
      return { id: big.file_id, name: `photo-${stamp}-${m.message_id}.jpg`, size: big.file_size, mime: "image/jpeg" };
    }
    if (m.video) return { id: m.video.file_id, name: m.video.file_name ?? `video-${stamp}.mp4`, size: m.video.file_size, mime: m.video.mime_type };
    if (m.audio) return { id: m.audio.file_id, name: m.audio.file_name ?? `audio-${stamp}.mp3`, size: m.audio.file_size, mime: m.audio.mime_type };
    if (m.voice) return { id: m.voice.file_id, name: `voice-${stamp}.ogg`, size: m.voice.file_size, mime: m.voice.mime_type };
    return undefined;
  }

  /** Скачать файл из Telegram в папку сессии (.kamharn/inbox) → id вложения для промпта. */
  private async download(f: { id: string; name: string; size?: number; mime?: string }): Promise<string> {
    if (f.size && f.size > TG_FILE_MAX) throw new Error(L(`«${f.name}» больше 20 МБ — Telegram не отдаёт ботам такие файлы. Закинь его через KraBness.`, `“${f.name}” is over 20 MB — Telegram doesn't give such files to bots. Upload it through KraBness.`));
    const info = await this.api("getFile", { file_id: f.id });
    const r = await this.http.fetch(`https://api.telegram.org/file/bot${this.cfg.token}/${info.file_path}`);
    if (!r.ok || !r.body) throw new Error(L(`Не скачался «${f.name}»: ${r.status}`, `Couldn't download “${f.name}”: ${r.status}`));
    const s = this.parent.sessions.get(this.cfg.sessionId);
    const row = await this.parent.files.saveIncoming(s.id, s.directory, f.name, Readable.fromWeb(r.body as unknown as WebStream), f.mime);
    return row.id;
  }

  /** Собранное за GATHER_MS — агенту одним сообщением. */
  private async flush(chat: number): Promise<void> {
    const p = this.pending.get(chat);
    this.pending.delete(chat);
    if (!p || (!p.texts.length && !p.fileIds.length)) return;
    const name = this.cfg.chats.find((c) => c.id === chat)?.name ?? String(chat);
    // подпись — агенту: кто пишет и откуда (ответ уйдёт только ему)
    const text = `[Telegram: ${name}]\n${p.texts.join("\n\n") || L("(файлы без подписи)", "(files, no caption)")}`;
    // до prompt: busy приходит событием, пока prompt ещё не вернулся
    this.askers.add(chat);
    if (this.typing) this.typeTo(chat);
    try {
      await this.parent.sessions.prompt(this.cfg.sessionId, text, p.fileIds);
    } catch (e) {
      this.askers.delete(chat);
      await this.api("sendMessage", { chat_id: chat, text: `⚠️ ${(e as Error).message}` }).catch(() => {});
    }
  }

  /** Привязка чата по одноразовому коду; после 5 неверных кодов подряд код меняется. */
  private async link(m: Json, code: string): Promise<void> {
    const chat = m.chat.id as number;
    if (m.chat.type && m.chat.type !== "private") {
      return void (await this.api("sendMessage", { chat_id: chat, text: L("Привязать можно только личный чат с ботом.", "Only a private chat with the bot can be linked.") }));
    }
    if (this.allowed(chat)) return void (await this.api("sendMessage", { chat_id: chat, text: L("Этот чат уже подключён.", "This chat is already linked.") }));
    if (code !== this.code) {
      if (++this.misses >= 5) {
        this.code = String(randomInt(100000, 1000000));
        this.misses = 0;
      }
      return void (await this.api("sendMessage", { chat_id: chat, text: L("Код не подходит. Возьми его в KraBness: чат сессии → Telegram.", "Wrong code. Get it in KraBness: the session chat → Telegram.") }));
    }
    this.misses = 0;
    this.code = String(randomInt(100000, 1000000)); // одноразовый: следующему человеку — новый
    const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(" ") || m.from?.username || String(chat);
    this.cfg = { ...this.cfg, chats: [...this.cfg.chats, { id: chat, name }] };
    this.parent.save(this.cfg);
    const title = this.parent.sessions.get(this.cfg.sessionId).title;
    this.parent.log(`[sessionbot] ${L("подключён чат", "linked chat")} ${name} → «${title}»`);
    await this.api("sendMessage", {
      chat_id: chat,
      text: L(`Готово: этот чат связан с «${title}». Пиши и присылай файлы — всё уйдёт агенту, ответ придёт сюда.`, `Done: this chat is linked to “${title}”. Write and send files — everything goes to the agent, the answer comes here.`),
    });
  }

  // ---------- от агента в Telegram ----------

  /** События сессии: ход начался/закончился, агент ждёт ответа. */
  onEvent(e: StoredEvent): void {
    const ev = e.event;
    if (ev.type === "session.updated" && ev.patch.status === "busy") {
      this.turnFrom = e.seq;
      this.startTyping();
    } else if (ev.type === "session.updated" && ev.patch.status === "idle") {
      this.stopTyping();
      const from = this.turnFrom;
      const to = [...this.askers];
      this.turnFrom = undefined;
      this.askers.clear();
      if (from !== undefined && to.length) void this.sendTurn(from, to).catch((err: Error) => this.parent.log(`[sessionbot] ${err.message}`));
    } else if (ev.type === "permission.asked") {
      const r = ev.request;
      void this.ask(r.id, L(`🔐 Агент просит разрешения: ${r.tool}\n${r.title}`, `🔐 The agent asks for permission: ${r.tool}\n${r.title}`), [
        [
          { text: L("✅ Разрешить", "✅ Allow"), callback_data: `p|${r.id}|once` },
          { text: L("⛔ Отклонить", "⛔ Deny"), callback_data: `p|${r.id}|reject` },
        ],
      ]);
    } else if (ev.type === "question.asked") {
      void this.question(ev.request);
    } else if (ev.type === "permission.resolved" || ev.type === "question.resolved") {
      void this.closeAsk(ev.id, L("— отвечено", "— answered"));
    }
  }

  private startTyping(): void {
    this.stopTyping();
    const tick = () => {
      for (const c of this.askers) this.typeTo(c);
    };
    tick();
    this.typing = setInterval(tick, 4500);
  }

  private typeTo(chat: number): void {
    void this.api("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
  }

  private stopTyping(): void {
    if (this.typing) clearInterval(this.typing);
    this.typing = undefined;
  }

  /** Итог хода: текст последнего сообщения агента и все файлы, которые он отдал за ход. */
  private async sendTurn(fromSeq: number, to: number[]): Promise<void> {
    const events = this.parent.sessions.eventsAfter(this.cfg.sessionId, fromSeq);
    const roles = new Map<string, string>();
    const texts = new Map<string, Map<string, string>>();
    const files: Array<{ fileId: string; name: string }> = [];
    let last: string | undefined;
    for (const { event: ev } of events) {
      if (ev.type === "message.upserted") roles.set(ev.message.id, ev.message.role);
      if (ev.type !== "part.upserted" || roles.get(ev.messageId) !== "assistant") continue;
      if (ev.part.type === "text" && ev.part.text.trim()) {
        const m = texts.get(ev.messageId) ?? new Map<string, string>();
        m.set(ev.part.id, ev.part.text);
        texts.set(ev.messageId, m);
        last = ev.messageId;
      }
      const part = ev.part;
      if (part.type === "file" && !files.some((f) => f.fileId === part.fileId)) files.push({ fileId: part.fileId, name: part.name });
    }
    const answer = last ? [...texts.get(last)!.values()].join("\n\n").trim() : "";
    for (const chat of to) {
      if (!this.allowed(chat)) continue; // отключили, пока агент думал
      for (const part of chunks(answer)) {
        await this.api("sendMessage", { chat_id: chat, text: mdToTelegram(part), parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() =>
          // разметка не разобралась — шлём как есть
          this.api("sendMessage", { chat_id: chat, text: part }),
        );
      }
      for (const f of files) await this.sendFile(chat, f.fileId).catch((e: Error) => this.api("sendMessage", { chat_id: chat, text: `⚠️ ${f.name}: ${e.message}` }).catch(() => {}));
    }
  }

  /** Файл от агента — документом (фото тоже документом: без пережатия, с исходным именем). */
  private async sendFile(chat: number, fileId: string): Promise<void> {
    const row = this.parent.files.get(fileId);
    if (!row) throw new Error(L("файл не найден", "file not found"));
    if (row.size > 50 * 1024 * 1024) throw new Error(L("больше 50 МБ — Telegram не принимает от ботов, открой в KraBness", "over 50 MB — Telegram doesn't accept it from bots, open it in KraBness"));
    const form = new FormData();
    form.set("chat_id", String(chat));
    const buf = await new Promise<Buffer>((res, rej) => {
      const parts: Buffer[] = [];
      createReadStream(row.path).on("data", (d) => parts.push(d as Buffer)).on("end", () => res(Buffer.concat(parts))).on("error", rej);
    });
    form.set("document", new Blob([new Uint8Array(buf)], { type: row.mime }), row.name || basename(row.path));
    const r = await this.http.fetch(`https://api.telegram.org/bot${this.cfg.token}/sendDocument`, { method: "POST", body: form });
    const j = (await r.json().catch(() => ({}))) as Json;
    if (!j.ok) throw new Error(j.description ?? `Telegram ${r.status}`);
  }

  private async ask(id: string, text: string, keyboard: Json[][]): Promise<void> {
    const sent: Array<{ chat: number; message: number }> = [];
    // спрашиваем того, кто начал разговор; ход начат из KraBness — там и ответят
    for (const chat of this.askers) {
      if (!this.allowed(chat)) continue;
      const m = await this.api("sendMessage", { chat_id: chat, text, reply_markup: { inline_keyboard: keyboard } }).catch(() => undefined);
      if (m) sent.push({ chat, message: m.message_id });
    }
    this.asks.set(id, sent);
  }

  /** Вопрос агента: варианты первого вопроса — кнопками; несколько вопросов или свой ответ — в KraBness. */
  private async question(r: QuestionRequest): Promise<void> {
    const q = r.questions[0];
    if (!q) return;
    const simple = r.questions.length === 1 && !q.multiple && q.options.length > 0 && q.options.length <= 8;
    const text = `❓ ${q.question}${simple ? "" : L("\n\nОтветь в KraBness: тут вопрос не помещается в кнопки.", "\n\nAnswer in KraBness: this question doesn't fit into buttons.")}`;
    await this.ask(r.id, text, simple ? q.options.map((o, i) => [{ text: o.label.slice(0, 60), callback_data: `q|${r.id}|${i}` }]) : []);
  }

  private async closeAsk(id: string, note: string): Promise<void> {
    const sent = this.asks.get(id);
    if (!sent) return;
    this.asks.delete(id);
    for (const s of sent) await this.api("editMessageReplyMarkup", { chat_id: s.chat, message_id: s.message, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    void note;
  }

  private async onButton(q: Json): Promise<void> {
    const chat = q.message?.chat?.id as number | undefined;
    if (!chat || !this.allowed(chat)) return void (await this.api("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {}));
    const [kind, rid, arg] = String(q.data ?? "").split("|");
    let note = L("Уже не актуально", "No longer relevant");
    try {
      if (kind === "p" && rid && (arg === "once" || arg === "reject")) {
        await this.parent.sessions.replyPermission(this.cfg.sessionId, rid, arg, "telegram");
        note = arg === "once" ? L("✅ Разрешено", "✅ Allowed") : L("⛔ Отклонено", "⛔ Denied");
      } else if (kind === "q" && rid) {
        const label = q.message?.reply_markup?.inline_keyboard?.[Number(arg)]?.[0]?.text as string | undefined;
        if (label) {
          await this.parent.sessions.replyQuestion(this.cfg.sessionId, rid, [[label]], "telegram");
          note = `✔ ${label}`;
        }
      }
    } catch {
      /* запрос уже закрыт */
    }
    await this.api("answerCallbackQuery", { callback_query_id: q.id, text: note }).catch(() => {});
  }

  info(): SessionBotInfo {
    return {
      configured: true,
      ...(this.botName ? { bot: this.botName } : {}),
      code: this.code,
      chats: this.cfg.chats.map((c) => ({ id: c.id, name: c.name })),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

/** Все боты сессий хаба. */
export class SessionBots {
  private bots = new Map<string, SessionBot>();
  private _net?: TelegramHttp;
  private netKey = "";

  constructor(
    public config: ConfigStore,
    public sessions: SessionManager,
    public files: FileStore,
    public log: (m: string) => void = () => {},
    private makeHttp: typeof telegramHttp = telegramHttp,
    public pollTimeoutSec = 30,
    /** запасной HTTP-прокси (адрес), если у Telegram свой не задан: где Telegram заблокирован, а у хаба есть выход наружу */
    private fallbackProxy?: () => string | undefined,
  ) {
    sessions.on("event", (e) => this.bots.get(e.sessionId)?.onEvent(e));
    sessions.on("session.deleted", (id) => void this.remove(id));
  }

  /** Связь с Bot API: прокси Telegram из настроек, иначе запасной, иначе напрямую. Сменились настройки — новое соединение. */
  get net(): TelegramHttp {
    const p = this.config.config.telegramProxy;
    const url = p ? undefined : this.fallbackProxy?.();
    const key = p ? JSON.stringify(p) : (url ?? "direct");
    if (!this._net || key !== this.netKey) {
      this._net?.close();
      const u = url ? new URL(url) : undefined;
      this._net = this.makeHttp(p ?? (u ? { type: "http", host: u.hostname, port: Number(u.port) } : undefined));
      this.netKey = key;
    }
    return this._net;
  }

  start(): void {
    for (const c of this.config.config.sessionBots ?? []) {
      if (!this.bots.has(c.sessionId)) this.bots.set(c.sessionId, new SessionBot(this, c));
      this.bots.get(c.sessionId)!.start();
    }
  }

  close(): void {
    for (const b of this.bots.values()) b.stop();
    this._net?.close();
  }

  info(sessionId: string): SessionBotInfo {
    this.sessions.get(sessionId);
    return this.bots.get(sessionId)?.info() ?? { configured: false, chats: [] };
  }

  save(c: SessionBotConfig): void {
    const list = (this.config.config.sessionBots ?? []).filter((x) => x.sessionId !== c.sessionId);
    this.config.setSessionBots([...list, c]);
  }

  /** Привязать бота к сессии: токен проверяем у Telegram; один токен — один бот (два опроса одного бота мешают друг другу). */
  async setToken(sessionId: string, token: string): Promise<SessionBotInfo> {
    this.sessions.get(sessionId);
    const t = token.trim();
    if (!/^\d+:[\w-]{30,}$/.test(t)) throw new Error(L("Это не похоже на токен бота (вида 123456:ABC…). Его выдаёт @BotFather.", "This doesn't look like a bot token (like 123456:ABC…). @BotFather issues it."));
    if (this.config.config.telegram?.token === t) throw new Error(L("Этот бот уже шлёт уведомления KraBness. Для сессии заведи отдельного у @BotFather.", "This bot already sends KraBness notifications. Create a separate one at @BotFather for the session."));
    if ((this.config.config.sessionBots ?? []).some((b) => b.token === t && b.sessionId !== sessionId)) throw new Error(L("Этот бот уже привязан к другой сессии.", "This bot is already linked to another session."));
    let me: Json;
    try {
      me = (await this.net.fetch(`https://api.telegram.org/bot${t}/getMe`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as Json;
    } catch (e) {
      throw new Error(`${L("Нет связи с Telegram", "No connection to Telegram")}: ${(e as Error).message}`);
    }
    if (!me.ok) throw new Error(`${L("Telegram не принял токен", "Telegram rejected the token")}: ${me.description ?? ""}`);
    this.bots.get(sessionId)?.stop();
    const old = this.bots.get(sessionId)?.cfg;
    const cfg: SessionBotConfig = { sessionId, token: t, chats: old?.token === t ? old.chats : [] };
    this.save(cfg);
    const bot = new SessionBot(this, cfg);
    bot.botName = me.result.username;
    this.bots.set(sessionId, bot);
    bot.start();
    return bot.info();
  }

  /** Отключить человека от бота сессии. */
  unlinkChat(sessionId: string, chatId: number): SessionBotInfo {
    const bot = this.bots.get(sessionId);
    if (!bot) return this.info(sessionId);
    bot.cfg = { ...bot.cfg, chats: bot.cfg.chats.filter((c) => c.id !== chatId) };
    this.save(bot.cfg);
    return bot.info();
  }

  /** Имя человека: им подписываются его сообщения агенту (по умолчанию — из профиля Telegram). */
  renameChat(sessionId: string, chatId: number, name: string): SessionBotInfo {
    const bot = this.bots.get(sessionId);
    const n = String(name ?? "").trim().slice(0, 40);
    if (!n) throw new Error(L("Пустое имя", "Empty name"));
    if (!bot || !bot.cfg.chats.some((c) => c.id === chatId)) throw new Error(L("Нет такого человека у бота", "No such person in the bot"));
    bot.cfg = { ...bot.cfg, chats: bot.cfg.chats.map((c) => (c.id === chatId ? { ...c, name: n } : c)) };
    this.save(bot.cfg);
    return bot.info();
  }

  newCode(sessionId: string): SessionBotInfo {
    const bot = this.bots.get(sessionId);
    if (bot) bot.code = String(randomInt(100000, 1000000));
    return this.info(sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    this.bots.get(sessionId)?.stop();
    this.bots.delete(sessionId);
    const list = this.config.config.sessionBots ?? [];
    if (list.some((b) => b.sessionId === sessionId)) this.config.setSessionBots(list.filter((b) => b.sessionId !== sessionId));
  }

  /** для тестов: бот сессии */
  botOf(sessionId: string): SessionBot | undefined {
    return this.bots.get(sessionId);
  }
}
