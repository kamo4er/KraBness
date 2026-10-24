// Мини-терминал в папке сессии (вкладка «Терминал» на экране проекта): команда без агента и без расхода лимита.
import { useEffect, useRef, useState } from "react";
import { client } from "./hub.ts";
import { t } from "@kamharn/client";

export function Terminal({ sessionId }: { sessionId: string }) {
  const [history, setHistory] = useState<string[]>([]);
  const [cmd, setCmd] = useState("");
  const [runId, setRunId] = useState<string>();
  const [running, setRunning] = useState<string>();
  const [output, setOutput] = useState("");
  const [exit, setExit] = useState<number | null>();
  const [error, setError] = useState<string>();
  const pre = useRef<HTMLPreElement>(null);

  const refresh = () => client.termInfo(sessionId).then((i) => setHistory(i.history), () => {});
  // при открытии: подцепиться к команде, которая ещё идёт
  useEffect(() => {
    void client.termInfo(sessionId).then((i) => {
      setHistory(i.history);
      if (i.running) (setRunning(i.running.command), setRunId(i.running.runId));
    }, () => {});
  }, [sessionId]);

  // забираем вывод кусками, пока команда не закончится; обрыв связи — просто пробуем ещё
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let from = 0;
    setOutput("");
    setExit(undefined);
    void (async () => {
      while (alive) {
        try {
          const r = await client.termRead(runId, from);
          if (!alive) return;
          from = r.next;
          if (r.data) setOutput((o) => o + r.data);
          if (r.done) {
            setExit(r.exitCode ?? null);
            setRunning(undefined);
            void refresh();
            return;
          }
          await new Promise((res) => setTimeout(res, 600));
        } catch {
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [runId]);

  useEffect(() => {
    const el = pre.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const run = async (command: string) => {
    if (!command.trim() || running) return;
    setError(undefined);
    try {
      const r = await client.termRun(sessionId, command);
      setRunning(command.trim());
      setRunId(r.runId);
      setCmd("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="term">
      <form
        className="term__input"
        onSubmit={(e) => {
          e.preventDefault();
          void run(cmd);
        }}
      >
        <span className="term__prompt">&gt;</span>
        <input className="input term__cmd" value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="git status, npm test…" disabled={!!running} autoFocus />
        {running ? (
          <button type="button" className="btn btn--danger" onClick={() => runId && void client.termStop(runId)}>
            {t("Стоп", "Stop")}
          </button>
        ) : (
          <button className="btn btn--primary" disabled={!cmd.trim()}>
            {t("Выполнить", "Run")}
          </button>
        )}
      </form>
      {history.length > 0 && (
        <div className="term__history">
          {history.slice(0, 8).map((h) => (
            <button key={h} className="chip" disabled={!!running} onClick={() => void run(h)} title={t("Выполнить ещё раз", "Run again")}>
              {h}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {(runId || output) && (
        <>
          <div className="muted term__status">
            {running ? (
              <>
                <span className="spinner" /> {running}
              </>
            ) : exit === undefined ? null : exit === 0 ? (
              t("✓ готово (код 0)", "✓ done (exit 0)")
            ) : (
              `✗ ${t("код", "exit")} ${exit ?? "—"}`
            )}
          </div>
          <pre className="term__out" ref={pre}>
            {output || " "}
          </pre>
        </>
      )}
      <p className="muted">{t("Команда выполняется в папке сессии через cmd.exe. Интерактивный ввод не поддерживается.", "The command runs in the session folder via cmd.exe. Interactive input isn't supported.")}</p>
    </div>
  );
}
