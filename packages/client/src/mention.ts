// «@» в поле ввода: упоминание файла или папки проекта, как в IDE. Общее для веба и приложения.

/** Набираемое упоминание у курсора: «@» в начале строки или после пробела, до курсора без пробелов. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | undefined {
  const m = /(^|\s)@([^\s@"]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

/** Как путь пишется в сообщении: «@путь», с пробелами — в кавычках; папка — со «/» на конце. */
export function mentionText(path: string, dir = false): string {
  const p = path.replace(/\\/g, "/") + (dir && !path.endsWith("/") ? "/" : "");
  return /\s/.test(p) ? `@"${p}"` : `@${p}`;
}

/**
 * Вставить выбранный путь вместо набираемого «@…». Папка — без пробела после: можно сразу искать внутри неё.
 * Возвращает новый текст и позицию курсора.
 */
export function applyMention(text: string, caret: number, path: string, dir = false): { text: string; caret: number } {
  const at = mentionAt(text, caret);
  if (!at) return { text, caret };
  // хвост слова после курсора (правили середину) заменяем тоже
  const tail = /^[^\s]*/.exec(text.slice(caret))![0].length;
  const ins = mentionText(path, dir) + (dir && !/\s/.test(path) ? "" : " ");
  const next = text.slice(0, at.start) + ins + text.slice(caret + tail).replace(/^ /, "");
  return { text: next, caret: at.start + ins.length };
}
