// Устройства и pairing. Запросы с localhost доверенные (это сам ПК),
// остальные — только с device-токеном, полученным через одноразовый код pairing.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import type { Db } from "./db.ts";

export const LOCAL_DEVICE = "local";
const PAIR_TTL_MS = 5 * 60_000;

export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Сокеты туннеля с VPS (remote.ts): адрес у них 127.0.0.1, но это чужая машина — доверия localhost нет. */
export const tunnelSockets = new WeakSet<object>();

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Auth {
  private codes = new Map<string, number>();
  private failures = 0;

  constructor(private db: Db) {}

  /** Возвращает deviceId или undefined, если доступ запрещён. */
  authenticate(remoteAddress: string | undefined, token: string | undefined): string | undefined {
    if (isLoopback(remoteAddress)) return LOCAL_DEVICE;
    if (!token) return undefined;
    const d = this.db.deviceByTokenHash(hash(token));
    if (!d) return undefined;
    this.db.touchDevice(d.id);
    return d.id;
  }

  startPairing(): { code: string; expiresAt: number } {
    const now = Date.now();
    for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = now + PAIR_TTL_MS;
    this.codes.set(code, expiresAt);
    return { code, expiresAt };
  }

  completePairing(code: string, name: string): { deviceId: string; token: string } | undefined {
    const exp = this.codes.get(code);
    if (!exp || exp < Date.now()) {
      // защита от перебора: после 5 промахов все активные коды сгорают
      if (++this.failures >= 5) {
        this.codes.clear();
        this.failures = 0;
      }
      return undefined;
    }
    this.codes.delete(code);
    this.failures = 0;
    const token = randomBytes(32).toString("base64url");
    const deviceId = "dev_" + randomUUID().slice(0, 8);
    const now = Date.now();
    this.db.insertDevice({ id: deviceId, name: name.slice(0, 64) || "device", tokenHash: hash(token), createdAt: now, lastSeen: now, fcmToken: null });
    return { deviceId, token };
  }
}
