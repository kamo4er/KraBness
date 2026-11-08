export function mermaidSource(className: unknown, children: unknown): string | undefined {
  if (typeof className !== "string" || !/(?:^|\s)language-mermaid(?:\s|$)/i.test(className)) return undefined;
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) return children.join("");
  return undefined;
}
