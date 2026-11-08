// Замечания по вёрстке со страницы превью: проверить, что прислала панель, сохранить снимки во входящие сессии
// и отдать агенту одним сообщением (текст + элемент + картинка по каждому).
import { Readable } from "node:stream";
import type { LayoutComment, LayoutComments } from "@kamharn/protocol";
import type { FileStore } from "./files.ts";
import { L } from "./lang.ts";
import { HttpError, type SessionManager } from "./sessions.ts";

const MAX_ITEMS = 20;
const MAX_IMAGE = 3 * 1024 * 1024;
const IMAGE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

const str = (v: unknown, max: number): string => String(v ?? "").slice(0, max);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

/** Привести присланное к виду LayoutComments; мусор — понятная ошибка. */
export function parseLayoutComments(raw: unknown): LayoutComments {
  const r = (raw ?? {}) as Record<string, any>;
  const items = Array.isArray(r.items) ? r.items : [];
  if (!items.length) throw new HttpError(400, L("Нет замечаний", "No comments"));
  if (items.length > MAX_ITEMS) throw new HttpError(400, L(`Не больше ${MAX_ITEMS} замечаний за раз`, `At most ${MAX_ITEMS} comments at once`));
  return {
    url: str(r.url, 500),
    ...(r.title ? { title: str(r.title, 200) } : {}),
    viewport: { w: num(r.viewport?.w), h: num(r.viewport?.h), dpr: Math.round(Number(r.viewport?.dpr) * 100) / 100 || 1 },
    items: items.map((it: Record<string, any>, i: number): LayoutComment => {
      const text = str(it?.text, 2000).trim();
      if (!text) throw new HttpError(400, L(`Замечание ${i + 1} пустое`, `Comment ${i + 1} is empty`));
      const styles: Record<string, string> = {};
      for (const [k, v] of Object.entries((it?.styles ?? {}) as Record<string, unknown>).slice(0, 30)) styles[str(k, 40)] = str(v, 120);
      const image = typeof it?.image === "string" && IMAGE.test(it.image) ? it.image : undefined;
      return {
        text,
        selector: str(it?.selector, 500),
        html: str(it?.html, 1000),
        rect: { x: num(it?.rect?.x), y: num(it?.rect?.y), w: num(it?.rect?.w), h: num(it?.rect?.h) },
        styles,
        ...(image ? { image } : {}),
      };
    }),
  };
}

/** Текст сообщения агенту; images[i] — имя файла снимка i-го замечания (если он есть). */
export function layoutPrompt(c: LayoutComments, images: Array<string | undefined>): string {
  const v = c.viewport;
  const head = L(
    `Замечания по вёрстке страницы ${c.url}${c.title ? ` («${c.title}»)` : ""}, экран ${v.w}×${v.h}, масштаб ${v.dpr}:`,
    `Layout comments on ${c.url}${c.title ? ` (“${c.title}”)` : ""}, screen ${v.w}×${v.h}, scale ${v.dpr}:`,
  );
  const items = c.items.map((it, i) => {
    const r = it.rect;
    const styles = Object.entries(it.styles)
      .map(([k, val]) => `${k}: ${val}`)
      .join("; ");
    return [
      `${i + 1}. «${it.text}» — \`${it.selector}\``,
      it.html && `   ${it.html.replace(/\s+/g, " ")}`,
      `   ${r.w}×${r.h} ${L("в", "at")} (${r.x}, ${r.y})${styles ? ` · ${styles}` : ""}`,
      images[i] && `   ${L("снимок", "snapshot")}: ${images[i]}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [head, ...items, L("Поправь вёрстку по этим замечаниям.", "Fix the layout according to these comments.")].join("\n\n");
}

/** Принять пачку замечаний: снимки — во входящие сессии, всё — агенту одним сообщением. */
export async function sendLayoutComments(sessions: SessionManager, files: FileStore, sessionId: string, raw: unknown): Promise<{ ok: true; count: number }> {
  const s = sessions.get(sessionId);
  const c = parseLayoutComments(raw);
  const fileIds: string[] = [];
  const names: Array<string | undefined> = [];
  for (const [i, it] of c.items.entries()) {
    const m = it.image ? IMAGE.exec(it.image) : null;
    const buf = m ? Buffer.from(m[2]!, "base64") : undefined;
    if (!buf?.length || buf.length > MAX_IMAGE) {
      names.push(undefined);
      continue;
    }
    const name = `layout-${i + 1}.${m![1] === "jpeg" ? "jpg" : "png"}`;
    const row = await files.saveIncoming(s.id, s.directory, name, Readable.from([buf]), `image/${m![1]}`);
    fileIds.push(row.id);
    names.push(name);
  }
  await sessions.prompt(sessionId, layoutPrompt(c, names), fileIds);
  return { ok: true, count: c.items.length };
}
