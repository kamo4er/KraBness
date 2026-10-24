// Обновления: раз в сутки хаб смотрит GitHub Releases, в вебе и приложении появляется плашка «Вышла X».
// «Обновить»: хаб скачивает выпуск (исходники zip и APK) в data/updates/stage, пишет pending.json и уходит на перезапуск.
// Сторож (scripts/hub-service.ps1) до старта хаба вызывает scripts/apply-update.mjs: старые файлы — в бэкап, новые — на место,
// npm ci, сборка веба. Пока хаб работает, файлы node_modules заняты, поэтому менять их можно только между запусками.
// Новый хаб сразу упал — сторож откатывает. Из папки git (разработка) не ставим: там обновляются через git pull.
import { execFile } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateRelease, UpdateStatus } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

export const DEFAULT_REPO = "kamo4er/KraBness";
/**
 * Открытый ключ подписи выпусков (ed25519, SPKI base64). Закрытый — только у автора (config/release-signing.pem, вне git):
 * zip выпуска подписан им, и хаб не ставит архив без верной подписи — даже угнанный аккаунт GitHub не подсунет своё.
 */
export const RELEASE_KEY = "MCowBQYDK2VwAyEAGQO53zVJvG/uQrRTKxJjsPZ00LxWywB69UqK+G7do4c=";
const DAY = 86_400_000;
const MAX_ZIP = 300 * 1024 * 1024;
const MAX_APK = 200 * 1024 * 1024;
const MAX_UNPACKED = 1024 * 1024 * 1024;
/** bsdtar из Windows (умеет zip); у git-bash в PATH бывает GNU tar, который zip не знает */
const TAR = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";
const LISTING = /^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+(.+)$/;

interface Asset {
  id: number;
  name: string;
  size: number;
}
interface Latest extends UpdateRelease {
  zip?: Asset;
  /** подпись zip: <имя zip>.sig, base64 */
  sig?: Asset;
  apk?: Asset;
}
interface GhRelease {
  tag_name: string;
  body?: string | null;
  html_url: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ id: number; name: string; size: number }>;
}

export interface UpdatesDeps {
  config: ConfigStore;
  current: string;
  /** папка установки (где package.json) */
  root: string;
  dataDir: string;
  /** под сторожем: умеет перезапускаться, значит, и ставить обновление */
  supervised: boolean;
  restart: (delayMs: number) => void;
  /** https://api.github.com (тесты подставляют свой) */
  api?: string;
  /** свой открытый ключ подписи (тесты); по умолчанию RELEASE_KEY */
  publicKey?: string;
  log: (m: string) => void;
}

/** a новее b (0.1.31 > 0.1.30, 0.2.0 > 0.1.99) */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** «Что нового» из описания выпуска: разделы «## Русский» и «## English»; без разделов — весь текст в оба. */
export function releaseNotes(body: string): { ru: string; en: string } {
  const clip = (s: string) => (s.length > 3000 ? s.slice(0, 2999) + "…" : s).trim();
  const parts: Record<string, string> = {};
  let cur: string | undefined;
  for (const line of body.replace(/\r/g, "").split("\n")) {
    const h = /^##\s*(Русский|English)\s*$/i.exec(line);
    if (h) {
      cur = /русский/i.test(h[1]!) ? "ru" : "en";
      parts[cur] = "";
    } else if (cur) parts[cur] += line + "\n";
  }
  const all = clip(body);
  return { ru: clip(parts.ru ?? parts.en ?? all), en: clip(parts.en ?? parts.ru ?? all) };
}

const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out))),
  );

/** Распаковать zip выпуска: без «..», абсолютных путей и символьных ссылок, не больше MAX_UNPACKED. */
async function unpackZip(zip: string, out: string): Promise<void> {
  const entries = (await run(TAR, ["-tf", zip])).split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error(L("пустой архив", "empty archive"));
  if (entries.some((e) => /^([a-z]:|[\\/])/i.test(e) || e.split(/[\\/]/).includes(".."))) throw new Error(L("в архиве недопустимые пути", "the archive has invalid paths"));
  let total = 0;
  for (const line of (await run(TAR, ["-tvf", zip])).split(/\r?\n/)) {
    const m = LISTING.exec(line);
    if (m) total += Number(m[1]);
  }
  if (total > MAX_UNPACKED) throw new Error(L("архив слишком большой", "the archive is too large"));
  await run(TAR, ["-xf", zip, "-C", out]);
  if (readdirSync(out, { withFileTypes: true, recursive: true }).some((e) => e.isSymbolicLink())) throw new Error(L("в архиве символьные ссылки", "the archive has symbolic links"));
}

export class Updates {
  private latest?: Latest;
  private checkedAt?: number;
  private error?: string;
  private state: UpdateStatus["state"] = "idle";
  private timers: NodeJS.Timeout[] = [];
  private listeners = new Set<(s: UpdateStatus) => void>();
  private dir: string;

