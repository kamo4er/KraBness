import { useState } from "react";
import { getLang, t, type UpdateStatus } from "@kamharn/client";
import { client, fmtTime, go, recall, remember, useHub } from "./hub.ts";

const notesOf = (u: UpdateStatus) => (u.latest ? (getLang() === "ru" ? u.latest.notes.ru : u.latest.notes.en) : "");

/** почему не ставится по кнопке */
const reasonText = (u: UpdateStatus) =>
  u.reason === "git"
    ? t("Хаб запущен из папки git: обновляй через git pull.", "The hub runs from a git folder: update with git pull.")
    : t("Хаб запущен вручную: обновление ставится, когда он работает под сторожем (scripts\\hub-service.ps1).", "The hub was started manually: updates install when it runs under the supervisor (scripts\\hub-service.ps1).");

const stateText = (u: UpdateStatus) =>
  u.state === "downloading"
    ? t("Скачиваю обновление…", "Downloading the update…")
    : u.state === "restarting"
      ? t("Устанавливаю. Хаб вернётся через пару минут, страница переподключится сама.", "Installing. The hub will be back in a couple of minutes, the page reconnects by itself.")
      : undefined;

async function install(setError: (e?: string) => void) {
  setError(undefined);
  try {
    await client.installUpdate();
  } catch (e) {
    setError((e as Error).message);
  }
}

/** Плашка в списке сессий: вышла новая версия. Закрыть — до следующей версии. */
export function UpdateBanner() {
  const { update } = useHub();
  const [dismissed, setDismissed] = useState(() => recall<string>("update.dismissed"));
  const [error, setError] = useState<string>();
  if (!update?.available || !update.latest) return null;
  const busy = stateText(update);
  if (!busy && dismissed === update.latest.version) return null;
  const first = notesOf(update).split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
  return (
    <div className="update">
      <div className="update__head">
        <b>{t(`Вышла версия ${update.latest.version}`, `Version ${update.latest.version} is out`)}</b>
        {!busy && (
          <button className="btn btn--icon btn--small" title={t("Скрыть до следующей версии", "Hide until the next version")} onClick={() => (remember("update.dismissed", update.latest!.version), setDismissed(update.latest!.version))}>
            ×
          </button>
        )}
      </div>
      {busy ? <p className="muted">{busy}</p> : first && <p className="update__notes">{first}</p>}
      {!busy && (
        <div className="row">
          {update.canInstall && (
            <button className="btn btn--primary btn--small" onClick={() => void install(setError)}>
              {t("Обновить", "Update")}
            </button>
          )}
          <button className="btn btn--small" onClick={() => go({ page: "settings" })}>
            {t("Подробнее", "Details")}
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** Раздел «Обновления» в настройках. */
export function UpdateSettings() {
  const { update } = useHub();
  const [error, setError] = useState<string>();
  if (!update) return null;
  const busy = stateText(update);
  const check = async () => {
    setError(undefined);
    try {
      await client.checkUpdate();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section>
      <h3>{t("Обновления", "Updates")}</h3>
      <p className="muted">
        {t("Версия", "Version")} {update.current}
        {update.checkedAt ? ` · ${t("проверено", "checked")} ${fmtTime(update.checkedAt)}` : ""}
      </p>
      {update.error && <p className="error">{update.error}</p>}
      {update.last && Date.now() - update.last.at < 7 * 86_400_000 && (
        <p className={update.last.ok ? "muted" : "error"}>
          {update.last.ok
            ? t(`Установлена ${update.last.version} (${fmtTime(update.last.at)}).`, `Installed ${update.last.version} (${fmtTime(update.last.at)}).`)
            : t(`Не встала ${update.last.version}: ${update.last.error ?? ""}. Вернул ${update.last.rolledBack ?? "прежнюю"}.`, `${update.last.version} didn't install: ${update.last.error ?? ""}. Restored ${update.last.rolledBack ?? "the previous one"}.`)}
        </p>
      )}
      {update.available && update.latest ? (
        <>
          <p>
            <b>{t(`Вышла версия ${update.latest.version}`, `Version ${update.latest.version} is out`)}</b> ·{" "}
            <a href={update.latest.url} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </p>
          {notesOf(update) && <p className="update__notes">{notesOf(update)}</p>}
          {busy ? (
            <p className="muted">{busy}</p>
          ) : update.canInstall ? (
            <button className="btn btn--primary" onClick={() => void install(setError)}>
              {t("Обновить", "Update")}
            </button>
          ) : (
            <p className="muted">{reasonText(update)}</p>
          )}
        </>
      ) : (
        !update.error && update.checkedAt && <p className="muted">{t("Стоит последняя версия.", "You have the latest version.")}</p>
      )}
      <div className="row">
        <button className="btn" disabled={update.state !== "idle"} onClick={() => void check()}>
          {update.state === "checking" ? t("Проверяю…", "Checking…") : t("Проверить сейчас", "Check now")}
        </button>
        <label className="check">
          <input type="checkbox" checked={update.auto} onChange={(e) => void client.setUpdateAuto(e.target.checked).catch((x: Error) => setError(x.message))} />
          {t("Проверять раз в сутки", "Check once a day")}
        </label>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
