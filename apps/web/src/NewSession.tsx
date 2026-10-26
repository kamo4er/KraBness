import { useEffect, useMemo, useState } from "react";
import { ago, baseName, type ClaudeTranscript, type EngineId, type FsEntry, type ModelRef, type NewSessionPrefs, type PermissionMode, t } from "@kamharn/client";
import { client, fmtSize, fmtTime, go, recall, remember, useEngines, useHub } from "./hub.ts";
import { EffortSelect } from "./Effort.tsx";

/** режимы подтверждений — функцией: подписи на текущем языке */
export const MODES = (): Array<{ id: PermissionMode; label: string; hint: string }> => [
  { id: "manual", label: t("Спрашивать всё", "Ask everything"), hint: t("и команды, и правки файлов", "both commands and file edits") },
  { id: "acceptEdits", label: t("Правки без вопросов", "Edits without asking"), hint: t("спрашивать только команды", "ask only for commands") },
  { id: "auto", label: t("Автономно", "Autonomous"), hint: t("без вопросов (claude: классификатор безопасности)", "no questions (claude: safety classifier)") },
];

const key = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

export function NewSession({ group: initialGroup }: { group?: string }) {
  const engines = useEngines();
  const { groups, sessions } = useHub();
  // новая сессия в группе: движок, модель, папка и режим — как у последней сессии группы
  const [tpl] = useState(() => (initialGroup ? sessions.find((s) => s.groupId === initialGroup) : undefined));
  const [group, setGroup] = useState(initialGroup ?? "");
  // движки и выбор по умолчанию — из настроек хаба («Настройки → Движки»), а не «последний выбранный»
  const [prefs, setPrefs] = useState<NewSessionPrefs>();
  const [engine, setEngine] = useState<EngineId | undefined>(() => tpl?.engine);
  useEffect(() => {
    void client.newSessionPrefs().then(
      (p) => (setPrefs(p), setEngine((e) => (e && p.engines.includes(e) ? e : p.engine))),
      () => setEngine((e) => e ?? "opencode"),
    );
  }, []);
  const [model, setModel] = useState<string>();
  const [dir, setDir] = useState<string | undefined>(() => (tpl ? (tpl.worktree?.repo ?? tpl.directory) : recall<string>("dir")));
  const [mode, setMode] = useState<PermissionMode>(() => tpl?.permissionMode ?? recall<PermissionMode>("mode") ?? "acceptEdits");
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const info = engines?.find((e) => e.id === engine);
  const models = info?.models ?? [];
  // уровень рассуждений — свой у каждой модели, помним последний выбор для модели
  const efforts = models.find((m) => key(m) === model)?.efforts ?? [];
  const [effort, setEffort] = useState("");
  useEffect(() => setEffort((model && recall<string>(`effort.${model}`)) || ""), [model]);

  // модель: как у группы → из настроек → последняя для движка → дефолт движка → первая; выключенные пропускаем
  useEffect(() => {
    if (!info || !engine) return;
    const online = (k?: string) => !!k && models.some((m) => key(m) === k && !m.offline);
    const group = tpl && tpl.engine === engine ? key(tpl.model) : undefined;
    const pref = prefs?.models[engine] && key(prefs.models[engine]!);
    const last = recall<string>(`model.${engine}`);
    const def = info.defaultModel && key(info.defaultModel);
    const first = models.find((m) => !m.offline);
    setModel([group, pref, last, def].find((k) => online(k)) ?? (first && key(first)) ?? undefined);
  }, [info, engine, prefs]);

  // папка по умолчанию — первая разрешённая
  useEffect(() => {
    if (!dir) void client.roots().then((r) => r[0] && setDir((d) => d ?? r[0]));
  }, []);

  const missing = !engines ? "" : !info?.available ? t("Движок недоступен", "Engine unavailable") : !model ? t("Нет доступной модели", "No model available") : !dir ? t("Выбери папку", "Pick a folder") : "";

  const grouped = useMemo(() => {
    const g = new Map<string, typeof models>();
    for (const m of models) g.set(m.providerId, [...(g.get(m.providerId) ?? []), m]);
    return [...g.entries()];
  }, [models]);

  async function create() {
    if (!dir || !model || !engine) return;
    setBusy(true);
    setError(undefined);
    const [providerId, ...rest] = model.split("/");
    try {
      const s = await client.createSession({
        engine,
        directory: dir,
        model: { providerId: providerId!, modelId: rest.join("/") },
        permissionMode: mode,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(branch ? { worktree: true } : {}),
        ...(group ? { groupId: group } : {}),
        ...(effort && efforts.includes(effort) ? { effort } : {}),
      });
      remember(`model.${engine}`, model);
      remember(`effort.${model}`, effort);
      remember("dir", dir);
      remember("mode", mode);
      go({ page: "session", id: s.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "home" })}>
          ←
        </button>
        <h2>{t("Новая сессия", "New session")}</h2>
      </header>
      <div className="page__body">
        <section>
          <h3>{t("Движок", "Engine")}</h3>
          {!engines && <p className="muted">{t("загрузка…", "loading…")}</p>}
          <div className="cards">
            {engines?.filter((e) => !prefs || prefs.engines.includes(e.id)).map((e) => (
              <button key={e.id} className={`pick ${engine === e.id ? "pick--on" : ""}`} disabled={!e.available} onClick={() => setEngine(e.id)}>
                <b>{e.id === "claude" ? "Claude Code" : "opencode"}</b>
                <span className="muted">
                  {e.available ? (e.id === "claude" ? t("подписка Claude", "Claude subscription") : t("локальные и другие модели", "local and other models")) : e.error}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3>{t("Модель", "Model")}</h3>
          <select className="select" value={model ?? ""} onChange={(e) => setModel(e.target.value)}>
            {grouped.map(([provider, ms]) => (
              <optgroup key={provider} label={provider}>
                {ms.map((m) => (
                  <option key={key(m)} value={key(m)} disabled={m.offline}>
                    {m.name}
                    {m.offline ? ` · ${t("не запущена", "not running")}` : m.free ? " · free" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <EffortSelect efforts={efforts} value={effort} onChange={setEffort} />
        </section>

        <section>
          <h3>{t("Папка", "Folder")}</h3>
          <FolderPicker value={dir} onChange={setDir} />
        </section>

        <section>
          <h3>{t("Разрешения", "Permissions")}</h3>
          <div className="cards">
            {MODES().map((m) => (
              <button key={m.id} className={`pick ${mode === m.id ? "pick--on" : ""}`} onClick={() => setMode(m.id)}>
                <b>{m.label}</b>
                <span className="muted">{m.hint}</span>
              </button>
            ))}
          </div>
        </section>

        {groups.length > 0 && (
          <section>
            <h3>{t("Группа", "Group")}</h3>
            <select className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t("Без группы", "No group")}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {`${g.icon ?? ""} ${g.name}`.trim()}
                  {g.prompt ? ` · ${t("свой промпт", "custom prompt")}` : ""}
                </option>
              ))}
            </select>
          </section>
        )}

        <section>
          <h3>{t("Название (необязательно)", "Title (optional)")}</h3>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("например: разбор логов", "e.g. log analysis")} />
        </section>

        <section>
          <label className="check">
            <input type="checkbox" checked={branch} onChange={(e) => setBranch(e.target.checked)} />
            <span>
              <b>{t("В отдельной ветке", "In a separate branch")}</b>
              <span className="muted">
                {" "}
                {t(
                  "— агент работает в своей копии проекта (git worktree рядом с папкой) и не мешает другим сессиям. Потом «Влить» одним коммитом или «Выбросить». В копии заново ставятся зависимости (npm install и т.п.).",
                  "— the agent works in its own copy of the project (a git worktree next to the folder) and doesn't disturb other sessions. Later “Merge” as one commit or “Discard”. Dependencies are installed again in the copy (npm install etc.).",
                )}
              </span>
            </span>
          </label>
        </section>

        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--big" disabled={!!missing || !engines || busy} onClick={() => void create()}>
          {busy ? t("Создаю…", "Creating…") : t("Создать", "Create")}
        </button>
        {missing && <p className="muted center">{missing}</p>}

        <ImportClaude />
      </div>
    </div>
  );
}

/** Продолжить в KamHarn сессию, начатую в Claude Code (терминал, VS Code). */
function ImportClaude() {
  const [list, setList] = useState<ClaudeTranscript[]>();
  const [hidden, setHidden] = useState<ClaudeTranscript[]>();
  const [showHidden, setShowHidden] = useState(false);
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const load = () => {
    client.claudeTranscripts().then(setList, () => setList([]));
    client.claudeTranscripts(true).then(setHidden, () => setHidden([]));
  };
  useEffect(load, []);

  const q = query.trim().toLowerCase();
  const found = useMemo(() => (list ?? []).filter((x) => !q || x.title.toLowerCase().includes(q) || baseName(x.directory).toLowerCase().includes(q)), [list, q]);
  // развёрнуто или поиск — по проектам; иначе 5 последних
  const groups = useMemo(() => {
    const m = new Map<string, ClaudeTranscript[]>();
    for (const x of found) m.set(baseName(x.directory), [...(m.get(baseName(x.directory)) ?? []), x]);
    return [...m.entries()];
  }, [found]);
  if (!list?.length && !hidden?.length) return null;
  const grouped = all || !!q;

  async function open(id: string) {
    setBusy(id);
    setError(undefined);
    try {
      const s = await client.importClaude(id);
      go({ page: "session", id: s.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  }

  async function hide(id: string, h: boolean) {
    setError(undefined);
    try {
      await client.hideTranscript(id, h);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const row = (tr: ClaudeTranscript, isHidden = false) => (
    <li key={tr.id} className="list__row">
      <span className="import__info">
        <b title={tr.title}>{tr.title}</b>
        <span className="muted">
          {!grouped || isHidden ? <span className="import__proj">{baseName(tr.directory)}</span> : null}
          {tr.source === "vscode" ? "VS Code" : tr.source === "cli" ? t("терминал", "terminal") : "Claude Code"} · {ago(tr.updatedAt)} · {fmtSize(tr.size)}
        </span>
      </span>
      {isHidden ? (
        <button className="btn btn--small" onClick={() => void hide(tr.id, false)}>
          {t("Вернуть", "Restore")}
        </button>
      ) : (
        <span className="row import__btns">
          <button className="btn btn--small" disabled={!!busy} onClick={() => void open(tr.id)}>
            {busy === tr.id ? t("Открываю…", "Opening…") : t("Продолжить", "Continue")}
          </button>
          <button className="btn btn--small btn--icon" title={t("Скрыть из этого списка (в Claude Code сессия останется)", "Hide from this list (the session stays in Claude Code)")} onClick={() => void hide(tr.id, true)}>
            ×
          </button>
        </span>
      )}
    </li>
  );

  return (
    <section>
      <h3>{t("Или продолжить сессию Claude Code", "Or continue a Claude Code session")}</h3>
      <p className="muted">{t("Из VS Code или терминала. Откроется копия с историей — исходная сессия не меняется. × — убрать из списка (в Claude Code она останется).", "From VS Code or the terminal. A copy with the history opens — the original session isn't changed. × — hide from the list (it stays in Claude Code).")}</p>
      {(list?.length ?? 0) > 5 && <input className="input" placeholder={t("Поиск по тексту или проекту", "Search by text or project")} value={query} onChange={(e) => setQuery(e.target.value)} />}
      {grouped ? (
        groups.map(([proj, items]) => (
          <div key={proj} className="import__group">
            <div className="import__head">
              {proj} <span className="muted">· {items.length}</span>
            </div>
            <ul className="list">{items.map((x) => row(x))}</ul>
          </div>
        ))
      ) : (
        <ul className="list">{found.slice(0, 5).map((x) => row(x))}</ul>
      )}
      {q && found.length === 0 && <p className="muted">{t("Ничего не нашлось.", "Nothing found.")}</p>}
      <div className="row">
        {!q && (list?.length ?? 0) > 5 && (
          <button className="btn btn--small" onClick={() => setAll(!all)}>
            {all ? t("Свернуть", "Collapse") : `${t("Показать все", "Show all")} (${list!.length})`}
          </button>
        )}
        {(hidden?.length ?? 0) > 0 && (
          <button className="btn btn--small" onClick={() => setShowHidden(!showHidden)}>
            {showHidden ? t("Убрать скрытые", "Hide hidden") : `${t("Скрытые", "Hidden")} (${hidden!.length})`}
          </button>
        )}
      </div>
      {showHidden && hidden && <ul className="list import__hidden">{hidden.map((x) => row(x, true))}</ul>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export function FolderPicker({ value, onChange }: { value?: string; onChange: (p: string) => void }) {
  const [cwd, setCwd] = useState<string | undefined>(value);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void client.roots().then(setRoots);
  }, []);

  useEffect(() => {
    setError(undefined);
    client
      .list(cwd)
      .then((es) => setEntries(es.filter((e) => e.dir)))
      .catch((e) => {
        setError((e as Error).message);
        setCwd(undefined);
      });
  }, [cwd]);

  const root = roots.find((r) => cwd && cwd.toLowerCase().startsWith(r.toLowerCase()));
  const up = cwd && root && cwd.length > root.length ? cwd.replace(/[\\/][^\\/]+$/, "") : undefined;

  return (
    <div className="folders">
      <div className="folders__bar">
        <button className="btn btn--small" onClick={() => setCwd(undefined)} title={t("К разрешённым папкам", "To allowed folders")}>
          ⌂
        </button>
        {cwd && (
          <button className="btn btn--small" disabled={!up} onClick={() => up && setCwd(up)}>
            ↑
          </button>
        )}
        <span className="folders__path">{cwd ?? t("Разрешённые папки", "Allowed folders")}</span>
        {cwd && (
          <button className={`btn btn--small ${value === cwd ? "btn--primary" : ""}`} onClick={() => onChange(cwd)}>
            {value === cwd ? t("✓ выбрана", "✓ selected") : t("Выбрать", "Select")}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="folders__list">
        {entries.map((e) => (
          <li key={e.path} className="folder__row">
            <button className={`folder ${value === e.path ? "folder--on" : ""}`} onClick={() => setCwd(e.path)} title={t("Открыть", "Open")}>
              📁 {cwd ? e.name : e.path}
            </button>
            <button className={`btn btn--small ${value === e.path ? "btn--primary" : ""}`} onClick={() => onChange(e.path)}>
              {value === e.path ? "✓" : t("Выбрать", "Select")}
            </button>
          </li>
        ))}
        {!entries.length && !error && <li className="muted pad">{t("Подпапок нет", "No subfolders")}</li>}
      </ul>
      {value && <p className="muted">{t("Выбрано", "Selected")}: {value}</p>}
    </div>
  );
}
