import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { descendants, killTree } from "../../src/proc.ts";

test("descendants: процесс с переиспользованным PID родителя не считается потомком", () => {
  const rows = [
    { pid: 100, ppid: 1, created: 1000n }, // claude, которому достался PID 100
    { pid: 200, ppid: 100, created: 1100n }, // его настоящий ребёнок (bash)
    { pid: 300, ppid: 200, created: 1200n }, // внук
    { pid: 400, ppid: 100, created: 500n }, // сторож: его родитель «100» умер давно, PID переиспользован
    { pid: 500, ppid: 400, created: 600n }, // ребёнок сторожа (хаб)
  ];
  assert.deepEqual(descendants(100, rows).sort(), [200, 300]);
  assert.deepEqual(descendants(999, rows), []);
});

test("killTree убивает настоящее дерево процессов", { skip: process.platform !== "win32" }, async () => {
  // родитель запускает ребёнка и печатает его PID
  const parent = spawn(
    process.execPath,
    ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );
  const childPid = await new Promise<number>((r) => parent.stdout!.once("data", (d: Buffer) => r(Number(String(d).trim()))));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(childPid), "ребёнок запущен");
  const exited = new Promise((r) => parent.once("exit", r));
  killTree(parent);
  await exited;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!alive(childPid), "ребёнок тоже убит");
});
