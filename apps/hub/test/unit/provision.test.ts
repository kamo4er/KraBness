// Настройка сервера из интерфейса: хаб по SSH (пароль или ключ) заливает vps-setup.sh и запускает его.
// SSH-сервер поддельный (тот же ssh2): что пришло, тем и отвечает; сам скрипт не выполняется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ssh2 from "ssh2";
import { provisionVps } from "../../src/provision.ts";
import { ConfigStore } from "../../src/config.ts";
import { RemoteTunnel } from "../../src/remote.ts";

const { Server, utils } = ssh2;
const PASSWORD = "s3cret pass";

/** поддельный сервер: root и ubuntu (с sudo) по паролю; bash отвечает строкой итога или падает */
async function fakeServer(opts: { fail?: boolean; url?: string; hang?: boolean; out?: string } = {}) {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const seen = { uploaded: "", commands: [] as string[], sudoInput: "" };
  const srv = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ["root", "ubuntu"].includes(ctx.username) && ctx.password === PASSWORD) return ctx.accept();
      ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acc, _rej, info) => {
          const stream = acc();
          const cmd = info.command;
          seen.commands.push(cmd);
          let input = "";
          stream.on("data", (d: Buffer) => (input += d.toString()));
          const done = (code: number) => (stream.exit(code), stream.end());
          if (cmd === "id -u") return (stream.write((client as unknown as { user?: string }).user === "ubuntu" ? "1000\n" : "0\n"), done(0));
          if (cmd.startsWith("umask 077 && cat > /tmp/krabness-vps-setup-")) return stream.on("end", () => ((seen.uploaded = input), done(0)));
          if (cmd.startsWith("rm -f /tmp/krabness-vps-setup-")) return done(0);
          if (/^(sudo -S -p '' )?bash \/tmp\/krabness-vps-setup-/.test(cmd)) {
            const run = () => {
              if (cmd.startsWith("sudo")) seen.sudoInput = input;
              stream.write("==> installing Caddy\n");
              // связь «тихо пропала»: скрипт не кончается и молчит
              if (opts.hang) return;
              if (opts.fail) {
                stream.stderr.write("KraBness: ports 80/443 are taken by another program\n");
                return done(1);
              }
              stream.write(`Done.\n${opts.out ?? `KRABNESS-OK 203.0.113.5 krabtunnel ${opts.url ?? "https://krab.203-0-113-5.sslip.io"}`}\n`);
              done(0);
            };
            // sudo ждёт пароль в stdin, root — нет
            return cmd.startsWith("sudo") ? stream.once("data", () => setTimeout(run, 20)) : run();
          }
          stream.stderr.write(`unknown: ${cmd}\n`);
          done(127);
        });
      });
    });
    // имя пользователя — для «id -u»
    client.on("authentication", (ctx) => void ((client as unknown as { user?: string }).user = ctx.username));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { srv, port: (srv.address() as AddressInfo).port, seen };
}

const SCRIPT = "#!/usr/bin/env bash\necho setup\n";
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample krabness-hub-tunnel";

test("root по паролю: скрипт залит как есть, ключ туннеля передан, итог разобран, журнал по шагам", async () => {
  const f = await fakeServer();
  const log: string[] = [];
  try {
    const r = await provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD }, script: SCRIPT, args: ["--key", KEY], log: (l) => log.push(l) });
    assert.deepEqual({ host: r.host, user: r.user, url: r.url }, { host: "203.0.113.5", user: "krabtunnel", url: "https://krab.203-0-113-5.sslip.io" });
    assert.match(r.hostKey, /^SHA256:[A-Za-z0-9+/]{40,}$/, "отпечаток ключа сервера");
    assert.equal(f.seen.uploaded, SCRIPT, "залит свой скрипт");
    const run = f.seen.commands.find((c) => c.startsWith("bash "))!;
    assert.ok(run.endsWith(`'--key' '${KEY}'`), run);
    assert.ok(f.seen.commands.some((c) => c.startsWith("rm -f /tmp/krabness-vps-setup-")), "временный файл убран");
    assert.ok(log.some((l) => /installing Caddy/.test(l)), "строки скрипта — в журнале");
    assert.ok(!log.join("\n").includes(PASSWORD), "пароля в журнале нет");
  } finally {
    f.srv.close();
  }
});

test("не root: через sudo, пароль — в stdin, а не в командной строке", async () => {
  const f = await fakeServer();
  try {
    const r = await provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "ubuntu", password: PASSWORD }, script: SCRIPT, args: ["--key", KEY], log: () => {} });
    assert.equal(r.user, "krabtunnel");
    const run = f.seen.commands.find((c) => c.includes("bash /tmp/"))!;
    assert.match(run, /^sudo -S -p '' bash /);
    assert.ok(!run.includes(PASSWORD), "пароль не в команде");
    assert.equal(f.seen.sudoInput, PASSWORD + "\n");
  } finally {
    f.srv.close();
  }
});

