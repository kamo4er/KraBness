// Фоновый сервис «KraBness на связи» (нативная часть — android/.../KeepAliveService.kt).
import { requireNativeModule } from "expo";

interface Native {
  /** запустить или обновить уведомление; title и channel — на языке интерфейса */
  start(text: string, title: string, channel: string): void;
  /** поменять уведомление у работающего сервиса (можно из фона) */
  update(text: string, title: string, channel: string): void;
  stop(): void;
  isRunning(): boolean;
}

export const KeepAlive = requireNativeModule<Native>("KamharnKeepAlive");
