import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { limitView, resolveFileRef, speakableText, type FileRef, type ChecksConfig, type ClaudeLimits, type EngineInfo, type ListeningPort, type WorktreeStatus, type MessageView, type ModelRef, type PermissionMode, type SlashCommand, t, locale } from "@kamharn/client";
import { client, fmtSize, go, useEngines, useHub, useQuickPrompts } from "./hub.ts";
import { EffortSelect } from "./Effort.tsx";
import { pickOpencodeModel } from "./ModelPick.tsx";
import { MODES } from "./NewSession.tsx";
import { FileChip, FileRefCtx, Limits, PartView, PermissionCard, QuestionCard } from "./Parts.tsx";

export function Chat({ id }: { id: string }) {
  const state = useHub();
  const view = state.views[id];
  const info = state.sessions.find((s) => s.id === id) ?? view?.info;
  const engines = useEngines();
  // клик по пути к файлу в ответе — просмотр проекта на этом файле (стабильная ссылка: иначе перерисуется весь markdown)
  const dir = info?.directory;
  const openRef = useCallback((r: FileRef) => dir && go({ page: "project", id, file: resolveFileRef(r, dir), ...(r.line ? { line: r.line } : {}) }), [id, dir]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dropFiles = useRef<(list: FileList) => void>(undefined);
  const [showOld, setShowOld] = useState(false);
  // с последней отметки «контекст сжат» (0 — отметки нет, показываем всё)
  const cut = Math.max(0, view?.messages.findLastIndex((m) => m.parts.some((p) => p.type === "compaction")) ?? -1);

  useEffect(() => {
    client.openSession(id);
    return () => client.closeSession(id);
  }, [id]);

  // автопрокрутка вниз, если пользователь и так был внизу
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.versions[id]]);

  if (!info) {
    return (
      <div className="empty">
        <p>{state.conn === "online" ? t("Сессия не найдена.", "Session not found.") : t("Загрузка…", "Loading…")}</p>
      </div>
    );
  }

  const busy = info.status === "busy" || info.status === "retry";
  return (
    <FileRefCtx.Provider value={openRef}>
    <div
      className={`chat ${dragging ? "chat--drop" : ""}`}
      // файлы можно бросить в любое место чата
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDragLeave={() => {
        if (--dragDepth.current <= 0) (dragDepth.current = 0), setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) dropFiles.current?.(e.dataTransfer.files);
      }}
    >
      {dragging && <div className="dropzone">{t("Отпусти, чтобы прикрепить", "Drop to attach")}</div>}
      <ChatHeader info={info} engines={engines} limits={state.limits} />
      <div
        className="chat__scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
          stick.current = fromBottom < 80;
          setShowDown(fromBottom > 400);
        }}
      >
        <div className="chat__messages">
          {/* после сжатия контекста ранние сообщения свёрнуты: агент их помнит только пересказом */}
          {cut > 0 && !showOld && (
            <button className="linkish older" onClick={() => setShowOld(true)}>
              {t(`Показать ранние сообщения: ${cut}`, `Show earlier messages: ${cut}`)}
            </button>
          )}
          {view?.messages.slice(showOld ? 0 : cut).map((m) => <Message key={m.info.id} m={m} />)}
          {view?.errors.map((e, i) => (
            <div key={i} className="notice notice--error">
              {e}
            </div>
          ))}
          {busy && (
            <div className="working">
              <span className="spinner" /> {info.status === "retry" ? t("повторная попытка…", "retrying…") : t("работает…", "working…")}
            </div>
          )}
        </div>
      </div>
      {showDown && (
        <button
          className="down"
          title={t("В самый низ", "Scroll to bottom")}
          onClick={() => {
            const el = scroller.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
          }}
        >
          ↓
        </button>
      )}
      {info.engine === "claude" && <LimitBanner limits={state.limits} sessionId={id} />}
      {info.resumeAt ? <ResumeBanner sessionId={id} at={info.resumeAt} /> : null}
      {view?.permissions.map((p) => <PermissionCard key={p.id} sessionId={id} req={p} />)}
      {view?.questions.map((q) => <QuestionCard key={q.id} sessionId={id} req={q} />)}
      <Composer sessionId={id} busy={busy} slash={info.engine === "claude"} dropFiles={dropFiles} />
    </div>
    </FileRefCtx.Provider>
  );
}

