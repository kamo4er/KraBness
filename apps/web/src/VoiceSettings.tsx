// Голос на ПК: «Крабик, …» → Диспетчер → ответ вслух в колонки (voice/main.py, хаб держит процесс).
import { useEffect, useState } from "react";
import { t, type VoiceStatus } from "@kamharn/client";
import { client } from "./hub.ts";

const STATE = (): Record<VoiceStatus["state"], string> => ({
  off: t("выключен", "off"),
  starting: t("запускается…", "starting…"),
  loading: t("загружает модели (первый раз — несколько минут)…", "loading models (first time — a few minutes)…"),
  listening: t("ждёт «Крабик»", "waiting for “Krabik”"),
  recording: t("слушает команду", "listening to the command"),
  thinking: t("Диспетчер думает", "the Dispatcher is thinking"),
  speaking: t("отвечает", "answering"),
  restarting: t("перезапускается после сбоя…", "restarting after a failure…"),
});

export function VoiceSettings() {
  const [s, setS] = useState<VoiceStatus>();
  const [error, setError] = useState<string>();
  const [device, setDevice] = useState("");
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => client.voice().then((v) => alive && setS(v), (e: Error) => alive && setError(e.message));
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (s) setDevice(s.device);
  }, [s?.device]);
  const set = async (patch: { enabled?: boolean; device?: string }) => {
    setError(undefined);
    try {
      setS(await client.setVoice(patch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!s) return error ? <p className="error">{error}</p> : null;
  return (
    <section data-voice>
      <h3>{t("Голос на ПК", "Voice on the PC")}</h3>
      <p className="muted">
        {t(
          "Начни фразу с «Крабик»: «Крабик, открой блокнот» — команда уйдёт Диспетчеру, начало ответа прозвучит в колонках. Сказал только «Крабик» — дождись сигнала и говори. Распознавание — Whisper на видеокарте, всё локально: фразы без «Крабика» никуда не уходят и не записываются.",
          "Start the phrase with “Krabik”: “Krabik, open Notepad” — the command goes to the Dispatcher, the beginning of the answer is played through the speakers. Said just “Krabik” — wait for the beep and speak. Recognition is Whisper on the GPU, all local: phrases without “Krabik” go nowhere and aren't recorded.",
        )}
      </p>
      {s.unavailable ? <p className="muted">{s.unavailable}</p> : null}
      <label className="row" style={{ alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={s.enabled} disabled={!!s.unavailable && !s.enabled} onChange={(e) => void set({ enabled: e.target.checked })} />
        <span>{t("Слушать микрофон ПК", "Listen to the PC microphone")}</span>
        {s.enabled ? <span className="muted">· {STATE()[s.state]}</span> : null}
      </label>
      <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
        <input className="input" style={{ maxWidth: 260 }} placeholder={t("микрофон: системный", "microphone: system default")} value={device} onChange={(e) => setDevice(e.target.value)} />
        <button className="btn btn--small" disabled={device === s.device} onClick={() => void set({ device })}>
          {t("Сохранить", "Save")}
        </button>
        <span className="muted">{t("номер или часть имени, например «ME6S»", "number or part of the name, e.g. “ME6S”")}</span>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {s.log.length ? (
        <p>
          <button className="btn btn--small" onClick={() => setShowLog(!showLog)}>
            {showLog ? t("Скрыть журнал", "Hide log") : t("Журнал", "Log")}
          </button>
        </p>
      ) : null}
      {showLog ? <pre className="pre">{s.log.join("\n")}</pre> : null}
    </section>
  );
}
