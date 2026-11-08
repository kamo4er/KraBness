// Задачи: хаб сам ведёт работу от цели до отчёта. Шаги — обычные сессии, поэтому чат, подтверждения и файлы работают как всегда.
//   исполнитель (claude, своя копия проекта) → автопроверка → ревью другой моделью → правки по ревью (до MAX_REVIEWS кругов)
//   → отчёт и решение пользователя: «Влить» / «Ещё круг» / «Выбросить».
// Состояние задач лежит в SQLite, поэтому переживает рестарт хаба; после старта незавершённые задачи подхватываются.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CreateTaskRequest, EngineId, EngineInfo, ModelRef, StoredEvent, TaskAction, TaskInfo, TaskStep, TaskStepKind, TeamRole, TeamStage } from "@kamharn/protocol";
import type { Db } from "./db.ts";
import type { ConfigStore } from "./config.ts";
import type { SessionManager } from "./sessions.ts";
import type { AutoCheck, CheckSettled } from "./checks.ts";
import { HttpError } from "./sessions.ts";
import { isLimitError } from "./autoresume.ts";
import { git, GitError, hasLinkedDeps } from "./worktree.ts";
import { reviewPrompt } from "./handoff.ts";
import { L } from "./lang.ts";

/** сколько кругов ревью делаем сами, дальше — к пользователю */
export const MAX_REVIEWS = 2;
const DIFF_MAX = 60_000;
/** ревью без замечаний отвечает этим словом первой строкой */
// \b после кириллицы не работает: границу слова JS считает по латинице
const CLEAN = /^\s*(ЧИСТО|CLEAN)[\s.!,:]*$/im;

/** Название задачи из цели: первое предложение, если короткое, иначе обрезка по слову. */
export function taskTitle(goal: string, max = 80): string {
  const line = goal.trim().split("\n")[0]!.trim();
  const sentence = /^(.{15,}?[.!?])(\s|$)/.exec(line)?.[1];
  if (sentence && sentence.length <= max) return sentence.replace(/\.$/, "");
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:(—–-]+$/, "") + "…";
}

export function workPrompt(goal: string, linkedDeps = false): string {
  return [L("Задача:", "Task:"), goal, "", ...copyNotes(linkedDeps)].join("\n");
}

/** Условия работы в копии проекта — общие для простой задачи и разработчика команды. */
function copyNotes(linkedDeps: boolean): string[] {
  return [
    L(
      "Ты работаешь в отдельной копии проекта (своя ветка): меняй файлы смело, в основную ветку ничего не попадёт, пока это не решит пользователь. Коммитить не нужно.",
      "You're working in a separate copy of the project (its own branch): change files freely, nothing reaches the main branch until the user decides so. No need to commit.",
    ),
    ...(linkedDeps
      ? [
          L(
            "Зависимости (node_modules) подключены ссылками из основного проекта — не переустанавливай и не удаляй их: это заденет основной проект.",
            "Dependencies (node_modules) are linked from the main project — don't reinstall or delete them: that would affect the main project.",
          ),
        ]
      : []),
    L(
      "Когда закончишь, последним сообщением коротко напиши, что сделал и что стоит проверить руками.",
      "When you're done, your last message should briefly say what you did and what is worth checking by hand.",
    ),
  ];
}

export function fixPrompt(review: string): string {
  return [
    L("Ревью твоих изменений другой моделью. Разберись по существу:", "A review of your changes by another model. Address it on the merits:"),
    L("реальные проблемы — исправь; то, с чем не согласен, — не меняй, но объясни почему.", "fix the real problems; where you disagree, don't change the code but explain why."),
    "",
    "<review>",
    review,
    "</review>",
  ].join("\n");
}

export function morePrompt(comment: string, review?: string): string {
  return [L("Пользователь посмотрел результат и просит доработать:", "The user looked at the result and asks for more work:"), comment, ...unseenReview(review)].join("\n");
}

/** Последнее ревью, которое исполнитель ещё не видел: круги кончились, и хаб не отдал его на правки. */
function unseenReview(review?: string): string[] {
  if (!review) return [];
  return [
    "",
    L("Последнее ревью другой моделью — его ты ещё не видел:", "The latest review by another model — you haven't seen it yet:"),
    L("реальные проблемы — исправь; то, с чем не согласен, — не меняй, но объясни почему.", "fix the real problems; where you disagree, don't change the code but explain why."),
    "<review>",
    review,
    "</review>",
  ];
}

/** Продолжить упавшую задачу: работа в копии цела, агент сам видит, что успел. */
export function resumeTaskPrompt(error: string | undefined, comment: string, review?: string): string {
  return [
    L("Работа над задачей оборвалась", "Work on the task was interrupted") + (error ? ` (${error.slice(0, 500)})` : "") + ".",
    L(
      "Всё, что ты успел сделать, на месте в этой копии проекта. Посмотри `git status` и `git diff`, доделай задачу и проверь.",
      "Everything you managed to do is still in this copy of the project. Look at `git status` and `git diff`, finish the task and check it.",
    ),
    ...(comment ? [L("Пользователь добавил:", "The user added:"), comment] : []),
    ...unseenReview(review),
  ].join("\n");
}

/** К промпту ревью — как ответить, если замечаний нет (иначе не отличить «всё хорошо» от разбора). */
export function reviewTaskPrompt(goal: string, diff: string, files: Array<{ status: string; path: string }>, truncated: boolean): string {
  return [
    `${L("Задача, которую решал автор:", "The task the author was solving:")} ${goal}`,
    "",
    reviewPrompt(diff, files, truncated),
    "",
    L("Если замечаний нет — ответь первой строкой ровно: ЧИСТО", "If you have no remarks, make the first line exactly: CLEAN"),
  ].join("\n");
}

// ---------- команда: аналитик → архитектор → одобрение → разработчик → тестировщик ----------

