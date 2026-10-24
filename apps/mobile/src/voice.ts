// Диктовка «зажал — говоришь — отпустил» (как в Telegram): системное распознавание Android (ru-RU),
// промежуточный текст виден сразу и дописывается к набранному.
import { useRef, useState } from "react";
import { ToastAndroid } from "react-native";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { t, locale } from "@kamharn/client";

/** есть ли на телефоне служба распознавания (на части эмуляторов и прошивок нет) */
export function voiceAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/** Диктовка в поле: setText получает полный текст поля (набранное + надиктованное). */
export function useDictation(text: string, setText: (t: string) => void) {
  const [listening, setListening] = useState(false);
  const base = useRef("");
  const last = useRef("");
  /** палец на кнопке: распознаватель Android сам останавливается на паузе — тогда запускаем снова */
  const holding = useRef(false);

  const begin = () => ExpoSpeechRecognitionModule.start({ lang: locale(), interimResults: true, addsPunctuation: true, continuous: false });

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("end", () => {
    if (holding.current) {
      base.current = last.current;
      begin();
      return;
    }
    setListening(false);
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
    holding.current = false;
    setListening(false);
    ToastAndroid.show(`${t("Распознавание", "Speech recognition")}: ${e.message || e.error}`, ToastAndroid.LONG);
  });

  /** нажали и держат */
  async function hold() {
    holding.current = true;
    const p = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!p.granted) {
      holding.current = false;
      return ToastAndroid.show(t("Нет доступа к микрофону", "No microphone access"), ToastAndroid.LONG);
    }
    // пока висел запрос разрешения, палец могли отпустить — не начинаем запись «в пустоту»
    if (!holding.current) return ToastAndroid.show(t("Готово — теперь удерживай кнопку и говори", "Done — now hold the button and speak"), ToastAndroid.SHORT);
    base.current = text;
    last.current = text;
    begin();
  }

  /** отпустили */
  function release() {
    if (!holding.current) return;
    holding.current = false;
    ExpoSpeechRecognitionModule.stop();
  }

  return { listening, hold, release };
}
