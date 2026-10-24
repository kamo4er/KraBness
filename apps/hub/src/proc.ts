import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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

/** Убивает процесс вместе с дочерними (на Windows обычный kill оставляет сирот). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  killPidTree(child.pid);
}

/** То же по номеру процесса (Windows). */
export function killPidTree(rootPid: number): void {
  const rows = snapshot();
  // сначала листья, потом корень; без /T — дерево собрали сами
  const pids = rows ? [...descendants(rootPid, rows)].reverse() : [];
  for (const pid of [...pids, rootPid]) spawnSync("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

export { spawn };
