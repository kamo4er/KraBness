// Панель замечаний по вёрстке: хаб вставляет её в страницы превью (режим замечаний).
// Тыкаешь в элемент → пишешь, что не так → копишь пачку → «Отправить агенту»: прокси хаба отдаёт всё агенту сессии.
// Своя Shadow DOM: стили страницы не ломают панель и наоборот. Замечания живут в localStorage страницы — HMR их не теряет.
import { domToPng } from "modern-screenshot";
import type { LayoutComment, LayoutComments } from "@kamharn/protocol";
import { cssPath, htmlSnippet, label, rectOf, stylesOf } from "./describe.ts";

type Note = LayoutComment & { id: string };

const ru = /[?&]lang=ru\b/.test((document.currentScript as HTMLScriptElement | null)?.src ?? "");
const t = (r: string, e: string) => (ru ? r : e);
const KEY = `krab-notes:${location.pathname}`;
const MAX_IMAGE = 4_000_000; // длина data URL (~3 МБ картинки)

function load(): Note[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Note[];
  } catch {
    return [];
  }
}
function save(list: Note[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // не влезло со снимками — храним без них, снимем заново при отправке
    try {
      localStorage.setItem(KEY, JSON.stringify(list.map(({ image: _i, ...n }) => n)));
    } catch {
      /* хранилище недоступно — живём в памяти */
    }
  }
}

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 52px; height: 52px; border-radius: 26px; border: 0;
  background: #3987e5; color: #fff; font-size: 22px; box-shadow: 0 4px 16px rgba(0,0,0,.35); cursor: pointer; }
