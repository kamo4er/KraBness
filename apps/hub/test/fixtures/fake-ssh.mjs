// Поддельный ssh для remote.test.ts: по-настоящему делает -R (слушает порт «на VPS» и пробрасывает на хаб).
// Пользователь «denied» — отказ по ключу, как настоящий ssh. Аргументы и pid пишутся в FAKE_SSH_LOG.
import { appendFileSync } from "node:fs";
import { createServer, connect } from "node:net";

const args = process.argv.slice(2);
if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ pid: process.pid, args }) + "\n");
const target = args[args.length - 1];
if (target.startsWith("denied@")) {
  process.stderr.write("denied@127.0.0.1: Permission denied (publickey).\r\n");
  process.exit(255);
}
const [bindHost, bindPort, toHost, toPort] = args[args.indexOf("-R") + 1].split(":");
const srv = createServer((sock) => {
  const up = connect(Number(toPort), toHost);
  sock.pipe(up).pipe(sock);
  up.on("error", () => sock.destroy());
  sock.on("error", () => up.destroy());
});
srv.on("error", () => {
  process.stderr.write(`Error: remote port forwarding failed for listen port ${bindPort}\n`);
  process.exit(255);
});
srv.listen(Number(bindPort), bindHost);
// -L: локальный порт → порт «на VPS» (в тесте — тоже на этой машине)
args.forEach((a, i) => {
  if (a !== "-L") return;
  const [lh, lp, th, tp] = args[i + 1].split(":");
  createServer((sock) => {
    const up = connect(Number(tp), th);
    sock.pipe(up).pipe(sock);
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  }).listen(Number(lp), lh);
});