/** Автопроверка: вкл/выкл, команды проекта (сохранённые или предложенные хабом), прогон сейчас. */
function ChecksButton({ sessionId, on }: { sessionId: string; on: boolean }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<ChecksConfig>();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string>();
  const toggleOpen = () => {
    setOpen(!open);
    setMsg(undefined);
    if (!open)
      void client.checks(sessionId).then(
        (c) => (setCfg(c), setText((c.commands.length ? c.commands : c.suggested).join("\n"))),
        (e: Error) => setMsg(e.message),
      );
  };
  const list = () => text.split("\n").map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    const c = await client.setChecks(sessionId, list());
    setCfg(c);
    return c;
  };
  const run = (f: () => Promise<unknown>) => void f().catch((e: Error) => setMsg(e.message));
  return (
    <div className="preview">
      <button className={`btn btn--icon ${on ? "btn--on" : ""}`} title={t("Автопроверка: после хода агента — тесты и сборка", "Auto-check: tests and build after each agent turn")} onClick={toggleOpen}>
        ✓
      </button>
      {open && (
        <div className="slash preview__menu checks__menu">
          <label className="row">
            <input
              type="checkbox"
              checked={on}
              onChange={() =>
                run(async () => {
                  // включаем — сразу сохраняем команды (иначе нечего гонять)
                  if (!on && !cfg?.commands.length) await save();
                  await client.updateSession(sessionId, { autoCheck: !on });
                })
              }
            />
            {t("Автопроверка после каждого хода агента", "Auto-check after every agent turn")}
          </label>
          <p className="muted">
            {t(
              "Хаб гоняет команды по очереди в папке сессии. Упало — отправляет ошибку агенту (до 3 раз), прошло — пришлёт «готово».",
              "The hub runs the commands in the session folder one by one. A failure goes back to the agent (up to 3 times), a pass sends you “done”.",
            )}
          </p>
          {cfg ? <textarea className="input mono" rows={3} value={text} placeholder="npm test" onChange={(e) => setText(e.target.value)} /> : !msg && <p className="muted">{t("загрузка…", "loading…")}</p>}
          {cfg && !cfg.commands.length && cfg.suggested.length > 0 && <p className="muted">{t("Предложены по файлам проекта — проверь и сохрани.", "Suggested from the project files — check and save.")}</p>}
          {cfg && !cfg.commands.length && !cfg.suggested.length && <p className="muted">{t("Не нашёл тестов в проекте — впиши команды сам, по одной в строке.", "No tests found in the project — enter commands yourself, one per line.")}</p>}
          <div className="row">
            <button className="btn btn--small" onClick={() => run(async () => (await save(), setMsg(t("Сохранено", "Saved"))))}>
              {t("Сохранить", "Save")}
            </button>
            <button className="btn btn--small" disabled={!list().length} onClick={() => run(async () => (await save(), await client.runChecks(sessionId), setOpen(false)))}>
              {t("Проверить сейчас", "Check now")}
            </button>
          </div>
          {cfg && <p className="muted mono">{cfg.directory}</p>}
          {msg && <p className="muted">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function ChatHeader({ info, engines, limits }: { info: NonNullable<ReturnType<typeof useHub>["sessions"][number]>; engines?: EngineInfo[]; limits?: ClaudeLimits }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(info.title);
  const models = engines?.find((e) => e.id === info.engine)?.models ?? [];
  const modelKey = (m: ModelRef) => `${m.providerId}/${m.modelId}`;

  return (
    <header className="chat__head">
      <button className="btn btn--icon back" onClick={() => go({ page: "home" })} title={t("К списку", "Back to list")}>
        ←
      </button>
      <div className="chat__titles">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
              if (title.trim() && title !== info.title) void client.updateSession(info.id, { title });
            }}
          >
            <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setEditing(false)} />
          </form>
        ) : (
          <h2 className="chat__title" onClick={() => (setTitle(info.title), setEditing(true))} title={t("Переименовать", "Rename")}>
            {info.title}
          </h2>
        )}
        <div className="chat__meta muted">
          <span className={`badge badge--${info.engine}`}>{info.engine}</span>
          <select
            className="select select--inline"
            value={modelKey(info.model)}
            onChange={(e) => {
              const m = models.find((x) => modelKey(x) === e.target.value);
              if (m) void client.updateSession(info.id, { model: { providerId: m.providerId, modelId: m.modelId } });
            }}
          >
            {!models.some((m) => modelKey(m) === modelKey(info.model)) && <option value={modelKey(info.model)}>{info.model.modelId}</option>}
            {models.map((m) => (
              <option key={modelKey(m)} value={modelKey(m)} disabled={m.offline}>
                {m.name}
                {m.offline ? ` · ${t("не запущена", "not running")}` : m.free ? " · free" : ""}
              </option>
            ))}
          </select>
          <EffortSelect
            inline
            efforts={models.find((m) => modelKey(m) === modelKey(info.model))?.efforts ?? []}
            value={info.effort ?? ""}
            onChange={(v) => void client.updateSession(info.id, { effort: v }).catch((err: Error) => alert(err.message))}
          />
          <select
            className="select select--inline"
            title={t("Режим подтверждений, применяется сразу", "Approval mode, applies immediately")}
            value={info.permissionMode}
            onChange={(e) => {
              client.updateSession(info.id, { permissionMode: e.target.value as PermissionMode }).catch((err: Error) => alert(err.message));
            }}
          >
            {MODES().map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </select>
          {info.engine === "claude" && <Limits limits={limits} compact />}
          {info.engine === "claude" && (
            <button className="linkish" title={t("Новая сессия на бесплатной модели с выжимкой этой", "A new session on a free model with a summary of this one")} onClick={() => void handoff(info.id)}>
              → opencode
            </button>
          )}
          <span className="chat__dir" title={info.directory}>
            {info.directory}
          </span>
        </div>
      </div>
      {info.worktree && <WorktreeButton sessionId={info.id} branch={info.worktree.branch} base={info.worktree.base} busy={info.status === "busy"} />}
      <PreviewButton sessionId={info.id} />
      <ChecksButton sessionId={info.id} on={!!info.autoCheck} />
      <button
        className="btn btn--icon"
        title={t("Сжать контекст: агент перескажет разговор сам себе и освободит место", "Compact the context: the agent summarizes the conversation for itself and frees up space")}
        disabled={info.status === "busy" || info.status === "retry"}
        onClick={() => {
          if (!confirm(t("Сжать контекст? Агент заменит историю коротким пересказом: главное запомнит, мелкие подробности забудет. Ранние сообщения в чате свернутся.", "Compact the context? The agent replaces the history with a short summary: it keeps the essentials and forgets small details. Earlier messages in the chat get collapsed."))) return;
          void client.compact(info.id).catch((e: Error) => alert(e.message));
        }}
      >
        🗜
      </button>
      <button className="btn btn--icon" title={t("Проект: изменения и файлы", "Project: changes and files")} onClick={() => go({ page: "project", id: info.id })}>
        📁
      </button>
      <button
        className="btn btn--icon btn--danger"
        title={t("Удалить сессию", "Delete session")}
        onClick={() => {
          if (!confirm(t(`Удалить сессию «${info.title}»? История в KraBness пропадёт, файлы в папке останутся.`, `Delete session “${info.title}”? Its history in KraBness will be gone, files in the folder stay.`))) return;
          void client.deleteSession(info.id).then(() => go({ page: "home" }));
        }}
      >
        🗑
      </button>
    </header>
  );
}

