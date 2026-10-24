// Уведомления через своего Telegram-бота — без Firebase и без открытого в интернет адреса:
// хаб сам ходит в Bot API (long polling), отправляет уведомления и забирает нажатия кнопок.
// Привязка: токен бота в настройках → пишешь боту «/start <код>» → чат запомнен, остальных бот игнорирует.
// Кнопки «Разрешить/Отклонить» отвечают на запрос подтверждения; ответ реплаем на уведомление уходит агенту.
// Где Telegram заблокирован — запросы через свой прокси (SOCKS5 или HTTP, обычно на VPS).
import { randomInt } from "node:crypto";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import type { HubNotice, PermissionReply, TelegramProxy, TelegramStatus } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { L } from "./lang.ts";

type Json = Record<string, any>;

export interface TelegramActions {
  replyPermission(sessionId: string, requestId: string, reply: PermissionReply): Promise<void>;
  prompt(sessionId: string, text: string): Promise<void>;
}

/** fetch к Bot API: напрямую или через прокси; close — закрыть соединения с прокси. */
export interface TelegramHttp {
  fetch: typeof fetch;
  close(): void;
}

export function telegramHttp(p?: TelegramProxy): TelegramHttp {
  if (!p) return { fetch, close: () => {} };
  const auth = p.username ? { user: p.username, pass: p.password ?? "" } : undefined;
  const host = p.host.includes(":") ? `[${p.host}]` : p.host;
  const dispatcher: Dispatcher =
    p.type === "socks5"
      ? socksDispatcher({ type: 5, host: p.host, port: p.port, ...(auth ? { userId: auth.user, password: auth.pass } : {}) })
      : new ProxyAgent({ uri: `http://${host}:${p.port}`, ...(auth ? { token: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}` } : {}) });
  return {
    fetch: ((url: string, init?: RequestInit) => undiciFetch(url, { ...(init as object), dispatcher })) as unknown as typeof fetch,
    close: () => void dispatcher.close().catch(() => {}),
  };
}

/** «fetch failed» от undici ничего не говорит — причина лежит в cause */
const reason = (e: unknown): string => {
  const err = e as Error & { cause?: Error };
  if (err.name === "TimeoutError") return L("нет ответа за 15 с", "no answer in 15 s");
  return err.cause?.message ?? err.message;
};

const checkProxy = (p: TelegramProxy): TelegramProxy => {
  const host = String(p.host ?? "").trim();
  const port = Number(p.port);
  if (p.type !== "socks5" && p.type !== "http") throw new Error(L("Тип прокси: socks5 или http", "Proxy type: socks5 or http"));
  // «1.2.3.4:1080» — порт вписали в адрес (у IPv6 двоеточий больше одного)
  if (!host || /[\s/@]/.test(host) || /^[^:]+:\d*$/.test(host)) throw new Error(L("Адрес прокси — только IP или домен, без socks5:// и порта", "Proxy address — IP or domain only, without socks5:// and port"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(L("Порт — число от 1 до 65535", "Port — a number from 1 to 65535"));
  const username = p.username?.trim();
  return { type: p.type, host, port, ...(username ? { username, password: p.password ?? "" } : {}) };
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** сколько последних уведомлений помним, чтобы реплай ушёл в нужную сессию */
const REMEMBER = 500;

export class TelegramBot {
  private code?: string;
  /** неверные коды подряд: после 5 код меняется — перебором 6 цифр не подобрать */
  private misses = 0;
  private botName?: string;
  private lastError?: string;
  private offset = 0;
  private ac?: AbortController;
  private running = false;
  /** message_id уведомления → сессия (для ответа реплаем) */
  private sent = new Map<number, string>();
  private net: TelegramHttp;

  constructor(
    private config: ConfigStore,
    private actions: TelegramActions,
    private log: (m: string) => void = () => {},
    private makeHttp: (p?: TelegramProxy) => TelegramHttp = telegramHttp,
    private pollTimeoutSec = 30,
  ) {
    this.net = makeHttp(config.config.telegramProxy);
  }

  private get http(): typeof fetch {
    return this.net.fetch;
  }

  private get cfg() {
    return this.config.config.telegram;
  }

  private async api(method: string, body: Json = {}, signal?: AbortSignal): Promise<any> {
    const token = this.cfg?.token;
    if (!token) throw new Error(L("Бот не настроен", "The bot isn't set up"));
    const r = await this.http(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }).catch((e: unknown) => {
      throw signal?.aborted ? e : new Error(`${L("Нет связи с Telegram", "No connection to Telegram")}: ${reason(e)}`);
    });
    const j = (await r.json().catch(() => ({}))) as Json;
    if (!j.ok) throw new Error(j.description ?? `${L("Telegram ответил", "Telegram answered")} ${r.status}`);
    return j.result;
  }

  status(): TelegramStatus {
    const c = this.cfg;
    const px = this.config.config.telegramProxy;
    const proxy = px ? { proxy: { type: px.type, host: px.host, port: px.port, ...(px.username ? { username: px.username } : {}), hasPassword: !!px.password } } : {};
    if (!c?.token) return { configured: false, bound: false, ...proxy };
    return { configured: true, bound: !!c.chatId, ...(this.botName ? { bot: this.botName } : {}), ...(!c.chatId && this.code ? { code: this.code } : {}), ...(this.lastError ? { error: this.lastError } : {}), ...proxy };
  }

  /** getMe с таймаутом — через неработающий прокси запрос может висеть долго */
  private async getMe(token: string, http: typeof fetch): Promise<Json> {
    try {
      return (await http(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as Json;
    } catch (e) {
      throw new Error(`${L("Нет связи с Telegram", "No connection to Telegram")}${this.config.config.telegramProxy ? L(" через прокси", " via the proxy") : ""}: ${reason(e)}`);
    }
  }

  /**
   * Прокси для Bot API (null — напрямую). Пароль не прислали, а логин тот же — оставляем старый.
   * Если бот уже настроен, сначала проверяем, что через новый прокси Telegram отвечает: не сохраняем то, что сломает связь.
   */
  async setProxy(input: TelegramProxy | null): Promise<TelegramStatus> {
    const old = this.config.config.telegramProxy;
    let p = input ? checkProxy(input) : undefined;
    // прежний пароль — только тому же прокси (адрес, порт, логин): иначе он ушёл бы на новый адрес
    if (p?.username && input?.password === undefined && old?.username === p.username && old.host === p.host && old.port === p.port) p = { ...p, password: old.password ?? "" };
    const net = this.makeHttp(p);
    const token = this.cfg?.token;
    if (token) {
      try {
        const me = (await net.fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json())) as Json;
        if (!me.ok) throw new Error(me.description ?? L("Telegram не ответил", "Telegram didn't answer"));
      } catch (e) {
        net.close();
        throw new Error(`${p ? L("Через этот прокси Telegram недоступен", "Telegram is unreachable through this proxy") : L("Напрямую Telegram недоступен", "Telegram is unreachable directly")}: ${reason(e)}. ${L("Настройки не сохранил.", "Settings not saved.")}`);
      }
    }
    this.stop();
    this.net.close();
    this.net = net;
    this.config.setTelegramProxy(p);
    this.lastError = undefined;
    this.start();
    return this.status();
  }

  /** Новый токен: проверяем у Telegram, сохраняем, ждём привязки чата по коду. */
  async setToken(token: string): Promise<TelegramStatus> {
    const t = token.trim();
    if (!/^\d+:[\w-]{30,}$/.test(t)) throw new Error(L("Это не похоже на токен бота (вида 123456:ABC…). Его выдаёт @BotFather.", "This doesn't look like a bot token (like 123456:ABC…). @BotFather issues it."));
    const me = await this.getMe(t, this.http);
    if (!me.ok) throw new Error(`${L("Telegram не принял токен", "Telegram rejected the token")}: ${me.description ?? L("ошибка", "error")}`);
    this.stop();
    this.config.setTelegram({ token: t });
    this.botName = me.result.username;
    this.code = String(randomInt(100000, 1000000));
    this.lastError = undefined;
    this.start();
    return this.status();
  }

  remove(): void {
    this.stop();
    this.config.setTelegram(undefined);
    this.code = undefined;
    this.botName = undefined;
  }

  async test(): Promise<void> {
    if (!this.cfg?.chatId) throw new Error(L("Чат ещё не привязан", "The chat isn't linked yet"));
    await this.api("sendMessage", { chat_id: this.cfg.chatId, text: L("Проверка: уведомления KraBness приходят сюда 👍", "Test: KraBness notifications arrive here 👍") });
  }

  /** Канал Notifier: уведомление в привязанный чат. */
  notify(n: HubNotice): void {
    const chat = this.cfg?.chatId;
    if (!chat || !this.cfg?.token) return;
    const markup =
      n.kind === "permission" && n.requestId
        ? { inline_keyboard: [[{ text: L("✅ Разрешить", "✅ Allow"), callback_data: `p|${n.sessionId}|${n.requestId}|once` }, { text: L("⛔ Отклонить", "⛔ Deny"), callback_data: `p|${n.sessionId}|${n.requestId}|reject` }]] }
        : undefined;
    void this.api("sendMessage", { chat_id: chat, text: `<b>${esc(n.title)}</b>\n${esc(n.message)}`, parse_mode: "HTML", ...(markup ? { reply_markup: markup } : {}) }).then(
      (m: Json) => {
        this.sent.set(m.message_id, n.sessionId);
        if (this.sent.size > REMEMBER) this.sent.delete(this.sent.keys().next().value!);
      },
      (e: Error) => this.log(`[telegram] ${L("не отправилось", "not sent")}: ${e.message}`),
    );
  }

  start(): void {
    if (this.running || !this.cfg?.token) return;
    if (!this.code && !this.cfg.chatId) this.code = String(randomInt(100000, 1000000));
    this.running = true;
    const ac = new AbortController();
    this.ac = ac;
    void (async () => {
      if (!this.botName) this.botName = await this.api("getMe").then((m: Json) => m.username, () => undefined);
      while (!ac.signal.aborted) {
        try {
          const updates: Json[] = await this.api("getUpdates", { offset: this.offset, timeout: this.pollTimeoutSec, allowed_updates: ["message", "callback_query"] }, ac.signal);
          this.lastError = undefined;
          for (const u of updates) {
            this.offset = u.update_id + 1;
            await this.handle(u).catch((e: Error) => this.log(`[telegram] ${e.message}`));
          }
        } catch (e) {
          if (ac.signal.aborted) break;
          this.lastError = (e as Error).message;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      this.running = false;
    })();
  }

  stop(): void {
    this.ac?.abort();
    this.running = false;
  }

  /** при выключении хаба: ещё и соединения с прокси */
  close(): void {
    this.stop();
    this.net.close();
  }

  private async handle(u: Json): Promise<void> {
    const chat = this.cfg?.chatId;
    if (u.message) {
      const m = u.message;
      const text = String(m.text ?? "").trim();
      const start = /^\/start(?:@\w+)?\s+(\d{6})$/.exec(text);
      // привязать можно только личный чат: в группе нажимать «Разрешить» и писать агенту смог бы любой участник
      if (start && !chat && m.chat.type && m.chat.type !== "private") {
        return void (await this.api("sendMessage", { chat_id: m.chat.id, text: L("Привязать можно только личный чат с ботом.", "Only a private chat with the bot can be linked.") }));
      }
      if (start && !chat) {
        if (start[1] !== this.code) {
          if (++this.misses >= 5) {
            this.code = String(randomInt(100000, 1000000));
            this.misses = 0;
            this.log(L("[telegram] 5 неверных кодов подряд — код привязки заменён", "[telegram] 5 wrong codes in a row — the link code was replaced"));
          }
          return void (await this.api("sendMessage", { chat_id: m.chat.id, text: L("Код не подходит. Возьми его в настройках KraBness.", "Wrong code. Get it in the KraBness settings.") }));
        }
        this.misses = 0;
        this.config.setTelegram({ token: this.cfg!.token, chatId: m.chat.id });
        this.code = undefined;
        this.log(`[telegram] ${L("привязан чат", "linked chat")} ${m.chat.id}`);
        return void (await this.api("sendMessage", { chat_id: m.chat.id, text: L("Готово: уведомления KraBness будут приходить сюда. Ответь реплаем на уведомление — текст уйдёт агенту в эту сессию.", "Done: KraBness notifications will arrive here. Reply to a notification — the text goes to the agent in that session.") }));
      }
      // чужие чаты молча игнорируем
      if (m.chat.id !== chat) return;
      const sid = m.reply_to_message ? this.sent.get(m.reply_to_message.message_id) : undefined;
      if (sid && text) {
        await this.actions.prompt(sid, text);
        return void (await this.api("sendMessage", { chat_id: chat, text: L("→ отправил агенту", "→ sent to the agent"), reply_to_message_id: m.message_id }));
      }
      return void (await this.api("sendMessage", { chat_id: chat, text: L("Чтобы написать агенту, ответь реплаем на его уведомление.", "To message the agent, reply to its notification.") }));
    }
    if (u.callback_query) {
      const q = u.callback_query;
      if (q.message?.chat?.id !== chat) return void (await this.api("answerCallbackQuery", { callback_query_id: q.id }));
      const [kind, sid, rid, reply] = String(q.data ?? "").split("|");
      if (kind !== "p" || !sid || !rid || (reply !== "once" && reply !== "reject")) return;
      let note: string;
      try {
        await this.actions.replyPermission(sid, rid, reply);
        note = reply === "once" ? L("✅ Разрешено", "✅ Allowed") : L("⛔ Отклонено", "⛔ Denied");
      } catch {
        note = L("Уже не актуально", "No longer relevant");
      }
      await this.api("answerCallbackQuery", { callback_query_id: q.id, text: note });
      await this.api("editMessageText", { chat_id: chat, message_id: q.message.message_id, text: `${q.message.text ?? ""}\n\n${note}` }).catch(() => {});
    }
  }
}
