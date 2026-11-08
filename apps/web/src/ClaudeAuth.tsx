// Вход в Claude Code на ПК: статус, окно входа на ПК, свой API-ключ Anthropic (вместо подписки).
import { useEffect, useState } from "react";
import { t, type ClaudeAuthInfo } from "@kamharn/client";
import { client } from "./hub.ts";

type Auth = ClaudeAuthInfo & { error?: string };

export function authText(a: Auth): string {
  if (!a.installed) return a.error ?? t("Claude Code не установлен", "Claude Code isn't installed");
  if (!a.loggedIn) return t("Вход не выполнен", "Not signed in");
  const who = a.email ? ` (${a.email})` : "";
  if (a.method === "apiKey") return t("Работает по API-ключу из KraBness, оплата по расходу", "Runs on the API key saved in KraBness, pay as you go");
  if (a.method === "subscription") return t(`Вход выполнен: подписка ${a.subscription ?? "Claude"}${who}`, `Signed in: ${a.subscription ?? "Claude"} subscription${who}`);
  return t(`Вход выполнен${who}`, `Signed in${who}`);
}

export function ClaudeAuthBox({ initial }: { initial?: Auth }) {
  const [a, setA] = useState<Auth | undefined>(initial);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();

  // после «Войти» статус обновляется сам, пока человек входит в браузере (до 5 минут)
  useEffect(() => {
    if (!waiting) return;
    const until = Date.now() + 5 * 60_000;
    const timer = setInterval(() => {
      void client.claudeAuth().then((s) => {
        setA(s);
        if (s.loggedIn || Date.now() > until) setWaiting(false);
      }, () => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [waiting]);

  const run = async (f: () => Promise<Auth | unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await f();
      if (r && typeof r === "object" && "installed" in r) setA(r as Auth);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!a) return null;
  return (
    <div className="claudeauth">
      <p className={a.loggedIn ? "" : "warn"}>{authText(a)}</p>
      {a.installed && (
        <div className="row">
          {a.method !== "apiKey" && (
            <button
              className={`btn btn--small ${a.loggedIn ? "" : "btn--primary"}`}
              disabled={busy}
              onClick={() => void run(async () => (await client.claudeLogin(), setWaiting(true)))}
            >
              {a.loggedIn ? t("Войти другим аккаунтом", "Sign in with another account") : t("Войти на ПК", "Sign in on the PC")}
            </button>
          )}
          <button className="btn btn--small" disabled={busy} onClick={() => void run(() => client.claudeAuth())}>
            {t("Проверить", "Check")}
          </button>
        </div>
      )}
      {waiting && (
        <p className="muted">
          {t(
            "На ПК открылось окно входа. Выбери вход по подписке Claude или через Anthropic Console и подтверди в браузере. Статус обновится сам.",
            "A sign-in window opened on the PC. Choose your Claude subscription or Anthropic Console and confirm in the browser. The status updates by itself.",
          )}
        </p>
      )}
      {a.installed && (
        <details className="claudeauth__key" open={a.apiKey}>
          <summary className="muted">{t("Свой API-ключ Anthropic (без подписки)", "Your own Anthropic API key (no subscription)")}</summary>
          <p className="muted">
            {t(
              "Оплата по расходу в Anthropic Console. Пока ключ сохранён, Claude Code работает по нему, а не по подписке. Ключ хранится только на этом ПК.",
              "Pay as you go in the Anthropic Console. While the key is saved, Claude Code uses it instead of the subscription. The key stays on this PC.",
            )}
          </p>
          {a.apiKey ? (
            <div className="row">
              <span>{t("Ключ сохранён", "Key saved")}</span>
              <button className="btn btn--small" disabled={busy} onClick={() => void run(() => client.removeClaudeKey())}>
                {t("Убрать", "Remove")}
              </button>
            </div>
          ) : (
            <div className="row">
              <input className="input mono" type="password" autoComplete="off" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
              <button className="btn btn--small" disabled={busy || !key.trim()} onClick={() => void run(async () => { const r = await client.setClaudeKey(key); setKey(""); return r; })}>
                {t("Проверить и сохранить", "Check and save")}
              </button>
            </div>
          )}
        </details>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