function Message({ m }: { m: MessageView }) {
  // отметка «контекст сжат» (у opencode она в сообщении пользователя) — во всю ширину, без пузыря
  const comp = m.parts.find((p) => p.type === "compaction");
  if (comp) return <PartView part={comp} />;
  if (m.info.summary) return <Summary m={m} />;
  if (m.info.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="bubble">
          {m.parts.map((p) =>
            p.type === "text" ? (
              <div key={p.id} className="bubble__text">
                {stripAttachmentNote(p.text)}
              </div>
            ) : p.type === "file" ? (
              <FileChip key={p.id} fileId={p.fileId} name={p.name} mime={p.mime} size={p.size} />
            ) : null,
          )}
        </div>
      </div>
    );
  }
  if (!m.parts.length) return null;
  return (
    <div className="msg msg--assistant">
      {m.parts.map((p) => (
        <PartView key={p.id} part={p} />
      ))}
      <SpeakButton m={m} />
    </div>
  );
}

/** Пересказ разговора после сжатия: то, что агент помнит о ранних сообщениях. Свёрнут. */
function Summary({ m }: { m: MessageView }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg msg--assistant summary">
      <button className="linkish" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {t("Что агент помнит о разговоре (пересказ)", "What the agent remembers of the conversation (summary)")}
      </button>
      {open && m.parts.map((p) => <PartView key={p.id} part={p} />)}
    </div>
  );
}

