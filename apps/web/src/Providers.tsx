// Модели и провайдеры (opencode): подключить по ключу или по подписке, свой сервер (LM Studio, Ollama), избранные модели.
import { useEffect, useMemo, useState } from "react";
import { t, tn, type OAuthStart, type ProviderAuthMethod, type ProviderEntry, type ProviderModel } from "@kamharn/client";
import { client, go } from "./hub.ts";

export function Providers() {
  const [list, setList] = useState<ProviderEntry[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [query, setQuery] = useState("");
  const load = () => client.providers().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const connected = list?.filter((p) => p.connected) ?? [];
  const rest = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list?.filter((p) => !p.connected) ?? [];
    return q ? all.filter((p) => p.name.toLowerCase().includes(q) || p.id.includes(q)).slice(0, 30) : all.filter((p) => p.popular);
  }, [list, query]);

  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "settings", section: "agents" })}>
          ←
        </button>
        <h2>{t("Модели и провайдеры", "Models and providers")}</h2>
      </header>
      <div className="page__body">
        <p className="muted">
          {t("Для движка opencode. Ключи и входы хранятся на ПК у opencode (как", "For the opencode engine. Keys and sign-ins are stored on the PC by opencode (like")} <code>opencode auth login</code>).{" "}
          {t("Claude Code работает по своей подписке отдельно.", "Claude Code uses its own subscription separately.")}
        </p>
        {error && <p className="error">{error}</p>}
        {!list && !error && <p className="muted">{t("Загрузка…", "Loading…")}</p>}

        {connected.length > 0 && (
          <section>
            <h3>{t("Подключены", "Connected")}</h3>
            {connected.map((p) => (
              <Connected key={p.id} p={p} onChange={load} />
            ))}
          </section>
        )}

        <section>
          <h3>{t("Подключить провайдера", "Connect a provider")}</h3>
          <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Поиск: kimi, glm, mistral, groq… (всего их больше двухсот)", "Search: kimi, glm, mistral, groq… (there are over two hundred)")} />
          <div className="prov__list">
            {rest.map((p) => (
              <div key={p.id} className="prov">
                <button className="prov__head" onClick={() => setOpen(open === p.id ? undefined : p.id)}>
                  <b>{p.name}</b>
                  <span className="muted">
                    {tn(p.models, ["модель", "модели", "моделей"], ["model", "models"])}
                    {p.methods.some((m) => m.type === "oauth") ? ` · ${t("вход по подписке", "subscription sign-in")}` : ""}
                  </span>
                </button>
                {open === p.id && <Connect p={p} onDone={() => (setOpen(undefined), void load())} />}
              </div>
            ))}
            {query && !rest.length && <p className="muted">{t("Не нашёл. Если это свой сервер — добавь его ниже.", "Not found. If it's your own server, add it below.")}</p>}
          </div>
        </section>

        <section>
          <h3>{t("Свой сервер (LM Studio, Ollama, vLLM…)", "Your own server (LM Studio, Ollama, vLLM…)")}</h3>
          <CustomServer onDone={load} />
        </section>
      </div>
    </div>
  );
}

