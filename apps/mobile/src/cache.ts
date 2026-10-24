// Чаты на телефоне: собранное состояние чата лежит в файле, при открытии показывается сразу,
// а у хаба запрашиваются только события после его lastSeq. Без этого после выгрузки приложения
// из памяти каждый чат заново качался целиком (мегабайты журнала через Tailscale).
import { AppState } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import type { HubClient, SessionGroup, SessionInfo, SessionView } from "@kamharn/client";

// поменять, если меняется формат SessionView: старые файлы просто перестанут читаться
const VERSION = 1;
const SAVE_DELAY_MS = 3000;

const dir = new Directory(Paths.document, "chats");
const fileOf = (id: string) => new File(dir, `${id.replace(/[^\w-]/g, "_")}.json`);
// список сессий — отдельно от папки чатов (её чистит prune)
const sessionsFile = new File(Paths.document, "sessions.json");

function loadSessions(): { sessions: SessionInfo[]; groups: SessionGroup[] } | undefined {
  try {
    if (!sessionsFile.exists) return undefined;
    const data = JSON.parse(sessionsFile.textSync()) as { v: number; sessions: SessionInfo[]; groups?: SessionGroup[] };
    return data.v === VERSION && Array.isArray(data.sessions) ? { sessions: data.sessions, groups: data.groups ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

/** Сохранённое состояние чата или undefined (нет, битое, старый формат). */
export function loadChat(id: string): SessionView | undefined {
  const f = fileOf(id);
  try {
    if (!f.exists) return undefined;
    const data = JSON.parse(f.textSync()) as { v: number; view: SessionView };
    if (data.v === VERSION && data.view && typeof data.view.lastSeq === "number") return data.view;
  } catch {
    // недописанный файл (приложение убили при записи) — выбрасываем
  }
  try {
    f.delete();
  } catch {}
  return undefined;
}

const saved = new Map<string, number>();
let savedSessions: SessionInfo[] | undefined;
let savedGroups: SessionGroup[] | undefined;
let writing = false;

async function flush(c: HubClient): Promise<void> {
  if (writing) return;
  writing = true;
  try {
    if (c.state.conn === "online" && (c.state.sessions !== savedSessions || c.state.groups !== savedGroups)) {
      await sessionsFile.write(JSON.stringify({ v: VERSION, sessions: c.state.sessions, groups: c.state.groups }));
      savedSessions = c.state.sessions;
      savedGroups = c.state.groups;
    }
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    for (const [id, view] of Object.entries(c.state.views)) {
      if (view.lastSeq === 0 || saved.get(id) === view.lastSeq) continue;
      await fileOf(id).write(JSON.stringify({ v: VERSION, view }));
      saved.set(id, view.lastSeq);
    }
  } catch (e) {
    console.warn("[kamharn] chat cache write failed", e);
  } finally {
    writing = false;
  }
}

/** Удалить файлы чатов, которых больше нет на хабе. */
function prune(c: HubClient): void {
  if (c.state.conn !== "online" || !dir.exists) return;
  const alive = new Set(c.state.sessions.map((s) => fileOf(s.id).name));
  for (const f of dir.list()) {
    if (f instanceof File && !alive.has(f.name)) {
      try {
        f.delete();
      } catch {}
    }
  }
}

/** Следить за чатами клиента и сохранять их (с задержкой и при уходе приложения в фон). */
export function persistChats(c: HubClient): () => void {
  // список сессий с прошлого раза: приложение открывается сразу, а не с «Загрузка…»
  const cachedSessions = loadSessions();
  if (cachedSessions) c.hydrateSessions(cachedSessions.sessions, cachedSessions.groups);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sessionsRef = c.state.sessions;
  const unsub = c.subscribe(() => {
    if (c.state.sessions !== sessionsRef) {
      sessionsRef = c.state.sessions;
      prune(c);
    }
    if (!timer) timer = setTimeout(() => ((timer = undefined), void flush(c)), SAVE_DELAY_MS);
  });
  const app = AppState.addEventListener("change", (s) => {
    if (s !== "active") void flush(c);
  });
  return () => {
    unsub();
    app.remove();
    if (timer) clearTimeout(timer);
  };
}
