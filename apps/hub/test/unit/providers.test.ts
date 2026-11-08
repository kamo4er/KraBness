// Провайдеры моделей: список (подключённые и популярные сверху), ключ + авто-избранное, вход по подписке в фоне,
// свои серверы (адрес, поиск моделей, перезапуск opencode), отключение.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../../src/config.ts";
import { normalizeBaseUrl, Providers } from "../../src/providers.ts";

const models = (n: number, prefix: string) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${i}`, { id: `${prefix}-${i}`, name: `${prefix} ${i}`, release_date: `2026-01-${String(i + 1).padStart(2, "0")}`, capabilities: { toolcall: i % 2 === 0 }, cost: { input: 1, output: 1 } }]));

function fakeOc() {
  const calls: string[] = [];
  const connected = new Set(["opencode"]);
  let releaseOauth: (ok: boolean) => void = () => {};
  const oc = {
    calls,
    connected,
    finishOauth: (ok: boolean) => releaseOauth(ok),
    providers: async () => ({
      all: [
        { id: "opencode", name: "OpenCode Zen", models: models(3, "zen") },
        { id: "zhipuai", name: "Zhipu AI", models: models(5, "glm") },
        { id: "openai", name: "OpenAI", models: models(30, "gpt") },
        { id: "openrouter", name: "OpenRouter", models: models(50, "or") },
        { id: "anthropic", name: "Anthropic", models: models(4, "claude") },
      ],
      connected: [...connected],
    }),
    authMethods: async () => ({ openai: [{ type: "oauth", label: "ChatGPT Pro/Plus (browser)" }, { type: "oauth", label: "ChatGPT Pro/Plus (headless)" }, { type: "api", label: "Manually enter API Key" }] }),
    setKey: async (id: string, key: string) => void (calls.push(`key ${id} ${key}`), connected.add(id)),
    oauthAuthorize: async (id: string, method: number) => (calls.push(`authorize ${id} ${method}`), { url: "https://auth.openai.com/codex/device", method: "auto" as const, instructions: "Enter code: AB12-CD34" }),
    oauthCallback: (id: string) => new Promise<boolean>((res) => (releaseOauth = (ok) => (ok && connected.add(id), res(ok)))),
    disconnect: async (id: string) => void (calls.push(`disconnect ${id}`), connected.delete(id)),
    restart: async () => void calls.push("restart"),
  };
  return oc;
}

const setup = () => {
  const config = new ConfigStore(join(mkdtempSync(join(tmpdir(), "kamharn-")), "cfg.json"), {});
  const oc = fakeOc();
  return { config, oc, p: new Providers(oc as never, config) };
};

test("normalizeBaseUrl: голый адрес → http://…/v1, путь и https сохраняются", () => {
  assert.equal(normalizeBaseUrl("localhost:1234"), "http://localhost:1234/v1");
  assert.equal(normalizeBaseUrl("http://192.168.1.5:11434/"), "http://192.168.1.5:11434/v1");
  assert.equal(normalizeBaseUrl("https://api.example.com/openai/v1/"), "https://api.example.com/openai/v1");
  assert.throws(() => normalizeBaseUrl("  "), /Нужен адрес/);
});

test("список: подключённые первыми, потом популярные по порядку, opencode скрыт; способы входа от opencode", async () => {
  const { p, oc } = setup();
  oc.connected.add("zhipuai");
  const list = await p.list();
  assert.deepEqual(list.map((e) => e.id), ["zhipuai", "openai", "openrouter", "anthropic"]);
  assert.equal(list[0]!.connected, true);
  assert.equal(list.find((e) => e.id === "openai")!.popular, true);
  assert.deepEqual(list.find((e) => e.id === "openai")!.methods.map((m) => [m.index, m.type]), [[0, "oauth"], [1, "oauth"], [2, "api"]]);
  assert.deepEqual(list.find((e) => e.id === "anthropic")!.methods, [{ index: 0, type: "api", label: "API-ключ" }], "нет способов — по ключу");
});

test("ключ: у большого провайдера сразу 8 свежих моделей с инструментами в избранном, у маленького — все", async () => {
  const { p, config } = setup();
  await p.setKey("openrouter", "  sk-or-1  ");
  const fav = config.config.modelFavorites!.openrouter!;
  assert.equal(fav.length, 8);
  assert.equal(fav[0], "or-48", "самые свежие первыми, только с инструментами (чётные)");
  assert.ok(fav.every((id) => Number(id.split("-")[1]) % 2 === 0));
  await p.setKey("anthropic", "sk-ant");
  assert.equal(config.config.modelFavorites!.anthropic, undefined, "4 модели — показываем все");
  await assert.rejects(p.setKey("openai", " "), /Пустой ключ/);

  // ручная правка избранного; пустой список — снова все
  p.setFavorites("openrouter", ["or-1", "or-1", "or-3"]);
  assert.deepEqual(config.config.modelFavorites!.openrouter, ["or-1", "or-3"]);
  assert.equal((await p.models("openrouter")).filter((m) => m.favorite).length, 2);
  p.setFavorites("openrouter", []);
  assert.equal(config.config.modelFavorites!.openrouter, undefined);
});

test("вход по подписке: ссылка и код сразу, хаб ждёт окончания в фоне", async () => {
  const { p, oc, config } = setup();
  const r = await p.oauthStart("openai", 1);
  assert.deepEqual(r, { url: "https://auth.openai.com/codex/device", instructions: "Enter code: AB12-CD34", method: "auto" });
  assert.equal(p.oauthStatus("openai").status, "waiting");
  oc.finishOauth(true);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(p.oauthStatus("openai").status, "done");
  assert.equal(config.config.modelFavorites!.openai!.length, 8, "30 моделей — избранное отмечено");
});

test("свой сервер: поиск моделей, добавление с перезапуском opencode, отключение", async () => {
  const { config, oc } = setup();
  const http = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "http://127.0.0.1:1234/v1/models");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer lm-key");
    return new Response(JSON.stringify({ data: [{ id: "qwen3-coder-30b" }, { id: "gemma-3-12b" }] }));
  }) as typeof fetch;
  const p = new Providers(oc as never, config, () => {}, http);
  assert.deepEqual(await p.probe("127.0.0.1:1234", "lm-key"), ["qwen3-coder-30b", "gemma-3-12b"]);

  const down = new Providers(oc as never, config, () => {}, (async () => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch);
  await assert.rejects(down.probe("127.0.0.1:9"), /не отвечает.*Start Server/s);

  const a = await p.addCustom({ name: "LM Studio", baseURL: "127.0.0.1:1234", models: ["qwen3-coder-30b"] });
  const b = await p.addCustom({ name: "LM Studio", baseURL: "http://10.0.0.2:1234/v1", apiKey: " k ", models: ["x", "x"] });
  assert.equal(a.id, "my-lm-studio");
  assert.equal(b.id, "my-lm-studio-2", "одинаковые названия не затирают друг друга");
  assert.deepEqual(b, { id: "my-lm-studio-2", name: "LM Studio", baseURL: "http://10.0.0.2:1234/v1", models: ["x"], apiKey: "k" });
  assert.equal(config.config.customProviders!.length, 2);
  assert.deepEqual(oc.calls.filter((c) => c === "restart").length, 2, "opencode перечитывает конфиг");
  await assert.rejects(p.addCustom({ name: "x", baseURL: "localhost:1", models: [] }), /хотя бы одну модель/);

  await p.disconnect("my-lm-studio");
  assert.deepEqual(config.config.customProviders!.map((c) => c.id), ["my-lm-studio-2"]);
  await p.disconnect("openai");
  assert.ok(oc.calls.includes("disconnect openai"), "провайдер из каталога — ключ удаляется в opencode");
});
