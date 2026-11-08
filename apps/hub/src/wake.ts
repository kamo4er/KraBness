// Пробуждение ПК: хаб спит вместе с ПК, поэтому будит «будильник» — scripts/nas-wake/wake.py на любом
// постоянно включённом устройстве в домашней сети (NAS, Raspberry Pi, роутер). Приложение ходит к нему по Tailscale или через прокси на белом IP.
// Хаб хранит адрес будильника и токен, сам находит MAC/широковещательный адрес своих сетевых карт
// и отдаёт всё это приложению, пока ПК не спит.
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { WakeNic, WakeSetup } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

const MAC = /^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$/;
// виртуальные адаптеры и VPN: Wake-on-LAN через них не работает
const VIRTUAL = /vEthernet|Hyper-V|VirtualBox|VMware|WSL|Loopback|Tailscale|ZeroTier|Docker|Amnezia|WireGuard|TAP|TUN|Bluetooth|Npcap/i;

const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function broadcastOf(address: string, netmask: string): string {
  const a = address.split(".").map(Number);
  const m = netmask.split(".").map(Number);
  return a.map((x, i) => (x | (~m[i]! & 255)) & 255).join(".");
}

/** Сетевые карты ПК, через которые его можно разбудить: физические, с адресом в домашней сети. */
export function wakeNics(ifaces = networkInterfaces()): WakeNic[] {
  const out: WakeNic[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || !isPrivate(i.address) || /^00(:00){5}$/.test(i.mac)) continue;
      out.push({ name, mac: i.mac.toUpperCase(), address: i.address, broadcast: broadcastOf(i.address, i.netmask) });
    }
  }
  return out;
}

export interface WakeDeps {
  /** адрес хаба в Tailscale — по нему будильник проверяет, проснулся ли ПК */
  pcHost: () => string | undefined;
  pcPort: () => number;
  http?: typeof fetch;
  nics?: () => WakeNic[];
}

export class Wake {
  constructor(
    private config: ConfigStore,
    private deps: WakeDeps,
  ) {}

  private get cfg() {
    return this.config.config.wake;
  }

  /** Для приложения: как будить (404 — не настроено). */
  runtime(): { url: string; token: string; mac?: string; broadcast?: string; pcHost?: string; pcPort: number } {
    const w = this.cfg;
    if (!w?.url || !w.token) throw new HttpError(404, L("Пробуждение не настроено (Настройки → Пробуждение ПК)", "Wake-up isn't set up (Settings → Wake the PC)"));
    const pcHost = this.deps.pcHost();
    return { url: w.url, token: w.token, ...(w.mac ? { mac: w.mac } : {}), ...(w.broadcast ? { broadcast: w.broadcast } : {}), ...(pcHost ? { pcHost } : {}), pcPort: this.deps.pcPort() };
  }

  /** Для экрана настройки: токен не отдаём, только есть ли он. */
  setup(): WakeSetup {
    const w = this.cfg;
    const pcHost = this.deps.pcHost();
    return {
      configured: !!(w?.url && w.token),
      ...(w?.url ? { url: w.url } : {}),
      hasToken: !!w?.token,
      ...(w?.mac ? { mac: w.mac } : {}),
      ...(w?.broadcast ? { broadcast: w.broadcast } : {}),
      nics: (this.deps.nics ?? wakeNics)(),
      ...(pcHost ? { pcHost } : {}),
      pcPort: this.deps.pcPort(),
    };
  }

  /** Сохранить: пустой токен при правке — оставить прежний. */
  save(input: { url?: string; token?: string; mac?: string; broadcast?: string }): WakeSetup {
    let u: URL;
    try {
      u = new URL(String(input.url ?? "").trim());
    } catch {
      throw new HttpError(400, L("Адрес будильника: http://<IP устройства в Tailscale>:7421", "Relay address: http://<device Tailscale IP>:7421"));
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, L("Адрес будильника: http или https", "Relay address: http or https"));
    const token = String(input.token ?? "").trim() || this.cfg?.token || "";
    if (token.length < 16) throw new HttpError(400, L("Токен — не короче 16 символов (кнопка «Сгенерировать»)", "The token must be at least 16 characters (the “Generate” button)"));
    if (/\s/.test(token)) throw new HttpError(400, L("В токене не должно быть пробелов", "The token must not contain spaces"));
    const mac = String(input.mac ?? "").trim().toUpperCase();
    if (!MAC.test(mac)) throw new HttpError(400, L("Выбери сетевую карту ПК (нужен её MAC)", "Pick the PC network card (its MAC is needed)"));
    const broadcast = String(input.broadcast ?? "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(broadcast)) throw new HttpError(400, L("Широковещательный адрес вида 192.168.1.255", "A broadcast address like 192.168.1.255"));
    this.config.setWake({ url: u.toString().replace(/\/$/, ""), token, mac, broadcast });
    return this.setup();
  }

  remove(): WakeSetup {
    this.config.setWake(undefined);
    return this.setup();
  }

  /** Новый токен: его же кладут в файл token рядом с wake.py. */
  static newToken(): string {
    return randomBytes(24).toString("hex");
  }

  /** Достучаться до будильника с ПК: он отвечает и принимает токен. (С телефона путь другой — через Tailscale.) */
  async test(): Promise<{ pc: string }> {
    const w = this.runtime();
    const q = w.pcHost ? `?host=${encodeURIComponent(w.pcHost)}&port=${w.pcPort}` : "";
    const get = (query: string) => (this.deps.http ?? fetch)(`${w.url}/status${query}`, { headers: { authorization: `Bearer ${w.token}` }, signal: AbortSignal.timeout(6000) });
    let r: Response;
    try {
      r = await get(q);
      // старый wake.py (адрес ПК в параметрах запуска) не знает ?host= и отвечает 404
      if (r.status === 404 && q) r = await get("");
    } catch (e) {
      const err = e as Error & { cause?: Error };
      throw new HttpError(502, `${L("Будильник не отвечает", "The relay doesn't answer")}: ${err.name === "TimeoutError" ? L("нет ответа за 6 с", "no answer in 6 s") : (err.cause?.message ?? err.message)}. ${L("Он запущен? Адрес верный?", "Is it running? Is the address right?")}`);
    }
    if (r.status === 401) throw new HttpError(502, L("Будильник не принял токен — проверь файл token рядом с wake.py", "The relay rejected the token — check the token file next to wake.py"));
    if (!r.ok) throw new HttpError(502, `${L("Будильник ответил", "The relay answered")} ${r.status}${r.status === 400 ? L(" (старая версия wake.py? обнови)", " (an old wake.py? update it)") : ""}`);
    const j = (await r.json().catch(() => ({}))) as { pc?: string };
    return { pc: j.pc ?? "unknown" };
  }
}
