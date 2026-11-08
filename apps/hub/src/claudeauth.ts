// Вход в Claude Code у того, кто поставил KraBness: вход хранится в ~/.claude его ПК, KraBness его не трогает.
// Статус — у движка (`claude auth status`). Здесь: свой API-ключ Anthropic (вместо подписки; хаб передаёт его claude
// как ANTHROPIC_API_KEY, ключ проверяется у Anthropic до сохранения и наружу не отдаётся) и окно входа на ПК.
import { spawn } from "node:child_process";
import { fetch as undiciFetch } from "undici";
import type { ClaudeAuthInfo } from "@kamharn/protocol";
import type { ConfigStore } from "./config.ts";
import type { ClaudeEngine } from "./engines/claude.ts";
import { HttpError } from "./sessions.ts";
import { L } from "./lang.ts";

export interface ClaudeLoginDeps {
  engine: () => ClaudeEngine | undefined;
  /** https://api.anthropic.com (тесты подставляют свой) */
  api?: string;
  /** открыть на ПК окно терминала с командой (тесты подставляют заглушку); env — окружение окна */
  openTerminal?: (bin: string, env: NodeJS.ProcessEnv) => void;
  log: (m: string) => void;
}

/** Окно cmd на рабочем столе ПК с `claude auth login`: дальше браузер, как при обычном входе. */
function openLoginWindow(bin: string, env: NodeJS.ProcessEnv): void {
  if (process.platform !== "win32") throw new HttpError(501, L("Вход из интерфейса пока только на Windows: запусти `claude auth login` в терминале", "Signing in from the UI is Windows only for now: run `claude auth login` in a terminal"));
  // start открывает отдельное видимое окно; кавычки вокруг пути — на случай пробелов, внешние снимает cmd /k
  const p = spawn("cmd.exe", ["/c", `start "Claude Code" cmd /k ""${bin}" auth login"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, env });
  p.unref();
}

export class ClaudeLogin {
  constructor(
    private config: ConfigStore,
    private deps: ClaudeLoginDeps,
  ) {}

  private get engine(): ClaudeEngine {
    const e = this.deps.engine();
    if (!e) throw new HttpError(409, L("Движок Claude выключен в настройках", "The Claude engine is disabled in the config"));
    return e;
  }

  status(force = true): ClaudeAuthInfo & { error?: string } {
    return this.engine.authInfo(force);
  }

  login(): { ok: true } {
    const e = this.engine;
    (this.deps.openTerminal ?? openLoginWindow)(e.binPath, process.env);
    this.deps.log(L("[claude] открыл на ПК окно входа (claude auth login)", "[claude] opened the sign-in window on the PC (claude auth login)"));
    return { ok: true };
  }

  /** Свой API-ключ: проверяем у Anthropic, сохраняем, процессы claude подхватят его со следующего сообщения. Пустой — убрать. */
  async setKey(raw: string | null): Promise<ClaudeAuthInfo & { error?: string }> {
    const e = this.engine;
    const key = (raw ?? "").trim();
    if (key) {
      if (!/^sk-ant-\S+$/.test(key)) throw new HttpError(400, L("Это не похоже на ключ Anthropic (начинается с sk-ant-)", "This doesn't look like an Anthropic key (it starts with sk-ant-)"));
      let r: { status: number; ok: boolean };
      try {
        r = await undiciFetch(`${this.deps.api ?? "https://api.anthropic.com"}/v1/models`, {
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        const x = err as Error & { cause?: Error };
        throw new HttpError(502, `${L("Не достучался до Anthropic, ключ не сохранил", "Couldn't reach Anthropic, the key isn't saved")}: ${x.cause?.message ?? x.message}`);
      }
      if (r.status === 401 || r.status === 403) throw new HttpError(400, L("Anthropic не принял ключ", "Anthropic rejected the key"));
      if (!r.ok) throw new HttpError(502, `${L("Anthropic ответил", "Anthropic answered")} ${r.status}${L(", ключ не сохранил", ", the key isn't saved")}`);
    }
    this.config.setClaudeApiKey(key || undefined);
    this.deps.log(key ? L("[claude] сохранён свой API-ключ", "[claude] own API key saved") : L("[claude] свой API-ключ убран", "[claude] own API key removed"));
    e.restartIdle();
    return e.authInfo(true);
  }
}
