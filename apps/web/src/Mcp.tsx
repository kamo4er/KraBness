// Свои MCP-серверы: KamHarn отдаёт их обоим движкам. Значения ключей хаб не показывает — только имена.
import { useEffect, useState } from "react";
import { joinArgs, parsePairs, splitArgs, type McpOverview, type McpServer, type McpServerStatus, type McpServerView, t } from "@kamharn/client";
import { client, go } from "./hub.ts";

/** статус сервера от движка — человеческими словами на текущем языке */
export const mcpStatus = (s: string): string =>
  ({
    connected: t("подключён", "connected"),
    failed: t("ошибка", "error"),
    pending: t("подключается", "connecting"),
    disabled: t("выключен", "disabled"),
    needs_auth: t("нужен вход", "sign-in needed"),
    needs_client_registration: t("нужен вход", "sign-in needed"),
  })[s] ?? s;

const enginesLabel = (e: McpServer["engines"]) =>
  e === "both" ? t("Claude и opencode", "Claude and opencode") : e === "claude" ? t("только Claude", "Claude only") : t("только opencode", "opencode only");

function Status({ label, s }: { label: string; s?: McpServerStatus }) {
  const cls = s?.status === "connected" ? "ok" : s?.status === "failed" ? "err" : "muted";
  return (
    <span className={`mcp__st mcp__st--${cls}`} title={s?.error ?? ""}>
      {label}: {s ? mcpStatus(s.status) : t("ещё не запускался", "not started yet")}
    </span>
  );
}