function Connected({ p, onChange }: { p: ProviderEntry; onChange: () => void }) {
  const [models, setModels] = useState<ProviderModel[]>();
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState<string>();
  const openModels = async () => {
    if (models) return setModels(undefined);
    const m = await client.providerModels(p.id);
    setModels(m);
    setPick(new Set(m.filter((x) => x.favorite).map((x) => x.id)));
  };
  const save = async (ids: string[]) => {
    await client.setFavorites(p.id, ids);
    setMsg(ids.length ? `${t("В выборе модели", "In the model picker")}: ${ids.length}` : t("В выборе модели: все", "In the model picker: all"));
    setModels(undefined);
    onChange();
  };
  const disconnect = async () => {
    if (!confirm(`${t("Отключить", "Disconnect")} ${p.name}? ${p.custom ? t("Сервер пропадёт из списка.", "The server will be removed from the list.") : t("Ключ или вход удалятся с ПК.", "The key or sign-in will be removed from the PC.")}`)) return;
    await client.disconnectProvider(p.id).then(onChange, (e: Error) => setMsg(e.message));
  };
  const shown = models?.filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()) || m.id.includes(filter.toLowerCase()));
  return (
    <div className="prov prov--on">
      <div className="prov__row">
        <div style={{ flex: 1 }}>
          <b>{p.name}</b>
          <div className="muted">
            {p.custom ? `${t("свой сервер", "own server")} · ` : ""}
            {p.favorites ? t(`в выборе ${p.favorites} из ${p.models}`, `${p.favorites} of ${p.models} in the picker`) : p.models === 1 ? t("1 модель в выборе", "1 model in the picker") : t(`все ${tn(p.models, ["модель", "модели", "моделей"], ["model", "models"])} в выборе`, `all ${p.models} models in the picker`)}
          </div>
        </div>
        <button className="btn btn--small" onClick={() => void openModels()}>
          {t("Модели", "Models")}
        </button>
        <button className="btn btn--small btn--danger" onClick={() => void disconnect()}>
          {t("Отключить", "Disconnect")}
        </button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {shown && (
        <div className="prov__models">
          {models!.length > 15 && <input className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("Поиск модели", "Search models")} />}
          <ul>
            {shown.map((m) => (
              <li key={m.id}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={pick.has(m.id)}
                    onChange={(e) => {
                      const n = new Set(pick);
                      if (e.target.checked) n.add(m.id);
                      else n.delete(m.id);
                      setPick(n);
                    }}
                  />
                  <span>
                    {m.name} <span className="muted">{[m.free ? t("бесплатно", "free") : "", m.tools === false ? t("без инструментов", "no tools") : ""].filter(Boolean).join(" · ")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="wt__actions">
            <button className="btn btn--primary btn--small" onClick={() => void save([...pick])} disabled={!pick.size}>
              {t("Показывать отмеченные", "Show checked")} ({pick.size})
            </button>
            <button className="btn btn--small" onClick={() => void save([])}>
              {t("Показывать все", "Show all")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Подключение: способы входа — от opencode (ключ, подписка). */
function Connect({ p, onDone }: { p: ProviderEntry; onDone: () => void }) {
  const [method, setMethod] = useState<ProviderAuthMethod>(p.methods.find((m) => m.type === "oauth" && /headless/i.test(m.label)) ?? p.methods[0]!);
  const [key, setKey] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<OAuthStart>();
  const [code, setCode] = useState("");
  const [state, setState] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // вход по подписке: хаб ждёт окончания входа, мы спрашиваем статус
  useEffect(() => {
    if (!oauth || oauth.method !== "auto") return;
    const timer = setInterval(() => {
      void client.oauthStatus(p.id).then((s) => {
        if (s.status === "done") (clearInterval(timer), onDone());
        if (s.status === "error") (clearInterval(timer), setError(s.error), setOauth(undefined));
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [oauth]);

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const code$ = /code[:\s]+([A-Z0-9-]{4,})/i.exec(oauth?.instructions ?? "")?.[1];

  return (
    <div className="prov__connect">
      {p.methods.length > 1 && (
        <div className="cards">
          {p.methods.map((m) => (
            <button key={m.index} className={`pick ${method.index === m.index ? "pick--on" : ""}`} onClick={() => (setMethod(m), setOauth(undefined), setError(undefined))}>
              <b>{m.type === "api" ? t("API-ключ", "API key") : t("Вход по подписке", "Subscription sign-in")}</b>
              <span className="muted">{methodHint(m)}</span>
            </button>
          ))}
        </div>
      )}
      {method.prompts?.map((q) => (
        <input key={q.key} className="input" placeholder={q.message + (q.placeholder ? ` (${q.placeholder})` : "")} value={inputs[q.key] ?? ""} onChange={(e) => setInputs({ ...inputs, [q.key]: e.target.value })} />
      ))}
      {method.type === "api" ? (
        <div className="prov__row">
          <input className="input" style={{ flex: 1 }} type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${t("API-ключ", "API key")} ${p.name}`} autoComplete="off" />
          <button className="btn btn--primary" disabled={!key.trim() || busy} onClick={() => void run(() => client.setProviderKey(p.id, key, inputs).then(onDone))}>
            {t("Подключить", "Connect")}
          </button>
        </div>
      ) : !oauth ? (
        <button className="btn btn--primary" disabled={busy} onClick={() => void run(async () => setOauth(await client.oauthStart(p.id, method.index, inputs)))}>
          {t("Войти", "Sign in")}
        </button>
      ) : (
        <div className="prov__oauth">
          <p>
            1. {t("Открой", "Open")}{" "}
            <a href={oauth.url} target="_blank" rel="noreferrer">
              {oauth.url}
            </a>{" "}
            {t("и войди в аккаунт.", "and sign in to your account.")}
          </p>
          {code$ ? (
            <p>
              2. {t("Введи код:", "Enter the code:")} <b className="prov__code">{code$}</b>{" "}
              <button className="linkish" onClick={() => void navigator.clipboard?.writeText(code$)}>
                {t("копировать", "copy")}
              </button>
            </p>
          ) : (
            oauth.instructions && <p className="muted">{oauth.instructions}</p>
          )}
          {oauth.method === "auto" ? (
            <p className="muted">
              <span className="spinner" /> {t("Жду, пока войдёшь…", "Waiting for you to sign in…")}
            </p>
          ) : (
            <div className="prov__row">
              <input className="input" style={{ flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("Код со страницы", "Code from the page")} />
              <button className="btn btn--primary" disabled={!code.trim() || busy} onClick={() => void run(() => client.oauthCode(p.id, method.index, code).then(onDone))}>
                {t("Готово", "Done")}
              </button>
            </div>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}


function methodHint(m: ProviderAuthMethod): string {
  if (m.type === "api") return t("оплата по токенам или ключ подписки", "pay per token or a subscription key");
  if (/headless/i.test(m.label)) return `${m.label.replace(/\s*\(headless\)/i, "")}: ${t("ссылка и код — можно с телефона", "link and code — works from a phone")}`;
  if (/browser/i.test(m.label)) return `${m.label.replace(/\s*\(browser\)/i, "")}: ${t("откроется браузер на ПК", "opens a browser on the PC")}`;
  return m.label;
}

function CustomServer({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("LM Studio");
  const [url, setUrl] = useState("http://127.0.0.1:1234/v1");
  const [key, setKey] = useState("");
  const [found, setFound] = useState<string[]>();
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState("");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const probe = async () => {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await client.probeServer(url, key);
      setFound(r.models);
      setPick(new Set(r.models));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    setBusy(true);
    setMsg(undefined);
    const models = [...pick, ...manual.split(/[\s,]+/).filter(Boolean)];
    try {
      const p = await client.addCustomProvider({ name, baseURL: url, apiKey: key, models });
      setMsg(t(`Добавлен «${p.name}» — модели появятся в выборе модели opencode`, `Added “${p.name}” — its models will appear in the opencode model picker`));
      setFound(undefined);
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prov prov__custom">
      <div className="prov__row">
        <input className="input" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Название", "Name")} />
      </div>
      <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("Адрес: LM Studio http://127.0.0.1:1234/v1, Ollama http://127.0.0.1:11434/v1", "URL: LM Studio http://127.0.0.1:1234/v1, Ollama http://127.0.0.1:11434/v1")} />
      <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("Ключ (если сервер его требует)", "Key (if the server needs one)")} autoComplete="off" />
      <div className="wt__actions">
        <button className="btn" disabled={!url.trim() || busy} onClick={() => void probe()}>
          {t("Найти модели", "Find models")}
        </button>
      </div>
      {found && (
        <ul className="prov__models">
          {found.map((m) => (
            <li key={m}>
              <label className="check">
                <input type="checkbox" checked={pick.has(m)} onChange={(e) => (e.target.checked ? pick.add(m) : pick.delete(m), setPick(new Set(pick)))} />
                <span>{m}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <input className="input" value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("Или впиши названия моделей через запятую", "Or type model names, comma-separated")} />
      <button className="btn btn--primary" disabled={busy || !name.trim() || (!pick.size && !manual.trim())} onClick={() => void add()}>
        {t("Добавить сервер", "Add server")}
      </button>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