test("неверный пароль — понятная ошибка; скрипт упал — его последние строки в ошибке", async () => {
  const f = await fakeServer({ fail: true });
  try {
    await assert.rejects(provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "root", password: "wrong" }, script: SCRIPT, args: [], log: () => {} }), /неверный логин|wrong login/);
    await assert.rejects(provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD }, script: SCRIPT, args: [], log: () => {} }), /ports 80\/443 are taken/);
    await assert.rejects(provisionVps({ req: { host: "127.0.0.1", sshPort: 1, user: "root", password: PASSWORD }, script: SCRIPT, args: [], log: () => {}, readyTimeout: 3000 }), /Не подключиться|Can't connect/);
  } finally {
    f.srv.close();
  }
});

test("из «Удалённого доступа»: фоном, потом адрес сохранён и туннель включён; пароль нигде не остался", async () => {
  // адрес на этом ПК, где никто не слушает: проверка «снаружи» отказывает сразу, без интернета
  const f = await fakeServer({ url: "http://127.0.0.1:9" });
  const dir = mkdtempSync(join(tmpdir(), "kh-provision-"));
  mkdirSync(join(dir, "repo", "scripts"), { recursive: true });
  writeFileSync(join(dir, "repo", "scripts", "vps-setup.sh"), SCRIPT);
  const config = new ConfigStore(join(dir, "k.json"));
  const tunnelSrv = createNetServer();
  await new Promise<void>((r) => tunnelSrv.listen(0, "127.0.0.1", () => r()));
  // туннель — поддельный ssh из соседнего теста; до «снаружи» он не достанет, это и проверим
  const rt = new RemoteTunnel({
    config,
    version: "test",
    log: () => {},
    dataDir: dir,
    sshBin: process.execPath,
    sshPrefix: [join(import.meta.dirname, "..", "fixtures", "fake-ssh.mjs")],
    upAfterMs: 100,
    repoRoot: join(dir, "repo"),
    provisionChecks: 2,
    provisionPauseMs: 50,
  });
  try {
    await rt.start((tunnelSrv.address() as AddressInfo).port);
    assert.throws(() => rt.startProvision({ host: "127.0.0.1", sshPort: f.port, user: "root" }), /пароль или ключ|password or key/);
    assert.throws(() => rt.startProvision({ host: "-oProxyCommand=x", password: PASSWORD }), /Адрес сервера|Server address/);
    const job = rt.startProvision({ host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD });
    assert.equal(job.running, true);
    assert.throws(() => rt.startProvision({ host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD }), /уже идёт|already running/, "второй раз — нельзя");
    for (let i = 0; i < 200 && rt.provisionStatus().running; i++) await new Promise((r) => setTimeout(r, 25));
    const st = rt.provisionStatus();
    assert.equal(st.error, undefined, st.log.join("\n"));
    assert.equal(st.done?.url, "http://127.0.0.1:9");
    assert.equal(st.done?.reachable, false, "снаружи поддельный туннель не отвечает — так и сказано");
    assert.ok(st.done?.note);
    const saved = config.config.remote!;
    assert.deepEqual({ host: saved.host, user: saved.user, url: saved.url, sshPort: saved.sshPort, enabled: saved.enabled }, { host: "127.0.0.1", user: "krabtunnel", url: "http://127.0.0.1:9", sshPort: f.port, enabled: true }, "туннель — туда, куда заходили, а не на IP из вывода скрипта");
    assert.equal(f.seen.uploaded, SCRIPT, "залит скрипт из repoRoot");
    assert.ok(f.seen.commands.find((c) => c.startsWith("bash "))!.includes(readFileSync(join(dir, "remote_ed25519.pub"), "utf8").trim()), "ключ туннеля этого хаба");
    assert.ok(!readFileSync(join(dir, "k.json"), "utf8").includes(PASSWORD), "пароля нет в конфиге");
    assert.ok(!JSON.stringify(st).includes(PASSWORD), "и в статусе");
  } finally {
    rt.close();
    tunnelSrv.close();
    f.srv.close();
  }
});


test("связь тихо пропала посреди скрипта — настройка кончается по таймауту; закрытие хаба рвёт её сразу", async () => {
  const f = await fakeServer({ hang: true });
  try {
    const t0 = Date.now();
    await assert.rejects(
      provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD }, script: SCRIPT, args: [], log: () => {}, totalTimeout: 800 }),
      /дольше 15 минут|took over 15 minutes/,
    );
    assert.ok(Date.now() - t0 < 5000, "не висит");
    const abort = new AbortController();
    const run = provisionVps({ req: { host: "127.0.0.1", sshPort: f.port, user: "root", password: PASSWORD }, script: SCRIPT, args: [], log: () => {}, signal: abort.signal });
    setTimeout(() => abort.abort(), 300);
    await assert.rejects(run, /оборвалась|dropped/);
  } finally {
    f.srv.close();
  }
});