// озвучка ответа: браузерный синтез речи, одновременно читается один ответ
let speakingId: string | undefined;
const speakListeners = new Set<() => void>();
const setSpeaking = (id: string | undefined) => {
  speakingId = id;
  for (const l of speakListeners) l();
};

/** 🔊 — прочитать ответ вслух (только текст, без кода и путей); во время чтения — ⏹. */
function SpeakButton({ m }: { m: MessageView }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const l = () => setOn(speakingId === m.info.id);
    speakListeners.add(l);
    return () => void speakListeners.delete(l);
  }, [m.info.id]);
  const md = m.parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n\n");
  const text = speakableText(md);
  if (text.length < 20 || !("speechSynthesis" in window)) return null;
  const toggle = () => {
    speechSynthesis.cancel();
    if (on) return setSpeaking(undefined);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale();
    u.onend = u.onerror = () => speakingId === m.info.id && setSpeaking(undefined);
    setSpeaking(m.info.id);
    speechSynthesis.speak(u);
  };
  return (
    <button className="linkish speak" onClick={toggle} title={on ? t("Остановить", "Stop") : t("Прочитать вслух", "Read aloud")}>
      {on ? `⏹ ${t("стоп", "stop")}` : "🔊"}
    </button>
  );
}

/** opencode получает список вложений в тексте — пользователю его показывать не нужно */
function stripAttachmentNote(text: string): string {
  return text.replace(/\n*\[(Вложения от пользователя|Attachments from the user): [^\]]*\]\s*$/, "");
}

interface Pending {
  key: string;
  name: string;
  size: number;
  fileId?: string;
  error?: string;
}

