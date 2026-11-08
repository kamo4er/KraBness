// Сон ПК по запросу из приложения. Именно сон (Suspend), не гибернация: из сна ПК будит Wake-on-LAN с NAS.
// macOS: pmset sleepnow (прав администратора не нужно). Linux — пока нет: кнопки «Усыпить» там не будет.
import { spawn } from "node:child_process";
import { L } from "./lang.ts";

/** умеет ли хаб усыпить этот компьютер (иначе кнопка «Усыпить» не показывается) */
export const canSuspend = () => process.platform === "win32" || process.platform === "darwin";

export function suspendPc(log: (m: string) => void): void {
  if (!canSuspend()) return log(L("[hub] сон компьютера здесь не поддерживается", "[hub] putting the computer to sleep isn't supported here"));
  // windowsHide: без консоли вообще, иначе Windows Terminal покажет окно
  const p =
    process.platform === "darwin"
      ? spawn("pmset", ["sleepnow"], { stdio: "ignore" })
      : spawn("powershell.exe", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"], { windowsHide: true, stdio: "ignore" });
  p.on("error", (e) => log(`${L("[hub] не удалось усыпить ПК", "[hub] couldn't put the PC to sleep")}: ${e.message}`));
}
