// Текст ответа агента для озвучки: без кода, путей, ссылок и markdown — их вслух слушать бессмысленно.

/** Android TTS не берёт больше ~4000 символов за раз */
export const SPEECH_MAX = 3900;

export function speakableText(md: string): string {
  let s = md
    // блоки кода целиком
    .replace(/```[\s\S]*?(```|$)/g, " ")
    // [текст](ссылка) → текст; голые ссылки — прочь
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    // `код`: короткое слово оставляем, пути и выражения — нет
    .replace(/`([^`]*)`/g, (_, c: string) => (c.length <= 24 && !/[\\/.(){}=<>:_]/.test(c) ? c : " "))
    // пути Windows и unix
    .replace(/[A-Za-z]:\\[^\s,;)]*/g, " ")
    .replace(/(^|\s)(\.{0,2}\/[\w.-]+)+\/?/g, " ")
    // markdown: заголовки, цитаты, списки, таблицы, выделение, разделители
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|?[-:\s|]{3,}\|?\s*$/gm, "")
    .replace(/[✓✔✗✘⏳⚠️🔊]/gu, " ")
    // строка таблицы → ячейки через запятую
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(", "))
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2");
  s = s
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return s.length > SPEECH_MAX ? s.slice(0, s.lastIndexOf(" ", SPEECH_MAX)) + "…" : s;
}

/** Что прочитать вслух в режиме «Разговор»: первый абзац ответа (у Диспетчера это итог); длинный — до конца предложения в пределах ~400 знаков. */
export function talkPart(md: string): string {
  const paragraphs = md.replace(/```[\s\S]*?(```|$)/g, "\n\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const first = paragraphs[0] ?? "";
  if (first.length <= 400) return first;
  const cut = first.slice(0, 400);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end >= 20 ? cut.slice(0, end + 1) : cut;
}