/** круги «архитектор вернул замечания», дальше решает пользователь */
export const MAX_DESIGN_ROUNDS = 2;
/** круги «тестировщик нашёл баги → разработчик правит», дальше — к пользователю */
export const MAX_TEST_ROUNDS = 3;
/** спецификация — файл в копии проекта (папка .kamharn git не видит) */
export const SPEC_FILE = ".kamharn/spec.md";
/** прототип дизайнера — рядом со спецификацией */
export const PROTO_FILE = ".kamharn/prototype.html";
const SPEC_MAX = 100_000;
const PROTO_MAX = 300_000;
/** «UI: да» первой строкой спецификации — задача меняет интерфейс (\b после кириллицы не работает) */
const UI_YES = /^UI:\s*(да|yes)(\s|$)/i;
export const specWantsUi = (spec: string) => UI_YES.test(firstLine(spec));
// вердикт — первая строка ответа целиком (как «ЧИСТО» у ревью, но строго первая: в замечаниях слово может встретиться)
const APPROVED = /^(ОДОБРЯЮ|APPROVED)[\s.!,:]*$/i;
const PASSED = /^(ПРОЙДЕНО|PASSED)[\s.!,:]*$/i;
const firstLine = (text: string) => text.trim().split("\n")[0]!.replace(/[*_`#]/g, "").trim();
export const isApproved = (text: string) => APPROVED.test(firstLine(text));
export const isPassed = (text: string) => PASSED.test(firstLine(text));

/** чья сессия в задаче: исполнитель (у команды — разработчик), ревью или роль команды */
type SessionRole = "worker" | "review" | TeamRole;
const ROLE_STAGE: Record<TeamRole, TeamStage> = { analyst: "analysis", designer: "ux", architect: "design", tester: "testing" };
const ROLE_STEP: Record<TeamRole, TaskStepKind> = { analyst: "analysis", designer: "ux", architect: "design", tester: "test" };
/** роль, которая работает на этапе (на «dev» — разработчик, он же исполнитель) */
function stageRole(stage?: TeamStage): TeamRole | undefined {
  return stage === "analysis" ? "analyst" : stage === "ux" ? "designer" : stage === "design" ? "architect" : stage === "testing" ? "tester" : undefined;
}
function stageOf(role: SessionRole): TeamStage | undefined {
  return role === "worker" ? "dev" : role === "review" ? undefined : ROLE_STAGE[role];
}
function roleName(role: TeamRole): string {
  return role === "analyst" ? L("Аналитик", "Analyst") : role === "designer" ? L("Дизайнер", "Designer") : role === "architect" ? L("Архитектор", "Architect") : L("Тестировщик", "Tester");
}

/** Шаблон спецификации: по нему работают разработчик и тестировщик, поэтому промпт-инженер не нужен. */
export function specTemplate(): string {
  return [
    L("# <короткое название>", "# <short title>"),
    L("## Цель", "## Goal"),
    L("Зачем это пользователю, одним-двумя предложениями.", "Why the user needs it, in one or two sentences."),
    L("## Что делаем", "## In scope"),
    L("## Что НЕ делаем", "## Out of scope"),
    L("## Где в коде", "## Where in the code"),
    L("Файлы и модули, которые затронет работа.", "Files and modules the work will touch."),
    L("## Как делать", "## How to build it"),
    L("(заполняет архитектор)", "(filled in by the architect)"),
    L("## Критерии приёмки", "## Acceptance criteria"),
    L("1. Проверяемое утверждение: что именно должно происходить.", "1. A checkable statement: what exactly must happen."),
    L("## Как проверить", "## How to check"),
    L("## Открытые вопросы", "## Open questions"),
  ].join("\n");
}

/** askUi — дизайнер в режиме «авто»: аналитик первой строкой отмечает, меняет ли задача интерфейс */
export function analystPrompt(goal: string, specPath: string, askUi = false): string {
  return [
    L(
      "Ты системный аналитик в команде агентов: аналитик → архитектор → разработчик → тестировщик. Пользователь — владелец продукта. Он хочет:",
      "You're the systems analyst in a team of agents: analyst → architect → developer → tester. The user is the product owner. They want:",
    ),
    "",
    goal,
    "",
    L("Твоя работа — спецификация, по которой разработчик сделает, а тестировщик проверит.", "Your job is a specification the developer will build from and the tester will check against."),
    L(
      "1. Изучи проект: читай код, документацию, тесты. Ничего в проекте не меняй — разработка начнётся после одобрения пользователя.",
      "1. Study the project: read the code, docs and tests. Don't change anything in the project — development starts after the user approves.",
    ),
    L(
      "2. Если чего-то важного не хватает и из кода это не выяснить — спроси пользователя обычным сообщением (коротко, списком) и закончи ход, не создавая файл. Он ответит здесь же. Мелочи решай сам и отметь в «Открытых вопросах» как принятое решение. Пунктов «ждём решения пользователя» в файле быть не должно: такой вопрос задай в чате.",
      '2. If something important is missing and the code can\'t tell you — ask the user in a normal message (short, as a list) and end your turn without creating the file. They\'ll answer right here. Decide small things yourself and note them under "Open questions" as decisions made. The file must not contain "waiting for the user\'s decision" items: ask such a question in the chat.',
    ),
    `${L("3. Когда всё ясно — запиши спецификацию в файл", "3. Once it's clear, write the specification to the file")} ${specPath} ${L("по шаблону:", "using this template:")}`,
    "",
    specTemplate(),
    "",
    L(
      "Критерии приёмки — пронумерованные и проверяемые (тестом или командой), без «удобно» и «быстро». Они про поведение, а не про устройство кода и тестов (никаких «ровно N проверок в файле»); сколько нужно задаче — обычно 3–8. Раздел «Как делать» оставь архитектору. После записи файла коротко напиши, что получилось.",
      'Acceptance criteria are numbered and checkable (by a test or a command), no "convenient" or "fast". They are about behaviour, not about how the code and tests are built (no "exactly N checks in the file"); as many as the task needs — usually 3–8. Leave "How to build it" to the architect. After writing the file, briefly say what you wrote.',
    ),
    ...(askUi
      ? [
          L(
            "Самой первой строкой файла (до заголовка) напиши «UI: да», если задача меняет то, что видит пользователь (экраны, вёрстка, тексты интерфейса), иначе «UI: нет». На «да» после тебя интерфейс и прототип нарисует дизайнер — сам раздел про интерфейс не пиши.",
            'On the very first line of the file (before the title) write "UI: yes" if the task changes what the user sees (screens, layout, interface texts), otherwise "UI: no". On "yes" a designer draws the interface and a prototype after you — don\'t write the interface section yourself.',
          ),
        ]
      : []),
  ].join("\n");
}

/** Дизайнер: раздел «Интерфейс» и UI-критерии в спецификации + кликабельный прототип одним файлом. */
export function designerPrompt(spec: string, specPath: string, protoPath: string, again: boolean): string {
  return [
    again
      ? L(
          "Спецификация поменялась (замечания архитектора или пользователя). Обнови раздел «Интерфейс», критерии про интерфейс и прототип, если это нужно; не нужно — оставь как есть.",
          'The specification changed (remarks from the architect or the user). Update the "Interface" section, the interface criteria and the prototype if needed; if not, leave them as they are.',
        )
      : L(
          "Ты дизайнер интерфейса в команде агентов. Аналитик написал спецификацию (ниже) — нарисуй, как это будет выглядеть, до того как её увидит пользователь.",
          "You're the interface designer in a team of agents. The analyst wrote a specification (below) — design how it will look before the user sees it.",
        ),
    L(
      "Сначала посмотри, как устроен интерфейс проекта: компоненты, стили, цвета, шрифты, отступы. Код проекта не меняй.",
      "First look at how the project's interface is built: components, styles, colours, fonts, spacing. Don't change the project's code.",
    ),
    `${L("1. Допиши в файл", "1. Add to the file")} ${specPath} ${L(
      "раздел «## Интерфейс»: какие экраны и элементы появляются или меняются; их состояния (пусто, загрузка, ошибка, много данных); как это выглядит на узком экране телефона; тексты интерфейса. В «Критерии приёмки» добавь 2–5 критериев про интерфейс, продолжив нумерацию: что пользователь видит и может сделать (элементы, тексты, состояния, узкий экран). Без пикселей и кодов цветов — точный вид задаёт прототип.",
      'an "## Interface" section: which screens and elements appear or change; their states (empty, loading, error, lots of data); how it looks on a narrow phone screen; the interface texts. Add 2–5 interface criteria to "Acceptance criteria", continuing the numbering: what the user sees and can do (elements, texts, states, narrow screen). No pixels or colour codes — the prototype sets the exact look.',
    )}`,
    `${L("2. Сделай кликабельный прототип одним файлом", "2. Make a clickable prototype as one file")} ${protoPath}: ${L(
      "самодостаточный HTML (стили и скрипт внутри, внешних файлов проекта нет, CDN можно), в стиле проекта, с переключением состояний из раздела. Это макет, а не реализация: данные выдуманные. Пользователь откроет его прямо в задаче, в том числе с телефона.",
      "self-contained HTML (styles and script inside, no project files, CDN is fine), in the project's style, with switching between the states from the section. It's a mock-up, not the implementation: the data is made up. The user opens it right in the task, including from a phone.",
    )}`,
    L(
      "Что должен решить пользователь — запиши в «Открытые вопросы». В конце коротко напиши, что сделал.",
      'Write what the user has to decide under "Open questions". At the end, briefly say what you did.',
    ),
    "",
    "<spec>",
    spec,
    "</spec>",
  ].join("\n");
}

export function analystRevisePrompt(text: string, from: "architect" | "user", specPath: string): string {
  return [
    from === "architect"
      ? L("Архитектор вернул спецификацию с замечаниями:", "The architect sent the specification back with remarks:")
      : L("Пользователь посмотрел спецификацию и просит поправить:", "The user looked at the specification and asks for changes:"),
    "",
    text,
    "",
    `${L("Поправь файл", "Update the file")} ${specPath}. ${L(
      "Если замечание требует решения пользователя — спроси его сообщением и закончи ход, не меняя файл. Код проекта по-прежнему не трогай.",
      "If a remark needs the user's decision, ask them in a message and end your turn without changing the file. Still don't touch the project's code.",
    )}`,
  ].join("\n");
}

export function architectPrompt(spec: string, specPath: string, protoPath?: string): string {
  return [
    L(
      "Ты архитектор в команде агентов. Аналитик написал спецификацию — проверь её против кода проекта, прежде чем её увидит пользователь.",
      "You're the architect in a team of agents. The analyst wrote a specification — check it against the project's code before the user sees it.",
    ),
    ...(protoPath
      ? [
          `${L("Интерфейс нарисовал дизайнер: раздел «Интерфейс» и прототип", 'A designer drew the interface: the "Interface" section and the prototype')} ${protoPath}. ${L(
            "Прототип — макет: его пиксели и вёрстку не меряй, смотри, реализуемо ли это в коде проекта и согласовано ли с требованиями.",
            "The prototype is a mock-up: don't measure its pixels and layout; check whether it can be built in the project's code and agrees with the requirements.",
          )}`,
        ]
      : []),
    L(
      "Смотри: реализуемо ли, где и что менять, что упущено (совместимость, данные, безопасность, тесты), проверяемы ли критерии. Код проекта не меняй.",
      "Look at: is it feasible, what changes where, what's missing (compatibility, data, security, tests), are the criteria checkable. Don't change the project's code.",
    ),
    "",
    `${L("Годится — допиши в файл", "If it works, fill in the section")} ${specPath} ${L(
      "раздел «## Как делать»: план изменений по файлам и модулям, решения и почему, риски. Затем ответь первой строкой ровно: ОДОБРЯЮ",
      '"## How to build it" in the file: the plan of changes by file and module, decisions and why, risks. Then make the first line of your answer exactly: APPROVED',
    )}`,
    L(
      "Есть проблемы в самих требованиях (противоречия, непроверяемые критерии, упущенное) — файл не трогай и перечисли замечания списком. Открытые вопросы, которые решает пользователь, — не повод не одобрять: он увидит их при одобрении; можешь дописать к ним свою рекомендацию.",
      "If the requirements themselves have problems (contradictions, uncheckable criteria, gaps), don't touch the file and list your remarks. Open questions the user decides are no reason to withhold approval: they'll see them when approving; you may add your recommendation to them.",
    ),
    "",
    "<spec>",
    spec,
    "</spec>",
  ].join("\n");
}

export function teamWorkPrompt(spec: string, linkedDeps = false, protoPath?: string): string {
  return [
    L("Задача — по спецификации, которую одобрил пользователь:", "The task follows a specification the user approved:"),
    "",
    "<spec>",
    spec,
    "</spec>",
    "",
    L(
      "Делай по разделу «Как делать» и выполни каждый критерий приёмки; тесты пиши или обновляй там, где это уместно. После тебя работу проверит тестировщик.",
      'Follow "How to build it" and meet every acceptance criterion; write or update tests where it makes sense. A tester checks your work afterwards.',
    ),
    ...(protoPath
      ? [
          `${L("Интерфейс делай по прототипу дизайнера", "Build the interface after the designer's prototype")} ${protoPath} ${L(
            "(его одобрил пользователь): тот же вид и состояния, но в коде и стиле проекта. Сам прототип в проект не копируй.",
            "(the user approved it): the same look and states, but in the project's code and style. Don't copy the prototype itself into the project.",
          )}`,
        ]
      : []),
    ...copyNotes(linkedDeps),
  ].join("\n");
}

export function testerPrompt(spec: string, files: Array<{ status: string; path: string }>, again: boolean): string {
  return [
    again
      ? L("Разработчик поправил по твоему отчёту. Проверь снова тем же порядком.", "The developer fixed things based on your report. Check again the same way.")
      : L(
          "Ты тестировщик в команде агентов. Разработчик закончил задачу по спецификации ниже — проверь, что выполнен каждый критерий приёмки.",
          "You're the tester in a team of agents. The developer finished the task from the specification below — check that every acceptance criterion is met.",
        ),
    L(
      "1. Каждый критерий, который проверяется автоматически, должен остаться в тестах проекта: чего там нет — допиши (его тестовым фреймворком, рядом с существующими тестами), иначе потом он сломается незаметно. Что автоматически не проверить — проверь командами и чтением кода.",
      "1. Every criterion that can be checked automatically must stay in the project's tests: add what's missing (with its test framework, next to the existing tests), otherwise it will break unnoticed later. What can't be automated — check with commands and by reading the code.",
    ),
    L("2. Прогони свои проверки и тесты проекта.", "2. Run your checks and the project's tests."),
    L("3. Код приложения не правь — только тесты.", "3. Don't fix the application code — only tests."),
    "",
    L(
      "Ответ: всё выполнено и тесты зелёные — первой строкой ровно ПРОЙДЕНО, дальше коротко по каждому критерию. Иначе — список проблем: номер критерия, что не так, как воспроизвести.",
      "Answer: if everything is met and the tests are green, make the first line exactly PASSED, then briefly go through each criterion. Otherwise list the problems: criterion number, what's wrong, how to reproduce.",
    ),
    ...(files.length ? ["", L("Что поменял разработчик:", "What the developer changed:"), ...files.map((f) => `${f.status} ${f.path}`)] : []),
    "",
    "<spec>",
    spec,
    "</spec>",
  ].join("\n");
}

export function teamFixPrompt(report: string): string {
  return [
    L("Тестировщик проверил работу и нашёл проблемы. Разберись по существу:", "The tester checked the work and found problems. Address them on the merits:"),
    L(
      "реальные баги исправь; тесты тестировщика не удаляй и не ослабляй — если тест неверен, объясни почему.",
      "fix the real bugs; don't delete or weaken the tester's tests — if a test is wrong, explain why.",
    ),
    "",
    "<test-report>",
    report,
    "</test-report>",
  ].join("\n");
}

/** Последний текст ассистента в сессии (итог для отчёта). */
export function lastAssistantText(events: StoredEvent[]): string {
  const roles = new Map<string, "user" | "assistant">();
  const texts = new Map<string, { messageId: string; text: string; order: number }>();
  let order = 0;
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "message.upserted") roles.set(ev.message.id, ev.message.role);
    if (ev.type === "part.upserted" && ev.part.type === "text") {
      const prev = texts.get(ev.part.id);
      texts.set(ev.part.id, { messageId: ev.messageId, text: ev.part.text, order: prev?.order ?? order++ });
    }
  }
  const mine = [...texts.values()].filter((t) => roles.get(t.messageId) === "assistant").sort((a, b) => a.order - b.order);
  return mine.at(-1)?.text.trim() ?? "";
}

export interface OrchestratorDeps {
  sessions: SessionManager;
  db: Db;
  /** настройки хаба (сколько задач одновременно) */
  config?: ConfigStore;
  autoCheck?: AutoCheck;
  notify: (sessionId: string, message: string) => void;
  log?: (m: string) => void;
  /** тесты подставляют свои git-команды */
  git?: (cwd: string, args: string[]) => Promise<string>;
}

export class Orchestrator {
  private listeners = new Set<(tasks: TaskInfo[]) => void>();
  /**
   * Сессии задач, которые сейчас работают (чтобы idle без busy не принять за конец хода). По сессиям, а не по задачам:
   * у команды ты переписываешься с аналитиком, и его ход не должен сбить флаг другой роли.
   */
  private busy = new Set<string>();
  private offSettled?: () => void;
  private closed = false;
  /** таймеры отложенного запуска */
  private timers = new Map<string, NodeJS.Timeout>();
  /** задачи, закончившиеся с последней сводки */
  private done = new Set<string>();
  /** по задаче сейчас идёт действие (влить/выбросить/ещё круг): второе действие получает 409, иначе вливание и выброс идут параллельно */
  private acting = new Set<string>();

  constructor(private d: OrchestratorDeps) {
    d.sessions.on("event", (e) => this.onEvent(e));
    this.offSettled = d.autoCheck?.onSettled((e) => this.onChecks(e));
  }

  // ---------- наружу ----------

  onChange(cb: (tasks: TaskInfo[]) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  list(): TaskInfo[] {
    return this.d.db.listTasks();
  }

  get(id: string): TaskInfo {
    const t = this.d.db.getTask(id);
    if (!t) throw new HttpError(404, L("Нет такой задачи", "No such task"));
    return t;
  }

  async create(req: CreateTaskRequest): Promise<TaskInfo> {
    const goal = String(req.goal ?? "").trim();
    if (!goal) throw new HttpError(400, L("Опиши, что сделать", "Describe what to do"));
    if (goal.length > 20_000) throw new HttpError(400, L("Слишком длинное описание", "The description is too long"));
    const now = Date.now();
    const title = String(req.title ?? "").trim().slice(0, 80) || taskTitle(goal);
    const task: TaskInfo = {
      id: `tk_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title,
      goal,
      directory: req.directory,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      steps: [],
      reviews: 0,
      ...(req.startAt && req.startAt > now ? { startAt: req.startAt } : {}),
      ...(req.mode === "team" ? { mode: "team" as const, designRounds: 0, testRounds: 0 } : {}),
    };
    // задача работает в отдельной ветке — без git она упала бы на старте; скажем сразу, в форме (клиенты узнают это
    // сообщение по notRepoError и предлагают сделать репозиторий)
    if (!(await git(req.directory, ["rev-parse", "--show-toplevel"]).then(() => true, () => false)))
      throw new HttpError(409, L("Папка не в git-репозитории: задаче нужна своя ветка. Выбери папку проекта с git.", "The folder isn't a git repository: a task needs its own branch. Pick a project folder with git."));
    await this.pickEngines(task, req);
    this.save(task);
    // очередь: больше заданного числа задач одновременно не запускаем (каждая занимает агента и копию проекта)
    await this.pump();
    return this.get(task.id);
  }

