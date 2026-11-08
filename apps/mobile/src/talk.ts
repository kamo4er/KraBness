// Режим «Разговор»: отпустил кнопку микрофона — сообщение ушло само; агент закончил ход — начало ответа звучит вслух.
// У Диспетчера включён по умолчанию (он и отвечает так: первая строка — итог), у остальных сессий — в меню ⋯.
import { useEffect, useState } from "react";
import { recall, remember } from "./store.ts";
export { talkPart } from "@kamharn/client";

const listeners = new Set<() => void>();

export function talkOn(sessionId: string, dispatcher: boolean): boolean {
  return recall<boolean>(`talk.${sessionId}`) ?? dispatcher;
}

export function setTalk(sessionId: string, on: boolean): void {
  remember(`talk.${sessionId}`, on);
  for (const l of listeners) l();
}

export function useTalk(sessionId: string, dispatcher: boolean): boolean {
  const [on, setOn] = useState(() => talkOn(sessionId, dispatcher));
  useEffect(() => {
    const l = () => setOn(talkOn(sessionId, dispatcher));
    listeners.add(l);
    l();
    return () => void listeners.delete(l);
  }, [sessionId, dispatcher]);
  return on;
}
