import type { ClaudeLimits, EngineId, EngineInfo, ModelRef, PartDelta, PermissionMode, PermissionReply, QuestionAnswers, SessionEvent } from "@kamharn/protocol";

/** Куда движок отдаёт нормализованные события. Адресация — по id сессии движка. */
export interface EngineSink {
  event(engineSessionId: string, ev: SessionEvent): void;
  delta(engineSessionId: string, d: PartDelta): void;
  /** лимиты подписки (claude) */
  limits?(l: ClaudeLimits): void;
}

export interface PromptFile {
  fileId: string;
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface Engine {
  readonly id: EngineId;
  start(sink: EngineSink): Promise<void>;
  stop(): Promise<void>;
  info(): Promise<EngineInfo>;
  /** Создаёт сессию в движке и возвращает её id. */
  createSession(o: {
    directory: string;
    model: ModelRef;
    permissionMode: PermissionMode;
    title?: string;
    /** продолжить копию сессии Claude Code */
    forkFrom?: string;
    /** агент работает только в своей папке (шаг задачи в копии проекта): за её пределы — отказ без вопроса */
    confined?: boolean;
  }): Promise<string>;
  /** Восстановление связи с уже существующей сессией (после перезапуска хаба). */
  attach(engineSessionId: string, o: { directory: string; model: ModelRef; permissionMode: PermissionMode; hasHistory: boolean }): void;
  /** system — системный промпт группы сессии (добавляется к стандартному) */
  /** effort — уровень рассуждений (claude: --effort, opencode: variant) */
  prompt(engineSessionId: string, o: { text: string; files: PromptFile[]; model: ModelRef; system?: string; effort?: string }): Promise<void>;
  abort(engineSessionId: string): Promise<void>;
  replyPermission(engineSessionId: string, requestId: string, reply: PermissionReply): Promise<void>;
  /** Ответ на вопрос агента (null — пользователь отказался отвечать). */
  replyQuestion(engineSessionId: string, requestId: string, answers: QuestionAnswers): Promise<void>;
  /** Смена режима подтверждений на ходу. Ждущие запросы, которые новый режим разрешает, одобряются. */
  setPermissionMode(engineSessionId: string, mode: PermissionMode): Promise<void>;
  /** Перезапустить простаивающие процессы, чтобы применились новые настройки. */
  restartIdle?(): void;
  /** Скиллы, о которых движок знает по последнему запуску (claude: system:init). */
  slashSkills?(): string[];
  /** Сжать контекст агента (пересказ вместо истории); ход идёт как обычный, итог — часть compaction в ленте. */
  compact?(engineSessionId: string, o: { model: ModelRef; system?: string; effort?: string }): Promise<void>;
  /** Сессию удалили в хабе: освободить ресурсы (процессы, подписки). */
  forget(engineSessionId: string): void;
}