export function Mcp() {
  const [ov, setOv] = useState<McpOverview>();
  const [error, setError] = useState<string>();
  const [edit, setEdit] = useState<McpServerView | "new">();
  const load = () => client.mcpOverview().then(setOv, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function act(f: () => Promise<McpOverview>) {
    setError(undefined);
    try {
      setOv(await f());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "settings", section: "agents" })}>
          ←
        </button>
        <h2>{t("MCP-серверы", "MCP servers")}</h2>
      </header>
      <div className="page__body">
        <p className="muted">
          {t(
            "Инструменты для агентов: браузер, базы, API сервисов. Список хранит KraBness и подключает к Claude и opencode в своих сессиях — настройки Claude Code в VS Code не меняются. Claude подхватит со следующего сообщения, opencode перезапустится (если в нём сейчас работает агент — он прервётся).",
            "Tools for agents: a browser, databases, service APIs. KraBness keeps the list and plugs it into Claude and opencode in its own sessions — your Claude Code settings in VS Code aren't changed. Claude picks it up from the next message, opencode restarts (an agent running in it right now will be interrupted).",
          )}
        </p>
        {error && <p className="error">{error}</p>}
        {ov?.opencodeError && <p className="error">{ov.opencodeError}</p>}
        {!ov && !error && <p className="muted">{t("Загрузка…", "Loading…")}</p>}

        {ov && (
          <section>
            <h3>{t("Свои серверы", "Your servers")}</h3>
            {ov.servers.length === 0 && edit !== "new" && <p className="muted">{t("Пока нет. Например, браузер для агента: команда", "None yet. For example, a browser for the agent: command")} <code>npx</code>, {t("аргументы", "arguments")} <code>-y @playwright/mcp@latest</code>.</p>}
            <div className="prov__list">
              {ov.servers.map((s) =>
                edit !== "new" && edit?.name === s.name ? (
                  <McpForm key={s.name} initial={s} onSaved={(o) => (setOv(o), setEdit(undefined))} onCancel={() => setEdit(undefined)} />
                ) : (
                  <div key={s.name} className={`prov prov--on mcp${s.enabled ? "" : " mcp--off"}`}>
                    <div className="prov__row">
                      <label className="row" title={s.enabled ? t("Выключить", "Disable") : t("Включить", "Enable")}>
                        <input type="checkbox" checked={s.enabled} onChange={(e) => void act(() => client.saveMcp({ ...toServer(s), enabled: e.target.checked }, s.name))} />
                        <b>{s.name}</b>
                      </label>
                      <span className="badge">{s.type === "stdio" ? t("команда", "command") : s.type}</span>
                      <span className="muted">{enginesLabel(s.engines)}</span>
                      <span style={{ flex: 1 }} />
                      <button className="btn btn--small" onClick={() => setEdit(s)}>
                        {t("Изменить", "Edit")}
                      </button>
                      <button
                        className="btn btn--small btn--danger"
                        onClick={() => confirm(t(`Удалить MCP-сервер «${s.name}»?`, `Delete MCP server “${s.name}”?`)) && void act(() => client.removeMcp(s.name))}
                      >
                        {t("Удалить", "Delete")}
                      </button>
                    </div>
                    <div className="mono mcp__cmd">{s.type === "stdio" ? `${s.command} ${joinArgs(s.args)}` : s.url}</div>
                    {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                      <div className="muted">
                        {s.envKeys.length > 0 && <>{t("Переменные", "Variables")}: {s.envKeys.join(", ")} </>}
                        {s.headerKeys.length > 0 && <>{t("Заголовки", "Headers")}: {s.headerKeys.join(", ")}</>}
                      </div>
                    )}
                    {s.enabled && (
                      <div className="row">
                        {s.engines !== "opencode" && <Status label="Claude" s={s.status.claude} />}
                        {s.engines !== "claude" && <Status label="opencode" s={s.status.opencode} />}
                      </div>
                    )}
                    {s.status.opencode?.error && <div className="error mcp__err">{s.status.opencode.error}</div>}
                  </div>
                ),
              )}
              {edit === "new" ? (
                <McpForm onSaved={(o) => (setOv(o), setEdit(undefined))} onCancel={() => setEdit(undefined)} />
              ) : (
                <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setEdit("new")}>
                  {t("+ Добавить сервер", "+ Add server")}
                </button>
              )}
            </div>
          </section>
        )}

        {ov && (
          <section>
            <h3>{t("Из настроек Claude Code", "From Claude Code settings")}</h3>
            <label className="row">
              <input type="checkbox" checked={ov.claude.enabled} onChange={(e) => void act(() => client.setClaudeUserMcp(e.target.checked))} />
              {t("Подключать в сессиях Claude серверы из ~/.claude.json и проектного .mcp.json", "Use servers from ~/.claude.json and the project's .mcp.json in Claude sessions")}
            </label>
            <p className="muted">
              {ov.claude.servers.length ? `${t("Там сейчас", "Currently there")}: ${ov.claude.servers.join(", ")}.` : t("Там серверов нет.", "No servers there.")}{" "}
              {t("Меняются в самом Claude Code (claude mcp add). Старт сессии с MCP медленнее.", "They are managed in Claude Code itself (claude mcp add). Sessions with MCP start slower.")}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Сервер из вида для сохранения без правки секретов: пустые значения = оставить прежние. */
function toServer(s: McpServerView): McpServer {
  const { envKeys, headerKeys, status: _status, ...rest } = s;
  return { ...rest, env: Object.fromEntries(envKeys.map((k) => [k, ""])), headers: Object.fromEntries(headerKeys.map((k) => [k, ""])) };
}

function McpForm({ initial, onSaved, onCancel }: { initial?: McpServerView; onSaved: (o: McpOverview) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<McpServer["type"]>(initial?.type ?? "stdio");
  const [engines, setEngines] = useState<McpServer["engines"]>(initial?.engines ?? "both");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(joinArgs(initial?.args));
  const [url, setUrl] = useState(initial?.url ?? "");
  // у существующих ключей значения не знаем: «КЛЮЧ=» — оставить как было
  const [env, setEnv] = useState((initial?.envKeys ?? []).map((k) => `${k}=`).join("\n"));
  const [headers, setHeaders] = useState((initial?.headerKeys ?? []).map((k) => `${k}: `).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hasSecrets = !!initial && (initial.envKeys.length > 0 || initial.headerKeys.length > 0);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const server: McpServer =
        type === "stdio"
          ? { name: name.trim(), enabled: initial?.enabled ?? true, engines, type, command: command.trim(), args: splitArgs(args), env: parsePairs(env) }
          : { name: name.trim(), enabled: initial?.enabled ?? true, engines, type, url: url.trim(), headers: parsePairs(headers, ":") };
      onSaved(await client.saveMcp(server, initial?.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prov prov__custom">
      <b>{initial ? t(`Изменить «${initial.name}»`, `Edit “${initial.name}”`) : t("Новый MCP-сервер", "New MCP server")}</b>
      <div className="row">
        <input className="input" placeholder={t("Имя: playwright", "Name: playwright")} value={name} onChange={(e) => setName(e.target.value)} />
        <select className="input" style={{ width: "auto" }} value={type} onChange={(e) => setType(e.target.value as McpServer["type"])}>
          <option value="stdio">{t("Команда (stdio)", "Command (stdio)")}</option>
          <option value="http">{t("Адрес (HTTP)", "URL (HTTP)")}</option>
          <option value="sse">{t("Адрес (SSE)", "URL (SSE)")}</option>
        </select>
        <select className="input" style={{ width: "auto" }} value={engines} onChange={(e) => setEngines(e.target.value as McpServer["engines"])}>
          <option value="both">{t("Claude и opencode", "Claude and opencode")}</option>
          <option value="claude">{t("Только Claude", "Claude only")}</option>
          <option value="opencode">{t("Только opencode", "opencode only")}</option>
        </select>
      </div>
      {type === "stdio" ? (
        <>
          <div className="row">
            <input className="input mono" style={{ width: 160 }} placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} />
            <input className="input mono" placeholder="-y @playwright/mcp@latest" value={args} onChange={(e) => setArgs(e.target.value)} />
          </div>
          <label className="muted">{t("Переменные окружения (ключи API), по одной в строке: КЛЮЧ=значение", "Environment variables (API keys), one per line: KEY=value")}</label>
          <textarea className="input mono" rows={3} placeholder="GITHUB_TOKEN=ghp_…" value={env} onChange={(e) => setEnv(e.target.value)} />
        </>
      ) : (
        <>
          <input className="input mono" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label className="muted">{t("Заголовки, по одному в строке: Имя: значение", "Headers, one per line: Name: value")}</label>
          <textarea className="input mono" rows={2} placeholder="Authorization: Bearer …" value={headers} onChange={(e) => setHeaders(e.target.value)} />
        </>
      )}
      {hasSecrets && <p className="muted">{t("Значения ключей не показываются. Пустое значение — оставить прежнее; удалишь строку — ключ уберётся.", "Key values aren't shown. Empty value — keep the current one; delete the line — the key is removed.")}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn btn--primary" disabled={busy || !name.trim() || (type === "stdio" ? !command.trim() : !url.trim())} onClick={() => void save()}>
          {busy ? t("Сохраняю…", "Saving…") : t("Сохранить", "Save")}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          {t("Отмена", "Cancel")}
        </button>
      </div>
    </div>
  );
}