.fab b { position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; border-radius: 10px; background: #e5484d; font: 600 12px/20px system-ui; padding: 0 5px; }
.panel { position: fixed; right: 12px; left: auto; bottom: 80px; z-index: 2147483647; width: min(420px, calc(100vw - 24px)); max-height: 70vh; overflow: auto;
  background: #171a21; color: #e6e8ee; border: 1px solid #2b303b; border-radius: 12px; padding: 12px; font-size: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.45); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn { border: 1px solid #2b303b; background: #232833; color: #e6e8ee; border-radius: 8px; padding: 8px 12px; font-size: 14px; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: default; }
.primary { background: #3987e5; border-color: #3987e5; color: #fff; }
.danger { color: #ff8589; }
.muted { color: #9aa3b2; font-size: 12px; }
.mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
h3 { margin: 0 0 8px; font-size: 15px; }
ol { margin: 8px 0; padding-left: 22px; }
li { margin: 6px 0; }
li .t { cursor: pointer; }
textarea { width: 100%; min-height: 72px; margin: 8px 0; background: #0f1115; color: #e6e8ee; border: 1px solid #2b303b; border-radius: 8px; padding: 8px; font-size: 15px; resize: vertical; }
.hl { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid #3987e5; background: rgba(57,135,229,.15); border-radius: 3px; display: none; }
.pin { position: fixed; z-index: 2147483646; min-width: 20px; height: 20px; border-radius: 10px; background: #e5484d; color: #fff; font: 600 12px/20px system-ui;
  text-align: center; padding: 0 5px; pointer-events: auto; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 84px; z-index: 2147483647; background: #232833; color: #e6e8ee; border: 1px solid #2b303b;
  border-radius: 8px; padding: 8px 12px; font-size: 14px; }
.bar { position: fixed; left: 50%; transform: translateX(-50%); top: 12px; z-index: 2147483647; background: #3987e5; color: #fff; border-radius: 8px; padding: 8px 12px; font-size: 14px; display: flex; gap: 10px; align-items: center; }
.bar button { background: rgba(255,255,255,.2); color: #fff; border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
`;

function main(): void {
  if (document.querySelector("krab-notes")) return;
  const host = document.createElement("krab-notes");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS}</style><div class="hl"></div><div class="pins"></div><div class="ui"></div>`;
  document.documentElement.appendChild(host);
  const hl = root.querySelector<HTMLDivElement>(".hl")!;
  const pins = root.querySelector<HTMLDivElement>(".pins")!;
  const ui = root.querySelector<HTMLDivElement>(".ui")!;

  let notes = load();
  let open = false;
  let picking = false;
  let picked: Element | undefined;
  let busy = false;
  let toast = "";
  let toastTimer: number | undefined;

  const say = (msg: string) => {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ((toast = ""), render()), 3500);
    render();
  };
  const ours = (t: EventTarget | null) => t === host || (t instanceof Node && host.contains(t));
  const box = (el: Element | undefined) => {
    if (!el) return void (hl.style.display = "none");
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };

  // ---------- выбор элемента ----------
  const onMove = (e: PointerEvent) => {
    if (!picking || e.pointerType === "touch") return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !ours(el)) box(el);
  };
  // пока выбираем — клик по странице не должен ничего делать (ссылки, кнопки, меню)
  const swallow = (e: Event) => {
    if (!picking || ours(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  const onClick = (e: MouseEvent) => {
    if (!picking || ours(e.target)) return;
    swallow(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el)) return;
    stopPicking();
    picked = el;
    open = true;
    render();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && picking) (stopPicking(), render());
  };
  const startPicking = () => {
    picking = true;
    picked = undefined;
    open = false;
    document.addEventListener("pointermove", onMove, true);
    for (const t of ["pointerdown", "mousedown", "mouseup", "pointerup"]) document.addEventListener(t, swallow, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    render();
  };
  const stopPicking = () => {
    picking = false;
    document.removeEventListener("pointermove", onMove, true);
    for (const t of ["pointerdown", "mousedown", "mouseup", "pointerup"]) document.removeEventListener(t, swallow, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    box(undefined);
  };

  // ---------- снимок ----------
  /** Маленький элемент снимаем вместе с блоком вокруг: «налезает на текст» без соседей не понять. */
  function contextOf(el: Element): Element {
    let ctx = el;
    for (let i = 0; i < 3; i++) {
      const r = ctx.getBoundingClientRect();
      const up = ctx.parentElement;
      if ((r.width >= 320 || r.height >= 200) || !up || up === document.body || up === document.documentElement) break;
      ctx = up;
    }
    return ctx;
  }

  /** Обвести элемент рамкой на снимке блока вокруг него. */
  async function outline(url: string, ctx: Element, el: Element, scale: number): Promise<string> {
    const img = new Image();
    await new Promise((res, rej) => ((img.onload = res), (img.onerror = rej), (img.src = url)));
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const a = ctx.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    g.strokeStyle = "#e5484d";
    g.lineWidth = 2 * scale;
    g.strokeRect((b.left - a.left) * scale - scale, (b.top - a.top) * scale - scale, b.width * scale + 2 * scale, b.height * scale + 2 * scale);
    return c.toDataURL("image/png");
  }

  async function snap(el: Element): Promise<string | undefined> {
    const ctx = contextOf(el);
    const shot = async (scale: number) => {
      const url = await Promise.race([
        domToPng(ctx, { scale, filter: (n) => n !== host }),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000)),
      ]);
      return ctx === el ? url : outline(url, ctx, el, scale);
    };
    try {
      let url = await shot(Math.min(devicePixelRatio || 1, 2));
      if (url.length > MAX_IMAGE) url = await shot(1);
      return url.length > MAX_IMAGE ? undefined : url;
    } catch {
      // чужие шрифты/картинки и т. п. — без снимка, остальное агенту всё равно уйдёт
      return undefined;
    }
  }

  async function add(text: string) {
    const el = picked;
    if (!el || !text.trim()) return;
    busy = true;
    render();
    box(undefined);
    const note: Note = {
      id: Math.random().toString(36).slice(2, 9),
      text: text.trim(),
      selector: cssPath(el),
      html: htmlSnippet(el),
      rect: rectOf(el),
      styles: stylesOf(el),
    };
    const image = await snap(el);
    if (image) note.image = image;
    notes = [...notes, note];
    save(notes);
    picked = undefined;
    busy = false;
    render();
  }

  async function send() {
    if (!notes.length || busy) return;
    busy = true;
    render();
    // снимки, не пережившие перезагрузку (не влезли в хранилище), — снять заново, если элемент на месте
    const items: LayoutComment[] = [];
    for (const { id: _id, ...n } of notes) {
      let image = n.image;
      if (!image) {
        const el = safeQuery(n.selector);
        if (el) image = await snap(el);
      }
      items.push({ ...n, ...(image ? { image } : {}) });
    }
    const body: LayoutComments = { url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio || 1 }, items };
    try {
      const r = await fetch("/__krab/comments", { method: "POST", headers: { "content-type": "application/json", "x-krab": "1" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      notes = [];
      save(notes);
      open = false;
      busy = false;
      say(t("Отправлено агенту ✓", "Sent to the agent ✓"));
    } catch (e) {
      busy = false;
      say(`⚠️ ${(e as Error).message}`);
    }
  }

  const safeQuery = (sel: string): Element | null => {
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  };

  // ---------- метки ①②③ на странице ----------
  const placePins = () => {
    const html = notes
      .map((n, i) => {
        const el = safeQuery(n.selector);
        if (!el) return "";
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return "";
        return `<div class="pin" data-i="${i}" style="left:${Math.max(0, r.left - 6)}px;top:${Math.max(0, r.top - 8)}px">${i + 1}</div>`;
      })
      .join("");
    if (pins.innerHTML !== html) pins.innerHTML = html;
  };
  let raf = 0;
  const schedulePins = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(placePins);
  };
  addEventListener("scroll", schedulePins, true);
  addEventListener("resize", schedulePins);
  // страница меняется сама (HMR, анимации) — метки догоняют раз в секунду
  setInterval(placePins, 1000);
  pins.addEventListener("click", (e) => {
    const i = Number((e.target as HTMLElement).dataset.i);
    if (Number.isFinite(i)) (open = true), render();
  });

  // ---------- разметка панели ----------
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

  function render() {
    const parts: string[] = [];
    if (picking) parts.push(`<div class="bar">${t("Нажми на элемент", "Tap an element")} <button data-a="cancel">${t("Отмена", "Cancel")}</button></div>`);
    else parts.push(`<button class="fab" data-a="toggle" title="${t("Замечания по вёрстке", "Layout comments")}">💬${notes.length ? `<b>${notes.length}</b>` : ""}</button>`);
    if (open && !picking) {
      if (picked) {
        parts.push(`<div class="panel">
          <h3>${t("Что не так?", "What's wrong?")}</h3>
          <div class="mono">${esc(label(picked))}</div>
          <textarea placeholder="${t("Например: кнопка налезает на текст", "E.g. the button overlaps the text")}"></textarea>
          <div class="row">
            <button class="btn primary" data-a="add" ${busy ? "disabled" : ""}>${busy ? t("Снимаю…", "Capturing…") : t("Добавить", "Add")}</button>
            ${picked.parentElement && picked.parentElement !== document.body ? `<button class="btn" data-a="parent">⬆ ${t("Блок побольше", "Bigger block")}</button>` : ""}
            <button class="btn" data-a="drop">${t("Отмена", "Cancel")}</button>
          </div></div>`);
      } else {
        const list = notes
          .map(
            (n, i) => `<li><span class="t" data-a="show" data-i="${i}">${esc(n.text)}</span>
              <div class="row"><span class="mono muted">${esc(n.selector)}</span>${n.image ? "" : `<span class="muted">· ${t("без снимка", "no snapshot")}</span>`}
              <button class="btn danger" data-a="del" data-i="${i}">✕</button></div></li>`,
          )
          .join("");
        parts.push(`<div class="panel">
          <h3>${t("Замечания по вёрстке", "Layout comments")}</h3>
          ${notes.length ? `<ol>${list}</ol>` : `<div class="muted">${t("Нажми «Выбрать элемент» и ткни в то, что не нравится.", "Press “Pick an element” and tap what you don't like.")}</div>`}
          <div class="row" style="margin-top:8px">
            <button class="btn" data-a="pick">➕ ${t("Выбрать элемент", "Pick an element")}</button>
            <button class="btn primary" data-a="send" ${!notes.length || busy ? "disabled" : ""}>${busy ? t("Отправляю…", "Sending…") : `${t("Отправить агенту", "Send to the agent")} (${notes.length})`}</button>
          </div></div>`);
      }
    }
    if (toast) parts.push(`<div class="toast">${esc(toast)}</div>`);
    const typed = ui.querySelector("textarea")?.value;
    ui.innerHTML = parts.join("");
    const ta = ui.querySelector("textarea");
    if (ta) {
      if (typed) ta.value = typed;
      ta.focus();
    }
    box(picked);
    placePins();
  }

  ui.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-a]");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    switch (btn.dataset.a) {
      case "toggle":
        open = !open;
        picked = undefined;
        return render();
      case "pick":
        return startPicking();
      case "cancel":
        stopPicking();
        open = true;
        return render();
      case "parent":
        if (picked?.parentElement && picked.parentElement !== document.body) picked = picked.parentElement;
        return render();
      case "drop":
        picked = undefined;
        return render();
      case "add":
        return void add(ui.querySelector("textarea")?.value ?? "");
      case "del":
        notes = notes.filter((_, k) => k !== i);
        save(notes);
        return render();
      case "show": {
        const el = safeQuery(notes[i]?.selector ?? "");
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        if (el) setTimeout(() => (box(el), setTimeout(() => box(picked), 1500)), 400);
        return;
      }
      case "send":
        return void send();
    }
  });
  render();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
else main();
