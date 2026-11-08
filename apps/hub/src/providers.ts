// Провайдеры моделей для opencode: подключить по API-ключу или по подписке (ChatGPT Plus/Pro и т.п.),
// свои OpenAI-совместимые серверы (LM Studio, Ollama), избранные модели для выбора.
// Ключи и входы хранит сам opencode (как `opencode auth login`); свои серверы и избранное — config/kamharn.json.
import type { CustomProvider, OAuthStart, ProviderAuthMethod, ProviderEntry, ProviderModel } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import type { OpencodeEngine } from "./engines/opencode.ts";
import { HttpError } from "./sessions.ts";
import { slugify } from "./worktree.ts";
import { L } from "./lang.ts";

/** показываются наверху списка (выбор пользователя), остальные — поиском */
export const POPULAR = ["openai", "openrouter", "deepseek", "google", "anthropic"];
/** у провайдера больше моделей — при подключении сразу отмечаем свежие, а не показываем сотни */
const FAVORITES_OVER = 20;
const AUTO_FAVORITES = 8;

type Json = Record<string, any>;

interface OAuthState {
  status: "waiting" | "done" | "error";
  error?: string;
}

export class Providers {
  private oauth = new Map<string, OAuthState>();

  constructor(
    private oc: Pick<OpencodeEngine, "providers" | "authMethods" | "setKey" | "oauthAuthorize" | "oauthCallback" | "disconnect" | "restart">,
    private config: ConfigStore,
    private log: (m: string) => void = () => {},
    private http: typeof fetch = fetch,
  ) {}

  private custom(): CustomProvider[] {
    return this.config.config.customProviders ?? [];
  }

