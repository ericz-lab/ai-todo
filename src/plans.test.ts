import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ConflictError, EDIT_WINDOW_MS, appendRecord, createTodo, editRecord, getPlanVersion, getTodo, listEvents, listPlanVersions, listRecordRevisions, listRecords, listTodos, openDb, setPlan,
} from "./db.ts";

describe("plans", () => {
  test("each write is a version; the todo carries the latest; events hold the number only", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Design", notes: "short" });
    expect(todo).toMatchObject({ plan: "", planVersion: 0 });
    const first = setPlan(db, todo.id, "  ## Plan\n\nstep 1  ", "ai")!;
    expect(first.todo).toMatchObject({ plan: "## Plan\n\nstep 1", planVersion: 1, notes: "short" });
    expect(first.version).toMatchObject({ version: 1, source: "ai", content: "## Plan\n\nstep 1" });
    const second = setPlan(db, todo.id, "## Plan\n\nstep 1\nstep 2", "manual", { expectedVersion: 1 })!;
    expect(second.todo.planVersion).toBe(2);
    expect(getPlanVersion(db, todo.id, 1)!.content).toBe("## Plan\n\nstep 1");
    expect(listPlanVersions(db, todo.id).map((v) => [v.version, v.source])).toEqual([[2, "manual"], [1, "ai"]]);
    expect(listPlanVersions(db, todo.id)[0]).toMatchObject({ chars: 22, excerpt: "## Plan step 1 step 2" });
    const events = listEvents(db, todo.id).filter((e) => e.kind === "plan-edited");
    expect(events.map((e) => e.data)).toEqual([{ source: "manual", version: 2 }, { source: "ai", version: 1 }]);
    // The same text again changes nothing.
    expect(setPlan(db, todo.id, "## Plan\n\nstep 1\nstep 2", "manual")!.todo.planVersion).toBe(2);
    // Clearing is a version too, and the old text stays.
    expect(setPlan(db, todo.id, "", "manual")!.todo).toMatchObject({ plan: "", planVersion: 3 });
    expect(getPlanVersion(db, todo.id, 2)!.content).toContain("step 2");
    expect(setPlan(db, 9999, "x")).toBeNull();
    db.close();
  });

  test("a stale expectedVersion is a conflict that carries the current plan", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Race" });
    setPlan(db, todo.id, "from window A", "manual");
    try { setPlan(db, todo.id, "from window B", "manual", { expectedVersion: 0 }); throw new Error("no conflict"); }
    catch (e) { expect(e).toBeInstanceOf(ConflictError); expect((e as ConflictError).current).toEqual({ plan: "from window A", planVersion: 1 }); }
    expect(getTodo(db, todo.id)!.plan).toBe("from window A");
    db.close();
  });

  test("one editor's typing within a minute rewrites its version; another session or source adds one", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Typing" });
    setPlan(db, todo.id, "a", "manual", { session: "s1" });
    const typed = setPlan(db, todo.id, "ab", "manual", { session: "s1", expectedVersion: 1 })!;
    expect(typed).toMatchObject({ merged: true, todo: { plan: "ab", planVersion: 1 } });
    expect(listEvents(db, todo.id).filter((e) => e.kind === "plan-edited")).toHaveLength(1);
    // Another window (session) never merges into this one's version, so its text survives as v1.
    expect(setPlan(db, todo.id, "abc", "manual", { session: "s2", expectedVersion: 1 })!.todo.planVersion).toBe(2);
    expect(getPlanVersion(db, todo.id, 1)!.content).toBe("ab");
    // Without a session (CLI, AI) every write is its own version.
    expect(setPlan(db, todo.id, "abcd", "cli")!.todo.planVersion).toBe(3);
    expect(setPlan(db, todo.id, "abcde", "cli")!.todo.planVersion).toBe(4);
    // A pause longer than the window starts a new version.
    setPlan(db, todo.id, "x", "manual", { session: "s3" });
    db.query("UPDATE todo_plan_versions SET created_at = ? WHERE todo_id = ? AND version = 5").run(new Date(Date.now() - EDIT_WINDOW_MS - 1000).toISOString(), todo.id);
    expect(setPlan(db, todo.id, "xy", "manual", { session: "s3" })!.todo.planVersion).toBe(6);
    db.close();
  });

  test("limits: text only, at most 50000 characters; drafts may carry a first plan; search finds plans", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Limits", plan: "初始方案 with keyword zebra" }, "ai");
    expect(todo).toMatchObject({ plan: "初始方案 with keyword zebra", planVersion: 1 });
    expect(() => setPlan(db, todo.id, "x".repeat(50_001))).toThrow("50000");
    expect(() => setPlan(db, todo.id, 42)).toThrow();
    expect(() => setPlan(db, todo.id, null)).toThrow();
    expect(setPlan(db, todo.id, "x".repeat(50_000))!.todo.planVersion).toBe(2);
    setPlan(db, todo.id, "keyword zebra");
    expect(listTodos(db, { q: "zebra" }).map((t) => t.id)).toEqual([todo.id]);
    db.close();
  });
});

