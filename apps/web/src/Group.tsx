// Экран группы сессий: название, эмодзи, системный промпт для всех её сессий, удаление.
import { useEffect, useState } from "react";
import { client, go, useHub } from "./hub.ts";
import { t } from "@kamharn/client";

const ICONS = ["🛠", "🎮", "📱", "🌐", "🧠", "📊", "🎨", "🔬", "📝", "🏠"];

export function Group({ id }: { id: string }) {
  const state = useHub();
  const isNew = id === "new";
  const g = state.groups.find((x) => x.id === id);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [prompt, setPrompt] = useState("");
  const [noUserRules, setNoUserRules] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // форма заполняется, когда группа пришла с хаба
  useEffect(() => {
    if (g) (setName(g.name), setIcon(g.icon ?? ""), setPrompt(g.prompt ?? ""), setNoUserRules(!!g.noUserRules));
  }, [g?.id]);

  if (!isNew && !g) return <div className="empty">{state.conn === "online" ? t("Группа не найдена.", "Group not found.") : t("Загрузка…", "Loading…")}</div>;
  const count = state.sessions.filter((s) => s.groupId === id).length;

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (isNew) await client.createGroup({ name, icon, prompt, noUserRules });
      else await client.updateGroup(id, { name, icon, prompt, noUserRules });
      go({ page: "home" });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(t(`Удалить группу «${g!.name}»? Сессии останутся, просто без группы.`, `Delete group “${g!.name}”? Its sessions stay, just ungrouped.`))) return;
    await client.deleteGroup(id).then(() => go({ page: "home" }), (e: Error) => setError(e.message));
  };

  return (
    <div className="page">
      <header className="page__head">
        <button className="btn btn--icon back" onClick={() => go({ page: "home" })}>
          ←
        </button>
        <h2>{isNew ? t("Новая группа", "New group") : `${g!.icon ?? ""} ${g!.name}`.trim()}</h2>
      </header>
      <div className="page__body">
        <section>
          <h3>{t("Название", "Name")}</h3>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("например: Игры", "e.g. Games")} autoFocus={isNew} />
        </section>
        <section>
          <h3>{t("Значок", "Icon")}</h3>
          <div className="icons">
            {ICONS.map((i) => (
              <button key={i} className={`icon ${icon === i ? "icon--on" : ""}`} onClick={() => setIcon(icon === i ? "" : i)}>
                {i}
              </button>
            ))}
            <input className="input icon__own" value={ICONS.includes(icon) ? "" : icon} onChange={(e) => setIcon(e.target.value)} placeholder={t("свой", "custom")} maxLength={4} />
          </div>
        </section>
        <section>
          <h3>{t("Системный промпт", "System prompt")}</h3>
          <textarea
            className="input prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={6}
            placeholder={t("Добавляется к инструкциям агента во всех сессиях группы. Например: «Ты психолог-программист, помогаешь мне справиться с внутренней сингулярностью».", "Appended to the agent's instructions in every session of the group. E.g. “You are a senior game developer, keep answers short”.")}
          />
          <p className="muted">{t("Применяется ко всем сессиям группы со следующего сообщения — и к уже идущим, и к перенесённым в группу.", "Applies to all sessions of the group from the next message — running ones and ones moved into the group.")}</p>
        </section>
        <section>
          <label className="row">
            <input type="checkbox" checked={noUserRules} onChange={(e) => setNoUserRules(e.target.checked)} />
            <b>{t("Без моих глобальных правил", "Without my global rules")}</b>
          </label>
          <p className="muted">
            {t(
              "Claude не читает ~/.claude/CLAUDE.md и ~/.claude/rules: твои правила про код, обращение и стиль. Для чатов не про код (врач, дом). Нужное из них допиши в промпт выше.",
              "Claude skips ~/.claude/CLAUDE.md and ~/.claude/rules: your rules about coding, how to address you, style. For chats that aren't about code. Put what you need from them into the prompt above.",
            )}
          </p>
        </section>
        {error && <p className="error">{error}</p>}
        <button className="btn btn--primary btn--big" disabled={!name.trim() || busy} onClick={() => void save()}>
          {isNew ? t("Создать группу", "Create group") : t("Сохранить", "Save")}
        </button>
        {!isNew && (
          <p className="center">
            <button className="btn btn--danger" onClick={() => void remove()}>
              {t("Удалить группу", "Delete group")}
            </button>
            <span className="muted"> · {t("сессий в ней", "sessions")}: {count}</span>
          </p>
        )}
      </div>
    </div>
  );
}
