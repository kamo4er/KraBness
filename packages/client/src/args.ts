// Строка аргументов команды → массив (кавычки "…" и '…' держат пробелы) и обратно — для форм MCP-серверов.
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export function joinArgs(args: string[] = []): string {
  return args.map((a) => (a === "" || /\s/.test(a) ? `"${a}"` : a)).join(" ");
}

/** «КЛЮЧ=значение» построчно → объект (пустые строки и строки без «=» пропускаются). */
export function parsePairs(text: string, sep = "="): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
}
