// Пробуждение ПК: поиск сетевых карт, настройка (токен не отдаётся, пустой — прежний), данные для приложения,
// проверка будильника (поддельный wake.py на localhost, в т. ч. старая версия без ?host=).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { Wake, wakeNics } from "../../src/wake.ts";

const nic = (address: string, netmask: string, mac: string, internal = false) => ({ address, netmask, mac, family: "IPv4" as const, internal, cidr: null });

test("wake: сетевые карты — только физические с домашним адресом, широковещательный по маске", () => {
  const list = wakeNics({
    Ethernet: [nic("192.168.1.40", "255.255.255.0", "02:11:22:33:44:55")],
    "Wi-Fi": [nic("10.0.5.7", "255.255.0.0", "11:22:33:44:55:66")],
    Tailscale: [nic("100.64.0.10", "255.255.255.255", "00:00:00:00:00:00")],
    "vEthernet (WSL)": [nic("172.20.0.1", "255.255.240.0", "00:15:5d:00:00:01")],
    "Loopback Pseudo-Interface 1": [nic("127.0.0.1", "255.0.0.0", "00:00:00:00:00:00", true)],
    AmneziaVPN: [nic("10.8.1.2", "255.255.255.0", "00:ff:aa:bb:cc:dd")],
  } as never);
  assert.deepEqual(list, [
    { name: "Ethernet", mac: "02:11:22:33:44:55", address: "192.168.1.40", broadcast: "192.168.1.255" },
    { name: "Wi-Fi", mac: "11:22:33:44:55:66", address: "10.0.5.7", broadcast: "10.0.255.255" },
  ]);
});

test("wake: настройка, данные для приложения, проверка будильника (новый и старый wake.py)", async () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  const seen: string[] = [];
  let oldRelay = false;
  const relay = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    if (req.headers.authorization !== `Bearer ${"t".repeat(20)}`) return void res.writeHead(401).end();
    if (oldRelay && req.url !== "/status") return void res.writeHead(404).end();
    res.end(JSON.stringify({ pc: "online" }));
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const wake = new Wake(config, { pcHost: () => "100.64.0.10", pcPort: () => 7420, nics: () => [] });
  try {
    assert.throws(() => wake.runtime(), /не настроено/);
    assert.equal(wake.setup().configured, false);
    assert.throws(() => wake.save({ url: "не адрес", token: "t".repeat(20), mac: "02:11:22:33:44:55", broadcast: "192.168.1.255" }), /Адрес будильника/);
    assert.throws(() => wake.save({ url, token: "короткий", mac: "02:11:22:33:44:55", broadcast: "192.168.1.255" }), /16 символов/);
    assert.throws(() => wake.save({ url, token: "t".repeat(20), mac: "нет", broadcast: "192.168.1.255" }), /сетевую карту/);
    assert.throws(() => wake.save({ url, token: "t".repeat(20), mac: "02:11:22:33:44:55", broadcast: "x" }), /Широковещательный/);

    const st = wake.save({ url: url + "/", token: "t".repeat(20), mac: "02:11:22:33:44:55", broadcast: "192.168.1.255" });
    assert.equal(st.configured, true);
    assert.ok(!JSON.stringify(st).includes("t".repeat(20)), "токен в настройках не светится");
    assert.deepEqual(wake.runtime(), { url, token: "t".repeat(20), mac: "02:11:22:33:44:55", broadcast: "192.168.1.255", pcHost: "100.64.0.10", pcPort: 7420 });
    // правка без токена — прежний
    wake.save({ url, token: "", mac: "11:22:33:44:55:66", broadcast: "10.0.255.255" });
    assert.equal(config.config.wake!.token, "t".repeat(20));
    assert.ok(Wake.newToken().length >= 32);

    assert.deepEqual(await wake.test(), { pc: "online" });
    assert.equal(seen.at(-1), `GET /status?host=100.64.0.10&port=7420 Bearer ${"t".repeat(20)}`);
    // старый wake.py на NAS: /status?host=… → 404, повторяем без параметров
    oldRelay = true;
    assert.deepEqual(await wake.test(), { pc: "online" });
    assert.equal(seen.at(-1)!.split(" ")[1], "/status");
    // неверный токен — понятная ошибка
    config.setWake({ ...config.config.wake!, token: "x".repeat(20) });
    await assert.rejects(wake.test(), /не принял токен/);
    wake.remove();
    assert.equal(config.config.wake, undefined);
    // будильник выключен
    wake.save({ url: "http://127.0.0.1:9", token: "t".repeat(20), mac: "02:11:22:33:44:55", broadcast: "192.168.1.255" });
    await assert.rejects(wake.test(), /не отвечает/);
  } finally {
    relay.close();
  }
});