describe("record edits", () => {
  test("an edit keeps the record's id, time and author, stores every revision and logs an event", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Records" });
    const record = appendRecord(db, todo.id, "Verified reads", "ai")!;
    expect(record).toMatchObject({ revision: 0, editedAt: null });
    expect(listRecordRevisions(db, todo.id, record.id)).toEqual([{ recordId: record.id, revision: 0, content: "Verified reads", attachments: [], source: "ai", createdAt: record.createdAt }]);
    const edited = editRecord(db, todo.id, record.id, "Verified reads (fact fixed)", "manual", 0)!;
    expect(edited).toMatchObject({ id: record.id, source: "ai", createdAt: record.createdAt, content: "Verified reads (fact fixed)", revision: 1 });
    expect(edited.editedAt).not.toBeNull();
    editRecord(db, todo.id, record.id, "third", "cli");
    expect(listRecordRevisions(db, todo.id, record.id)!.map((r) => [r.revision, r.content, r.source])).toEqual([
      [0, "Verified reads", "ai"], [1, "Verified reads (fact fixed)", "manual"], [2, "third", "cli"],
    ]);
    expect(listEvents(db, todo.id).filter((e) => e.kind === "record-edited").map((e) => e.data)).toEqual([
      { source: "cli", recordId: record.id, revision: 2 }, { source: "manual", recordId: record.id, revision: 1 },
    ]);
    expect(listRecords(db, todo.id)[0]!.content).toBe("third");
    // Same text: no revision; a stale revision: conflict; bad text: refused; wrong todo: null.
    expect(editRecord(db, todo.id, record.id, "third", "cli")!.revision).toBe(2);
    expect(() => editRecord(db, todo.id, record.id, "fourth", "manual", 1)).toThrow(ConflictError);
    for (const v of ["", "  ", 42, "a".repeat(20_001)]) expect(() => editRecord(db, todo.id, record.id, v)).toThrow();
    const other = createTodo(db, { title: "Other" });
    expect(editRecord(db, other.id, record.id, "hijack")).toBeNull();
    expect(editRecord(db, todo.id, 9999, "missing")).toBeNull();
    expect(listRecordRevisions(db, other.id, record.id)).toBeNull();
    db.close();
  });

  test("an image record may lose its text; the images stay", () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Images" });
    const image = { key: "records/1/a.png", name: "a.png", mime: "image/png", size: 3 };
    const record = appendRecord(db, todo.id, "caption", "manual", [image])!;
    const edited = editRecord(db, todo.id, record.id, "", "manual")!;
    expect(edited).toMatchObject({ content: "", attachments: [image], revision: 1 });
    db.close();
  });
});

describe("migration on open", () => {
  test("a database from before plans gains the columns and tables; its rows stay as they were", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-plans-"));
    try {
      const path = join(dir, "old.db");
      // The shape before plans and record edits.
      const old = new Database(path, { create: true });
      old.exec(`CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
          priority INTEGER NOT NULL DEFAULT 0, due TEXT, tags TEXT NOT NULL DEFAULT '[]', project TEXT, source TEXT NOT NULL DEFAULT 'manual', position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, parent_id INTEGER);
        CREATE TABLE todo_events (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', at TEXT NOT NULL);
        CREATE TABLE todo_records (id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]');
        INSERT INTO todos (title, notes, created_at, updated_at) VALUES ('Old', 'old notes', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
        INSERT INTO todo_events (todo_id, kind, data, at) VALUES (1, 'created', '{"source":"manual"}', '2026-01-01T00:00:00.000Z');
        INSERT INTO todo_records (todo_id, content, source, created_at) VALUES (1, 'old record', 'cli', '2026-01-02T00:00:00.000Z');`);
      old.close();
      const db = openDb(path);
      expect(getTodo(db, 1)).toMatchObject({ title: "Old", notes: "old notes", plan: "", planVersion: 0, updatedAt: "2026-01-01T00:00:00.000Z" });
      expect(listRecords(db, 1)).toEqual([{ id: 1, todoId: 1, content: "old record", source: "cli", createdAt: "2026-01-02T00:00:00.000Z", attachments: [], revision: 0, editedAt: null }]);
      expect(listEvents(db, 1)).toHaveLength(1);
      expect(setPlan(db, 1, "new plan")!.todo.planVersion).toBe(1);
      expect(editRecord(db, 1, 1, "fixed")!.revision).toBe(1);
      db.close();
      // Opening again is a no-op.
      const again = openDb(path);
      expect(getTodo(again, 1)!.plan).toBe("new plan");
      again.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