  async list(): Promise<ProviderEntry[]> {
    const [prov, auth] = await Promise.all([this.oc.providers(), this.oc.authMethods().catch(() => ({}) as Record<string, never>)]);
    const connected = new Set(prov.connected);
    const fav = this.config.config.modelFavorites ?? {};
    const customIds = new Set(this.custom().map((c) => c.id));
    const out: ProviderEntry[] = prov.all
      // встроенный бесплатный opencode подключён всегда — в списке провайдеров он не нужен
      .filter((p: Json) => p.id !== "opencode")
      .map((p: Json) => {
        const methods: ProviderAuthMethod[] = ((auth as Json)[p.id] ?? [{ type: "api", label: L("API-ключ", "API key") }]).map((m: Json, index: number) => ({
          index,
          type: m.type,
          label: m.label,
          ...(m.prompts?.length ? { prompts: m.prompts } : {}),
        }));
        return {
          id: p.id,
          name: p.name ?? p.id,
          connected: connected.has(p.id),
          popular: POPULAR.includes(p.id),
          custom: customIds.has(p.id),
          models: Object.keys(p.models ?? {}).length,
          favorites: fav[p.id]?.length ?? 0,
          methods: customIds.has(p.id) ? [] : methods,
        };
      });
    const rank = (e: ProviderEntry) => (e.connected ? 0 : e.popular ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b) || (a.popular && b.popular ? POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id) : a.name.localeCompare(b.name)));
  }

  async models(providerId: string): Promise<ProviderModel[]> {
    const p = (await this.oc.providers()).all.find((x: Json) => x.id === providerId);
    if (!p) throw new HttpError(404, L("Нет такого провайдера", "No such provider"));
    const fav = new Set(this.config.config.modelFavorites?.[providerId] ?? []);
    return Object.values<Json>(p.models ?? {})
      .filter((m) => m.status !== "deprecated")
      .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")) || String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)))
      .map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        ...(m.cost ? { free: m.cost.input === 0 && m.cost.output === 0 } : {}),
        ...(m.capabilities?.toolcall !== undefined ? { tools: !!m.capabilities.toolcall } : {}),
        favorite: fav.has(m.id),
      }));
  }

  setFavorites(providerId: string, models: string[]): void {
    this.config.setFavorites(providerId, [...new Set(models.filter((m) => typeof m === "string" && m))]);
  }

  /** у большого провайдера сразу отмечаем самые свежие модели с инструментами */
  private async autoFavorites(providerId: string): Promise<void> {
    if (this.config.config.modelFavorites?.[providerId]?.length) return;
    const models = await this.models(providerId).catch(() => []);
    if (models.length <= FAVORITES_OVER) return;
    this.setFavorites(providerId, models.filter((m) => m.tools !== false).slice(0, AUTO_FAVORITES).map((m) => m.id));
  }

  async setKey(providerId: string, key: string, inputs?: Record<string, string>): Promise<void> {
    if (!key.trim()) throw new HttpError(400, L("Пустой ключ", "Empty key"));
    await this.oc.setKey(providerId, key.trim(), inputs);
    await this.autoFavorites(providerId);
    this.log(L(`[hub] провайдер ${providerId}: ключ сохранён`, `[hub] provider ${providerId}: key saved`));
  }

  /** Вход по подписке: ссылка и код для пользователя; для auto хаб сам ждёт окончания входа в фоне. */
  async oauthStart(providerId: string, method: number, inputs?: Record<string, string>): Promise<OAuthStart> {
    const r = await this.oc.oauthAuthorize(providerId, method, inputs);
    if (r.method === "auto") {
      this.oauth.set(providerId, { status: "waiting" });
      void this.oc.oauthCallback(providerId, method).then(
        async (ok) => {
          this.oauth.set(providerId, ok ? { status: "done" } : { status: "error", error: L("Вход не подтвердился", "Sign-in wasn't confirmed") });
          if (ok) await this.autoFavorites(providerId);
        },
        (e: Error) => this.oauth.set(providerId, { status: "error", error: /timeout|Headers Timeout|fetch failed/i.test(e.message) ? L("Не дождался входа — попробуй ещё раз", "Timed out waiting for sign-in — try again") : e.message }),
      );
    }
    return { url: r.url, instructions: r.instructions, method: r.method === "code" ? "code" : "auto" };
  }

  oauthStatus(providerId: string): OAuthState {
    return this.oauth.get(providerId) ?? { status: "error", error: L("Вход не начинали", "Sign-in wasn't started") };
  }

  /** для способа code: пользователь вставил код со страницы провайдера */
  async oauthCode(providerId: string, method: number, code: string): Promise<void> {
    if (!(await this.oc.oauthCallback(providerId, method, code.trim()))) throw new HttpError(400, L("Код не подошёл", "The code didn't work"));
    await this.autoFavorites(providerId);
  }

  async disconnect(providerId: string): Promise<void> {
    const custom = this.custom();
    if (custom.some((c) => c.id === providerId)) {
      this.config.setCustomProviders(custom.filter((c) => c.id !== providerId));
      this.config.setFavorites(providerId, []);
      await this.oc.restart();
      return;
    }
    await this.oc.disconnect(providerId);
    this.config.setFavorites(providerId, []);
  }

  /** Свой сервер: проверяем адрес, сохраняем, перезапускаем opencode с новым конфигом. */
  async addCustom(p: { name: string; baseURL: string; apiKey?: string; models: string[] }): Promise<CustomProvider> {
    const name = String(p.name ?? "").trim().slice(0, 60);
    if (!name) throw new HttpError(400, L("Нужно название", "A name is required"));
    const baseURL = normalizeBaseUrl(p.baseURL);
    const models = [...new Set((p.models ?? []).map((m) => String(m).trim()).filter(Boolean))];
    if (!models.length) throw new HttpError(400, L("Отметь хотя бы одну модель (или впиши её название)", "Check at least one model (or type its name)"));
    const custom = this.custom();
    const base = `my-${slugify(name) || "server"}`;
    let id = base;
    for (let i = 2; custom.some((c) => c.id === id); i++) id = `${base}-${i}`;
    const entry: CustomProvider = { id, name, baseURL, models, ...(p.apiKey?.trim() ? { apiKey: p.apiKey.trim() } : {}) };
    this.config.setCustomProviders([...custom, entry]);
    await this.oc.restart();
    this.log(L(`[hub] свой сервер ${name}: ${baseURL}, моделей ${models.length}`, `[hub] custom server ${name}: ${baseURL}, ${models.length} models`));
    return entry;
  }

  /** «Найти модели»: список моделей у OpenAI-совместимого сервера (GET {baseURL}/models) — запрос идёт с ПК. */
  async probe(baseURL: string, apiKey?: string): Promise<string[]> {
    const url = normalizeBaseUrl(baseURL) + "/models";
    let r: Response;
    try {
      r = await this.http(url, { headers: apiKey?.trim() ? { authorization: `Bearer ${apiKey.trim()}` } : {}, signal: AbortSignal.timeout(6000) });
    } catch (e) {
      throw new HttpError(409, L(`Сервер не отвечает (${url}): ${(e as Error).message}. Он запущен? Для LM Studio — включи «Start Server».`, `The server doesn't answer (${url}): ${(e as Error).message}. Is it running? For LM Studio — turn on “Start Server”.`));
    }
    if (!r.ok) throw new HttpError(409, L(`Сервер ответил ${r.status} на ${url}`, `The server answered ${r.status} at ${url}`) + (r.status === 401 ? L(" — нужен ключ", " — a key is required") : ""));
    const j = (await r.json().catch(() => ({}))) as Json;
    const ids: string[] = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).map((m: Json) => String(m.id ?? m.name ?? "")).filter(Boolean);
    if (!ids.length) throw new HttpError(409, L("Сервер ответил, но моделей не прислал — загрузи модель (в LM Studio — Load) или впиши её название вручную", "The server answered but sent no models — load a model (in LM Studio — Load) or type its name manually"));
    return ids;
  }
}

/** «localhost:1234», «http://x:11434/» → «http://x:11434/v1» (OpenAI-совместимый путь) */
export function normalizeBaseUrl(raw: string): string {
  let s = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!s) throw new HttpError(400, L("Нужен адрес сервера", "A server URL is required"));
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${L("Непонятный адрес", "Unrecognized address")}: ${raw}`);
  }
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/v1";
  return u.toString().replace(/\/+$/, "");
}
