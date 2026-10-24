// Обновление приложения с хаба: сравниваем свой versionCode с последней опубликованной сборкой
// (apps/mobile → npm run release), качаем APK системным менеджером загрузок и отдаём установщику.
// Системный — потому что загрузку внутри приложения Android рвёт, когда оно свёрнуто или погас экран.
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import { t, type AppRelease } from "@kamharn/client";
import { SystemDownload } from "../modules/kamharn-download/index.ts";
import app from "../app.json";
import { client, useHub } from "./store.ts";

export const APP_VERSION: string = app.expo.version;
export const APP_VERSION_CODE: number = app.expo.android.versionCode;

const KEY = "kamharn.update";
const APK_MIME = "application/vnd.android.package-archive";

/** начатая загрузка: переживает выгрузку приложения из памяти */
interface Pending {
  id: number;
  versionCode: number;
  /** сколько раз уже начинали заново после неудачи */
  tries?: number;
}

const MAX_TRIES = 3;
/** байты не идут столько времени — соединение повисло, начинаем заново */
const STALL_MS = 90_000;

// причины паузы DownloadManager (COLUMN_REASON при STATUS_PAUSED)
const PAUSED_WAITING_TO_RETRY = 1;
const PAUSED_WAITING_FOR_NETWORK = 2;

/** что показать на плашке вместо застывших процентов */
function stageOf(status: string, reason: number, stillFor: number): string {
  if (status === "pending") return t("в очереди", "queued");
  if (status === "paused") return reason === PAUSED_WAITING_FOR_NETWORK ? t("жду сеть", "waiting for network") : reason === PAUSED_WAITING_TO_RETRY ? t("связь оборвалась, повтор", "connection lost, retrying") : t("пауза", "paused");
  if (status === "running" && stillFor > 15_000) return t("не двигается…", "stalled…");
  return t("качаю", "downloading");
}

function loadPending(): Pending | null {
  try {
    const raw = SecureStore.getItem(KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function savePending(p: Pending | null): void {
  if (p) SecureStore.setItem(KEY, JSON.stringify(p));
  else void SecureStore.deleteItemAsync(KEY);
}

export interface UpdateState {
  /** более новая сборка на хабе */
  release?: AppRelease;
  progress?: number;
  busy: boolean;
  /** скачано, осталось установить */
  ready: boolean;
  /** что сейчас с загрузкой: качаю, жду сеть, повтор… */
  stage?: string;
  error?: string;
  install(): Promise<void>;
}

export function useUpdate(): UpdateState {
  const { conn } = useHub();
  const [release, setRelease] = useState<AppRelease>();
  const [pending, setPending] = useState<Pending | null>(() => {
    const p = loadPending();
    // загрузка от уже установленной (или старой) версии больше не нужна
    if (p && p.versionCode <= APP_VERSION_CODE) {
      try {
        SystemDownload.remove(p.id);
      } catch {}
      savePending(null);
      return null;
    }
    return p;
  });
  const [progress, setProgress] = useState<number>();
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState<string>();
  const [error, setError] = useState<string>();
  const launched = useRef(false);

  useEffect(() => {
    if (conn !== "online") return;
    client?.appLatest().then(
      (r) => setRelease(r.versionCode > APP_VERSION_CODE ? r : undefined),
      () => setRelease(undefined),
    );
  }, [conn]);

  // пока качалось, на хабе появилась сборка ещё новее — старую загрузку выбрасываем
  useEffect(() => {
    if (!release || !pending || release.versionCode <= pending.versionCode) return;
    try {
      SystemDownload.remove(pending.id);
    } catch {}
    savePending(null);
    setPending(null);
    setReady(false);
    setProgress(undefined);
  }, [release, pending]);

  // следим за загрузкой, пока приложение на экране; в фоне она идёт сама
  useEffect(() => {
    if (!pending) return;
    let lastBytes = -1;
    let movedAt = Date.now();
    // начать загрузку заново (несколько раз); false — попытки кончились
    const restart = (): boolean => {
      const tries = (pending.tries ?? 0) + 1;
      if (!release || tries >= MAX_TRIES) return false;
      try {
        SystemDownload.remove(pending.id);
      } catch {}
      try {
        const p = { id: SystemDownload.enqueue(client!.appApkUrl(), release.file, `KraBness ${release.version}`, APK_MIME), versionCode: release.versionCode, tries };
        savePending(p);
        setPending(p);
        return true;
      } catch {
        return false;
      }
    };
    const giveUp = (msg: string) => {
      setError(msg);
      setProgress(undefined);
      setStage(undefined);
      savePending(null);
      setPending(null);
    };
    const tick = () => {
      if (AppState.currentState !== "active") return;
      const info = SystemDownload.query(pending.id);
      if (!info || info.status === "failed") {
        // связь рвалась так, что докачать нельзя — начинаем заново сами
        if (!restart()) giveUp(info ? t(`Загрузка не удалась (код ${info.reason}). Попробуй ещё раз.`, `Download failed (code ${info.reason}). Try again.`) : t("Загрузка пропала. Попробуй ещё раз.", "The download disappeared. Try again."));
        return;
      }
      if (info.bytes !== lastBytes) (lastBytes = info.bytes), (movedAt = Date.now());
      // соединение повисло (бывает через ретранслятор Tailscale): байты не идут — заново
      const offline = info.status === "paused" && info.reason === PAUSED_WAITING_FOR_NETWORK;
      if (info.status !== "successful" && !offline && Date.now() - movedAt > STALL_MS) {
        if (!restart()) giveUp(t("Загрузка не двигается. Проверь связь с ПК и попробуй ещё раз.", "The download is stuck. Check the connection to the PC and try again."));
        return;
      }
      setStage(stageOf(info.status, info.reason, Date.now() - movedAt));
      const total = info.total > 0 ? info.total : (release?.size ?? 0);
      setProgress(total ? info.bytes / total : undefined);
      if (info.status === "successful") {
        setReady(true);
        // установщик открываем сами один раз; дальше — кнопкой «Установить»
        if (!launched.current) {
          launched.current = true;
          SystemDownload.install(pending.id);
        }
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    const sub = AppState.addEventListener("change", (s) => s === "active" && tick());
    return () => (clearInterval(timer), sub.remove());
  }, [pending, release?.size]);

  async function install() {
    setError(undefined);
    if (ready && pending) return SystemDownload.install(pending.id);
    if (!release || pending) return;
    try {
      const id = SystemDownload.enqueue(client!.appApkUrl(), release.file, `KraBness ${release.version}`, APK_MIME);
      const p = { id, versionCode: release.versionCode };
      savePending(p);
      launched.current = false;
      setPending(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return { release, progress, busy: !!pending && !ready, ready, stage: pending && !ready ? stage : undefined, error, install };
}