/**
   * Кто делает и кто ревьюит. Ничего не зашито: у кого нет Claude — всё идёт на opencode.
   * По умолчанию исполнитель — Claude, если он подключён (сильнее в коде), иначе opencode;
   * ревьюер — opencode (бесплатные модели есть у всех), без него — движок исполнителя.
   * Модель — выбранная, иначе из настройки «Движки», иначе модель движка по умолчанию.
   */
  private async pickEngines(task: TaskInfo, req: CreateTaskRequest): Promise<void> {
    for (const e of [req.workerEngine, req.reviewEngine])
      if (e !== undefined && e !== "claude" && e !== "opencode") throw new HttpError(400, L(`Неизвестный движок: ${e}`, `Unknown engine: ${e}`));
    const engines = await this.d.sessions.enginesInfo().catch(() => [] as EngineInfo[]);
    const info = (e: EngineId) => engines.find((x) => x.id === e);
    const usable = (e: EngineId) => {
      const i = info(e);
      return !!i?.available && !(i.auth?.installed && !i.auth.loggedIn);
    };
    const name = (e: EngineId) => (e === "claude" ? "Claude Code" : "opencode");
    const unusable = (e: EngineId) =>
      new HttpError(409, info(e)?.error ?? L(`${name(e)} сейчас недоступен — выбери другую модель`, `${name(e)} isn't available right now — pick another model`));
    const modelFor = (e: EngineId): ModelRef | undefined => this.d.config?.config.newSession?.models?.[e] ?? info(e)?.defaultModel;

    const worker: EngineId = req.workerEngine ?? (usable("claude") ? "claude" : "opencode");
    if (!usable(worker)) throw unusable(worker);
    task.workerEngine = worker;
    const wm = req.workerModel ?? modelFor(worker);
    if (wm) task.workerModel = wm;
    if (req.workerEffort) task.workerEffort = req.workerEffort;

    if (req.mode === "team") {
      // аналитик, дизайнер и архитектор — как разработчик (думать над кодом); тестировщик — по умолчанию другая модель: чужой взгляд ловит больше
      const defaults: Record<TeamRole, EngineId> = { analyst: worker, designer: worker, architect: worker, tester: usable("opencode") ? "opencode" : worker };
      if (req.designer !== undefined && !["auto", "on", "off"].includes(req.designer)) throw new HttpError(400, "designer: auto | on | off");
      const designer = req.designer ?? "auto";
      task.team = {};
      for (const role of ["analyst", "designer", "architect", "tester"] as const) {
        const want = req.team?.[role];
        if (want === null && role === "tester") continue; // без тестировщика
        if (role === "designer" && (designer === "off" || want === null)) continue;
        if (want?.engine !== undefined && want.engine !== "claude" && want.engine !== "opencode") throw new HttpError(400, L(`Неизвестный движок: ${want.engine}`, `Unknown engine: ${want.engine}`));
        const engine = want?.engine ?? defaults[role];
        if (!usable(engine)) throw unusable(engine);
        const model = want?.model ?? modelFor(engine);
        task.team[role] = { engine, ...(model ? { model } : {}), ...(want?.effort ? { effort: want.effort } : {}) };
      }
      if (task.team.designer) task.designerMode = designer === "on" ? "on" : "auto";
      return; // у команды вместо ревью — тестировщик
    }

    if (req.reviewModel === null) return; // без ревью
    const reviewer: EngineId = req.reviewEngine ?? (usable("opencode") ? "opencode" : worker);
    if (!usable(reviewer)) throw unusable(reviewer);
    task.reviewEngine = reviewer;
    const rm = req.reviewModel ?? modelFor(reviewer);
    if (rm) task.reviewModel = rm;
    if (req.reviewEffort) task.reviewEffort = req.reviewEffort;
  }

  /** Сколько задач работает одновременно (config.tasks.parallel, 1…5). */
  private get parallel(): number {
    const n = Number(this.d.config?.config.tasks?.parallel ?? 2);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 2;
  }

  /** Запустить очередные задачи, если есть место и подошло их время. */
  private async pump(): Promise<void> {
    if (this.closed) return;
    const all = this.list();
    const active = all.filter((t) => t.status === "running" || t.status === "waiting_limit").length;
    const now = Date.now();
    // по очереди создания: кто раньше поставлен, тот раньше пойдёт
    const queued = all.filter((t) => t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
    let free = this.parallel - active;
    for (const t of queued) {
      if (t.startAt && t.startAt > now) {
        this.arm(t.id, t.startAt);
        continue;
      }
      if (free <= 0) break;
      free--;
      await this.launch(t.id);
    }
    this.maybeSummary();
  }

  /** Таймер отложенного запуска (переживает рестарт: время лежит в задаче). */
  private arm(id: string, at: number): void {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pump();
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /** Создать исполнителя и отправить ему цель. */
  private async launch(id: string): Promise<void> {
    let task = this.get(id);
    if (task.status !== "queued") return;
    try {
      const worker = await this.d.sessions.create({
        engine: task.workerEngine ?? "claude",
        directory: task.directory,
        worktree: true,
        permissionMode: "auto",
        title: task.title,
        taskId: task.id,
        ...(task.workerModel ? { model: task.workerModel } : {}),
        ...(task.workerEffort ? { effort: task.workerEffort } : {}),
      });
      task = this.get(id);
      // задачу могли остановить, пока создавалась копия
      if (task.status !== "queued") {
        try {
          this.d.sessions.delete(worker.id);
        } catch {
          /* уже удалена */
        }
        return;
      }
      task.workerSessionId = worker.id;
      task.workerModel = worker.model;
      if (worker.worktree) task.worktree = worker.worktree;
      task.status = "running";
      if (task.mode === "team") {
        // копия проекта — у разработчика (вливание и выброс работают как у простой задачи), но первым идёт аналитик;
        // этап — до первого сохранения: рестарт в этом окне иначе отдал бы задачу разработчику без спецификации
        task.stage = "analysis";
        this.save(task);
        if (this.d.autoCheck?.commands(worker).length) await this.d.sessions.update(worker.id, { autoCheck: true });
        if (!this.running(task.id)) return;
        await this.toRole(task, "analyst", analystPrompt(task.goal, SPEC_FILE, task.designerMode === "auto"));
        this.d.log?.(`[task] ${L("команда начала", "the team started")}: ${task.title}`);
        return;
      }
      this.step(task, "work", worker.id, worker.model);
      this.save(task);
      this.busy.add(worker.id);
      if (this.d.autoCheck?.commands(worker).length) await this.d.sessions.update(worker.id, { autoCheck: true });
      // могли остановить, пока мы ждали: остановка уже порвала сессию и откатила копию
      if (!this.running(task.id)) return;
      await this.d.sessions.prompt(worker.id, workPrompt(task.goal, !!worker.worktree && hasLinkedDeps(worker.worktree.path)));
      this.d.log?.(`[task] ${L("начал", "started")}: ${task.title}`);
    } catch (e) {
      const cur = this.d.db.getTask(id);
      if (cur) this.fail(cur, (e as Error).message);
    }
  }

  /** Когда работа кончилась и очередь пуста — одна сводка на всё (ночной прогон). */
  private maybeSummary(): void {
    const all = this.list();
    if (all.some((t) => t.status === "running" || t.status === "waiting_limit" || t.status === "queued")) return;
    if (this.done.size < 2) return;
    const mine = all.filter((t) => this.done.has(t.id));
    const ready = mine.filter((t) => t.status === "ready").length;
    const failed = mine.filter((t) => t.status === "failed").length;
    const sid = mine.find((t) => t.workerSessionId)?.workerSessionId;
    this.done.clear();
    if (!sid) return;
    this.d.notify(
      sid,
      L(`Задачи закончились: готово ${ready}, сломалось ${failed}`, `Tasks finished: ${ready} ready, ${failed} broke`),
    );
  }

  async act(id: string, a: TaskAction): Promise<TaskInfo> {
    if (this.acting.has(id)) throw new HttpError(409, L("Задача уже обрабатывается", "The task is already being handled"));
    this.acting.add(id);
    try {
      return await this.actNow(id, a);
    } finally {
      this.acting.delete(id);
    }
  }

  private async actNow(id: string, a: TaskAction): Promise<TaskInfo> {
    const t = this.get(id);
    if (a.action === "approve" || a.action === "revise") {
      if (t.status !== "approval") throw new HttpError(409, L("Спецификация не ждёт одобрения", "The specification isn't waiting for approval"));
      // ты обсуждаешь спецификацию с ролью, и она ещё отвечает: её правки в файле не должны потеряться или откатиться
      if (this.sessionIds(t).some((sid) => this.working(sid)))
        throw new HttpError(409, L("Роль команды ещё отвечает в чате — дождись конца её хода", "A team role is still answering in its chat — wait until it finishes"));
      if (a.action === "approve") return await this.approve(t, a.spec);
      const comment = String(a.comment ?? "").trim();
      if (!comment) throw new HttpError(400, L("Напиши, что поправить", "Say what to change"));
      t.status = "running";
      t.designRounds = 0;
      delete t.designRemarks;
      await this.orFail(t, () => this.toRole(t, "analyst", analystRevisePrompt(comment, "user", SPEC_FILE)));
      return this.get(id);
    }
    if (a.action === "merge") {
      if (t.status !== "ready") throw new HttpError(409, L("Задача ещё не готова", "The task isn't ready yet"));
      if (!t.workerSessionId) throw new HttpError(409, L("У задачи нет сессии исполнителя", "The task has no worker session"));
      const r = await this.d.sessions.mergeWorktree(t.workerSessionId);
      t.status = "merged";
      t.report = { ...(t.report ?? this.emptyReport()), commit: r.commit };
      this.save(t);
      await this.pump();
      return t;
    }
    if (a.action === "discard") {
      // влитую задачу выбрасывать нельзя: в истории должно остаться, что её влили
      if (!["running", "waiting_limit", "queued", "approval", "ready", "failed"].includes(t.status))
        throw new HttpError(409, L("Выбросить можно только задачу в работе, в очереди, ожидающую лимита или одобрения, готовую или упавшую", "Discard is only for a running, queued, waiting, awaiting-approval, ready, or failed task"));
      // Сначала закрываем задачу: события от остановленных сессий не должны её двигать
      // (idle от abort приходит асинхронно, пока мы ещё катим откат).
      const timer = this.timers.get(t.id);
      if (timer) clearTimeout(timer);
      this.timers.delete(t.id);
      for (const sid of this.sessionIds(t)) this.busy.delete(sid);
      const step = t.steps.at(-1);
      if (step && step.status === "running") {
        step.status = "skipped";
        step.finishedAt = Date.now();
        step.note = L("остановлено", "stopped");
      }
      t.status = "discarded";
      this.save(t);

      for (const sid of this.sessionIds(t)) {
        const s = this.session(sid);
        if (!s) continue;
        // проверки не должны прислать «почини» остановленному агенту
        if (sid === t.workerSessionId && s.autoCheck) await this.d.sessions.update(sid, { autoCheck: false }).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
        await this.d.sessions.abort(sid).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
        if (s.resumeAt) this.d.sessions.setResumeAt(sid, 0);
      }
      // откат, когда агент точно перестал писать: у Claude abort — запрос прерывания, процесс умирает не сразу
      if (t.workerSessionId) {
        await this.waitStopped(t.workerSessionId);
        if (t.worktree) await this.d.sessions.discardWorktree(t.workerSessionId).catch((e: Error) => this.d.log?.(`[task] ${e.message}`));
      }
      await this.pump();
      return this.get(t.id);
    }
    const comment = String(a.comment ?? "").trim();
    // ещё круг — у готовой задачи (тогда нужен комментарий) или у упавшей (продолжить с того места, где оборвалась)
    const failed = t.status === "failed";
    if (t.status !== "ready" && !failed)
      throw new HttpError(409, t.status === "running" ? L("Задача ещё работает", "The task is still running") : L("Ещё круг — только у готовой или упавшей задачи", "One more round is only for a ready or failed task"));
    if (!comment && !failed) throw new HttpError(400, L("Напиши, что доработать", "Say what to improve"));
    if (!t.workerSessionId) throw new HttpError(409, L("У задачи нет сессии исполнителя", "The task has no worker session"));
    const error = t.error;
    // замечания последнего ревью исполнителю не уходили (кончились круги) — отдаём сейчас, иначе «доделай по ревью» ему не о чем;
    // у команды так же с последним отчётом тестировщика
    const review =
      t.reviewVerdict === "remarks" && t.reviewText ? t.reviewText : t.testVerdict === "bugs" && t.testText ? t.testText : undefined;
    delete t.reviewVerdict;
    // круги ревью и тестов считаем заново: это новая порция работы
    t.reviews = 0;
    if (t.mode === "team") {
      t.testRounds = 0;
      delete t.testVerdict;
    }
    t.status = "running";
    delete t.error;
    // команда упала до разработки — продолжает та роль, на которой оборвалось
    const role = failed && t.mode === "team" ? stageRole(t.stage) : undefined;
    if (role === "analyst" || role === "architect") {
      await this.orFail(t, () => this.toRole(t, role, resumeTaskPrompt(error, comment)));
      return this.get(id);
    }
    if (t.mode === "team") t.stage = "dev";
    this.step(t, failed ? "work" : "fix", t.workerSessionId, t.workerModel);
    this.save(t);
    this.busy.add(t.workerSessionId);
    const worker = t.workerSessionId;
    await this.orFail(t, () => this.d.sessions.prompt(worker, failed ? resumeTaskPrompt(error, comment, review) : morePrompt(comment, review)));
    return this.get(id);
  }

  /** Действие уже перевело задачу в running, а запуск шага споткнулся: задача падает (её можно продолжить), а не висит. */
  private async orFail(t: TaskInfo, f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (e) {
      this.fail(t, (e as Error).message);
      throw e;
    }
  }

  /** Сессия сейчас отвечает (ход идёт). */
  private working(sid: string): boolean {
    const s = this.session(sid);
    return !!s && (s.status === "busy" || s.status === "retry");
  }

  /** Удалить задачу вместе с её сессиями (копия проекта убирается вместе с сессией исполнителя). */
  async remove(id: string): Promise<void> {
    const t = this.get(id);
    for (const sid of this.sessionIds(t)) {
      try {
        this.d.sessions.delete(sid);
      } catch {
        /* сессии уже нет */
      }
    }
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.d.db.deleteTask(id);
    this.done.delete(id);
    this.emit();
    await this.pump();
  }

  /** После старта хаба: подхватить незавершённые задачи. */
  start(): void {
    for (const t of this.list()) {
      if (t.status !== "running" && t.status !== "waiting_limit") continue;
      // у команды работает роль текущего этапа; у простой задачи — исполнитель (ревью подхватывается через него)
      const role = t.mode === "team" ? stageRole(t.stage) : undefined;
      const sid = role ? t.team?.[role]?.sessionId : t.workerSessionId;
      const s = sid && this.session(sid);
      if (!sid || !s) {
        this.fail(t, L("Сессия исполнителя пропала", "The worker session is gone"));
        continue;
      }
      if (s.status === "busy" || s.status === "retry") {
        this.busy.add(sid);
        continue;
      }
      if (s.resumeAt) {
        t.status = "waiting_limit";
        this.save(t);
        continue;
      }
      // шаг закончился, пока хаб лежал: продолжаем с того места, где остановились
      this.d.log?.(`[task] ${L("продолжаю после рестарта", "continuing after a restart")}: ${t.title}`);
      if (role === "analyst") void this.afterAnalyst(t.id);
      else if (role === "designer") void this.afterDesigner(t.id);
      else if (role === "architect") void this.afterArchitect(t.id);
      else if (role === "tester") void this.afterTester(t.id);
      else void this.advance(t.id);
    }
    // очередь и отложенные запуски тоже переживают рестарт
    void this.pump();
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.offSettled?.();
    this.listeners.clear();
    this.acting.clear();
  }

  // ---------- события ----------

  private onEvent(e: StoredEvent): void {
    const found = this.bySession(e.sessionId);
    if (!found || this.closed) return;
    const { task: t, role } = found;
    const ev = e.event;
    // агент ждёт человека — помечаем задачу, иначе она молча «работает»
    if (ev.type === "permission.asked" || ev.type === "question.asked") {
      const text = ev.type === "permission.asked" ? `${ev.request.tool}: ${ev.request.title}` : (ev.request.questions[0]?.question ?? "");
      t.asking = { sessionId: e.sessionId, kind: ev.type === "permission.asked" ? "permission" : "question", text: text.slice(0, 300), at: Date.now() };
      this.save(t);
      return;
    }
    if (ev.type === "permission.resolved" || ev.type === "question.resolved") {
      if (t.asking?.sessionId === e.sessionId) {
        delete t.asking;
        this.save(t);
      }
      return;
    }
    // чья сейчас очередь: у команды — роль этапа (ты можешь писать аналитику и во время разработки), у простой — исполнитель
    const current = t.mode === "team" ? role !== "review" && stageOf(role) === (t.stage ?? "dev") : role === "worker";
    if (ev.type === "error" && !isLimitError(ev.message)) {
      // ошибка в чате роли не на её этапе задачу не роняет
      if ((t.status === "running" || t.status === "waiting_limit") && (current || t.mode !== "team")) this.fail(t, ev.message);
      return;
    }
    if (ev.type !== "session.updated") return;
    const isWorker = role === "worker";
    if (ev.patch.resumeAt !== undefined && current) {
      // упёрлись в лимит Claude: ждём сброса, автопродолжение само напишет «Продолжай»
      if (ev.patch.resumeAt && t.status === "running") {
        t.status = "waiting_limit";
        this.save(t);
      } else if (!ev.patch.resumeAt && t.status === "waiting_limit") {
        t.status = "running";
        this.save(t);
      }
      return;
    }
    if (ev.patch.status === "busy" || ev.patch.status === "retry") {
      this.busy.add(e.sessionId);
      // ответил аналитику — он снова работает, ждать от тебя больше нечего
      if (t.asking?.kind === "reply" && t.asking.sessionId === e.sessionId) {
        delete t.asking;
        this.save(t);
      }
      return;
    }
    if (ev.patch.status !== "idle" || !this.busy.delete(e.sessionId)) return;
    // спецификация на одобрении, а ты обсуждаешь её с аналитиком: он мог переписать файл — показываем и одобряем новую
    if (t.status === "approval" && (role === "analyst" || role === "designer")) return this.refreshSpec(t);
    if (t.status !== "running") return;
    if (t.mode === "team" && !current) return;
    if (isWorker) {
      // с автопроверкой ждём не idle, а конца круга проверок (она ещё может вернуть агенту ошибку)
      if (this.d.autoCheck?.active(e.sessionId)) return;
      void this.advance(t.id);
    } else if (role === "analyst") void this.afterAnalyst(t.id);
    else if (role === "designer") void this.afterDesigner(t.id);
    else if (role === "architect") void this.afterArchitect(t.id);
    else if (role === "tester") void this.afterTester(t.id);
    else void this.afterReview(t.id);
  }

  private onChecks(e: CheckSettled): void {
    const t = this.byWorker(e.sessionId);
    if (!t || this.closed || t.status !== "running" || e.sentFix) return;
    // у команды проверки разработчика считаются только на его этапе
    if (t.mode === "team" && t.stage !== "dev") return;
    const step = t.steps.at(-1);
    if (step) step.note = e.status === "passed" ? L("проверки прошли", "checks passed") : L("проверки не прошли", "checks failed");
    void this.advance(t.id, e.status === "passed" ? "passed" : "failed");
  }

  // ---------- конвейер ----------

  /** Шаг исполнителя закончился: решаем, что дальше — ревью или отчёт. */
  private async advance(id: string, checks?: "passed" | "failed"): Promise<void> {
    let t: TaskInfo;
    try {
      t = this.get(id);
    } catch {
      return;
    }
    this.finishStep(t);
    if (checks) t.checksResult = checks;
    try {
      if (t.mode === "team") {
        // у команды вместо ревью — тестировщик (нет его — сразу отчёт)
        if (!t.team?.tester) return await this.ready(t);
        const files = await this.files(t);
        if (!this.running(t.id)) return;
        return await this.toRole(t, "tester", testerPrompt(t.spec ?? "", files, (t.testRounds ?? 0) > 0));
      }
      if (!t.reviewModel || t.reviews >= MAX_REVIEWS) return await this.ready(t);
      const diff = await this.diff(t);
      if (!this.running(t.id)) return;
      if (!diff.diff.trim()) return await this.ready(t);
      await this.review(t, diff);
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  private async review(t: TaskInfo, d: { diff: string; files: Array<{ status: string; path: string }>; truncated: boolean }): Promise<void> {
    let sid = t.reviewSessionId;
    if (sid && !this.session(sid)) sid = undefined;
    if (!sid) {
      const s = await this.d.sessions.create({
        engine: t.reviewEngine ?? "opencode",
        directory: this.workerDir(t),
        permissionMode: "manual",
        title: L(`Ревью: ${t.title}`, `Review: ${t.title}`).slice(0, 200),
        taskId: t.id,
        ...(t.reviewModel ? { model: t.reviewModel } : {}),
        ...(t.reviewEffort ? { effort: t.reviewEffort } : {}),
      }, { confined: true });
      sid = s.id;
      if (!this.running(t.id)) {
        // остановили, пока создавалась сессия ревью — её и копию убирает уже остановка
        try {
          this.d.sessions.delete(sid);
        } catch {
          /* уже удалена */
        }
        return;
      }
      t.reviewSessionId = sid;
      t.reviewModel = s.model;
    }
    this.step(t, "review", sid, t.reviewModel);
    this.save(t);
    this.busy.add(sid);
    if (!this.running(t.id)) return;
    await this.d.sessions.prompt(sid, reviewTaskPrompt(t.goal, d.diff, d.files, d.truncated));
  }

  /** Ревью ответило: чисто — отчёт, есть замечания — отдаём исполнителю (пока есть круги). */
  private async afterReview(id: string): Promise<void> {
    let t: TaskInfo;
    try {
      t = this.get(id);
    } catch {
      return;
    }
    this.finishStep(t);
    t.reviews++;
    const text = t.reviewSessionId ? lastAssistantText(this.d.sessions.eventsAfter(t.reviewSessionId, 0)) : "";
    t.reviewText = text;
    try {
      if (!text || CLEAN.test(text)) {
        t.reviewVerdict = t.reviews > 1 ? "fixed" : "ok";
        return await this.ready(t);
      }
      if (t.reviews >= MAX_REVIEWS || !t.workerSessionId) {
        t.reviewVerdict = "remarks";
        return await this.ready(t);
      }
      this.step(t, "fix", t.workerSessionId, t.workerModel);
      this.save(t);
      this.busy.add(t.workerSessionId);
      if (!this.running(t.id)) return;
      await this.d.sessions.prompt(t.workerSessionId, fixPrompt(text));
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  // ---------- команда ----------

  /** Передать работу роли команды: её сессия (создаётся при первом обращении, в копии проекта), шаг и промпт. */
  private async toRole(t: TaskInfo, role: TeamRole, prompt: string): Promise<void> {
    const member = t.team?.[role];
    if (!member) throw new Error(L(`В команде нет роли: ${role}`, `The team has no role: ${role}`));
    t.stage = ROLE_STAGE[role];
    this.save(t);
    let sid = member.sessionId;
    if (sid && !this.session(sid)) sid = undefined;
    if (!sid) {
      const s = await this.d.sessions.create(
        {
          engine: member.engine,
          directory: this.workerDir(t),
          permissionMode: "auto",
          title: `${roleName(role)}: ${t.title}`.slice(0, 200),
          taskId: t.id,
          ...(member.model ? { model: member.model } : {}),
          ...(member.effort ? { effort: member.effort } : {}),
        },
        // роль работает в копии разработчика и, как он, за неё не выходит
        { confined: true },
      );
      sid = s.id;
      if (!this.running(t.id)) {
        // остановили, пока создавалась сессия — её и копию убирает уже остановка
        try {
          this.d.sessions.delete(sid);
        } catch {
          /* уже удалена */
        }
        return;
      }
      member.sessionId = sid;
      member.model = s.model;
    } else if (this.working(sid)) {
      // ты переписываешься с этой ролью: промпт посреди твоего хода — и её ответ тебе засчитался бы как её работа
      await this.waitStopped(sid, 10 * 60_000);
      this.busy.delete(sid);
    }
    this.step(t, ROLE_STEP[role], sid, member.model);
    this.save(t);
    this.busy.add(sid);
    if (role === "analyst") this.specDir(t);
    if (!this.running(t.id)) return;
    await this.d.sessions.prompt(sid, prompt);
  }

  /** Аналитик закончил ход: новая спецификация — к архитектору; файла нет или он прежний — значит, спросил тебя. */
  private async afterAnalyst(id: string): Promise<void> {
    const t = this.d.db.getTask(id);
    if (!t || t.status !== "running") return;
    const sid = t.team?.analyst?.sessionId;
    const spec = this.readSpec(t);
    try {
      if (!spec || spec === t.spec) {
        const text = sid ? lastAssistantText(this.d.sessions.eventsAfter(sid, 0)) : "";
        // уже ждём ответа на этот вопрос (рестарт хаба) — второй пуш ни к чему
        const again = t.asking?.kind === "reply" && t.asking.sessionId === sid;
        if (sid) t.asking = { sessionId: sid, kind: "reply", text: (text || L("Аналитик ждёт ответа", "The analyst is waiting for an answer")).slice(0, 300), at: again ? t.asking!.at : Date.now() };
        this.save(t);
        if (sid && !again) this.d.notify(sid, L(`Аналитик спрашивает: ${t.title}`, `The analyst has questions: ${t.title}`));
        return;
      }
      t.spec = spec;
      delete t.asking;
      if (t.designerMode === "auto") t.ui = specWantsUi(spec);
      // каждая новая версия спецификации проходит через дизайнера (если он в задаче и она про интерфейс), потом — архитектор
      if (t.team?.designer && (t.designerMode === "on" || t.ui)) {
        return await this.toRole(t, "designer", designerPrompt(spec, SPEC_FILE, PROTO_FILE, !!t.prototype));
      }
      await this.toArchitect(t);
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  /** Дизайнер закончил ход: забираем спецификацию с разделом «Интерфейс» и прототип, дальше — архитектор. */
  private async afterDesigner(id: string): Promise<void> {
    const t = this.d.db.getTask(id);
    if (!t || t.status !== "running") return;
    try {
      t.spec = this.readSpec(t) ?? t.spec;
      const proto = this.readProto(t);
      if (proto) t.prototype = proto;
      await this.toArchitect(t);
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  private async toArchitect(t: TaskInfo): Promise<void> {
    if (!t.team?.architect) return this.toApproval(t);
    await this.toRole(t, "architect", architectPrompt(t.spec ?? "", SPEC_FILE, t.prototype ? PROTO_FILE : undefined));
  }

  /** Архитектор ответил: одобрил — к тебе на одобрение; замечания — аналитику, пока есть круги, потом решаешь ты. */
  private async afterArchitect(id: string): Promise<void> {
    const t = this.d.db.getTask(id);
    if (!t || t.status !== "running") return;
    const sid = t.team?.architect?.sessionId;
    const text = sid ? lastAssistantText(this.d.sessions.eventsAfter(sid, 0)) : "";
    try {
      // архитектор дописывает «Как делать» в тот же файл
      t.spec = this.readSpec(t) ?? t.spec;
      if (isApproved(text)) {
        delete t.designRemarks;
        return this.toApproval(t);
      }
      t.designRounds = (t.designRounds ?? 0) + 1;
      if (!text || t.designRounds >= MAX_DESIGN_ROUNDS) {
        t.designRemarks = text || L("Архитектор не ответил", "The architect didn't answer");
        return this.toApproval(t);
      }
      await this.toRole(t, "analyst", analystRevisePrompt(text, "architect", SPEC_FILE));
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  private toApproval(t: TaskInfo): void {
    if (!this.running(t.id)) return;
    this.finishStep(t);
    t.status = "approval";
    delete t.stage;
    this.save(t);
    const sid = t.team?.analyst?.sessionId ?? t.workerSessionId;
    if (sid) this.d.notify(sid, L(`Спецификация готова — посмотри и одобри: ${t.title}`, `The specification is ready — review and approve: ${t.title}`));
    this.d.log?.(`[task] ${L("спецификация на одобрении", "specification awaiting approval")}: ${t.title}`);
  }

  /** На одобрении ты обсудил спецификацию с аналитиком, и он переписал файл: показываем новую. */
  private refreshSpec(t: TaskInfo): void {
    const spec = this.readSpec(t);
    const proto = this.readProto(t);
    if ((!spec || spec === t.spec) && (!proto || proto === t.prototype)) return;
    if (spec) t.spec = spec;
    if (proto) t.prototype = proto;
    this.save(t);
  }

  /** Ты одобрил спецификацию (может, поправив руками): откат случайных правок в коде и старт разработчика. */
  private async approve(t: TaskInfo, edited?: string): Promise<TaskInfo> {
    // одобряешь то, что лежит в файле: аналитик мог его поправить, пока вы обсуждали
    if (edited === undefined) t.spec = this.readSpec(t) ?? t.spec;
    t.prototype = this.readProto(t) ?? t.prototype;
    if (edited !== undefined) {
      const s = String(edited).trim();
      if (!s) throw new HttpError(400, L("Спецификация пустая", "The specification is empty"));
      if (s.length > SPEC_MAX) throw new HttpError(400, L("Слишком длинная спецификация", "The specification is too long"));
      if (s !== t.spec) {
        this.writeSpec(t, s);
        t.spec = s;
      }
    }
    if (!t.spec) throw new HttpError(409, L("Спецификации ещё нет", "There's no specification yet"));
    if (!t.workerSessionId) throw new HttpError(409, L("У задачи нет сессии исполнителя", "The task has no worker session"));
    const reverted = await this.revertStray(t);
    t.status = "running";
    t.stage = "dev";
    delete t.designRemarks;
    this.step(t, "work", t.workerSessionId, t.workerModel);
    if (reverted) t.steps.at(-1)!.note = L(`откачены правки в коде до разработки: ${reverted}`, `code edits made before development were reverted: ${reverted}`);
    this.save(t);
    this.busy.add(t.workerSessionId);
    const wt = t.worktree;
    const [worker, spec] = [t.workerSessionId, t.spec];
    const proto = t.prototype ? PROTO_FILE : undefined;
    await this.orFail(t, () => this.d.sessions.prompt(worker, teamWorkPrompt(spec, !!wt && hasLinkedDeps(wt.path), proto)));
    this.d.log?.(`[task] ${L("спецификация одобрена, разработка", "specification approved, development")}: ${t.title}`);
    return this.get(t.id);
  }

  /** Аналитик и архитектор код не правят; если всё же поправили — до разработки откатываем (папку .kamharn git не видит). */
  private async revertStray(t: TaskInfo): Promise<number> {
    const g = this.d.git ?? git;
    const wt = t.worktree;
    if (!wt) return 0;
    const changed = (await g(wt.path, ["status", "--porcelain"]).catch(() => "")).split("\n").filter((l) => l.trim()).length;
    if (!changed) return 0;
    await g(wt.path, ["reset", "-q"]).catch(() => "");
    await g(wt.path, ["checkout", "--", "."]).catch(() => "");
    // без -x: игнорируемое (node_modules из ссылок, .kamharn) остаётся
    await g(wt.path, ["clean", "-fd"]).catch(() => "");
    return changed;
  }

  /** Тестировщик ответил: всё принято — отчёт; баги — разработчику, пока есть круги. */
  private async afterTester(id: string): Promise<void> {
    const t = this.d.db.getTask(id);
    if (!t || t.status !== "running") return;
    this.finishStep(t);
    t.testRounds = (t.testRounds ?? 0) + 1;
    const sid = t.team?.tester?.sessionId;
    const text = sid ? lastAssistantText(this.d.sessions.eventsAfter(sid, 0)) : "";
    t.testText = text || L("Тестировщик не ответил", "The tester didn't answer");
    try {
      if (text && isPassed(text)) {
        t.testVerdict = "passed";
        return await this.ready(t);
      }
      if (!text || t.testRounds >= MAX_TEST_ROUNDS || !t.workerSessionId) {
        t.testVerdict = "bugs";
        return await this.ready(t);
      }
      t.stage = "dev";
      this.step(t, "fix", t.workerSessionId, t.workerModel);
      this.save(t);
      this.busy.add(t.workerSessionId);
      if (!this.running(t.id)) return;
      await this.d.sessions.prompt(t.workerSessionId, teamFixPrompt(text));
    } catch (e) {
      this.fail(t, (e as Error).message);
    }
  }

  private specPath(t: TaskInfo): string {
    return join(this.workerDir(t), SPEC_FILE);
  }

  /** Папка спецификации в копии: со своим .gitignore, как .kamharn/inbox — в коммит при «Влить» не попадёт. */
  private specDir(t: TaskInfo): void {
    const dir = dirname(this.specPath(t));
    mkdirSync(dir, { recursive: true });
    const gi = join(dir, ".gitignore");
    if (!existsSync(gi)) writeFileSync(gi, "*\n");
  }

  private readProto(t: TaskInfo): string | undefined {
    try {
      const html = readFileSync(join(this.workerDir(t), PROTO_FILE), "utf8").trim();
      return html && html.length <= PROTO_MAX ? html : undefined;
    } catch {
      return undefined;
    }
  }

  private readSpec(t: TaskInfo): string | undefined {
    try {
      return readFileSync(this.specPath(t), "utf8").trim().slice(0, SPEC_MAX) || undefined;
    } catch {
      return undefined;
    }
  }

  private writeSpec(t: TaskInfo, spec: string): void {
    this.specDir(t);
    writeFileSync(this.specPath(t), spec + "\n");
  }

  /** Готово: собрать отчёт и позвать пользователя. */
  private async ready(t: TaskInfo): Promise<void> {
    if (!this.running(t.id)) return;
    const files = await this.files(t);
    if (!this.running(t.id)) return;
    const summary = t.workerSessionId ? lastAssistantText(this.d.sessions.eventsAfter(t.workerSessionId, 0)) : "";
    t.report = {
      summary,
      files,
      checks: t.checksResult ?? "none",
      review: t.reviewVerdict ?? (t.reviewModel ? "skipped" : "skipped"),
      ...(t.reviewText ? { reviewText: t.reviewText } : {}),
      ...(t.mode === "team" ? { test: t.testVerdict ?? ("skipped" as const), ...(t.testText ? { testText: t.testText } : {}) } : {}),
    };
    t.status = "ready";
    delete t.stage;
    this.done.add(t.id);
    this.save(t);
    const what = files.length ? L(`файлов изменено: ${files.length}`, `files changed: ${files.length}`) : L("файлы не менялись", "no files changed");
    if (t.workerSessionId) this.d.notify(t.workerSessionId, L(`Задача готова: ${t.title} (${what})`, `Task ready: ${t.title} (${what})`));
    this.d.log?.(`[task] ${L("готово", "ready")}: ${t.title}`);
    await this.pump();
  }

  // ---------- мелочи ----------

  private emptyReport(): NonNullable<TaskInfo["report"]> {
    return { summary: "", files: [], checks: "none", review: "skipped" };
  }

  private workerDir(t: TaskInfo): string {
    const s = t.workerSessionId && this.session(t.workerSessionId);
    // сессии разработчика нет — всё равно в копии (её корень), а не в основном проекте
    return s ? s.directory : (t.worktree?.path ?? t.directory);
  }

  /** Что наработано в копии проекта: индексируем всё (копия наша) и сравниваем с основной веткой. */
  private async diff(t: TaskInfo): Promise<{ diff: string; files: Array<{ status: string; path: string }>; truncated: boolean }> {
    const g = this.d.git ?? git;
    const wt = t.worktree;
    if (!wt) return { diff: "", files: [], truncated: false };
    // новые файлы иначе не попадут в дифф; .gitignore (node_modules) при этом не трогаем
    await g(wt.path, ["add", "-A"]).catch(() => "");
    const from = await this.forkPoint(t);
    const diff = await g(wt.path, ["diff", "--no-color", from]).catch((e: GitError) => {
      this.d.log?.(`[task] diff: ${e.message}`);
      return "";
    });
    return { diff: diff.slice(0, DIFF_MAX), files: await this.files(t), truncated: diff.length > DIFF_MAX };
  }

/**
   * Откуда считать работу задачи: коммит, от которого ответвилась копия (merge-base), а не текущая основная ветка.
   * Основная могла уйти вперёд, пока задача работала, — тогда дифф от неё показал бы чужие коммиты как «удалённые» задачей.
   */
  private async forkPoint(t: TaskInfo): Promise<string> {
    const wt = t.worktree!;
    const g = this.d.git ?? git;
    return (await g(wt.path, ["merge-base", wt.base, "HEAD"]).catch(() => "")).trim() || wt.base;
  }

  private async files(t: TaskInfo): Promise<Array<{ status: string; path: string }>> {
    const g = this.d.git ?? git;
    const wt = t.worktree;
    if (!wt) return [];
    const out = await g(wt.path, ["diff", "--name-status", await this.forkPoint(t)]).catch(() => "");
    return out
      .split("\n")
      .filter(Boolean)
      .slice(0, 100)
      .map((l) => {
        const [status, ...rest] = l.split("\t");
        return { status: (status ?? "").trim(), path: rest.join("\t").trim() };
      })
      .filter((f) => f.path);
  }

  private step(t: TaskInfo, kind: TaskStepKind, sessionId?: string, model?: ModelRef): void {
    this.finishStep(t);
    const s: TaskStep = { kind, status: "running", startedAt: Date.now(), ...(sessionId ? { sessionId } : {}), ...(model ? { model } : {}) };
    t.steps.push(s);
    if (t.steps.length > 40) t.steps.splice(0, t.steps.length - 40);
  }

  private finishStep(t: TaskInfo): void {
    const s = t.steps.at(-1);
    if (s && s.status === "running") {
      s.status = "done";
      s.finishedAt = Date.now();
    }
  }

  private fail(t: TaskInfo, message: string): void {
    const cur = this.d.db.getTask(t.id);
    // остановленную (или уже влитую) задачу ошибкой не перекрашиваем. Статус — из базы, а данные — текущие:
    // в t уже могут быть несохранённые итоги шага (текст ревью, круги), их не теряем
    if (!cur || !["running", "waiting_limit", "queued"].includes(cur.status)) return;
    this.finishStep(t);
    const s = t.steps.at(-1);
    if (s) s.status = "failed";
    t.status = "failed";
    t.error = message.slice(0, 2000);
    this.done.add(t.id);
    this.save(t);
    if (t.workerSessionId) this.d.notify(t.workerSessionId, L(`Задача сломалась: ${t.title}`, `The task broke: ${t.title}`));
    this.d.log?.(`[task] ${L("ошибка", "error")} «${t.title}»: ${message}`);
    void this.pump();
  }

  private sessionIds(t: TaskInfo): string[] {
    const team = Object.values(t.team ?? {}).map((m) => m?.sessionId);
    return [t.workerSessionId, t.reviewSessionId, ...team].filter((x): x is string => !!x);
  }

  private session(id: string) {
    try {
      return this.d.sessions.get(id);
    } catch {
      return undefined;
    }
  }

  /** Задача ещё в работе: её могли остановить, пока мы ждали git или движок. Объект не перечитываем — на нём уже есть правки шага. */
  private running(id: string): boolean {
    const t = this.d.db.getTask(id);
    return !!t && t.status === "running";
  }

  /** Ждём, что движок перестал писать (у Claude abort — запрос прерывания, idle приходит позже). */
  private async waitStopped(id: string, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const s = this.session(id);
      if (!s || (s.status !== "busy" && s.status !== "retry")) return;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  private byWorker(sessionId: string): TaskInfo | undefined {
    return this.list().find((t) => t.workerSessionId === sessionId);
  }

  /** Задача сессии и чья это сессия в ней. */
  private bySession(sessionId: string): { task: TaskInfo; role: SessionRole } | undefined {
    for (const t of this.list()) {
      if (t.workerSessionId === sessionId) return { task: t, role: "worker" };
      if (t.reviewSessionId === sessionId) return { task: t, role: "review" };
      for (const r of ["analyst", "designer", "architect", "tester"] as const) if (t.team?.[r]?.sessionId === sessionId) return { task: t, role: r };
    }
    return undefined;
  }

  private save(t: TaskInfo): void {
    // задачу могли остановить, пока мы ждали git или движок — устаревший объект не должен затереть остановку
    const cur = this.d.db.getTask(t.id);
    if (cur && cur.status === "discarded" && t.status !== "discarded") return;
    // задача больше не работает — и ждать от человека нечего
    if (t.status !== "running" && t.status !== "waiting_limit") delete t.asking;
    t.updatedAt = Date.now();
    this.d.db.saveTask(t);
    this.emit();
  }

  private emit(): void {
    const tasks = this.list();
    for (const cb of this.listeners) {
      try {
        cb(tasks);
      } catch (e) {
        this.d.log?.(`[task] ${(e as Error).message}`);
      }
    }
  }
}
