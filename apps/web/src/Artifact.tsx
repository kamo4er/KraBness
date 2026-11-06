// Живой артефакт: блок ```html из ответа агента — работающая страница в карточке чата и на весь экран.
// Песочница: iframe с sandbox="allow-scripts" без allow-same-origin — у страницы «нулевое» происхождение, ей не видны
// ни токен, ни localStorage, ни API хаба, ни окно чата. Сеть (CDN) доступна.
// Сама запускается только целая страница (isRunnablePage); кусок вёрстки — код с кнопкой «Запустить».
// Ошибки страницы перехватывает скрипт из artifactDocument и шлёт сюда postMessage — только текст.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { artifactDocument, artifactError, artifactFixPrompt, isRunnablePage, t } from "@kamharn/client";

/** пока агент дописывает ответ, блок растёт — запускаем, когда он не менялся столько */
const SETTLE_MS = 1200;
const SANDBOX = "allow-scripts allow-pointer-lock";

/** Отправить текст агенту этой сессии (кнопка «Отправить агенту» у ошибки страницы); нет — кнопки нет. */
export const ArtifactSendCtx = createContext<((text: string) => void) | undefined>(undefined);

function Frame({ source, nonce, className, onError }: { source: string; nonce: number; className: string; onError?: (message: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (!onError) return;
    // слушаем только свой iframe: в чате бывает несколько страниц
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const m = artifactError(e.data);
      if (m) onError(m);
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [onError]);
  return (
    <iframe
      ref={ref}
      key={nonce}
      className={className}
      title={t("Живой результат", "Live result")}
      sandbox={SANDBOX}
      allow="fullscreen"
      referrerPolicy="no-referrer"
      srcDoc={artifactDocument(source)}
      data-artifact-frame
    />
  );
}

function Tools({ source, onRestart, onCode, code, onFull }: { source: string; onRestart: () => void; onCode: () => void; code: boolean; onFull?: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => void navigator.clipboard?.writeText(source).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <span className="artifact__tools">
      {onFull && (
        <button className="btn btn--small" title={t("На весь экран", "Full screen")} onClick={onFull}>
          ⤢
        </button>
      )}
      <button className="btn btn--small" title={t("Перезапустить", "Restart")} onClick={onRestart}>
        ↻
      </button>
      <button className={`btn btn--small ${code ? "btn--primary" : ""}`} title={t("Показать код", "Show code")} onClick={onCode}>
        {"</>"}
      </button>
      <button className="btn btn--small" title={t("Скопировать код", "Copy the code")} onClick={copy}>
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

/** Плашка ошибки страницы: текст и «Отправить агенту» (если карточка в чате). */
function ErrorBar({ error }: { error: string }) {
  const send = useContext(ArtifactSendCtx);
  const [sent, setSent] = useState(false);
  return (
    <div className="artifact__error" data-artifact-error>
      <span className="artifact__errtext">
        ⚠ {t("Ошибка на странице", "Page error")}: {error}
      </span>
      {send && (
        <button className="btn btn--small" disabled={sent} onClick={() => (send(artifactFixPrompt(error)), setSent(true))}>
          {sent ? t("Отправлено", "Sent") : t("Отправить агенту", "Send to the agent")}
        </button>
      )}
    </div>
  );
}

/** Первая ошибка страницы; сбрасывается при перезапуске. */
function useFirstError(): [string | undefined, (m: string) => void, () => void] {
  const [error, setError] = useState<string>();
  // стабильные: Frame переподписывается на message при смене onError
  const add = useCallback((m: string) => setError((cur) => cur ?? m), []);
  const clear = useCallback(() => setError(undefined), []);
  return [error, add, clear];
}

/** Страница на весь экран (и для .html-файлов из просмотра проекта). Esc — закрыть. */
export function ArtifactFull({ source, title, onClose }: { source: string; title?: string; onClose: () => void }) {
  const [nonce, setNonce] = useState(0);
  const [code, setCode] = useState(false);
  const [error, onError, clearError] = useFirstError();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  // в body: родитель с transform или overflow обрезал бы fixed-слой
  return createPortal(
    <div className="artifact-full" data-artifact-full>
      <div className="artifact__bar">
        <button className="btn btn--small" title={t("Закрыть (Esc)", "Close (Esc)")} onClick={onClose}>
          ✕
        </button>
        <span className="muted artifact__title">{title ?? t("Живой результат", "Live result")}</span>
        <Tools source={source} code={code} onCode={() => setCode(!code)} onRestart={() => (clearError(), setNonce(nonce + 1))} />
      </div>
      {error && !code && <ErrorBar error={error} />}
      {code ? <pre className="pre artifact__code artifact__code--full">{source}</pre> : <Frame source={source} nonce={nonce} className="artifact__frame--full" onError={onError} />}
    </div>,
    document.body,
  );
}

/** Карточка в ответе агента. autoRun — запускать даже кусок вёрстки (присланный .html-файл). */
export function ArtifactCard({ source, title, autoRun }: { source: string; title?: string; autoRun?: boolean }) {
  const [ready, setReady] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const [code, setCode] = useState(false);
  const [full, setFull] = useState(false);
  const [forced, setForced] = useState(false);
  const [error, onError, clearError] = useFirstError();
  useEffect(() => {
    const timer = setTimeout(() => setReady(source), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [source]);
  // запускаем только устоявшийся исходник: недописанная страница не мигает ошибками и не дёргает CDN на каждую дельту
  const live = ready === source;
  const run = autoRun || forced || isRunnablePage(source);
  if (!run) {
    return (
      <div className="artifact" data-artifact data-artifact-code>
        <div className="artifact__bar">
          <span className="muted artifact__title">HTML</span>
          <button className="btn btn--small" title={t("Запустить как страницу", "Run as a page")} onClick={() => setForced(true)} data-artifact-run>
            ▶ {t("Запустить", "Run")}
          </button>
          <button className="btn btn--small" title={t("Скопировать код", "Copy the code")} onClick={() => void navigator.clipboard?.writeText(source)}>
            ⧉
          </button>
        </div>
        <pre className="pre artifact__code">{source}</pre>
      </div>
    );
  }
  return (
    <div className="artifact" data-artifact>
      <div className="artifact__bar">
        <span className="muted artifact__title">✨ {title ?? t("Живой результат", "Live result")}</span>
        <Tools source={source} code={code} onCode={() => setCode(!code)} onRestart={() => (clearError(), setNonce(nonce + 1))} onFull={() => setFull(true)} />
      </div>
      {error && !code && <ErrorBar error={error} />}
      {code ? (
        <pre className="pre artifact__code">{source}</pre>
      ) : live ? (
        <Frame source={source} nonce={nonce} className="artifact__frame" onError={onError} />
      ) : (
        <div className="artifact__wait muted">{t("Собираю…", "Assembling…")}</div>
      )}
      {full && <ArtifactFull source={source} title={title} onClose={() => setFull(false)} />}
    </div>
  );
}

/** до стольких байт присланная страница подгружается сама; больше — по кнопке (историю чата не тянем мегабайтами) */
const AUTO_LOAD = 3 * 1024 * 1024;

/** .html-файл, присланный в чат (send_file_to_user), — такая же живая карточка. */
export function FileArtifact({ url, name, size }: { url: string; name: string; size: number }) {
  const [want, setWant] = useState(size <= AUTO_LOAD);
  const [source, setSource] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!want || source !== undefined) return;
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
      .then((text) => alive && setSource(text), (e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [want, url]);
  if (source !== undefined) return <ArtifactCard source={source} title={name} autoRun />;
  return (
    <div className="artifact" data-artifact>
      <div className="artifact__bar">
        <span className="muted artifact__title">✨ {name}</span>
      </div>
      <div className="artifact__wait muted">
        {error ? (
          `${t("Не загрузилось", "Failed to load")}: ${error}`
        ) : want ? (
          t("Загружаю…", "Loading…")
        ) : (
          <button className="btn btn--primary" onClick={() => setWant(true)}>
            ▶ {t("Показать живой страницей", "Show as a live page")}
          </button>
        )}
      </div>
    </div>
  );
}
