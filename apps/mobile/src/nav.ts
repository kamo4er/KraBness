// Простой стек экранов: для четырёх экранов роутер не нужен.
import { useSyncExternalStore } from "react";

export type Route =
  | { page: "home" }
  | { page: "session"; id: string }
  | { page: "project"; id: string }
  | { page: "file"; fileId: string; name: string; mime: string; size: number }
  /** group — новая сессия сразу в группе */
  | { page: "new"; group?: string }
  | { page: "settings" }
  /** модели и провайдеры opencode */
  | { page: "providers" }
  /** свои MCP-серверы и скиллы */
  | { page: "mcp" }
  | { page: "skills" }
  /** экран группы сессий: id "new" — создать */
  | { page: "group"; id: string };

let stack: Route[] = [{ page: "home" }];
const listeners = new Set<() => void>();
const set = (s: Route[]) => {
  stack = s;
  for (const l of listeners) l();
};

export const go = (r: Route) => set(r.page === "home" ? [{ page: "home" }] : [...stack, r]);
/** заменить текущий экран (например, «новая сессия» → сама сессия) */
export const replace = (r: Route) => set([...stack.slice(0, -1), r]);
/** false — назад некуда (пусть система свернёт приложение) */
export const back = (): boolean => {
  if (stack.length <= 1) return false;
  set(stack.slice(0, -1));
  return true;
};

export function useRoute(): Route {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => stack[stack.length - 1]!,
  );
}
