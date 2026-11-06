// Действия сессии: меню ⋯ в шапке чата, палитра команд (веб), плашки включённого под шапкой.
// Одно описание на оба клиента, чтобы веб и приложение не расходились; рисует и выполняет каждый по-своему.
import type { ModelInfo, PermissionMode, SessionInfo } from "@kamharn/protocol";
import { t } from "./i18n.ts";

export type SessionActionId = "project" | "preview" | "worktree" | "checks" | "compact" | "talk" | "bot" | "search" | "delete";
export type SessionActionGroup = "project" | "agent" | "link" | "danger";

export interface SessionAction {
  id: SessionActionId;
  group: SessionActionGroup;
  icon: string;
  label: string;
  hint: string;
  /** слова для поиска в палитре: «телег» само не найдёт «Telegram» */
  keywords: string;
  /** переключатель: включён ли сейчас (нет поля — обычное действие) */
  on?: boolean;
  /** текст плашки под шапкой; есть — плашка видна */
  pill?: string;
  danger?: boolean;
}

export interface SessionActionsOpts {
  platform: "web" | "mobile";
  /** режим «Разговор» (только приложение) */
  talk?: boolean;
  /** у сессии подключён бот в Telegram; undefined — ещё не знаем */
  bot?: boolean;
}

export const branchName = (branch: string): string => branch.replace(/^kamharn\//, "");

export function sessionActions(s: SessionInfo, o: SessionActionsOpts): SessionAction[] {
  const mobile = o.platform === "mobile";
  const list: Array<SessionAction | false> = [
    { id: "project", group: "project", icon: "📁", label: t("Файлы и изменения", "Files and changes"), hint: t("git diff, файлы, терминал", "git diff, files, terminal"), keywords: "project files diff git terminal проект файлы изменения терминал" },
    { id: "preview", group: "project", icon: "▶", label: t("Превью dev-сервера", "Dev server preview"), hint: t("открыть сайт или игру проекта, замечания по вёрстке", "open the project's site or game, layout comments"), keywords: "preview port site comments превью сайт порт замечания вёрстка" },
    !!s.worktree && {
      id: "worktree",
      group: "project",
      icon: "⎇",
      label: t("Ветка сессии", "Session branch"),
      hint: t(`${s.worktree.branch} → влить или выбросить`, `${s.worktree.branch} → merge or discard`),
      keywords: "branch worktree merge discard git ветка влить выбросить",
      pill: `⎇ ${branchName(s.worktree.branch)}`,
    },
    {
      id: "checks",
      group: "agent",
      icon: "✅",
      label: t("Автопроверка", "Auto-check"),
      hint: t("тесты и сборка после хода агента, ошибки уходят ему", "tests and build after each agent turn, failures go back to the agent"),
      keywords: "check checks tests lint build автопроверка проверка тесты сборка",
      on: !!s.autoCheck,
      ...(s.autoCheck ? { pill: `✓ ${t("автопроверка", "auto-check")}` } : {}),
    },
    { id: "compact", group: "agent", icon: "🗜", label: t("Сжать контекст", "Compact the context"), hint: t("агент перескажет разговор сам себе и освободит место", "the agent summarizes the conversation for itself and frees up space"), keywords: "compact context summary сжать контекст пересказ" },
    mobile && {
      id: "talk",
      group: "agent",
      icon: "🗣",
      label: t("Разговор", "Talk mode"),
      hint: t("выключил микрофон — сообщение ушло, ответ звучит вслух", "mic off — the message is sent, the answer is read aloud"),
      keywords: "talk voice speech разговор голос озвучка",
      on: !!o.talk,
      ...(o.talk ? { pill: `🗣 ${t("разговор", "talk")}` } : {}),
    },
    {
      id: "bot",
      group: "link",
      icon: "✈",
      label: t("Бот в Telegram", "Telegram bot"),
      hint: t("писать этой сессии из Telegram, файлы туда-обратно", "talk to this session from Telegram, files both ways"),
      keywords: "telegram bot tg телеграм телеграмм тг бот",
      ...(o.bot !== undefined ? { on: o.bot } : {}),
      ...(o.bot ? { pill: "✈ Telegram" } : {}),
    },
    mobile && { id: "search", group: "link", icon: "🔍", label: t("Найти в чате", "Find in chat"), hint: t("поиск по сообщениям этой сессии", "search this session's messages"), keywords: "search find поиск найти" },
    { id: "delete", group: "danger", icon: "🗑", label: t("Удалить сессию", "Delete session"), hint: t("файлы в папке останутся", "files in the folder stay"), keywords: "delete remove удалить", danger: true },
  ];
  return list.filter((a): a is SessionAction => !!a);
}

export const actionGroupName = (g: SessionActionGroup): string =>
  ({ project: t("Проект", "Project"), agent: t("Агент", "Agent"), link: t("Связь", "Link"), danger: "" })[g];

/** Режим подтверждений коротко — для плашки параметров в шапке. */
export const permissionShort = (m: PermissionMode): string =>
  ({ manual: t("спрашивать всё", "ask everything"), acceptEdits: t("правки сам", "edits itself"), auto: t("автономно", "autonomous") })[m];

/** Плашка параметров: «модель · рассуждение · подтверждения». Уровень — только если модель его знает. */
export function sessionSummary(s: SessionInfo, models: ModelInfo[] = []): string {
  const m = models.find((x) => x.providerId === s.model.providerId && x.modelId === s.model.modelId);
  const effort = m?.efforts?.length ? (s.effort && m.efforts.includes(s.effort) ? s.effort : "auto") : undefined;
  return [m?.name ?? s.model.modelId, effort, permissionShort(s.permissionMode)].filter(Boolean).join(" · ");
}

/** Поиск в палитре: каждое слово запроса должно найтись в названии, подсказке или ключевых словах. */
export function matchQuery(hay: string, query: string): boolean {
  const h = hay.toLowerCase().replace(/ё/g, "е");
  return query
    .toLowerCase()
    .replace(/ё/g, "е")
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => h.includes(w));
}
