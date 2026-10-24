export interface SseEvent {
  id?: string;
  event?: string;
  data?: string;
}

/** Читает SSE-поток до конца или до abort. */
export async function readSse(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const res = await fetch(url, { signal, headers: { accept: "text/event-stream", ...headers } });
  if (!res.ok || !res.body) throw new Error(`SSE ${url} → ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev: SseEvent = {};
      for (const line of chunk.split("\n")) {
        const m = /^(id|event|data):\s?(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1] as keyof SseEvent;
        ev[key] = ev[key] !== undefined ? `${ev[key]}\n${m[2]}` : m[2];
      }
      onEvent(ev);
    }
  }
}
