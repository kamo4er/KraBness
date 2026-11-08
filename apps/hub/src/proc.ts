import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface ProcRow {
  pid: number;
  ppid: number;
  /** время создания, FILETIME UTC */
  created: bigint;
}

/** Снимок процессов Windows: pid, родитель, время создания. */
function snapshot(): ProcRow[] | undefined {
  const r = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }",
    ],
    { encoding: "utf8", timeout: 15_000, windowsHide: true },
  );
  if (r.status !== 0 || !r.stdout) return undefined;
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: BigInt(m[3]!) });
  }
  return rows;
}

/**
 * Потомки процесса — только настоящие: у ребёнка совпадает родитель И он создан не раньше родителя.
 * `taskkill /T` смотрит лишь на номер родителя, а PID в Windows переиспользуются: процесс, чей
 * давно умерший родитель имел тот же номер (например, сторож хаба с родителем WmiPrvSE), убивался «за компанию».
 */
export function descendants(rootPid: number, rows: ProcRow[]): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const root = byPid.get(rootPid);
  if (!root) return [];
  const out: number[] = [];
  const queue: ProcRow[] = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const r of rows) {
      if (r.ppid === parent.pid && r.pid !== parent.pid && r.created >= parent.created && !out.includes(r.pid)) {
        out.push(r.pid);
        queue.push(r);
      }
    }
  }
  return out;
}

/** Снимок процессов macOS/Linux: pid и родитель (время создания не нужно — дерево берём в момент убийства). */
function posixSnapshot(): ProcRow[] | undefined {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 15_000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const rows: ProcRow[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created: 0n });
  }
  return rows;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Убивает процесс вместе с дочерними: обычный kill оставляет сирот (MCP-серверы claude, npm test, python за uv). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  killPidTree(child.pid);
}

/** То же по номеру процесса. */
export function killPidTree(rootPid: number): void {
  if (process.platform !== "win32") {
    const rows = posixSnapshot();
    const pids = [...(rows ? descendants(rootPid, rows).reverse() : []), rootPid];
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* уже нет */
      }
    }
    // кто не ушёл по-хорошему за 3 с — SIGKILL
    setTimeout(() => {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }, 3000).unref();
    return;
  }
  const rows = snapshot();
  // сначала листья, потом корень; без /T — дерево собрали сами
  const pids = rows ? [...descendants(rootPid, rows)].reverse() : [];
  for (const pid of [...pids, rootPid]) spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

/**
 * Команда человека на macOS/Linux — в его логин-оболочке (zsh на маке): под launchd у хаба голый PATH,
 * а Homebrew, nvm и прочее прописываются в профиле оболочки.
 */
export function posixShell(command: string): [string, string[]] {
  const sh = process.env.SHELL && /^\/[\w./-]+$/.test(process.env.SHELL) ? process.env.SHELL : process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  return [sh, ["-lc", command]];
}

/**
 * Программа на macOS/Linux: PATH, потом обычные места установки. Под launchd PATH голый (/usr/bin:/bin…),
 * а Homebrew, официальные установщики (~/.local/bin, ~/.opencode/bin) и npm -g у нашего node (рядом с ним) — мимо.
 */
export function posixBin(name: string, extra: string[] = []): string | undefined {
  const home = homedir();
  const dirs = [...(process.env.PATH ?? "").split(":"), ...extra, join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", dirname(process.execPath)];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** как запустить хаб под сторожем на этой ОС — для подсказок «запущен вручную» */
export const supervisorHint = () => (process.platform === "win32" ? "scripts\\hub-service.ps1" : "~/KraBness/scripts/krabness start");

export { spawn };
