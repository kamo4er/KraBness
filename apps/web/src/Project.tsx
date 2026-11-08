// Просмотр проекта сессии без агента: файлы и git-изменения (бесплатно по лимитам).
import { useEffect, useRef, useState } from "react";
import { ApiError, isArtifactFile, type FileView, type FsEntry, type GitInfo, t } from "@kamharn/client";
import { ArtifactFull } from "./Artifact.tsx";
import { client, fmtSize, go, useHub } from "./hub.ts";
import { Markdown } from "./Parts.tsx";
import { Terminal } from "./Terminal.tsx";
import { pickOpencodeModel } from "./ModelPick.tsx";

export function Project({ id, file, line }: { id: string; file?: string; line?: number }) {
  const state = useHub();
  const info = state.sessions.find((s) => s.id === id);
  const [tab, setTab] = useState<"files" | "git" | "term">(file ? "files" : "git");
  if (!info) return <div className="empty">{state.conn === "online" ? t("Сессия не найдена.", "Session not found.") : t("Загрузка…", "Loading…")}</div>;
  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "session", id })} title={t("К чату", "Back to chat")}>
          ←
        </button>
        <h2 className="project__title">{info.title}</h2>
      </header>
      <div className="tabs">
        <button className={`tab ${tab === "git" ? "tab--on" : ""}`} onClick={() => setTab("git")}>
          {t("Изменения", "Changes")}
        </button>
        <button className={`tab ${tab === "files" ? "tab--on" : ""}`} onClick={() => setTab("files")}>
          {t("Файлы", "Files")}
        </button>
        <button className={`tab ${tab === "term" ? "tab--on" : ""}`} onClick={() => setTab("term")}>
          {t("Терминал", "Terminal")}
        </button>
      </div>
      <div className="page__body">{tab === "git" ? <Changes id={id} /> : tab === "files" ? <Files root={info.directory} initial={file} line={line} /> : <Terminal sessionId={id} />}</div>
    </div>
  );
}

