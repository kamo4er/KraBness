// Свои MCP-серверы: список хранит KamHarn (config.mcpServers) и отдаёт обоим движкам —
// Claude через mcp-конфиг сессии (--mcp-config), opencode через OPENCODE_CONFIG_CONTENT.
// Настройки Claude Code пользователя (~/.claude.json, VS Code) не трогаем.
// Значения env и headers (ключи API) наружу не отдаём: клиент видит только имена.
import type { McpOverview, McpServer, McpServerStatus, McpServerView } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

type Json = Record<string, any>;

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9-]+$/;
// на Windows npx и другие .cmd-обёртки без оболочки не запускаются
const SHIM = /^(npx|npm|pnpm|pnpx|yarn|bunx)(\.cmd)?$|\.(cmd|bat)$/i;

/** Команда запуска stdio-сервера с учётом Windows. */
export function launch(command: string, args: string[] = [], platform: string = process.platform): string[] {
  return platform === "win32" && SHIM.test(command) ? ["cmd", "/c", command, ...args] : [command, ...args];
}

function bad(msg: string): never {
  throw new HttpError(400, msg);
}

/** Ключи и значения; пустое значение у ключа, который уже был, — оставить прежнее (секреты в UI не видны). */
function secrets(input: unknown, old: Record<string, string> | undefined, key: RegExp, what: string): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) bad(`${what}: ${L("ожидается объект", "an object is expected")}`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!key.test(k)) bad(`${what}: ${L(`недопустимое имя «${k}»`, `invalid name “${k}”`)}`);
    const s = typeof v === "string" ? v : "";
    out[k] = s === "" && old?.[k] !== undefined ? old[k]! : s;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Проверка и нормализация сервера из UI; old — прежняя версия (для секретов). */
