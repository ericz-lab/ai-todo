import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, createTodo, deleteTodo, getTodo, listEvents, listRecords, openDb, updateTodo } from "./db.ts";
import { createServer } from "./index.ts";
import { cleanAction, executePrompt } from "./ai.ts";
import type { OperationRecord } from "./types.ts";

describe("operation records", () => {
  test("append independently of notes and status; preserve entries and audit even after deletion", () => {
    const db = openDb(":memory:");
    try {
      const todo = createTodo(db, { title: "Acceptance", notes: "Requirements" });
      updateTodo(db, todo.id, { status: "done" });
      const first = appendRecord(db, todo.id, "  Verified reads  ", "cli")!;
      const second = appendRecord(db, todo.id, "Writes remain unverified", "manual")!;
      expect(listRecords(db, todo.id)).toEqual([second, first]);
      expect(first.content).toBe("Verified reads");
      expect(getTodo(db, todo.id)).toMatchObject({ notes: "Requirements", status: "done" });
      expect(listEvents(db, todo.id).slice(0, 2).map((e) => [e.kind, e.data.recordId])).toEqual([["record-added", second.id], ["record-added", first.id]]);
      for (const value of ["", "  ", null, {}, 42, "a".repeat(20001)]) expect(() => appendRecord(db, todo.id, value)).toThrow();
      expect(appendRecord(db, 99999, "missing")).toBeNull();
      expect(listRecords(db, todo.id)).toHaveLength(2);
      deleteTodo(db, todo.id);
      expect(listRecords(db, todo.id)).toEqual([second, first]);
    } finally { db.close(); }
  });

  test("an audit failure rolls back the record and todo timestamp together", () => {
    const db = openDb(":memory:");
    try {
      const todo = createTodo(db, { title: "Atomic" });
      db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON todo_events WHEN NEW.kind = 'record-added' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      expect(() => appendRecord(db, todo.id, "should roll back")).toThrow("audit unavailable");
      expect(listRecords(db, todo.id)).toEqual([]);
      expect(getTodo(db, todo.id)).toEqual(todo);
    } finally { db.close(); }
  });

  test("existing databases gain records without rewriting notes or history, and records survive reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-records-"));
    try {
      const path = join(dir, "todo.db");
      let db = openDb(path);
      const todo = createTodo(db, { title: "Existing", notes: "Existing notes" });
      const events = listEvents(db, todo.id);
      db.exec("DROP TABLE todo_records");
      db.close();
      db = openDb(path);
      expect(getTodo(db, todo.id)).toEqual(todo);
      expect(listEvents(db, todo.id)).toEqual(events);
      const record = appendRecord(db, todo.id, "After upgrade", "cli");
      db.close();
      db = openDb(path);
      expect(listRecords(db, todo.id)).toEqual([record!]);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("API concurrent appends, stable pagination, CLI, and AI read/write paths", async () => {
    const db = openDb(":memory:");
    const todo = createTodo(db, { title: "Read and write", notes: "Keep notes" });
    const { server } = createServer({ db, port: 0, web: false });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, data: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    try {
      const path = `/api/todos/${todo.id}/records`;
      const responses = await Promise.all(Array.from({ length: 55 }, (_, i) => post(path, { content: `Step ${i}`, source: "cli" })));
      expect(responses.every((r) => r.status === 201)).toBe(true);
      const page = await (await fetch(base + path)).json();
      expect(page.records).toHaveLength(50);
      expect(page.recordsNextBefore).toBe(page.records.at(-1).id);
      await post(path, { content: "Appended between pages" });
      const older = await (await fetch(`${base}${path}?before=${page.recordsNextBefore}`)).json();
      expect(older.records).toHaveLength(5);
      expect(older.recordsNextBefore).toBeNull();
      expect(new Set([...page.records, ...older.records].map((r: OperationRecord) => r.id)).size).toBe(55);
      expect((await post(path, { content: " " })).status).toBe(400);
      expect((await post(path, { content: "x".repeat(20001) })).status).toBe(400);
      expect((await fetch(`${base}${path}?before=no`)).status).toBe(400);
      expect((await post("/api/todos/9999/records", { content: "orphan" })).status).toBe(404);
      expect((await fetch(`${base}/api/todos/9999/records`)).status).toBe(404);
      const action = cleanAction({ op: "record", id: todo.id, content: "Verified through chat" });
      const applied = await (await post("/api/ai/apply", { actions: [action] })).json();
      expect(applied.results[0].ok).toBe(true);
      expect(listRecords(db, todo.id, 1)[0]).toMatchObject({ content: "Verified through chat", source: "chat" });
      const cli = Bun.spawn(["bun", "src/cli.ts", "record", String(todo.id), "Verified through CLI"], { env: { ...process.env, TODO_URL: base }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
      expect(stderr).toBe(""); expect(code).toBe(0);
      expect(JSON.parse(stdout).record).toMatchObject({ content: "Verified through CLI", source: "cli" });
      const detail = await (await fetch(`${base}/api/todos/${todo.id}`)).json();
      expect(detail.records[0].content).toBe("Verified through CLI");
      expect(detail.todo.notes).toBe("Keep notes");
      const context = await (await fetch(`${base}/api/ai/context`)).json();
      expect(context.text).toContain("Verified through CLI");
      expect(context.system).toContain('"op":"record"');
      const prompt = executePrompt(todo, { now: new Date(), timezone: "UTC", lang: "en", records: listRecords(db, todo.id, 5) });
      expect(prompt).toContain("Verified through chat");
      expect(() => cleanAction({ op: "record", id: todo.id, content: "" })).toThrow();
    } finally { server.stop(true); db.close(); }
  });
});
