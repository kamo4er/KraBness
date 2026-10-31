// Конфиг хаба: config/kamharn.json. Разрешённые папки (roots) можно менять на лету из UI.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { L } from "./lang.ts";
import type { ModelRef, CustomProvider, LangSetting, McpServer, NewSessionPrefs, TelegramProxy, RemoteSettings } from "@kamharn/protocol";

/** Бот одной сессии: токен от @BotFather и подключённые личные чаты. */
export interface SessionBotConfig {
  sessionId: string;
  token: string;
  chats: Array<{ id: number; name: string }>;
}

export interface HubConfig {
  /** адреса, на которых слушает хаб; "tailscale" — подставить IPv4 из `tailscale ip -4` */
  listen: string[];
  port: number;
  /** папка для БД и файлов */
  dataDir: string;
  roots: string[];
  /** быстрые кнопки над полем ввода (общие для всех устройств) */
  quickPrompts?: string[];
  /** будильник ПК (scripts/nas-wake/wake.py в домашней сети): приложение зовёт его по Tailscale, когда ПК спит */
  wake?: { url: string; token: string; mac?: string; broadcast?: string };
  /** свои OpenAI-совместимые серверы для opencode (LM Studio, Ollama…) */
  customProviders?: CustomProvider[];
  /** избранные модели по провайдерам opencode (в выборе модели только они) */
  modelFavorites?: Record<string, string[]>;
  /** свой Telegram-бот для уведомлений: токен от @BotFather и привязанный чат */
  telegram?: { token: string; chatId?: number };
  /** боты сессий в Telegram (sessionbot.ts) */
  sessionBots?: SessionBotConfig[];
  /** свои MCP-серверы — хаб отдаёт их обоим движкам */
  mcpServers?: McpServer[];
  /** язык интерфейса, уведомлений и ошибок; auto — язык системы (у клиентов — их устройства) */
  language?: LangSetting;
  /** обновления с GitHub Releases: repo — owner/name, token — пока репозиторий приватный, auto: false — не проверять раз в сутки */
  updates?: { repo?: string; token?: string; auto?: boolean; /** свой адрес вместо api.github.com (проверка установки) */ api?: string };
  /** «Новая сессия»: какие движки показывать и что выбрано по умолчанию */
  newSession?: Partial<NewSessionPrefs>;
  /** прокси для Bot API; живёт отдельно от токена — смена бота его не сбрасывает */
  telegramProxy?: TelegramProxy;
  /** задачи: сколько работает одновременно (остальные ждут очереди) */
  tasks?: { parallel?: number };
  /** команды автопроверки по папкам проектов (ключ — папка проекта, у ветки сессии — основная) */
  checks?: Record<string, string[]>;
  /** адреса хаба за своим обратным прокси (NAS, роутер с белым IP): попадают в известные адреса и QR */
  publicUrls?: string[];
  /** общий адрес превью за тем же обратным прокси (своё имя → порт хаба): превью с телефона без Tailscale */
  previewUrl?: string;
  /** подсказка агентам про живые артефакты (```html) и диаграммы (```mermaid); по умолчанию включена */
  artifactsHint?: boolean;
  /** Диспетчер (dispatcher.ts): модель Claude его сессии (по умолчанию Opus); computer: false — без управления ПК */
  dispatcher?: { model?: string; computer?: boolean };
  /** голос на ПК (voice.ts): включён, микрофон, порог слова-активатора */
  voice?: { enabled?: boolean; device?: string; threshold?: number };
  /** удалённый доступ через свой VPS (remote.ts): SSH-туннель + HTTPS на сервере */
  remote?: RemoteSettings;
  engines: {
    opencode: { enabled: boolean; bin?: string; port: number; defaultModel?: ModelRef };
    /** userMcp — подключать MCP-серверы из пользовательских настроек Claude (замедляет старт) */
    /** apiKey — свой ключ Anthropic вместо входа по подписке (наружу не отдаётся) */
    /** args — доп. аргументы claude при каждом запуске (например, --settings с языком) */
    claude: { enabled: boolean; bin?: string; defaultModel?: ModelRef; userMcp?: boolean; apiKey?: string; args?: string[] };
  };
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

/**
 * Сетевые пути (\\сервер\папка, //сервер, \\?\UNC\…) отклоняем до любого обращения к диску:
 * уже realpath на них заставляет Windows отправить NTLM-хэш пароля на чужой сервер.
 */
export function noUnc(p: string): void {
  if (/^[\\/]{2}/.test(p)) throw new Error(`${L("Сетевые пути не поддерживаются", "Network paths aren't supported")}: ${p}`);
}

export function defaultConfig(): HubConfig {
  return {
    listen: ["127.0.0.1", "tailscale"],
    port: 7420,
    dataDir: join(REPO_ROOT, "data"),
    roots: [join(homedir(), "Projects")],
    engines: {
      opencode: { enabled: true, port: 0 },
      claude: { enabled: true },
    },
  };
}

export class ConfigStore {
  config: HubConfig;

