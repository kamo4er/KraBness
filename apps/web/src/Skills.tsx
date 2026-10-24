// Скиллы (~/.claude/skills): написать, загрузить SKILL.md/zip, поставить из GitHub, изменить, удалить.
import { useEffect, useRef, useState } from "react";
import { ApiError, type SkillInfo, t, tn } from "@kamharn/client";
import { client, fmtSize, fmtTime, go } from "./hub.ts";

const template = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body.trim()}\n`;

/** 409 «уже есть» → спросить и повторить с заменой */
async function withReplace<T>(f: (overwrite: boolean) => Promise<T>): Promise<T | undefined> {
  try {
    return await f(false);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return confirm(`${e.message}. ${t("Заменить?", "Replace?")}`) ? f(true) : undefined;
    throw e;
  }
}

export function Skills() {
  const [list, setList] = useState<SkillInfo[]>();
  const [error, setError] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [mode, setMode] = useState<"new" | "github" | { edit: string }>();
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const load = () => client.skills().then(setList, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function run(f: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(undefined);
    setMsg(undefined);
    try {
      const r = await f();
      if (r !== undefined) {
        setMode(undefined);
        if (done) setMsg(done);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "settings" })}>
          ←
        </button>
        <h2>{t("Скиллы", "Skills")}</h2>
      </header>
      <div className="page__body">
        <p className="muted">
          {t("Инструкции и скрипты, которые агент берёт сам, когда задача подходит под описание; вручную — «/имя» в чате. Лежат в", "Instructions and scripts the agent picks up by itself when a task matches the description; manually — “/name” in chat. They live in")}{" "}
          <code>~/.claude/skills</code>: {t("их видят Claude (в KraBness, VS Code, терминале) и opencode.", "seen by Claude (in KraBness, VS Code, the terminal) and opencode.")}
        </p>
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => setMode("new")}>
            {t("+ Написать", "+ Write")}
          </button>
          <button className="btn" disabled={busy} onClick={() => file.current?.click()}>
            {t("Загрузить SKILL.md или zip", "Upload SKILL.md or zip")}
          </button>
          <button className="btn" disabled={busy} onClick={() => setMode("github")}>
            {t("Из GitHub", "From GitHub")}
          </button>
          <input
            ref={file}
            type="file"
            accept=".md,.zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void run(() => withReplace((o) => client.uploadSkill(f.name, f, o)), `${t("Поставил из", "Installed from")} ${f.name}`);
            }}
          />
        </div>
        {msg && <p className="muted">{msg}</p>}
        {error && <p className="error">{error}</p>}

        {mode === "github" && <GithubForm busy={busy} onRun={(url) => run(() => withReplace((o) => client.skillFromGithub(url, o)), t("Скилл поставлен", "Skill installed"))} onCancel={() => setMode(undefined)} />}
        {mode === "new" && <Editor busy={busy} onSave={(name, text) => run(() => client.saveSkill(name, text, true), t(`Скилл «${name}» создан`, `Skill “${name}” created`))} onCancel={() => setMode(undefined)} />}

        <section>
          <h3>{t("Установлены", "Installed")}</h3>
          {!list && !error && <p className="muted">{t("Загрузка…", "Loading…")}</p>}
          {list?.length === 0 && <p className="muted">{t("Пока нет.", "None yet.")}</p>}
          <div className="prov__list">
            {list?.map((s) =>
              typeof mode === "object" && mode.edit === s.name ? (
                <Editor key={s.name} name={s.name} busy={busy} onSave={(name, text) => run(() => client.saveSkill(name, text), t("Сохранено", "Saved"))} onCancel={() => setMode(undefined)} />
              ) : (
                <div key={s.name} className="prov prov--on">
                  <div className="prov__row">
                    <b>/{s.name}</b>
                    <span className="muted">
                      {tn(s.files, ["файл", "файла", "файлов"], ["file", "files"])} · {fmtSize(s.size)} · {fmtTime(s.updatedAt)}
                    </span>
                    <span style={{ flex: 1 }} />
                    <button className="btn btn--small" disabled={busy} onClick={() => setMode({ edit: s.name })}>
                      {t("Изменить", "Edit")}
                    </button>
                    <button
                      className="btn btn--small btn--danger"
                      disabled={busy}
                      onClick={() => confirm(t(`Удалить скилл «${s.name}» со всеми файлами? Он пропадёт и в Claude Code.`, `Delete skill “${s.name}” with all its files? It will disappear from Claude Code too.`)) && void run(() => client.removeSkill(s.name), t("Удалён", "Deleted"))}
                    >
                      {t("Удалить", "Delete")}
                    </button>
                  </div>
                  {s.description && <div className="muted skill__desc">{s.description}</div>}
                </div>
              ),
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function GithubForm({ busy, onRun, onCancel }: { busy: boolean; onRun: (url: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  return (
    <section className="prov prov__custom">
      <b>{t("Поставить из GitHub", "Install from GitHub")}</b>
      <p className="muted">
        {t("Ссылка на папку скилла, например", "A link to the skill folder, e.g.")} <code>https://github.com/anthropics/skills/tree/main/skills/pdf</code>.{" "}
        {t("В скиллах бывают скрипты, которые агент запускает, — ставь из мест, которым доверяешь.", "Skills may contain scripts the agent runs — install only from sources you trust.")}
      </p>
      <input className="input mono" placeholder="https://github.com/…/tree/main/…" value={url} onChange={(e) => setUrl(e.target.value)} />
      <div className="row">
        <button className="btn btn--primary" disabled={busy || !url.trim()} onClick={() => onRun(url.trim())}>
          {busy ? t("Скачиваю…", "Downloading…") : t("Поставить", "Install")}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          {t("Отмена", "Cancel")}
        </button>
      </div>
    </section>
  );
}

/** Новый скилл — имя, описание, инструкция; существующий — весь SKILL.md целиком. */
function Editor({ name: existing, busy, onSave, onCancel }: { name?: string; busy: boolean; onSave: (name: string, text: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(existing ?? "");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [text, setText] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    if (existing) void client.skillText(existing).then((r) => setText(r.text), (e: Error) => setLoadError(e.message));
  }, [existing]);
  return (
    <section className="prov prov__custom">
      <b>{existing ? `${t("Изменить", "Edit")} /${existing}` : t("Новый скилл", "New skill")}</b>
      {existing ? (
        text === undefined ? (
          loadError ? <p className="error">{loadError}</p> : <p className="muted">{t("Загрузка…", "Loading…")}</p>
        ) : (
          <textarea className="input mono" rows={16} value={text} onChange={(e) => setText(e.target.value)} />
        )
      ) : (
        <>
          <input className="input mono" placeholder={t("Имя: code-review (строчная латиница, цифры, дефис)", "Name: code-review (lowercase latin, digits, hyphen)")} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          <input className="input" placeholder={t("Когда применять: «Ревью кода перед коммитом: ищет баги и…»", "When to use: “Code review before a commit: finds bugs and…”")} value={description} onChange={(e) => setDescription(e.target.value)} />
          <textarea className="input" rows={10} placeholder={t("Инструкция для агента: что и как делать по шагам.", "Instructions for the agent: what to do, step by step.")} value={body} onChange={(e) => setBody(e.target.value)} />
          <p className="muted">{t("По описанию агент решает, когда брать скилл, — пиши конкретно.", "The agent decides when to use the skill by its description — be specific.")}</p>
        </>
      )}
      <div className="row">
        <button
          className="btn btn--primary"
          disabled={busy || (existing ? !text : !name.trim() || !description.trim() || !body.trim())}
          onClick={() => onSave(existing ?? name.trim(), existing ? text! : template(name.trim(), description.trim(), body))}
        >
          {busy ? t("Сохраняю…", "Saving…") : t("Сохранить", "Save")}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          {t("Отмена", "Cancel")}
        </button>
      </div>
    </section>
  );
}