function Changes({ id }: { id: string }) {
  const [git, setGit] = useState<GitInfo>();
  const [error, setError] = useState<string>();
  const load = () => {
    setError(undefined);
    client.git(id).then(setGit, (e: Error) => setError(e.message));
  };
  useEffect(load, [id]);
  if (error) return <p className="error">{error}</p>;
  if (!git) return <p className="muted">{t("загрузка…", "loading…")}</p>;
  if (!git.repo) return <p className="muted">{t("Папка сессии не в git-репозитории.", "The session folder is not a git repository.")}</p>;
  return (
    <>
      <div className="row">
        <span className="muted">
          {t("Ветка", "Branch")} <b>{git.branch ?? "?"}</b> · {git.files.length ? `${t("изменено файлов", "files changed")}: ${git.files.length}` : t("изменений нет", "no changes")}
        </span>
        <button className="btn btn--small" onClick={load}>
          {t("Обновить", "Refresh")}
        </button>
        {git.diff && (
          <button className="btn btn--small" title={t("Новая сессия opencode: ревью диффа, ничего не меняет", "New opencode session: reviews the diff, changes nothing")} onClick={() => void review(id)}>
            {t("Ревью в opencode…", "Review in opencode…")}
          </button>
        )}
      </div>
      {git.files.length > 0 && (
        <ul className="gitfiles">
          {git.files.map((f) => (
            <li key={f.path}>
              <span className={`gitstat gitstat--${f.status === "??" ? "new" : f.status.includes("D") ? "del" : "mod"}`}>{f.status === "??" ? "new" : f.status}</span>{" "}
              <span className="mono">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
      {git.diff && <Diff text={git.diff} />}
      {git.truncated && <p className="muted">{t("Дифф обрезан — слишком большой.", "The diff is truncated — too large.")}</p>}
    </>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="gitdiff">
      {text.split("\n").map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith("diff --git")
              ? "gitdiff__file"
              : l.startsWith("@@")
                ? "gitdiff__hunk"
                : l.startsWith("+") && !l.startsWith("+++")
                  ? "diff__add"
                  : l.startsWith("-") && !l.startsWith("---")
                    ? "diff__del"
                    : undefined
          }
        >
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/** initial — файл (или папка) по ссылке из чата, line — строка, к которой прокрутить */
function Files({ root, initial, line }: { root: string; initial?: string; line?: number }) {
  const [cwd, setCwd] = useState(root);
  const [entries, setEntries] = useState<FsEntry[]>();
  const [file, setFile] = useState<FileView>();
  // .html-файл, запущенный живой страницей
  const [running, setRunning] = useState<string>();
  const [error, setError] = useState<string>();
  // подсвеченная строка — только у файла, открытого по ссылке
  const [hl, setHl] = useState<number>();
  const hlRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initial) return;
    client.readFile(initial).then(
      (f) => {
        setFile(f);
        setCwd(f.path.replace(/[\\/][^\\/]+$/, ""));
        if (line) setHl(line);
      },
      // не файл — может, папка: показываем её список
      (e: Error) => client.list(initial).then(() => setCwd(initial), () => setError(`${initial}: ${e.message}`)),
    );
  }, [initial, line]);
  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "center" });
  }, [hl, file]);
  // правка руками: draft — текст в поле (undefined — просто просмотр)
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ text: string; conflict: boolean }>();
  const dirty = draft !== undefined && draft !== file?.text;

  useEffect(() => {
    setError(undefined);
    setEntries(undefined);
    client.list(cwd).then(setEntries, (e: Error) => setError(e.message));
  }, [cwd]);

  async function open(e: FsEntry) {
    if (e.dir) return setCwd(e.path);
    setError(undefined);
    setHl(undefined);
    try {
      setFile(await client.readFile(e.path));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function close() {
    if (dirty && !confirm(t("Изменения не сохранены. Выйти без сохранения?", "Unsaved changes. Leave without saving?"))) return;
    setDraft(undefined);
    setSaveError(undefined);
    setFile(undefined);
    setRunning(undefined);
    setHl(undefined);
  }

  async function save() {
    if (!file?.sha256 || draft === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      setFile(await client.writeFile(file.path, draft, file.sha256));
      setDraft(undefined);
    } catch (e) {
      setSaveError({ text: (e as Error).message, conflict: e instanceof ApiError && e.status === 409 });
    } finally {
      setSaving(false);
    }
  }

  async function reload() {
    if (!file) return;
    if (dirty && !confirm(t("Твои правки пропадут — загрузить файл заново?", "Your edits will be lost — reload the file?"))) return;
    setFile(await client.readFile(file.path));
    setDraft(undefined);
    setSaveError(undefined);
  }

  if (file) {
    const name = file.path.split(/[\\/]/).pop()!;
    return (
      <>
        <div className="row project__filebar">
          <button className="btn btn--small" onClick={close}>
            {t("← к списку", "← back to list")}
          </button>
          <span className="mono muted">
            {name}
            {dirty ? " •" : ""}
          </span>
          <span className="muted">{fmtSize(file.size)}</span>
          {draft === undefined ? (
            <>
              <a className="btn btn--small" href={client.rawUrl(file.path)} download={name}>
                {t("Скачать", "Download")}
              </a>
              {isArtifactFile(file.path) && !file.binary && file.text !== undefined && (
                <button
                  className="btn btn--small btn--primary"
                  title={t("Открыть страницу живой (на весь экран). Соседние .js и .css по относительным путям не подтянутся — подходит для страниц «всё в одном файле».", "Open the page live (full screen). Sibling .js and .css files by relative paths are not loaded — works for all-in-one-file pages.")}
                  onClick={() => void client.fullText(file).then(setRunning, (err: Error) => setError(err.message))}
                >
                  ▶ {t("Запустить", "Run")}
                </button>
              )}
              {file.sha256 && (
                <button className="btn btn--small" onClick={() => setDraft(file.text ?? "")}>
                  {t("Изменить", "Edit")}
                </button>
              )}
            </>
          ) : (
            <>
              <button className="btn btn--small btn--primary" disabled={saving || !dirty} onClick={() => void save()} title="Ctrl+S">
                {saving ? t("Сохраняю…", "Saving…") : t("Сохранить", "Save")}
              </button>
              <button className="btn btn--small" disabled={saving} onClick={() => (!dirty || confirm(t("Отменить правки?", "Discard your edits?"))) && (setDraft(undefined), setSaveError(undefined))}>
                {t("Отмена", "Cancel")}
              </button>
            </>
          )}
        </div>
        {saveError && (
          <p className="error">
            {saveError.text}{" "}
            {saveError.conflict && (
              <button className="btn btn--small" onClick={() => void reload()}>
                {t("Загрузить заново", "Reload")}
              </button>
            )}
          </p>
        )}
        {draft !== undefined ? (
          <textarea
            className="input mono project__edit"
            value={draft}
            spellCheck={false}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
          />
        ) : file.binary ? (
          file.mime.startsWith("image/") ? (
            <img className="project__img" src={client.rawUrl(file.path)} alt={name} />
          ) : (
            <p className="muted">{t("Двоичный файл", "Binary file")} ({file.mime}) — {t("можно скачать.", "you can download it.")}</p>
          )
        ) : hl ? (
          // ссылка на строку: текст построчно, нужная подсвечена (и у .md — исходник, а не разметка)
          <pre className="pre project__text">
            {(file.text ?? "").split(/\r?\n/).map((l, i) => (
              <div key={i} ref={i + 1 === hl ? hlRef : undefined} className={i + 1 === hl ? "project__hl" : undefined}>
                {l || " "}
              </div>
            ))}
          </pre>
        ) : file.mime === "text/markdown" ? (
          <Markdown text={file.text ?? ""} />
        ) : (
          <pre className="pre project__text">{file.text}</pre>
        )}
        {file.truncated && <p className="muted">{t("Показано начало файла.", "Showing the beginning of the file.")}</p>}
        {running !== undefined && <ArtifactFull source={running} title={name} onClose={() => setRunning(undefined)} />}
      </>
    );
  }

  const up = cwd.length > root.length ? cwd.replace(/[\\/][^\\/]+$/, "") : undefined;
  return (
    <>
      <div className="folders__bar">
        <button className="btn btn--small" onClick={() => setCwd(root)} title={t("Папка сессии", "Session folder")}>
          ⌂
        </button>
        <button className="btn btn--small" disabled={!up} onClick={() => up && setCwd(up)}>
          ↑
        </button>
        <span className="folders__path">{cwd.slice(root.length) || "\\"}</span>
      </div>
      {error && <p className="error">{error}</p>}
      {!entries && !error && <p className="muted">{t("загрузка…", "loading…")}</p>}
      <ul className="list">
        {entries?.map((e) => (
          <li key={e.path}>
            <button className="folder" onClick={() => void open(e)}>
              {e.dir ? "📁" : "📄"} {e.name} {!e.dir && e.size !== undefined && <span className="muted">{fmtSize(e.size)}</span>}
            </button>
          </li>
        ))}
        {entries && !entries.length && <li className="muted">{t("Пусто", "Empty")}</li>}
      </ul>
    </>
  );
}

async function review(id: string): Promise<void> {
  const model = await pickOpencodeModel(t("Ревью изменений", "Review changes"), t("Начать ревью", "Start review"), t("Новая сессия opencode получит дифф и только посмотрит его — ничего не меняет и не запускает.", "A new opencode session gets the diff and only reads it — changes nothing and runs nothing."));
  if (!model) return;
  try {
    const s = await client.review(id, model);
    go({ page: "session", id: s.id });
  } catch (e) {
    alert((e as Error).message);
  }
}