  constructor(private deps: UpdatesDeps) {
    this.dir = join(deps.dataDir, "updates");
    try {
      const s = JSON.parse(readFileSync(join(this.dir, "state.json"), "utf8")) as { checkedAt?: number; latest?: Latest };
      this.checkedAt = s.checkedAt;
      this.latest = s.latest;
    } catch {
      /* ещё не проверяли */
    }
  }

  private get repo(): string {
    return this.deps.config.config.updates?.repo || DEFAULT_REPO;
  }

  private get auto(): boolean {
    return this.deps.config.config.updates?.auto !== false;
  }

  private get reason(): UpdateStatus["reason"] {
    if (existsSync(join(this.deps.root, ".git"))) return "git";
    if (!this.deps.supervised) return "manual";
    return undefined;
  }

  status(): UpdateStatus {
    const reason = this.reason;
    let last: UpdateStatus["last"];
    try {
      last = JSON.parse(readFileSync(join(this.dir, "result.json"), "utf8")) as UpdateStatus["last"];
      // apply-update.mjs пишет по-английски (он без зависимостей); свою частую причину переводим
      if (last?.error === "the new version exited right after start") last.error = L("новая версия упала сразу после старта", "the new version exited right after start");
    } catch {
      /* ещё не ставили */
    }
    const latest = this.latest ? { version: this.latest.version, notes: this.latest.notes, url: this.latest.url, ...(this.latest.publishedAt ? { publishedAt: this.latest.publishedAt } : {}) } : undefined;
    return {
      current: this.deps.current,
      ...(latest ? { latest } : {}),
      available: !!latest && newer(latest.version, this.deps.current),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      auto: this.auto,
      canInstall: !reason,
      ...(reason ? { reason } : {}),
      state: this.state,
      ...(last ? { last } : {}),
    };
  }

