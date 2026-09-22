/**
 * SQLite store: todos, their append-only history and their AI runs. Every write logs an event,
 * so a todo can always answer "where from, when".
 */
import { Database } from "bun:sqlite";
import { PRIORITIES, SOURCES, STATUSES, type Draft, type Patch, type Priority, type Run, type Source, type Status, type Todo, type TodoEvent } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  due TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  project TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX IF NOT EXISTS todos_status ON todos(status, due);
CREATE TABLE IF NOT EXISTS todo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_events_todo ON todo_events(todo_id, id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  prompt TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  error TEXT,
  call_id INTEGER,
  model TEXT,
  cost_usd REAL,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_todo ON runs(todo_id, id);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

const toTodo = (r: Row): Todo => ({
  id: r.id as number,
  title: r.title as string,
  notes: r.notes as string,
  status: r.status as Status,
  priority: r.priority as Priority,
  due: (r.due as string | null) ?? null,
  tags: JSON.parse(r.tags as string) as string[],
  project: (r.project as string | null) ?? null,
  source: r.source as Source,
  position: r.position as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  doneAt: (r.done_at as string | null) ?? null,
});
const toEvent = (r: Row): TodoEvent => ({ id: r.id as number, todoId: r.todo_id as number, kind: r.kind as string, data: JSON.parse(r.data as string), at: r.at as string });
const toRun = (r: Row): Run => ({
  id: r.id as number, todoId: r.todo_id as number, status: r.status as Run["status"], prompt: r.prompt as string, output: r.output as string,
  error: (r.error as string | null) ?? null, callId: (r.call_id as number | null) ?? null, model: (r.model as string | null) ?? null,
  costUsd: (r.cost_usd as number | null) ?? null, startedAt: r.started_at as string, finishedAt: (r.finished_at as string | null) ?? null,
});

// ---- validation, shared by the API, the chat actions and the CLI

const DUE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export function cleanTitle(v: unknown): string {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!t) throw new Error("title is required");
  return t.slice(0, 300);
}
export function cleanDue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  if (!DUE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM, got ${s}`);
  return s;
}
export function cleanPriority(v: unknown): Priority {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  if (!PRIORITIES.includes(n as Priority)) throw new Error(`priority must be 0..3, got ${String(v)}`);
  return n as Priority;
}
export function cleanTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，\s]+/) : [];
  const out: string[] = [];
  for (const t of list) {
    const s = String(t ?? "").trim().replace(/^#/, "").slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 12);
}
export function cleanProject(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 80);
  return s || null;
}
export function cleanNotes(v: unknown): string {
  return String(v ?? "").trim().slice(0, 20_000);
}
export function cleanStatus(v: unknown): Status {
  const s = String(v ?? "");
  if (!STATUSES.includes(s as Status)) throw new Error(`status must be one of ${STATUSES.join(", ")}, got ${s}`);
  return s as Status;
}
export function cleanDraft(v: unknown): Draft {
  const d = (v ?? {}) as Record<string, unknown>;
  return { title: cleanTitle(d.title), notes: cleanNotes(d.notes), due: cleanDue(d.due), priority: cleanPriority(d.priority), tags: cleanTags(d.tags), project: cleanProject(d.project) };
}
export function cleanPatch(v: unknown): Patch {
  const p = (v ?? {}) as Record<string, unknown>;
  const out: Patch = {};
  if ("title" in p) out.title = cleanTitle(p.title);
  if ("notes" in p) out.notes = cleanNotes(p.notes);
  if ("status" in p) out.status = cleanStatus(p.status);
  if ("priority" in p) out.priority = cleanPriority(p.priority);
  if ("due" in p) out.due = cleanDue(p.due);
  if ("tags" in p) out.tags = cleanTags(p.tags);
  if ("project" in p) out.project = cleanProject(p.project);
  return out;
}

// ---- todos

export type ListFilter = { status?: Status | "active" | "all"; q?: string; tag?: string; project?: string; limit?: number };

export function listTodos(db: Database, f: ListFilter = {}): Todo[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const status = f.status ?? "active";
  if (status === "active") where.push("status IN ('open','doing')");
  else if (status !== "all") { where.push("status = ?"); args.push(status); }
  if (f.q) { where.push("(title LIKE ? OR notes LIKE ? OR tags LIKE ? OR project LIKE ?)"); const like = `%${f.q}%`; args.push(like, like, like, like); }
  if (f.tag) { where.push("tags LIKE ?"); args.push(`%${JSON.stringify(f.tag)}%`); }
  if (f.project) { where.push("project = ?"); args.push(f.project); }
  const sql = `SELECT * FROM todos ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      CASE WHEN status IN ('done','dropped') THEN updated_at END DESC,
      CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, priority DESC, position, id
    LIMIT ?`;
  args.push(Math.min(Math.max(f.limit ?? 500, 1), 2000));
  return (db.query(sql).all(...args) as Row[]).map(toTodo);
}

export function getTodo(db: Database, id: number): Todo | null {
  const r = db.query("SELECT * FROM todos WHERE id = ?").get(id) as Row | null;
  return r ? toTodo(r) : null;
}

export function addEvent(db: Database, todoId: number, kind: string, data: Record<string, unknown> = {}, at = now()): TodoEvent {
  const r = db.query("INSERT INTO todo_events (todo_id, kind, data, at) VALUES (?, ?, ?, ?) RETURNING *").get(todoId, kind, JSON.stringify(data), at) as Row;
  return toEvent(r);
}
export function listEvents(db: Database, todoId: number, limit = 100): TodoEvent[] {
  return (db.query("SELECT * FROM todo_events WHERE todo_id = ? ORDER BY id DESC LIMIT ?").all(todoId, limit) as Row[]).map(toEvent);
}

export function createTodo(db: Database, draft: Draft, source: Source = "manual", origin: Record<string, unknown> = {}): Todo {
  if (!SOURCES.includes(source)) throw new Error(`bad source ${source}`);
  const d = cleanDraft(draft);
  const t = now();
  const pos = ((db.query("SELECT COALESCE(MAX(position), 0) AS m FROM todos").get() as { m: number }).m) + 1;
  const r = db.query(`INSERT INTO todos (title, notes, status, priority, due, tags, project, source, position, created_at, updated_at)
    VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(d.title, d.notes ?? "", d.priority ?? 0, d.due ?? null, JSON.stringify(d.tags ?? []), d.project ?? null, source, pos, t, t) as Row;
  const todo = toTodo(r);
  addEvent(db, todo.id, "created", { source, ...origin }, t);
  return todo;
}

