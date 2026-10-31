// Диктовка «нажал — говоришь — нажал ещё раз»: держать кнопку не нужно (за рулём, с занятыми руками).
// Системное распознавание Android, промежуточный текст виден сразу и дописывается к набранному.
import { useEffect, useRef, useState } from "react";
import { ToastAndroid } from "react-native";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { t, locale } from "@kamharn/client";

/** забыли выключить — микрофон гаснет сам */
const MAX_MS = 2 * 60_000;

/** есть ли на телефоне служба распознавания (на части эмуляторов и прошивок нет) */
export function voiceAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/** Диктовка в поле: setText получает полный текст поля (набранное + надиктованное). onDone — запись выключили и распознавание закончилось (режим «Разговор» отправляет сразу). */
export function useDictation(text: string, setText: (t: string) => void, onDone?: (text: string) => void) {
  // включено с нажатия до нажатия: между перезапусками распознавателя кнопка не мигает
  const [on, setOn] = useState(false);
  const base = useRef("");
  const last = useRef("");
  /** запись включена: распознаватель Android сам останавливается на паузе — тогда запускаем снова */
  const active = useRef(false);
  /** выключили, ждём конца распознавания — тогда onDone */
  const released = useRef(false);
  const startText = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const done = useRef(onDone);
  done.current = onDone;

  const begin = () => ExpoSpeechRecognitionModule.start({ lang: locale(), interimResults: true, addsPunctuation: true, continuous: false });
  const off = () => {
    active.current = false;
    if (timer.current) clearTimeout(timer.current);
    setOn(false);
  };
  // ушли с экрана — микрофон не оставляем
  useEffect(() => () => {
    if (active.current) ExpoSpeechRecognitionModule.abort();
    off();
  }, []);

  useSpeechRecognitionEvent("end", () => {
    if (active.current) {
      base.current = last.current;
      begin();
      return;
    }
    if (released.current) {
      released.current = false;
      // что-то надиктовали (а не только то, что было набрано до кнопки)
      if (last.current.trim() && last.current !== startText.current) done.current?.(last.current.trim());
    }
  });
  useSpeechRecognitionEvent("result", (e) => {
    const said = e.results[0]?.transcript?.trim() ?? "";
    const glued = base.current && said ? `${base.current.replace(/\s*$/, "")} ${said}` : base.current || said;
    last.current = glued;
    setText(glued);
    if (e.isFinal) base.current = glued;
  });
  useSpeechRecognitionEvent("error", (e) => {
    // тишина и ручная остановка — не ошибка для пользователя
    if (e.error === "no-speech" || e.error === "aborted") return;
    off();
    released.current = false;
    ToastAndroid.show(`${t("Распознавание", "Speech recognition")}: ${e.message || e.error}`, ToastAndroid.LONG);
  });

  async function start() {
    if (active.current) return;
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!p.granted) return ToastAndroid.show(t("Нет доступа к микрофону", "No microphone access"), ToastAndroid.LONG);
    active.current = true;
    released.current = false;
    setOn(true);
    base.current = text;
    startText.current = text;
    last.current = text;
    begin();
    timer.current = setTimeout(() => {
      ToastAndroid.show(t("Микрофон выключен: 2 минуты", "Microphone off: 2 minutes"), ToastAndroid.SHORT);
      stop();
    }, MAX_MS);
  }

  function stop() {
    if (!active.current) return;
    off();
    released.current = true;
    ExpoSpeechRecognitionModule.stop();
  }

  return { listening: on, start, stop, toggle: () => (active.current ? stop() : void start()) };
}
