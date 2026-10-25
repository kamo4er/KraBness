// SQLite-хранилище хаба: сессии, журнал событий (для replay), устройства, файлы.
import { DatabaseSync } from "node:sqlite";
import type { TaskInfo, EngineId, ModelRef, PermissionMode, SessionEvent, SessionInfo, SessionStatus, StoredEvent, SessionGroup, WorktreeInfo } from "@kamharn/protocol";
import { L } from "./lang.ts";

export interface SessionRow extends SessionInfo {
  engineSessionId: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: number;
  lastSeen: number;
  fcmToken: string | null;
}

export interface FileRow {
  id: string;
  sessionId: string | null;
  direction: "in" | "out";
  name: string;
  mime: string;
  size: number;
  path: string;
  sha256: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

export class Db {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        engine TEXT NOT NULL,
        engine_session_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        model_json TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        fcm_token TEXT
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        direction TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // колонки, добавленные позже: у старых баз их нет
    const cols = (this.db.prepare(`PRAGMA table_info(sessions)`).all() as Row[]).map((c) => String(c.name));
    if (!cols.includes("resume_at")) this.db.exec(`ALTER TABLE sessions ADD COLUMN resume_at INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes("worktree_json")) this.db.exec(`ALTER TABLE sessions ADD COLUMN worktree_json TEXT`);
    if (!cols.includes("group_id")) this.db.exec(`ALTER TABLE sessions ADD COLUMN group_id TEXT`);
    if (!cols.includes("auto_check")) this.db.exec(`ALTER TABLE sessions ADD COLUMN auto_check INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes("task_id")) this.db.exec(`ALTER TABLE sessions ADD COLUMN task_id TEXT`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, prompt TEXT, sort INTEGER NOT NULL DEFAULT 0)`);
    // задача целиком лежит в JSON: её поля меняются чаще, чем стоит плодить колонки
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL)`);
  }

  close(): void {
    this.db.close();
  }

  // ---------- sessions ----------

  insertSession(s: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, engine, engine_session_id, directory, title, model_json, permission_mode, status, created_at, updated_at, last_seq, worktree_json, group_id, task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.engine, s.engineSessionId, s.directory, s.title, JSON.stringify(s.model), s.permissionMode, s.status, s.createdAt, s.updatedAt, s.lastSeq, s.worktree ? JSON.stringify(s.worktree) : null, s.groupId || null, s.taskId || null);
  }

  updateSession(id: string, patch: Partial<Pick<SessionInfo, "title" | "status" | "model" | "permissionMode" | "updatedAt" | "resumeAt" | "groupId" | "autoCheck">>): void {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.title !== undefined) sets.push("title = ?"), vals.push(patch.title);
    if (patch.permissionMode !== undefined) sets.push("permission_mode = ?"), vals.push(patch.permissionMode);
    if (patch.status !== undefined) sets.push("status = ?"), vals.push(patch.status);
    if (patch.model !== undefined) sets.push("model_json = ?"), vals.push(JSON.stringify(patch.model));
    if (patch.updatedAt !== undefined) sets.push("updated_at = ?"), vals.push(patch.updatedAt);
    if (patch.resumeAt !== undefined) sets.push("resume_at = ?"), vals.push(patch.resumeAt);
    // "" — убрать из группы
    if (patch.groupId !== undefined) sets.push("group_id = ?"), vals.push(patch.groupId || (null as unknown as string));
    if (patch.autoCheck !== undefined) sets.push("auto_check = ?"), vals.push(patch.autoCheck ? 1 : 0);
    if (!sets.length) return;
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  listSessions(): SessionRow[] {
    return (this.db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`).all() as Row[]).map(toSession);
  }

  // ---------- группы сессий ----------

  // ---------- tasks ----------

  listTasks(): TaskInfo[] {
    return (this.db.prepare(`SELECT json FROM tasks ORDER BY created_at DESC`).all() as Row[]).map((r) => JSON.parse(String(r.json)) as TaskInfo);
  }

  getTask(id: string): TaskInfo | undefined {
    const r = this.db.prepare(`SELECT json FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.json)) as TaskInfo) : undefined;
  }

  saveTask(t: TaskInfo): void {
    this.db.prepare(`INSERT INTO tasks (id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(t.id, t.createdAt, JSON.stringify(t));
  }

  deleteTask(id: string): void {
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  }

  listGroups(): SessionGroup[] {
    return (this.db.prepare(`SELECT * FROM groups ORDER BY sort, name`).all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      ...(r.icon ? { icon: String(r.icon) } : {}),
      ...(r.prompt ? { prompt: String(r.prompt) } : {}),
      sort: Number(r.sort),
    }));
  }

  getGroup(id: string): SessionGroup | undefined {
    return this.listGroups().find((g) => g.id === id);
  }

  saveGroup(g: SessionGroup): void {
    this.db
      .prepare(`INSERT INTO groups (id, name, icon, prompt, sort) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, prompt = excluded.prompt, sort = excluded.sort`)
      .run(g.id, g.name, g.icon ?? null, g.prompt ?? null, g.sort);
  }

  /** сессии группы остаются, но без группы */
  deleteGroup(id: string): string[] {
    const ids = (this.db.prepare(`SELECT id FROM sessions WHERE group_id = ?`).all(id) as Row[]).map((r) => String(r.id));
    this.db.prepare(`UPDATE sessions SET group_id = NULL WHERE group_id = ?`).run(id);
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id);
    return ids;
  }

  deleteSession(id: string): void {
    this.db.prepare(`DELETE FROM events WHERE session_id = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }

  // ---------- events ----------

  /** Атомарно выдаёт следующий seq сессии и сохраняет событие. */
  appendEvent(sessionId: string, event: SessionEvent, ts = Date.now()): StoredEvent {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db.prepare(`SELECT last_seq FROM sessions WHERE id = ?`).get(sessionId) as Row | undefined;
      if (!r) throw new Error(L(`Нет сессии ${sessionId}`, `No session ${sessionId}`));
      const seq = Number(r.last_seq) + 1;
      this.db.prepare(`INSERT INTO events (session_id, seq, ts, event_json) VALUES (?, ?, ?, ?)`).run(sessionId, seq, ts, JSON.stringify(event));
      this.db.prepare(`UPDATE sessions SET last_seq = ?, updated_at = ? WHERE id = ?`).run(seq, ts, sessionId);
      this.db.exec("COMMIT");
      return { seq, sessionId, ts, event };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  eventsAfter(sessionId: string, after: number): StoredEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, ts, event_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq`)
      .all(sessionId, after) as Row[];
    return rows.map((r) => ({ seq: Number(r.seq), sessionId, ts: Number(r.ts), event: JSON.parse(String(r.event_json)) as SessionEvent }));
  }

  // ---------- devices ----------

  insertDevice(d: DeviceRow): void {
    this.db
      .prepare(`INSERT INTO devices (id, name, token_hash, created_at, last_seen, fcm_token) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d.id, d.name, d.tokenHash, d.createdAt, d.lastSeen, d.fcmToken);
  }

  deviceByTokenHash(hash: string): DeviceRow | undefined {
    const r = this.db.prepare(`SELECT * FROM devices WHERE token_hash = ?`).get(hash) as Row | undefined;
    return r ? toDevice(r) : undefined;
  }

  listDevices(): DeviceRow[] {
    return (this.db.prepare(`SELECT * FROM devices ORDER BY created_at`).all() as Row[]).map(toDevice);
  }

  touchDevice(id: string, ts = Date.now()): void {
    this.db.prepare(`UPDATE devices SET last_seen = ? WHERE id = ?`).run(ts, id);
  }

  setFcmToken(id: string, token: string | null): void {
    this.db.prepare(`UPDATE devices SET fcm_token = ? WHERE id = ?`).run(token, id);
  }

  deleteDevice(id: string): void {
    this.db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
  }

  // ---------- files ----------

  insertFile(f: FileRow): void {
    this.db
      .prepare(`INSERT INTO files (id, session_id, direction, name, mime, size, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.id, f.sessionId, f.direction, f.name, f.mime, f.size, f.path, f.sha256, f.createdAt);
  }

  getFile(id: string): FileRow | undefined {
    const r = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as Row | undefined;
    return r ? toFile(r) : undefined;
  }

  fileByPath(path: string): FileRow | undefined {
    const r = this.db.prepare(`SELECT * FROM files WHERE lower(path) = lower(?) ORDER BY created_at DESC LIMIT 1`).get(path) as Row | undefined;
    return r ? toFile(r) : undefined;
  }
}

function toFile(r: Row): FileRow {
    return {
      id: String(r.id),
      sessionId: r.session_id == null ? null : String(r.session_id),
      direction: String(r.direction) as FileRow["direction"],
      name: String(r.name),
      mime: String(r.mime),
      size: Number(r.size),
      path: String(r.path),
      sha256: String(r.sha256),
      createdAt: Number(r.created_at),
    };
}

function toSession(r: Row): SessionRow {
  return {
    id: String(r.id),
    engine: String(r.engine) as EngineId,
    engineSessionId: String(r.engine_session_id),
    directory: String(r.directory),
    title: String(r.title),
    model: JSON.parse(String(r.model_json)) as ModelRef,
    permissionMode: String(r.permission_mode) as PermissionMode,
    status: String(r.status) as SessionStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastSeq: Number(r.last_seq),
    ...(Number(r.resume_at) > 0 ? { resumeAt: Number(r.resume_at) } : {}),
    ...(r.worktree_json ? { worktree: JSON.parse(String(r.worktree_json)) as WorktreeInfo } : {}),
    ...(r.group_id ? { groupId: String(r.group_id) } : {}),
    ...(r.task_id ? { taskId: String(r.task_id) } : {}),
    ...(Number(r.auto_check) ? { autoCheck: true } : {}),
  };
}

function toDevice(r: Row): DeviceRow {
  return {
    id: String(r.id),
    name: String(r.name),
    tokenHash: String(r.token_hash),
    createdAt: Number(r.created_at),
    lastSeen: Number(r.last_seen),
    fcmToken: r.fcm_token == null ? null : String(r.fcm_token),
  };
}

export function publicSession(s: SessionRow): SessionInfo {
  const { engineSessionId: _, ...info } = s;
  return info;
}
