// Отрисовка частей сообщения: текст (markdown), размышления, вызовы инструментов, файлы.
import { createContext, isValidElement, memo, useContext, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { artifactSource, limitView, parseFileRef, type FileRef, type ClaudeLimits, type Part, type PermissionRequest, type QuestionAnswers, type QuestionRequest, t } from "@kamharn/client";
import { client, fmtSize } from "./hub.ts";
import { MermaidDiagram } from "./Mermaid.tsx";
import { ArtifactCard } from "./Artifact.tsx";
import { mermaidSource } from "./mermaid.ts";

/** открыть файл по ссылке из ответа (чат даёт его; в просмотре .md-файла ссылок на файлы нет) */
export const FileRefCtx = createContext<((ref: FileRef) => void) | undefined>(undefined);

/** ссылка без схемы ([план](tmp/plans/a.md)) — тоже путь к файлу */
const linkRef = (href: string | undefined): FileRef | undefined => {
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(href.replace(/^[A-Za-z]:/, ""))) return undefined;
  let h = href;
  try {
    h = decodeURI(href);
  } catch {
    /* кривой %XX — берём как есть */
  }
  return parseFileRef(/[\\/]/.test(h) ? h : `./${h}`);
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const openRef = useContext(FileRefCtx);
  const components = useMemo<Components>(() => ({
    pre: ({ node: _, children, ...props }) => {
      if (isValidElement<{ className?: unknown; children?: unknown }>(children)) {
        const page = artifactSource(children.props.className, children.props.children);
        if (page !== undefined) return <ArtifactCard source={page} />;
        const diagram = mermaidSource(children.props.className, children.props.children);
        if (diagram !== undefined) return <MermaidDiagram source={diagram} />;
      }
      return <pre {...props}>{children}</pre>;
    },
    a: ({ node: _, href, ...props }) => {
      const ref = openRef && linkRef(href);
      if (ref) return <a {...props} href="#" className="fileref" title={ref.path} onClick={(e) => (e.preventDefault(), openRef(ref))} />;
      return <a {...props} href={href} target="_blank" rel="noreferrer" />;
    },
    code: ({ node, className, children, ...props }) => {
      // `код` в строке: у блока ``` позиция занимает несколько строк, у инлайна — одну
      const inline = !className && node?.position?.start.line === node?.position?.end.line;
      const ref = inline && openRef && typeof children === "string" ? parseFileRef(children) : undefined;
      if (ref) return <code {...props} className="fileref" role="link" title={t("Открыть файл", "Open the file")} onClick={() => openRef!(ref)}>{children}</code>;
      return <code {...props} className={className}>{children}</code>;
    },
  }), [openRef]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

const fmtMs = (ms: number) => (ms < 1000 ? `${ms} ${t("мс", "ms")}` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} ${t("с", "s")}`);

/** Автопроверка хаба: команды проекта после хода агента. Упавшая раскрыта сразу. */
function CheckCard({ part }: { part: Extract<Part, { type: "check" }> }) {
  const failed = part.results.find((r) => r.code !== 0);
  const [open, setOpen] = useState<boolean>();
  const shown = open ?? part.status === "failed";
  const total = part.results.reduce((a, r) => a + r.ms, 0);
  const icon = part.status === "running" ? <span className="spinner" /> : part.status === "passed" ? "✓" : part.status === "failed" ? "✗" : "■";
  const title =
    part.status === "running"
      ? t("Проверка идёт…", "Checking…")
      : part.status === "passed"
        ? `${t("Проверки прошли", "Checks passed")} · ${fmtMs(total)}`
        : part.status === "failed" && failed
          ? `${t("Упало", "Failed")}: ${failed.command}${failed.timedOut ? ` (${t("не уложилась во время", "timed out")})` : ` (${t("код", "code")} ${failed.code ?? "?"})`}`
          : t("Проверка остановлена", "Check stopped");
  return (
    <div className={`tool check tool--${part.status === "passed" ? "completed" : part.status === "failed" ? "error" : "running"}`}>
      <button className="tool__head" onClick={() => setOpen(!shown)}>
        <span className="tool__status">{icon}</span>
        <span className="tool__name">{t("автопроверка", "auto-check")}</span>
        <span className="tool__title">{title}</span>
      </button>
      {part.note && <div className="check__note">{part.note}</div>}
      {shown && (
        <div className="tool__body">
          {part.results.map((r, i) => (
            <div key={i}>
              <div className="mono">
                {r.code === 0 ? "✓" : "✗"} {r.command} <span className="muted">· {fmtMs(r.ms)}</span>
              </div>
              {r.code !== 0 && r.output && <pre className="pre pre--err">{r.output}</pre>}
            </div>
          ))}
          {part.status === "running" && <div className="muted">{t("идёт следующая команда…", "running the next command…")}</div>}
        </div>
      )}
    </div>
  );
}

export function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "reasoning":
      return part.text ? <Reasoning text={part.text} /> : null;
    case "tool":
      return <ToolCard part={part} />;
    case "file":
      return <FileChip fileId={part.fileId} name={part.name} mime={part.mime} size={part.size} />;
    case "check":
      return <CheckCard part={part} />;
    case "compaction":
      return <CompactionMark part={part} />;
  }
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** Отметка в ленте: здесь контекст агента сжат, выше — то, что он помнит только пересказом. */
export function CompactionMark({ part }: { part: Extract<Part, { type: "compaction" }> }) {
  return (
    <div className="compaction">
      <span>
        {part.trigger === "auto" ? t("Контекст сжат автоматически", "Context compacted automatically") : t("Контекст сжат", "Context compacted")}
        {part.preTokens && part.postTokens ? ` · ${kTokens(part.preTokens)} → ${kTokens(part.postTokens)} ${t("токенов", "tokens")}` : ""}
      </span>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="reasoning">
      <button className="linkish" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {t("размышления", "thinking")}
      </button>
      {open && <div className="reasoning__text">{text}</div>}
    </div>
  );
}

const STATUS_ICON = { pending: "…", running: "", completed: "✓", error: "✗" } as const;

function ToolCard({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const input = (part.input ?? {}) as Record<string, unknown>;
  return (
    <div className={`tool tool--${part.status}`}>
      <button className="tool__head" onClick={() => setOpen(!open)}>
        <span className="tool__status">{part.status === "running" ? <span className="spinner" /> : STATUS_ICON[part.status]}</span>
        <span className="tool__name">{part.tool}</span>
        <span className="tool__title">{part.title ?? ""}</span>
      </button>
      {open && (
        <div className="tool__body">
          <ToolInput tool={part.tool} input={input} />
          {part.output && <pre className="pre pre--out">{part.output}</pre>}
          {part.error && <pre className="pre pre--err">{part.error}</pre>}
        </div>
      )}
    </div>
  );
}

/** Для правок показываем дифф, для остального — JSON входа. */
export function ToolInput({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const oldS = (input.old_string ?? input.oldString) as string | undefined;
  const newS = (input.new_string ?? input.newString) as string | undefined;
  if (typeof oldS === "string" && typeof newS === "string") {
    return (
      <div className="diff">
        <div className="diff__file">{String(input.file_path ?? input.filePath ?? "")}</div>
        {oldS.split("\n").map((l, i) => (
          <div key={`o${i}`} className="diff__del">- {l}</div>
        ))}
        {newS.split("\n").map((l, i) => (
          <div key={`n${i}`} className="diff__add">+ {l}</div>
        ))}
      </div>
    );
  }
  if (/^write$/i.test(tool) && typeof input.content === "string") {
    return (
      <div className="diff">
        <div className="diff__file">{String(input.file_path ?? input.filePath ?? "")}</div>
        <pre className="pre">{input.content.length > 4000 ? input.content.slice(0, 4000) + "\n…" : input.content}</pre>
      </div>
    );
  }
  if (typeof input.command === "string") return <pre className="pre pre--cmd">$ {input.command}</pre>;
  if (!Object.keys(input).length) return null;
  return <pre className="pre">{JSON.stringify(input, null, 2)}</pre>;
}

export function FileChip({ fileId, name, mime, size }: { fileId: string; name: string; mime: string; size: number }) {
  const url = client.fileUrl(fileId);
  const isImage = mime.startsWith("image/") && mime !== "image/heic";
  return (
    <div className="file">
      {isImage && (
        <a href={url} target="_blank" rel="noreferrer">
          <img className="file__img" src={url} alt={name} loading="lazy" />
        </a>
      )}
      <a className="file__chip" href={url} download={name}>
        <span className="file__icon">{isImage ? "🖼" : mime === "application/pdf" ? "📕" : "📄"}</span>
        <span className="file__name">{name}</span>
        <span className="muted">{fmtSize(size)}</span>
        <span className="file__dl">⬇</span>
      </a>
    </div>
  );
}

export function PermissionCard({ sessionId, req }: { sessionId: string; req: PermissionRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (reply: "once" | "always" | "reject") => {
    setBusy(true);
    setError(undefined);
    try {
      await client.reply(sessionId, req.id, reply);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const detail = (req.detail ?? {}) as Record<string, unknown>;
  return (
    <div className="perm">
      <div className="perm__head">
        <span className="perm__q">{t("Разрешить?", "Allow?")}</span> <span className="tool__name">{req.tool}</span>
      </div>
      <div className="perm__body">
        {typeof detail === "object" && detail ? <ToolInput tool={req.tool} input={detail} /> : null}
        {!Object.keys(detail).length && <code>{req.title}</code>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="perm__actions">
        <button className="btn btn--primary" disabled={busy} onClick={() => answer("once")}>
          {t("Разрешить", "Allow")}
        </button>
        {req.canAlways && (
          <button className="btn" disabled={busy} onClick={() => answer("always")}>
            {t("Всегда", "Always")}
          </button>
        )}
        <button className="btn btn--danger" disabled={busy} onClick={() => answer("reject")}>
          {t("Отклонить", "Deny")}
        </button>
      </div>
    </div>
  );
}

/** Вопрос агента: варианты (один или несколько) и свой ответ, если разрешён. */
export function QuestionCard({ sessionId, req }: { sessionId: string; req: QuestionRequest }) {
  const [picked, setPicked] = useState<string[][]>(() => req.questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => req.questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const answers = req.questions.map((_, i) => [...picked[i]!, ...(custom[i]!.trim() ? [custom[i]!.trim()] : [])]);
  const ready = answers.every((a) => a.length > 0);

  const toggle = (qi: number, label: string, multiple?: boolean) =>
    setPicked((p) => p.map((sel, i) => (i !== qi ? sel : multiple ? (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]) : [label])));

  const send = async (a: QuestionAnswers) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.answer(sessionId, req.id, a);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="perm question">
      {req.questions.map((q, qi) => (
        <div key={qi} className="question__item">
          <div className="perm__head">
            {q.header && <span className="chip">{q.header}</span>} <span className="question__text">{q.question}</span>
            {q.multiple && <span className="muted"> · {t("можно несколько", "multiple allowed")}</span>}
          </div>
          <div className="question__options">
            {q.options.map((o) => (
              <button
                key={o.label}
                className={`pick ${picked[qi]!.includes(o.label) ? "pick--on" : ""}`}
                disabled={busy}
                onClick={() => toggle(qi, o.label, q.multiple)}
              >
                <b>{o.label}</b>
                {o.description && <span className="muted">{o.description}</span>}
              </button>
            ))}
          </div>
          {q.custom && (
            <input
              className="input"
              placeholder={t("Свой ответ…", "Your own answer…")}
              value={custom[qi]}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                setCustom((c) => c.map((x, i) => (i === qi ? v : x)));
                // свой текст в одиночном выборе заменяет вариант
                if (v.trim() && !q.multiple) setPicked((p) => p.map((sel, i) => (i === qi ? [] : sel)));
              }}
            />
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <div className="perm__actions">
        <button className="btn btn--primary" disabled={!ready || busy} onClick={() => void send(answers)}>
          {t("Ответить", "Answer")}
        </button>
        <button className="btn" disabled={busy} onClick={() => void send(null)}>
          {t("Не отвечать", "Skip")}
        </button>
      </div>
    </div>
  );
}

/** Лимиты подписки Claude: окна 5 часов и неделя в процентах (по последнему ответу Claude). */
export function Limits({ limits, compact }: { limits?: ClaudeLimits; compact?: boolean }) {
  const v = limitView(limits);
  if (!v) return null;
  const title = [
    v.fiveHourReset && `${t("5 часов: сброс в", "5 hours: resets at")} ${v.fiveHourReset}`,
    v.sevenDayReset && `${t("неделя: сброс", "week: resets")} ${v.sevenDayReset}`,
    `${t("данные из последнего ответа Claude", "from Claude's last reply")}, ${v.ageMin ? `${v.ageMin} ${t("мин назад", "min ago")}` : t("только что", "just now")}`,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className={`limits limits--${v.level}`} title={title}>
      {compact ? "" : "Claude: "}{t("5ч", "5h")} {v.fiveHour ?? "—"}% · {t("неделя", "week")} {v.sevenDay ?? "—"}%
    </span>
  );
}