export function normalize(input: McpServer, old?: McpServer): McpServer {
  const name = String(input?.name ?? "").trim();
  if (!NAME.test(name)) bad(L("Имя: латиница, цифры, - и _ (до 40 символов)", "Name: latin letters, digits, - and _ (up to 40 characters)"));
  if (name.toLowerCase() === "kamharn") bad(L("Имя «kamharn» занято служебным сервером хаба", "The name “kamharn” is taken by the hub's internal server"));
  const engines = input.engines ?? "both";
  if (!["both", "claude", "opencode"].includes(engines)) bad(L("Движки: both, claude или opencode", "Engines: both, claude or opencode"));
  const base = { name, enabled: input.enabled !== false, engines };
  if (input.type === "stdio") {
    const command = String(input.command ?? "").trim();
    if (!command) bad(L("Укажи команду запуска, например npx", "Specify the launch command, e.g. npx"));
    const args = (input.args ?? []).map(String).filter((a) => a !== "");
    // прежние значения — только той же команде: иначе секреты достались бы другой программе
    const env = secrets(input.env, old?.type === "stdio" && old.command === command ? old.env : undefined, ENV_KEY, L("Переменные", "Variables"));
    return { ...base, type: "stdio", command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) };
  }
  if (input.type === "http" || input.type === "sse") {
    const url = String(input.url ?? "").trim();
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      bad(L("Адрес сервера: полный URL, например https://example.com/mcp", "Server URL: a full URL, e.g. https://example.com/mcp"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") bad(L("Адрес сервера: только http или https", "Server URL: http or https only"));
    // прежние заголовки (токены) — только тому же серверу: иначе их получил бы новый адрес
    const sameHost = !!old?.url && old.type !== "stdio" && (() => { try { return new URL(old.url!).host === u.host; } catch { return false; } })();
    const headers = secrets(input.headers, sameHost ? old!.headers : undefined, HEADER_KEY, L("Заголовки", "Headers"));
    return { ...base, type: input.type, url, ...(headers ? { headers } : {}) };
  }
  bad(L("Тип: stdio (команда) или http/sse (адрес)", "Type: stdio (command) or http/sse (URL)"));
}

const forEngine = (s: McpServer, e: "claude" | "opencode") => s.enabled && (s.engines === "both" || s.engines === e);

/** mcpServers для mcp-конфига Claude. */
export function claudeEntries(list: McpServer[]): Record<string, Json> {
  return Object.fromEntries(
    list
      .filter((s) => forEngine(s, "claude"))
      .map((s) => {
        if (s.type === "stdio") {
          const [command, ...args] = launch(s.command!, s.args);
          return [s.name, { type: "stdio", command, args, ...(s.env ? { env: s.env } : {}) }];
        }
        return [s.name, { type: s.type, url: s.url, ...(s.headers ? { headers: s.headers } : {}) }];
      }),
  );
}

/** mcp для конфига opencode (local — команда массивом, remote — адрес; OAuth не используем). */
export function opencodeEntries(list: McpServer[]): Record<string, Json> {
  return Object.fromEntries(
    list
      .filter((s) => forEngine(s, "opencode"))
      .map((s) =>
        s.type === "stdio"
          ? [s.name, { type: "local", command: launch(s.command!, s.args), enabled: true, ...(s.env ? { environment: s.env } : {}) }]
          : [s.name, { type: "remote", url: s.url, enabled: true, oauth: false, ...(s.headers ? { headers: s.headers } : {}) }],
      ),
  );
}

export interface McpHooks {
  /** список для Claude поменялся — простаивающие процессы перезапустить со следующего сообщения */
  claudeChanged(): void;
  /** список для opencode поменялся — перезапустить opencode */
  opencodeChanged(): Promise<void>;
  /** статусы серверов у работающего opencode (GET /mcp) */
  opencodeStatus?(): Promise<Record<string, { status: string; error?: string }>>;
  /** серверы из настроек Claude и галка «подключать» */
  claudeUser(): { enabled: boolean; servers: string[] };
}

export class McpRegistry {
  private claudeStatus = new Map<string, McpServerStatus>();

  constructor(
    private config: ConfigStore,
    private hooks: McpHooks,
  ) {}

  list(): McpServer[] {
    return this.config.config.mcpServers ?? [];
  }

  forClaude(): Record<string, Json> {
    return claudeEntries(this.list());
  }

  forOpencode(): Record<string, Json> {
    return opencodeEntries(this.list());
  }

  /** system/init Claude: mcp_servers [{name, status}] — запоминаем последнее состояние */
  noteClaudeInit(servers: unknown): void {
    if (!Array.isArray(servers)) return;
    const at = Date.now();
    for (const s of servers as Json[]) if (typeof s?.name === "string" && typeof s.status === "string") this.claudeStatus.set(s.name, { status: s.status, at });
  }

  async overview(): Promise<McpOverview> {
    let oc: Record<string, { status: string; error?: string }> = {};
    try {
      oc = (await this.hooks.opencodeStatus?.()) ?? {};
    } catch {
      /* opencode не запущен */
    }
    const at = Date.now();
    const servers: McpServerView[] = this.list().map(({ env, headers, ...s }) => {
      const st: McpServerView["status"] = {};
      const c = this.claudeStatus.get(s.name);
      if (c && forEngine({ ...s, env, headers }, "claude")) st.claude = c;
      const o = oc[s.name];
      if (o && forEngine({ ...s, env, headers }, "opencode")) st.opencode = { status: o.status, ...(o.error ? { error: o.error } : {}), at };
      return { ...s, envKeys: Object.keys(env ?? {}), headerKeys: Object.keys(headers ?? {}), status: st };
    });
    return { servers, claude: this.hooks.claudeUser() };
  }

  private async apply(next: McpServer[]): Promise<McpOverview> {
    const before = { c: JSON.stringify(this.forClaude()), o: JSON.stringify(this.forOpencode()) };
    this.config.setMcpServers(next);
    if (JSON.stringify(this.forClaude()) !== before.c) this.hooks.claudeChanged();
    // настройки уже сохранены: сбой перезапуска opencode — не ошибка сохранения, а пометка в ответе
    let opencodeError: string | undefined;
    if (JSON.stringify(this.forOpencode()) !== before.o) {
      try {
        await this.hooks.opencodeChanged();
      } catch (e) {
        opencodeError = `${L("Сохранено, но opencode не перезапустился", "Saved, but opencode didn't restart")}: ${(e as Error).message}`;
      }
    }
    const ov = await this.overview();
    return opencodeError ? { ...ov, opencodeError } : ov;
  }

  /** Добавить или изменить (oldName — прежнее имя при переименовании). */
  async save(oldName: string | undefined, input: McpServer): Promise<McpOverview> {
    const list = this.list();
    const old = oldName ? list.find((s) => s.name === oldName) : undefined;
    if (oldName && !old) bad(L(`Сервера «${oldName}» нет`, `No server “${oldName}”`));
    const s = normalize(input, old);
    if (list.some((x) => x.name.toLowerCase() === s.name.toLowerCase() && x !== old)) bad(L(`Сервер «${s.name}» уже есть`, `Server “${s.name}” already exists`));
    // переименовали — статус старого имени больше ни к чему не относится
    if (old && old.name !== s.name) this.claudeStatus.delete(old.name);
    return this.apply(old ? list.map((x) => (x === old ? s : x)) : [...list, s]);
  }

  async remove(name: string): Promise<McpOverview> {
    const list = this.list();
    if (!list.some((s) => s.name === name)) bad(L(`Сервера «${name}» нет`, `No server “${name}”`));
    this.claudeStatus.delete(name);
    return this.apply(list.filter((s) => s.name !== name));
  }
}