  subscribe(cb: (s: UpdateStatus) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private emit(): void {
    const s = this.status();
    for (const cb of this.listeners) cb(s);
  }

  /** Проверять раз в сутки (раз в час смотрим, не пора ли; первый раз — через полминуты после старта). */
  start(): void {
    const tick = () => {
      // папка git (разработка) обновляется через git pull — выпуски там не нужны, а у закрытой репы проверка только ругалась бы
      if (this.reason === "git") return;
      if (this.auto && Date.now() - (this.checkedAt ?? 0) > DAY) void this.check();
    };
    const first = setTimeout(tick, 30_000);
    const every = setInterval(tick, 3_600_000);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  setAuto(auto: boolean): UpdateStatus {
    this.deps.config.setUpdatesAuto(auto);
    this.emit();
    return this.status();
  }

  private get(path: string, accept: string): Promise<Response> {
    const token = this.deps.config.config.updates?.token;
    return fetch((this.deps.api ?? "https://api.github.com") + path, {
      headers: { accept, "user-agent": "KraBness", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(path.includes("/assets/") ? 600_000 : 15_000),
    });
  }

  async check(): Promise<UpdateStatus> {
    if (this.state !== "idle") return this.status();
    this.state = "checking";
    this.emit();
    try {
      const r = await this.get(`/repos/${this.repo}/releases/latest`, "application/vnd.github+json");
      if (r.status === 404) throw new Error(L("Выпусков на GitHub пока нет (или репозиторий закрыт и нужен токен)", "No releases on GitHub yet (or the repository is private and needs a token)"));
      if (!r.ok) throw new Error(`${L("GitHub ответил", "GitHub answered")} ${r.status}`);
      const j = (await r.json()) as GhRelease;
      const asset = (re: RegExp) => j.assets?.find((a) => re.test(a.name));
      const zip = asset(/^krabness-.+\.zip$/i);
      const sig = zip && j.assets?.find((a) => a.name === `${zip.name}.sig`);
      const apk = asset(/\.apk$/i);
      this.latest = {
        version: j.tag_name.replace(/^v/i, ""),
        notes: releaseNotes(j.body ?? ""),
        url: j.html_url,
        ...(j.published_at ? { publishedAt: Date.parse(j.published_at) } : {}),
        ...(zip ? { zip: { id: zip.id, name: zip.name, size: zip.size } } : {}),
        ...(sig ? { sig: { id: sig.id, name: sig.name, size: sig.size } } : {}),
        ...(apk ? { apk: { id: apk.id, name: apk.name, size: apk.size } } : {}),
      };
      this.error = undefined;
      if (newer(this.latest.version, this.deps.current)) this.deps.log(L(`[hub] вышла новая версия ${this.latest.version}`, `[hub] new version ${this.latest.version} is out`));
    } catch (e) {
      const err = e as Error & { cause?: Error };
      this.error = err.name === "TimeoutError" ? L("GitHub не ответил за 15 с", "GitHub didn't answer in 15 s") : (err.cause?.message ?? err.message);
    } finally {
      this.checkedAt = Date.now();
      this.state = "idle";
      try {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, "state.json"), JSON.stringify({ checkedAt: this.checkedAt, latest: this.latest }));
      } catch {
        /* не записалось — проверим ещё раз после рестарта */
      }
      this.emit();
    }
    return this.status();
  }

  private async fetchAsset(a: Asset, max: number): Promise<Buffer> {
    if (a.size > max) throw new Error(L(`${a.name} слишком большой`, `${a.name} is too large`));
    const r = await this.get(`/repos/${this.repo}/releases/assets/${a.id}`, "application/octet-stream");
    if (!r.ok) throw new Error(`${a.name}: ${L("GitHub ответил", "GitHub answered")} ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length > max) throw new Error(L(`${a.name} слишком большой`, `${a.name} is too large`));
    return data;
  }

  private async download(a: Asset, file: string, max: number): Promise<void> {
    writeFileSync(file, await this.fetchAsset(a, max));
  }

  /** Подпись выпуска ключом автора: без неё или с чужой архив не ставим. */
  private checkSignature(data: Buffer, sig: Buffer): void {
    const key = createPublicKey({ key: Buffer.from(this.deps.publicKey ?? RELEASE_KEY, "base64"), format: "der", type: "spki" });
    let ok = false;
    try {
      ok = verify(null, data, key, Buffer.from(sig.toString("utf8").trim(), "base64"));
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(L("подпись выпуска не сходится, не ставлю", "the release signature doesn't match, not installing"));
  }

  /** APK с GitHub не затирает свою сборку (другой ключ или свой Firebase): только если на хабе нет APK или он тоже с GitHub. */
  private mayReplaceApk(): boolean {
    try {
      const cur = JSON.parse(readFileSync(join(this.deps.dataDir, "apk", "latest.json"), "utf8")) as { source?: string };
      return cur.source === "github";
    } catch {
      return true;
    }
  }

  async install(): Promise<UpdateStatus> {
    const st = this.status();
    if (st.reason === "git") throw new HttpError(409, L("Хаб запущен из папки git — обновляй через git pull", "The hub runs from a git folder — update with git pull"));
    if (st.reason === "manual")
      throw new HttpError(409, L("Хаб запущен вручную, без сторожа — обновление не поставить. Запусти scripts\\hub-service.ps1", "The hub was started manually, without the supervisor — can't install the update. Run scripts\\hub-service.ps1"));
    if (this.state !== "idle") throw new HttpError(409, L("Подожди, хаб уже занят обновлением", "Wait, the hub is already busy with the update"));
    const rel = this.latest;
    if (!rel || !st.available) throw new HttpError(409, L("Новой версии нет", "No new version"));
    if (!rel.zip) throw new HttpError(409, L("В выпуске нет архива KraBness", "The release has no KraBness archive"));
    if (!rel.sig) throw new HttpError(409, L("Выпуск без подписи — не ставлю", "The release isn't signed — not installing"));
    this.state = "downloading";
    this.emit();
    try {
      mkdirSync(this.dir, { recursive: true });
      const zip = join(this.dir, rel.zip.name);
      const data = await this.fetchAsset(rel.zip, MAX_ZIP);
      this.checkSignature(data, await this.fetchAsset(rel.sig, 4096));
      writeFileSync(zip, data);
      const stage = join(this.dir, "stage");
      rmSync(stage, { recursive: true, force: true });
      mkdirSync(stage);
      await unpackZip(zip, stage);
      rmSync(zip, { force: true });
      const pkg = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")) as { version?: string };
      if (pkg.version !== rel.version || !existsSync(join(stage, "scripts", "apply-update.mjs"))) throw new Error(L("архив выпуска не похож на KraBness", "the release archive doesn't look like KraBness"));
      let apk: string | undefined;
      if (rel.apk && this.mayReplaceApk()) {
        apk = join(this.dir, rel.apk.name);
        await this.download(rel.apk, apk, MAX_APK);
      }
      writeFileSync(join(this.dir, "pending.json"), JSON.stringify({ version: rel.version, from: this.deps.current, stage, ...(apk ? { apk } : {}) }));
    } catch (e) {
      this.state = "idle";
      this.emit();
      throw new HttpError(502, `${L("Не удалось скачать обновление", "Failed to download the update")}: ${(e as Error).message}`);
    }
    this.state = "restarting";
    this.emit();
    this.deps.log(L(`[hub] обновление ${rel.version} скачано, перезапускаюсь для установки`, `[hub] update ${rel.version} downloaded, restarting to install`));
    this.deps.restart(2000);
    return this.status();
  }
}
