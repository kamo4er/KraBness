// Сон ПК по запросу из приложения. Именно сон (Suspend), не гибернация: из сна ПК будит Wake-on-LAN с NAS.
import { spawn } from "node:child_process";
import { L } from "./lang.ts";

export function suspendPc(log: (m: string) => void): void {
  if (process.platform !== "win32") return log(L("[hub] сон ПК поддерживается только на Windows", "[hub] putting the PC to sleep is only supported on Windows"));
  // windowsHide: без консоли вообще, иначе Windows Terminal покажет окно
  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"],
    { windowsHide: true, stdio: "ignore" },
  );
  ps.on("error", (e) => log(`${L("[hub] не удалось усыпить ПК", "[hub] couldn't put the PC to sleep")}: ${e.message}`));
}
