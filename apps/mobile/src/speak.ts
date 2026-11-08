// Озвучка ответа агента (кнопка 🔊): системный синтез речи, русский голос. Одновременно читается один ответ.
import { useEffect, useState } from "react";
import * as Speech from "expo-speech";
import { speakableText, t, locale } from "@kamharn/client";
import { dialog } from "./dialog.tsx";

let current: string | undefined;
const listeners = new Set<() => void>();
const set = (id: string | undefined) => {
  current = id;
  for (const l of listeners) l();
};

/** Сейчас читается это сообщение. */
export function useSpeaking(id: string): boolean {
  const [on, setOn] = useState(current === id);
  useEffect(() => {
    const l = () => setOn(current === id);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [id]);
  return on;
}

/** Есть ли в тексте что читать вслух (без кода и путей). */
export const speakable = (md: string) => speakableText(md).length >= 20;

export function toggleSpeak(id: string, md: string): void {
  if (current === id) {
    void Speech.stop();
    return set(undefined);
  }
  sayMessage(id, md);
}

/** Прочитать сейчас (режим «Разговор»): то, что звучало, обрывается. */
export function sayMessage(id: string, md: string): void {
  void Speech.stop();
  set(id);
  Speech.speak(speakableText(md), {
    language: locale(),
    onDone: () => void (current === id && set(undefined)),
    onStopped: () => void (current === id && set(undefined)),
    onError: (e) => {
      if (current === id) set(undefined);
      dialog(t("Не получилось озвучить", "Couldn't read aloud"), `${e.message || t("На телефоне не найден синтез речи.", "No text-to-speech engine on the phone.")}\n\n${t("Проверь в настройках телефона: Специальные возможности → Синтез речи, русский язык.", "Check the phone settings: Accessibility → Text-to-speech, and the language.")}`);
    },
  });
}