function Composer({
  sessionId,
  busy,
  slash,
  dropFiles,
}: {
  sessionId: string;
  busy: boolean;
  slash: boolean;
  /** чат отдаёт сюда файлы, брошенные в любое его место */
  dropFiles: { current?: (list: FileList) => void };
}) {
  const [text, setText] = useState(() => sessionStorage.getItem(`draft.${sessionId}`) ?? "");
  const quick = useQuickPrompts();
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  useEffect(() => {
    if (slash) client.commands(sessionId).then(setCommands, () => {});
  }, [sessionId, slash]);
  // меню «/»: пока набирается имя команды (без пробела)
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const slashMatches =
    slashQuery === undefined ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery.toLowerCase())).slice(0, 12);
  const [files, setFiles] = useState<Pending[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    sessionStorage.setItem(`draft.${sessionId}`, text);
    const el = area.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 240) + "px";
    }
  }, [text, sessionId]);

  const uploading = files.some((f) => !f.fileId && !f.error);

  dropFiles.current = (list) => void addFiles(list);

  async function addFiles(list: FileList | File[]) {
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      setFiles((fs) => [...fs, { key, name: file.name || "file", size: file.size }]);
      try {
        const up = await client.upload(sessionId, file.name || `paste-${Date.now()}.png`, file);
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, fileId: up.fileId } : f)));
      } catch (e) {
        setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: (e as Error).message } : f)));
      }
    }
  }

  async function send(override?: string) {
    const fileIds = files.flatMap((f) => (f.fileId ? [f.fileId] : []));
    const body = override ?? text;
    if ((!body.trim() && !fileIds.length) || uploading || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await client.prompt(sessionId, body, fileIds);
      setText("");
      setFiles([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="composer">
      {files.length > 0 && (
        <div className="composer__files">
          {files.map((f) => (
            <span key={f.key} className={`chip ${f.error ? "chip--error" : ""}`} title={f.error}>
              {f.fileId ? "📎" : f.error ? "⚠" : <span className="spinner" />} {f.name} <span className="muted">{fmtSize(f.size)}</span>
              <button className="chip__x" onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {slashMatches.length > 0 && (
        <ul className="slash">
          {slashMatches.map((c) => (
            <li key={c.name}>
              <button className="slash__item" onClick={() => (setText(`/${c.name} `), area.current?.focus())}>
                <span className="slash__name">/{c.name}</span>
                {c.description && <span className="muted">{c.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {quick.length > 0 && (
        <div className="quick">
          {quick.map((q) => (
            <button
              key={q}
              className="quick__btn"
              disabled={sending || uploading}
              title={text.trim() ? t("Дописать в сообщение", "Append to message") : t("Отправить", "Send")}
              // пустое поле — отправляем сразу, иначе дописываем к набранному
              onClick={() => (text.trim() ? setText((t) => t.replace(/\s*$/, " ") + q) : void send(q))}
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="composer__row">
        {slash && commands.length > 0 && (
          <button className="btn btn--icon" title={t("Скиллы и команды Claude", "Claude skills and commands")} onClick={() => (setText((t) => (t.startsWith("/") ? "" : "/")), area.current?.focus())}>
            /
          </button>
        )}
        <button className="btn btn--icon" title={t("Прикрепить файл", "Attach a file")} onClick={() => fileInput.current?.click()}>
          📎
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          ref={area}
          className="composer__input"
          rows={1}
          placeholder={busy ? t("В очередь…", "Queue a message…") : t("Сообщение…", "Message…")}
          title={t("Enter — отправить, Shift+Enter — перенос строки", "Enter — send, Shift+Enter — new line")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              void addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {busy && (
          <button className="btn btn--danger" title={t("Остановить", "Stop")} onClick={() => void client.abort(sessionId)}>
            ■
          </button>
        )}
        <button className="btn btn--primary" disabled={sending || uploading || (!text.trim() && !files.some((f) => f.fileId))} onClick={() => void send()}>
          ➤
        </button>
      </div>
    </div>
  );
}

/** Продолжить на бесплатной модели: новая opencode-сессия с выжимкой этой. */
async function handoff(id: string): Promise<void> {
  const model = await pickOpencodeModel(t("Продолжить в opencode", "Continue in opencode"), t("Продолжить", "Continue"), t("Создам сессию opencode с выжимкой этой. Эта сессия останется как есть; если она ждала сброса лимита — ждать перестанет.", "I will create an opencode session with a summary of this one. This session stays as is; if it was waiting for the limit to reset, it stops waiting."));
  if (!model) return;
  try {
    const s = await client.handoff(id, model);
    go({ page: "session", id: s.id });
  } catch (e) {
    alert((e as Error).message);
  }
}

/** Отдельная ветка сессии: что сделано, «Влить» одним коммитом в основную, «Выбросить». */
function WorktreeButton({ sessionId, branch, base, busy }: { sessionId: string; branch: string; base: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<WorktreeStatus>();
  const [msg, setMsg] = useState<string>();
  const [working, setWorking] = useState(false);
  const load = () => client.worktreeStatus(sessionId).then(setSt, (e: Error) => setMsg(e.message));
  const toggle = () => {
    setOpen(!open);
    if (!open) (setSt(undefined), setMsg(undefined), void load());
  };
  const act = async (what: "merge" | "discard") => {
    if (what === "discard" && !confirm(t(`Выбросить всё, что сделано в ветке ${branch} после последнего вливания?`, `Discard everything done in branch ${branch} since the last merge?`))) return;
    setWorking(true);
    setMsg(undefined);
    try {
      if (what === "merge") {
        const r = await client.worktreeMerge(sessionId);
        setMsg(t(`Влито в ${base}: коммит ${r.commit}, файлов ${r.files}`, `Merged into ${base}: commit ${r.commit}, ${r.files} files`));
      } else {
        await client.worktreeDiscard(sessionId);
        setMsg(t("Изменения выброшены, копия снова как основная ветка", "Changes discarded, the copy matches the main branch again"));
      }
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const changed = st ? st.ahead + st.dirty : 0;
  return (
    <div className="wt">
      <button className="btn btn--small" title={t(`Сессия работает в ветке ${branch}`, `The session works in branch ${branch}`)} onClick={toggle}>
        ⎇ {branch.replace(/^kamharn\//, "")}
      </button>
      {open && (
        <div className="wt__menu">
          <div>
            {t("Ветка", "Branch")} <code>{branch}</code> → {t("вливается в", "merges into")} <code>{base}</code>
          </div>
          {!st && !msg && <div className="muted">{t("Смотрю…", "Checking…")}</div>}
          {st && (
            <div className="muted">
              {changed ? t(`коммитов: ${st.ahead}, незакоммиченных файлов: ${st.dirty}`, `commits: ${st.ahead}, uncommitted files: ${st.dirty}`) : t("изменений нет — копия совпадает с основной веткой", "no changes — the copy matches the main branch")}
            </div>
          )}
          {st && st.files.length > 0 && <pre className="wt__files">{st.files.join("\n")}</pre>}
          {msg && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{msg}</div>}
          <div className="wt__actions">
            <button className="btn btn--primary btn--small" disabled={!changed || busy || working} onClick={() => void act("merge")}>
              {t("Влить в", "Merge into")} {base}
            </button>
            <button className="btn btn--small btn--danger" disabled={!changed || busy || working} onClick={() => void act("discard")}>
              {t("Выбросить", "Discard")}
            </button>
            <button className="btn btn--small" onClick={() => setOpen(false)}>
              {t("Закрыть", "Close")}
            </button>
          </div>
          {busy && <div className="muted">{t("Агент работает — вливать можно, когда он закончит.", "The agent is working — you can merge when it finishes.")}</div>}
        </div>
      )}
    </div>
  );
}

/** Превью dev-сервера: на ПК — прямо localhost, с другого устройства — ссылка хаба через Tailscale. */
function PreviewButton({ sessionId }: { sessionId: string }) {
  const [ports, setPorts] = useState<ListeningPort[]>();
  const [open, setOpen] = useState(false);
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const toggle = () => {
    setOpen(!open);
    if (!open) {
      setPorts(undefined);
      client.ports(sessionId).then(setPorts, () => setPorts([]));
    }
  };
  const go = (p: ListeningPort) => {
    setOpen(false);
    if (local) return void window.open(`http://localhost:${p.port}/`, "_blank");
    // окно открываем сразу (иначе браузер посчитает его всплывающим), адрес подставляем после ответа хаба
    const w = window.open("about:blank", "_blank");
    client.openPreview(p.port).then(
      (r) => (w ? (w.location.href = r.url) : window.open(r.url, "_blank")),
      (e: Error) => (w?.close(), alert(e.message)),
    );
  };
  return (
    <div className="preview">
      <button className="btn btn--icon" title={t("Превью dev-сервера", "Dev server preview")} onClick={toggle}>
        ▶
      </button>
      {open && (
        <ul className="slash preview__menu" onMouseLeave={() => setOpen(false)}>
          {!ports && <li className="muted pad">{t("Ищу порты…", "Looking for ports…")}</li>}
          {ports && !ports.length && <li className="muted pad">{t("Нет запущенных веб-серверов. Попроси агента запустить dev-сервер.", "No web servers running. Ask the agent to start a dev server.")}</li>}
          {ports?.map((p) => (
            <li key={p.port}>
              <button className="slash__item" onClick={() => go(p)}>
                <span>
                  <span className="slash__name">:{p.port}</span> {p.process} {p.project ? <span className="muted">· {t("этот проект", "this project")}</span> : null}
                </span>
                <span className="muted">{p.command}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Упёрлись в лимит: хаб сам напишет «Продолжай» после сброса. */
function ResumeBanner({ sessionId, at }: { sessionId: string; at: number }) {
  return (
    <div className="limitbanner limitbanner--warn">
      <span>⏳ {t("Упёрлись в лимит Claude — продолжу сам в", "Hit the Claude limit — I'll continue by myself at")} {new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" })}</span>
      {/* простую часть можно не ждать: передать бесплатной модели (тогда Claude не проснётся — иначе двое правят одни файлы) */}
      <button className="btn btn--small" title={t("Передать работу бесплатной модели в opencode", "Hand the work to a free model in opencode")} onClick={() => void handoff(sessionId)}>
        {t("Не ждать", "Don't wait")}
      </button>
      <button className="btn btn--small" onClick={() => void client.updateSession(sessionId, { resumeAt: 0 })}>
        {t("Не продолжать", "Don't continue")}
      </button>
    </div>
  );
}

/** Лимит Claude подходит к концу (≥80%) — предложить продолжить на бесплатной модели. */
function LimitBanner({ limits, sessionId }: { limits?: ClaudeLimits; sessionId: string }) {
  const v = limitView(limits);
  if (!v || v.level === "ok") return null;
  return (
    <div className={`limitbanner limitbanner--${v.level}`}>
      <span>
        {t("Лимит Claude", "Claude limit")}: {t("5ч", "5h")} {v.fiveHour ?? "—"}% · {t("неделя", "week")} {v.sevenDay ?? "—"}%
        {v.fiveHourReset ? <span className="muted"> · {t("сброс в", "resets at")} {v.fiveHourReset}</span> : null}
      </span>
      <button className="btn btn--small" onClick={() => void handoff(sessionId)}>
        {t("Продолжить на бесплатной модели", "Continue on a free model")}
      </button>
    </div>
  );
}