  constructor(readonly path: string, overrides: Partial<HubConfig> = {}) {
    const base = defaultConfig();
    let fromFile: Partial<HubConfig> = {};
    if (existsSync(path)) fromFile = JSON.parse(readFileSync(path, "utf8")) as Partial<HubConfig>;
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(base, null, 2) + "\n");
    }
    this.config = {
      ...base,
      ...fromFile,
      ...overrides,
      engines: { ...base.engines, ...fromFile.engines, ...overrides.engines },
    };
  }

  save(): void {
    writeFileSync(this.path, JSON.stringify(this.config, null, 2) + "\n");
  }

  addRoot(p: string): string {
    noUnc(p);
    const real = realpathSync(resolve(p));
    if (!statSync(real).isDirectory()) throw new Error(`${L("Не папка", "Not a folder")}: ${p}`);
    if (!this.config.roots.some((r) => samePath(r, real))) {
      this.config.roots.push(real);
      this.save();
    }
    return real;
  }

  get quickPrompts(): string[] {
    return this.config.quickPrompts ?? defaultQuickPrompts();
  }

  setQuickPrompts(list: unknown): string[] {
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new Error(L("prompts: массив строк", "prompts: an array of strings"));
    const clean = [...new Set(list.map((x: string) => x.trim()).filter(Boolean))];
    if (clean.length > 20) throw new Error(L("Не больше 20 кнопок", "No more than 20 buttons"));
    if (clean.some((x) => x.length > 500)) throw new Error(L("Кнопка длиннее 500 символов", "A button is longer than 500 characters"));
    this.config.quickPrompts = clean;
    this.save();
    return clean;
  }

  setTelegram(t: { token: string; chatId?: number } | undefined): void {
    if (t) this.config.telegram = t;
    else delete this.config.telegram;
    this.save();
  }

  setSessionBots(list: SessionBotConfig[]): void {
    if (list.length) this.config.sessionBots = list;
    else delete this.config.sessionBots;
    this.save();
  }

  setLanguage(l: LangSetting): void {
    this.config.language = l;
    this.save();
  }

  setClaudeApiKey(key?: string): void {
    const c = { ...this.config.engines.claude };
    if (key) c.apiKey = key;
    else delete c.apiKey;
    this.config.engines = { ...this.config.engines, claude: c };
    this.save();
  }

  setUpdatesAuto(auto: boolean): void {
    this.config.updates = { ...this.config.updates, auto };
    this.save();
  }

  setNewSession(p: NewSessionPrefs): void {
    this.config.newSession = p;
    this.save();
  }

  setMcpServers(list: McpServer[]): void {
    this.config.mcpServers = list;
    this.save();
  }

  setWake(w: HubConfig["wake"] | undefined): void {
    if (w) this.config.wake = w;
    else delete this.config.wake;
    this.save();
  }

  setTasksParallel(n: number): void {
    this.config.tasks = { ...this.config.tasks, parallel: n };
    this.save();
  }

  setChecks(directory: string, commands: string[]): void {
    const all = { ...(this.config.checks ?? {}) };
    if (commands.length) all[directory] = commands;
    else delete all[directory];
    this.config.checks = all;
    this.save();
  }

  setPublicUrls(list: string[]): void {
    if (list.length) this.config.publicUrls = list;
    else delete this.config.publicUrls;
    this.save();
  }

  setPreviewUrl(url: string | undefined): void {
    if (url) this.config.previewUrl = url;
    else delete this.config.previewUrl;
    this.save();
  }

  setRemote(r: RemoteSettings | undefined): void {
    if (r) this.config.remote = r;
    else delete this.config.remote;
    this.save();
  }

  setTelegramProxy(p: TelegramProxy | undefined): void {
    if (p) this.config.telegramProxy = p;
    else delete this.config.telegramProxy;
    this.save();
  }

  setCustomProviders(list: CustomProvider[]): void {
    this.config.customProviders = list;
    this.save();
  }

  /** пустой список — показывать все модели провайдера */
  setFavorites(providerId: string, models: string[]): void {
    const all = { ...(this.config.modelFavorites ?? {}) };
    if (models.length) all[providerId] = models;
    else delete all[providerId];
    this.config.modelFavorites = all;
    this.save();
  }

  setClaudeUserMcp(enabled: boolean): void {
    this.config.engines.claude.userMcp = enabled;
    this.save();
  }

  removeRoot(p: string): void {
    this.config.roots = this.config.roots.filter((r) => !samePath(r, p));
    this.save();
  }

  /**
   * Возвращает реальный путь, если он внутри одного из roots, иначе бросает ошибку.
   * realpath раскрывает `..` и симлинки, так что выйти за пределы allowlist'а нельзя.
   */
  resolveAllowed(p: string): string {
    noUnc(p);
    if (!isAbsolute(p)) throw new Error(`${L("Нужен абсолютный путь", "An absolute path is required")}: ${p}`);
    let real: string;
    try {
      real = realpathSync(resolve(p));
    } catch {
      throw new Error(`${L("Путь не существует", "The path doesn't exist")}: ${p}`);
    }
    for (const root of this.config.roots) {
      let rootReal: string;
      try {
        rootReal = realpathSync(root);
      } catch {
        continue;
      }
      if (isInside(rootReal, real)) return real;
    }
    throw new Error(`${L("Путь вне разрешённых папок", "The path is outside the allowed folders")}: ${p}`);
  }
}

// На Windows пути регистронезависимы
const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);

function samePath(a: string, b: string): boolean {
  return fold(resolve(a)) === fold(resolve(b));
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(fold(root), fold(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** быстрые кнопки по умолчанию — на языке хаба (свои, сохранённые, не трогаем) */
export const defaultQuickPrompts = (): string[] => [L("Продолжай", "Continue"), L("Проверь, что всё работает", "Check that everything works"), L("Закоммить изменения", "Commit the changes")];
