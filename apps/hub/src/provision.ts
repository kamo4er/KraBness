// Настроить свой сервер (VPS) из интерфейса: хаб один раз заходит по SSH с паролем или ключом владельца, заливает
// свой scripts/vps-setup.sh (не с GitHub: из приватной репы это 404, а у сборок разный набор), запускает его от root
// (или через sudo) и забирает итог. Пароль живёт только на время операции: не сохраняется и в журнал не пишется.
import { createHash, randomBytes } from "node:crypto";
import { Client, type ConnectConfig } from "ssh2";
import type { ProvisionRequest } from "@kamharn/protocol";
import { L } from "./lang.ts";

export interface ProvisionResult {
  /** адрес сервера и пользователь туннеля — как их напечатал скрипт */
  host: string;
  user: string;
  url: string;
  /** отпечаток ключа сервера SHA256 (как у ssh) — показать человеку */
  hostKey: string;
}

/** строка журнала из вывода скрипта: без управляющих символов, обрезанная */
const clean = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 400);

/** одинарные кавычки для bash: аргументы скрипта уже проверены, но кавычки всё равно ставим как положено */
const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

export async function provisionVps(o: {
  req: ProvisionRequest;
  script: string;
  args: string[];
  log: (line: string) => void;
  /** тесты подставляют время ожидания */
  readyTimeout?: number;
  /** вся настройка не дольше этого (связь могла тихо пропасть посреди скрипта) */
  totalTimeout?: number;
  /** хаб закрывается — рвём соединение, а не держим процесс */
  signal?: AbortSignal;
}): Promise<ProvisionResult> {
  const { req } = o;
  if (!req.password && !req.privateKey) throw new Error(L("Нужен пароль или ключ", "A password or a key is required"));
  const conn = new Client();
  let hostKey = "";
  // ошибки соединения: до подключения первая уходит в отказ, дальше — в журнал. Слушатель стоит с самого начала:
  // ssh2 может бросить вторую ошибку (ECONNRESET после отказа во входе), а без слушателя она уронила бы весь хаб
  let fail: ((e: Error) => void) | undefined;
  conn.on("error", (e: Error & { level?: string }) => {
    if (fail) {
      const f = fail;
      fail = undefined;
      return f(e);
    }
    o.log(`✗ ${L("Связь с сервером оборвалась", "The connection to the server dropped")}: ${e.message}`);
  });
  // тихий обрыв (сменилась сеть, VPN) иначе не заметить: без keepalive ждали бы данных вечно, и настройка висела бы «идёт»
  let timedOut = false;
  const timer = setTimeout(() => ((timedOut = true), conn.destroy()), o.totalTimeout ?? 15 * 60_000);
  const onAbort = () => conn.destroy();
  o.signal?.addEventListener("abort", onAbort);
  const cfg: ConnectConfig = {
    host: req.host,
    port: req.sshPort ?? 22,
    username: req.user,
    readyTimeout: o.readyTimeout ?? 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    // первое знакомство с сервером: доверяем и показываем отпечаток (туннель потом сверяет свой known_hosts так же)
    hostVerifier: (key: Buffer) => {
      hostKey = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
      return true;
    },
    ...(req.privateKey ? { privateKey: req.privateKey } : {}),
    ...(req.password ? { password: req.password, tryKeyboard: true } : {}),
  };
  // часть серверов спрашивает пароль через keyboard-interactive, а не password
  conn.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => req.password ?? "")));
  try {
    await new Promise<void>((resolve, reject) => {
      conn.once("ready", () => ((fail = undefined), resolve()));
      fail = (e: Error & { level?: string }) =>
        reject(
          new Error(
            e.level === "client-authentication"
              ? L("Сервер не пустил: неверный логин, пароль или ключ", "The server refused: wrong login, password or key")
              : `${L("Не подключиться к серверу", "Can't connect to the server")}: ${e.message}`,
          ),
        );
      // destroy (таймаут, закрытие хаба) до ready — тоже отказ, а не вечное ожидание
      conn.once("close", () => fail?.(new Error(L("соединение закрыто", "the connection was closed"))));
      conn.connect(cfg);
    });
  } catch (e) {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    conn.end();
    throw e;
  }
  o.log(L(`Подключился к ${req.host}, ключ сервера ${hostKey}`, `Connected to ${req.host}, server key ${hostKey}`));

  const exec = (cmd: string, input?: string, onLine?: (line: string) => void) =>
    new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      // соединение порвали (таймаут, закрытие хаба, сеть) — команда кончилась, даже если close у потока не пришёл
      const gone = () => reject(new Error(timedOut ? L("Настройка шла дольше 15 минут — связь, похоже, пропала", "The setup took over 15 minutes — the connection seems to be lost") : L("Связь с сервером оборвалась", "The connection to the server dropped")));
      conn.once("close", gone);
      conn.exec(cmd, (err, stream) => {
        if (err) return (conn.off("close", gone), reject(err));
        let out = "";
        let errOut = "";
        let buf = "";
        stream.on("data", (d: Buffer) => {
          const s = d.toString("utf8");
          out += s;
          if (!onLine) return;
          buf += s;
          const lines = buf.split(/\r?\n/);
          buf = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) onLine(clean(l));
        });
        stream.stderr.on("data", (d: Buffer) => {
          const s = d.toString("utf8");
          errOut += s;
          if (onLine) for (const l of s.split(/\r?\n/)) if (l.trim()) onLine(clean(l));
        });
        stream.on("close", (code: number | null) => {
          conn.off("close", gone);
          if (onLine && buf.trim()) onLine(clean(buf));
          resolve({ code: code ?? 1, out, err: errOut });
        });
        if (input !== undefined) stream.end(input);
      });
    });

  const file = `/tmp/krabness-vps-setup-${randomBytes(6).toString("hex")}.sh`;
  try {
    const root = (await exec("id -u")).out.trim() === "0";
    const put = await exec(`umask 077 && cat > ${file}`, o.script);
    if (put.code !== 0) throw new Error(`${L("Не залить скрипт на сервер", "Couldn't upload the script")}: ${put.err.trim().slice(0, 300)}`);
    o.log(L("Запускаю настройку (на свежем сервере — пара минут: ставится Caddy)", "Running the setup (a couple of minutes on a fresh server: Caddy is being installed)"));
    const cmd = `bash ${file} ${o.args.map(sq).join(" ")}`;
    // не root: sudo берёт пароль из stdin (-S), без приглашения (-p ''); с ключом и без пароля — только sudo без пароля (-n)
    const run = root
      ? await exec(cmd, undefined, o.log)
      : req.password
        ? await exec(`sudo -S -p '' ${cmd}`, req.password + "\n", o.log)
        : await exec(`sudo -n ${cmd}`, undefined, o.log);
    if (run.code !== 0) {
      // причину скрипт пишет строкой «KraBness: …» (дальше могут идти подробности — они уже в журнале)
      const lines = (run.err || run.out).trim().split(/\r?\n/);
      const why = (lines.find((l) => l.startsWith("KraBness: ")) ?? lines.slice(-3).join(" ")).slice(0, 400);
      throw new Error(`${L("Настройка сервера не удалась", "The server setup failed")}: ${clean(why)}`);
    }
    const ok = /^KRABNESS-OK (\S+) (\S+) (https?:\/\/\S+)$/m.exec(run.out);
    if (!ok) throw new Error(L("Скрипт отработал, но не сообщил адрес — посмотри журнал", "The script finished but didn't report the address — see the log"));
    return { host: ok[1]!, user: ok[2]!, url: ok[3]!, hostKey };
  } finally {
    await exec(`rm -f ${file}`).catch(() => undefined);
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
    conn.end();
  }
}
