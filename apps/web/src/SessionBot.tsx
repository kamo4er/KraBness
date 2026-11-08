// Бот сессии в Telegram: панель из меню ⋯ шапки чата. Токен от @BotFather → бот привязан к сессии;
// люди подключаются ссылкой t.me/<бот>?start=<код> (код одноразовый), их можно отключить.
import { useEffect, useState } from "react";
import { t, type SessionBotInfo } from "@kamharn/client";
import { client } from "./hub.ts";

/** onInfo — шапке: подключён ли бот (для плашки «✈ Telegram»). */
export function SessionBotPanel({ sessionId, onInfo }: { sessionId: string; onInfo?: (info: SessionBotInfo) => void }) {
  const [info, setInfoState] = useState<SessionBotInfo>();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const setInfo = (i: SessionBotInfo) => (setInfoState(i), onInfo?.(i));
  useEffect(() => {
    void client.sessionBot(sessionId).then(setInfo, (e: Error) => setMsg(e.message));
  }, [sessionId]);
  const run = (f: () => Promise<SessionBotInfo>) => {
    setBusy(true);
    setMsg(undefined);
    void f()
      .then(setInfo, (e: Error) => setMsg(e.message))
      .finally(() => setBusy(false));
  };
  const link = info?.bot && info.code ? `https://t.me/${info.bot}?start=${info.code}` : undefined;
  return (
    <div className="slash preview__menu checks__menu">
      {!info ? (
        <p className="muted">{t("загрузка…", "loading…")}</p>
      ) : !info.configured ? (
        <>
          <b>{t("Бот в Telegram для этой сессии", "A Telegram bot for this session")}</b>
          <p className="muted">
            {t(
              "Пишешь боту — уходит агенту этой сессии, файлы ложатся в её папку, ответ и файлы от агента приходят в Telegram. В Telegram открой @BotFather → /newbot, придумай имя и вставь сюда токен.",
              "Write to the bot — it goes to this session's agent, files land in its folder, the answer and files from the agent come to Telegram. In Telegram open @BotFather → /newbot, pick a name and paste the token here.",
            )}
          </p>
          <input className="input mono" placeholder="123456789:AA…" value={token} onChange={(e) => setToken(e.target.value)} />
          <button className="btn btn--primary btn--small" disabled={busy || !token.trim()} onClick={() => run(() => client.setSessionBot(sessionId, token))}>
            {busy ? t("Проверяю…", "Checking…") : t("Подключить бота", "Connect the bot")}
          </button>
        </>
      ) : (
        <>
          <b>
            {t("Бот", "Bot")}: {info.bot ? `@${info.bot}` : "…"}
          </b>
          {info.error && <p className="error">{info.error}</p>}
          <p className="muted">{t("Кто подключён:", "Who is connected:")}</p>
          {info.chats.length ? (
            info.chats.map((c) => (
              <div key={c.id} className="row" style={{ justifyContent: "space-between" }}>
                <span style={{ flex: 1 }}>{c.name}</span>
                <button
                  className="linkish"
                  title={t("Переименовать", "Rename")}
                  onClick={() => {
                    const name = prompt(t("Как зовут? Этим именем подписываются сообщения агенту.", "What's the name? Messages to the agent are signed with it."), c.name);
                    if (name?.trim() && name.trim() !== c.name) run(() => client.renameSessionBotChat(sessionId, c.id, name));
                  }}
                >
                  ✎
                </button>
                <button
                  className="linkish"
                  title={t("Отключить", "Disconnect")}
                  onClick={() => confirm(t(`Отключить ${c.name} от бота?`, `Disconnect ${c.name} from the bot?`)) && run(() => client.unlinkSessionBotChat(sessionId, c.id))}
                >
                  ✕
                </button>
              </div>
            ))
          ) : (
            <p className="muted">{t("пока никого", "nobody yet")}</p>
          )}
          {info.chats.length > 0 && (
            <p className="muted">
              {t(
                "Агент видит, кто пишет (по имени). Ответ приходит только тому, кто спросил; написанное в KraBness в Telegram не уходит.",
                "The agent sees who is writing (by name). The answer goes only to whoever asked; what you write in KraBness doesn't go to Telegram.",
              )}
            </p>
          )}
          {link && (
            <p className="muted">
              {t("Подключить человека: открыть ссылку в Telegram и нажать «Start» (код одноразовый)", "Connect someone: open the link in Telegram and press “Start” (the code is single-use)")}
              <br />
              <a href={link} target="_blank" rel="noreferrer">
                {link}
              </a>
              <br />
              {t("или написать боту", "or write to the bot")} <code>/start {info.code}</code>
            </p>
          )}
          {!link && info.code && (
            <p className="muted">
              {t("Подключить человека: написать боту", "Connect someone: write to the bot")} <code>/start {info.code}</code> {t("(код одноразовый)", "(single-use code)")}
            </p>
          )}
          <div className="row">
            <button className="btn btn--small" disabled={busy} onClick={() => run(() => client.sessionBotCode(sessionId))}>
              {t("Новый код", "New code")}
            </button>
            <button
              className="btn btn--small btn--danger"
              disabled={busy}
              onClick={() => confirm(t("Отвязать бота от сессии? Подключённые люди отвалятся.", "Unlink the bot from the session? Connected people will be dropped.")) && run(() => client.removeSessionBot(sessionId))}
            >
              {t("Отвязать бота", "Unlink the bot")}
            </button>
          </div>
        </>
      )}
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}
