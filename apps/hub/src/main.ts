import { createHub } from "./hub.ts";
import { suspendPc } from "./power.ts";
import { L } from "./lang.ts";

// под сторожем (scripts/hub-service.ps1) перезапуск — это корректный выход, сторож поднимет хаб заново
const supervised = process.env.KAMHARN_SUPERVISED === "1";
export const RESTART_EXIT_CODE = 75;

// время в каждой строке: в data/logs/hub.log строки хаба идут вперемешку со строками сторожа
const log = (m: string) => console.log(`${new Date().toLocaleString("sv-SE")} ${m}`);

let closing = false;
const shutdown = async (code: number) => {
  if (closing) return;
  closing = true;
  log(code === RESTART_EXIT_CODE ? L("[hub] перезапускаюсь…", "[hub] restarting…") : L("[hub] останавливаюсь…", "[hub] stopping…"));
  // страховка: зависшее закрытие не должно держать процесс — иначе сторож не перезапустит хаб
  setTimeout(() => {
    log(L("[hub] закрытие зависло дольше 10 с — выхожу принудительно", "[hub] shutdown hung for over 10 s — exiting forcibly"));
    process.exit(code);
  }, 10_000).unref();
  await hub.close().catch((e) => log(`${L("[hub] ошибка при закрытии", "[hub] error while closing")}: ${(e as Error).stack ?? e}`));
  process.exit(code);
};

process.on("uncaughtException", (e) => {
  log(`${L("[hub] необработанная ошибка", "[hub] unhandled error")}: ${e.stack ?? e}`);
  void shutdown(1);
});
process.on("unhandledRejection", (e) => log(`${L("[hub] необработанный reject", "[hub] unhandled rejection")}: ${(e as Error)?.stack ?? e}`));

const hub = await createHub({
  log,
  // другой конфиг — для тестового экземпляра рядом с рабочим
  ...(process.env.KAMHARN_CONFIG ? { configPath: process.env.KAMHARN_CONFIG } : {}),
  ...(supervised ? { onRestart: () => void shutdown(RESTART_EXIT_CODE) } : {}),
  onSleep: () => suspendPc(log),
  // раз в сутки смотреть выпуски на GitHub (KRABNESS_UPDATES_API — свой адрес вместо api.github.com, для проверки)
  updates: { check: true, ...(process.env.KRABNESS_UPDATES_API ? { api: process.env.KRABNESS_UPDATES_API } : {}) },
});
log(`${L("[hub] KraBness слушает", "[hub] KraBness is listening on")}: ${hub.urls.join(", ")}${supervised ? L(" (под сторожем)", " (supervised)") : ""}`);

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