export function updateTodo(db: Database, id: number, patch: Patch, source: Source = "manual"): Todo | null {
  const before = getTodo(db, id);
  if (!before) return null;
  const p = cleanPatch(patch);
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const old = before[k as keyof Patch];
    if (JSON.stringify(old) !== JSON.stringify(v)) changed[k] = { from: old, to: v };
  }
  if (!Object.keys(changed).length) return before;
  const t = now();
  const next = { ...before, ...p };
  const doneAt = next.status === "done" ? (before.status === "done" ? before.doneAt : t) : null;
  db.query(`UPDATE todos SET title = ?, notes = ?, status = ?, priority = ?, due = ?, tags = ?, project = ?, updated_at = ?, done_at = ? WHERE id = ?`)
    .run(next.title, next.notes, next.status, next.priority, next.due, JSON.stringify(next.tags), next.project, t, doneAt, id);
  const kind = "status" in changed ? String(next.status) : "edited";
  addEvent(db, id, kind, { source, changed }, t);
  return getTodo(db, id);
}

export function deleteTodo(db: Database, id: number, source: Source = "manual"): boolean {
  const before = getTodo(db, id);
  if (!before) return false;
  db.query("DELETE FROM todos WHERE id = ?").run(id);
  addEvent(db, id, "deleted", { source, title: before.title });
  return true;
}

/** Explicit ordering among open todos: `ids` in the wanted order get positions 1..n. */
export function reorderTodos(db: Database, ids: number[]): void {
  const tx = db.transaction((list: number[]) => {
    list.forEach((id, i) => db.query("UPDATE todos SET position = ? WHERE id = ?").run(i + 1, id));
  });
  tx(ids);
}

export function tagCounts(db: Database): { tag: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const t of listTodos(db, { status: "active" })) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}
export function projectCounts(db: Database): { project: string; n: number }[] {
  return db.query("SELECT project, COUNT(*) AS n FROM todos WHERE status IN ('open','doing') AND project IS NOT NULL GROUP BY project ORDER BY n DESC, project").all() as { project: string; n: number }[];
}

// ---- runs

export function createRun(db: Database, todoId: number, prompt: string, model: string | null): Run {
  const r = db.query("INSERT INTO runs (todo_id, prompt, model, started_at) VALUES (?, ?, ?, ?) RETURNING *").get(todoId, prompt, model, now()) as Row;
  addEvent(db, todoId, "run-started", { runId: r.id });
  return toRun(r);
}
export function finishRun(db: Database, id: number, result: { ok: boolean; output: string; error?: string; callId?: number | null; model?: string | null; costUsd?: number | null }): Run {
  const r = db.query(`UPDATE runs SET status = ?, output = ?, error = ?, call_id = ?, model = COALESCE(?, model), cost_usd = ?, finished_at = ? WHERE id = ? RETURNING *`)
    .get(result.ok ? "ok" : "error", result.output, result.error ?? null, result.callId ?? null, result.model ?? null, result.costUsd ?? null, now(), id) as Row;
  const run = toRun(r);
  addEvent(db, run.todoId, result.ok ? "run-finished" : "run-failed", { runId: id, error: result.error ?? null, chars: result.output.length });
  return run;
}
export function listRuns(db: Database, todoId: number, limit = 20): Run[] {
  return (db.query("SELECT * FROM runs WHERE todo_id = ? ORDER BY id DESC LIMIT ?").all(todoId, limit) as Row[]).map(toRun);
}
export function runningRun(db: Database, todoId: number): Run | null {
  const r = db.query("SELECT * FROM runs WHERE todo_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1").get(todoId) as Row | null;
  return r ? toRun(r) : null;
}
/** Runs left `running` by a crash are closed on boot so a todo can be executed again. */
export function abandonRuns(db: Database): number {
  const rows = db.query("SELECT * FROM runs WHERE status = 'running'").all() as Row[];
  for (const r of rows) finishRun(db, r.id as number, { ok: false, output: r.output as string, error: "abandoned: the service restarted" });
  return rows.length;
}
