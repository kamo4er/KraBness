// Описание элемента для агента: селектор, кусок HTML, положение, важные стили.

const STYLE_KEYS = [
  "display",
  "position",
  "width",
  "height",
  "margin",
  "padding",
  "font-size",
  "font-weight",
  "line-height",
  "font-family",
  "color",
  "background-color",
  "border",
  "border-radius",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "text-align",
  "overflow",
  "z-index",
];
/** значения по умолчанию — агенту только шум */
const BORING = /^(none|normal|auto|0px|static|visible|start|rgba\(0, 0, 0, 0\)|0px none .*|stretch|row|flex-start)$/;

const unique = (sel: string): boolean => {
  try {
    return document.querySelectorAll(sel).length === 1;
  } catch {
    return false;
  }
};
const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** классы сборщиков (css-1x2y3, sc-abc, хэши) меняются от сборки к сборке — в селектор не берём */
const stableClass = (c: string) => /^[A-Za-z][\w-]*$/.test(c) && !/^(css|sc|jsx|svelte|astro|emotion)-/.test(c) && !/\d{3,}|[a-z]+[0-9][a-z0-9]{4,}$/i.test(c);

// Короткий однозначный CSS-селектор: id, потом data-атрибуты, name или aria-label, потом классы и nth-of-type;
// поднимаемся по дереву, пока селектор не станет уникальным.
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    let part: string;
    if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) part = `#${cur.id}`;
    else {
      part = cur.tagName.toLowerCase();
      const attr = ["data-testid", "data-test", "data-id", "name", "aria-label"].find((a) => cur!.getAttribute(a));
      if (attr) part += `[${attr}=${quote(cur.getAttribute(attr)!)}]`;
      else {
        const cls = [...cur.classList].filter(stableClass).slice(0, 2);
        if (cls.length) part += cls.map((c) => `.${c}`).join("");
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((x) => x.matches(part));
        if (same.length > 1) part += `:nth-of-type(${[...parent.children].filter((x) => x.tagName === cur!.tagName).indexOf(cur) + 1})`;
      }
    }
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (unique(sel)) return sel;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

/** Начало outerHTML: длинный элемент — открывающий тег, кусок текста и закрывающий тег. */
export function htmlSnippet(el: Element, max = 300): string {
  const html = el.outerHTML.replace(/\s+/g, " ");
  if (html.length <= max) return html;
  const open = html.slice(0, html.indexOf(">") + 1).slice(0, max - 40);
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${open}${text ? text + "…" : "…"}</${el.tagName.toLowerCase()}>`;
}

export function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
}

export function stylesOf(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const k of STYLE_KEYS) {
    let v = cs.getPropertyValue(k).trim();
    if (k === "font-family") v = v.split(",")[0]!.replace(/["']/g, "");
    if (v && (k === "display" || k === "width" || k === "height" || !BORING.test(v))) out[k] = v;
  }
  return out;
}

/** Подпись элемента в панели: button.buy-btn 120×40 */
export function label(el: Element): string {
  const r = el.getBoundingClientRect();
  const cls = [...el.classList].filter(stableClass).slice(0, 2);
  return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls.map((c) => "." + c).join("")} ${Math.round(r.width)}×${Math.round(r.height)}`;
}
