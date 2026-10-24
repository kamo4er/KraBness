// Системный менеджер загрузок Android (нативная часть — android/.../KamharnDownloadModule.kt).
import { requireNativeModule } from "expo";

export type DownloadStatus = "pending" | "running" | "paused" | "successful" | "failed";

export interface DownloadInfo {
  status: DownloadStatus;
  bytes: number;
  total: number;
  /** код причины DownloadManager для paused/failed */
  reason: number;
}

interface Native {
  enqueue(url: string, fileName: string, title: string, mime: string): number;
  query(id: number): DownloadInfo | null;
  install(id: number): void;
  remove(id: number): void;
}

export const SystemDownload = requireNativeModule<Native>("KamharnDownload");
