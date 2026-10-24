// Сообщаем хабу, что пользователь за этой вкладкой: пока так, пуши на телефон не идут.
// Активна = вкладка видна, окно в фокусе и был ввод за последние IDLE_MS (отошёл от ПК — пуши снова идут).
import { client } from "./hub.ts";

const IDLE_MS = 5 * 60_000;
// пульс должен быть заметно чаще PRESENCE_TTL_MS хаба (75 с)
const BEAT_MS = 30_000;

export function startPresence(): void {
  let lastInput = Date.now();
  let active = false;

  const isActive = () => document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput < IDLE_MS;
  const check = (beat = false) => {
    const now = isActive();
    if (now !== active || (beat && now)) client.setPresence(now);
    active = now;
  };
  const onInput = () => {
    lastInput = Date.now();
    if (!active) check();
  };

  for (const e of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) window.addEventListener(e, onInput, { passive: true });
  window.addEventListener("focus", () => check());
  window.addEventListener("blur", () => check());
  document.addEventListener("visibilitychange", () => check());
  setInterval(() => check(true), BEAT_MS);
  check();
}
