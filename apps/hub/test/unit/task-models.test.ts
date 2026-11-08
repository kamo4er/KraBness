// Выбор моделей для задачи в клиентах: умолчания и ключи вариантов.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultTaskModels, modelKey, modelOptions, optionReady, parseModelKey, type EngineInfo } from "@kamharn/client";

const claude = (loggedIn: boolean): EngineInfo => ({
  id: "claude",
  available: true,
  models: [
    { engine: "claude", providerId: "anthropic", modelId: "opus", name: "Opus" },
    { engine: "claude", providerId: "anthropic", modelId: "sonnet", name: "Sonnet" },
  ],
  defaultModel: { providerId: "anthropic", modelId: "opus" },
  auth: { installed: true, loggedIn, apiKey: false },
});
const opencode: EngineInfo = {
  id: "opencode",
  available: true,
  models: [
    { engine: "opencode", providerId: "opencode", modelId: "free", name: "Free", free: true },
    { engine: "opencode", providerId: "lmstudio", modelId: "qwen/coder", name: "Qwen", offline: true },
    { engine: "opencode", providerId: "opencode", modelId: "glm", name: "GLM", free: true },
  ],
  defaultModel: { providerId: "opencode", modelId: "free" },
};

test("умолчания: Claude подключён — делает он, ревью opencode; нет Claude — всё на opencode", () => {
  assert.deepEqual(defaultTaskModels([claude(true), opencode]), { worker: "claude|anthropic/opus", review: "opencode|opencode/free" });
  assert.deepEqual(defaultTaskModels([claude(false), opencode]), { worker: "opencode|opencode/free", review: "opencode|opencode/free" });
  // модель из настройки «Движки» важнее модели движка по умолчанию
  assert.equal(defaultTaskModels([claude(true), opencode], { engines: ["opencode", "claude"], engine: "opencode", models: { opencode: { providerId: "opencode", modelId: "glm" } } }).review, "opencode|opencode/glm");
  // только Claude — ревьюит тоже он
  assert.deepEqual(defaultTaskModels([claude(true)]), { worker: "claude|anthropic/opus", review: "claude|anthropic/opus" });
  assert.deepEqual(defaultTaskModels([]), {});
});

test("варианты: без недоступных движков; спящая локальная модель видна, но не выбирается; ключ с «/» в имени модели", () => {
  const opts = modelOptions([claude(false), opencode]);
  assert.deepEqual(
    opts.map((o) => o.key),
    ["opencode|opencode/free", "opencode|lmstudio/qwen/coder", "opencode|opencode/glm"],
  );
  assert.equal(optionReady(opts, "opencode|lmstudio/qwen/coder"), false, "не в сети — выбрать нельзя");
  assert.equal(optionReady(opts, "opencode|opencode/glm"), true);
  // спящая модель не становится умолчанием, даже если стоит первой
  const sleepy: EngineInfo = { ...opencode, models: [opencode.models[1]!, ...opencode.models], defaultModel: { providerId: "lmstudio", modelId: "qwen/coder" } };
  assert.equal(defaultTaskModels([sleepy]).worker, "opencode|opencode/free");
  const k = modelKey("opencode", { providerId: "lmstudio", modelId: "qwen/coder" });
  assert.deepEqual(parseModelKey(k), { engine: "opencode", model: { providerId: "lmstudio", modelId: "qwen/coder" } });
  assert.equal(parseModelKey("gpt|x/y"), undefined);
  assert.equal(parseModelKey("none"), undefined);
});
