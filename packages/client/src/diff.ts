// Построчный дифф правки (old_string → new_string) для карточек подтверждения и инструментов:
// показываем только изменённые строки и немного контекста, а не «удалено всё, добавлено всё».

export type DiffRow = { kind: "ctx" | "del" | "add"; text: string } | { kind: "gap"; count: number };

/** дальше этого (строк старого × нового после общих краёв) LCS не считаем — показываем как раньше, целиком */
const MAX_CELLS = 1_000_000;

const lines = (s: string): string[] => (s === "" ? [] : s.split("\n").map((l) => l.replace(/\r$/, "")));

export function lineDiff(oldText: string, newText: string, context = 2): DiffRow[] {
  const a = lines(oldText);
  const b = lines(newText);
  // общие начало и конец — без LCS: обычно правка меняет пару строк в середине
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const mid: DiffRow[] = [];
  if (am.length * bm.length > MAX_CELLS) {
    for (const t of am) mid.push({ kind: "del", text: t });
    for (const t of bm) mid.push({ kind: "add", text: t });
  } else {
    // lcs[i][j] — длина общей подпоследовательности хвостов am[i..] и bm[j..]
    const n = am.length;
    const m = bm.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) (mid.push({ kind: "ctx", text: am[i]! }), i++, j++);
      // удаления раньше вставок: «−старое» над «+новым», как в git
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) mid.push({ kind: "del", text: am[i++]! });
      else mid.push({ kind: "add", text: bm[j++]! });
    }
  }
  const all: DiffRow[] = [...a.slice(0, pre).map((text) => ({ kind: "ctx" as const, text })), ...mid, ...a.slice(a.length - suf).map((text) => ({ kind: "ctx" as const, text }))];

  // контекст — только рядом с изменениями, остальное сворачиваем в «… N строк без изменений»
  const changed = all.map((r) => r.kind !== "ctx");
  const near = (k: number) => {
    for (let d = -context; d <= context; d++) if (changed[k + d]) return true;
    return false;
  };
  const out: DiffRow[] = [];
  let skipped: DiffRow[] = [];
  // одну строку не сворачиваем: «⋯ 1 строка без изменений» не короче её самой
  const flush = () => (skipped.length === 1 ? out.push(skipped[0]!) : skipped.length && out.push({ kind: "gap", count: skipped.length }), (skipped = []));
  all.forEach((r, k) => {
    if (r.kind !== "ctx" || near(k)) (flush(), out.push(r));
    else skipped.push(r);
  });
  flush();
  return out;
}
