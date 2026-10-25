import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ConflictError, EDIT_WINDOW_MS, appendRecord, createTodo, editRecord, getPlanVersion, getTodo, listEvents, listPlanVersions, listRecordRevisions, listRecords, listTodos, openDb, setPlan,
} from "./db.ts";
import { createServer } from "./index.ts";
import { chatContext, cleanAction, executePrompt, PLAN_PROMPT_CHARS } from "./ai.ts";

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

describe("plan and record-edit API", () => {
  test("routes, conflicts, capabilities, chat operations and the CLI", async () => {
    const db = openDb(":memory:");
    const { server } = createServer({ db, port: 0, web: false });
    const base = `http://127.0.0.1:${server.port}`;
    const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    };
    try {
      const { body: created } = await call("POST", "/api/todos", { title: "With plan", notes: "one line", plan: "## v1" });
      const id = created.todo.id as number;
      expect(created.todo).toMatchObject({ plan: "## v1", planVersion: 1, notes: "one line" });

      // PUT: 200, conflict 409 with the current text, 404, too long, not text; empty clears.
      const put = await call("PUT", `/api/todos/${id}/plan`, { content: "## v2", expectedVersion: 1 });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ todo: { plan: "## v2", planVersion: 2 }, planMeta: { version: 2, source: "manual" }, merged: false });
      const stale = await call("PUT", `/api/todos/${id}/plan`, { content: "## from another window", expectedVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ ok: false, conflict: true, plan: "## v2", planVersion: 2 });
      expect((await call("PUT", "/api/todos/9999/plan", { content: "x" })).status).toBe(404);
      expect((await call("PUT", `/api/todos/${id}/plan`, { content: "x".repeat(50_001) })).status).toBe(400);
      expect((await call("PUT", `/api/todos/${id}/plan`, { content: 3 })).status).toBe(400);
      expect((await call("PUT", `/api/todos/${id}/plan`, { content: "y", expectedVersion: "two" })).status).toBe(400);
      // The page's typing session merges into its version.
      await call("PUT", `/api/todos/${id}/plan`, { content: "## v3 a", session: "tab1" });
      const typed = await call("PUT", `/api/todos/${id}/plan`, { content: "## v3 ab", session: "tab1", expectedVersion: 3 });
      expect(typed.body).toMatchObject({ merged: true, todo: { planVersion: 3 } });

      const versions = await call("GET", `/api/todos/${id}/plan/versions`);
      expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
      expect((await call("GET", `/api/todos/${id}/plan/versions?version=1`)).body.version).toMatchObject({ version: 1, content: "## v1" });
      expect((await call("GET", `/api/todos/${id}/plan/versions?version=9`)).status).toBe(404);
      expect((await call("GET", `/api/todos/${id}/plan`)).body).toMatchObject({ plan: "## v3 ab", planVersion: 3 });
      const detail = await call("GET", `/api/todos/${id}`);
      expect(detail.body.todo.plan).toBe("## v3 ab");
      expect(detail.body.planMeta).toMatchObject({ version: 3, source: "manual" });
      expect(detail.body.events.filter((e: { kind: string }) => e.kind === "plan-edited")).toHaveLength(3);

      // Records: edit, conflict, 404, empty, revisions.
      const { body: rec } = await call("POST", `/api/todos/${id}/records`, { content: "Acceptance: 3 of 4 pass", source: "ai" });
      const rid = rec.record.id as number;
      const ok = await call("PATCH", `/api/todos/${id}/records/${rid}`, { content: "Acceptance: 3 of 5 pass", expectedRevision: 0 });
      expect(ok.status).toBe(200);
      expect(ok.body.record).toMatchObject({ id: rid, source: "ai", content: "Acceptance: 3 of 5 pass", revision: 1 });
      const late = await call("PATCH", `/api/todos/${id}/records/${rid}`, { content: "other", expectedRevision: 0 });
      expect(late.status).toBe(409);
      expect(late.body.record).toMatchObject({ revision: 1 });
      expect((await call("PATCH", `/api/todos/${id}/records/${rid}`, { content: " " })).status).toBe(400);
      expect((await call("PATCH", `/api/todos/${id}/records/${rid}`, { content: "x".repeat(20_001) })).status).toBe(400);
      expect((await call("PATCH", `/api/todos/${id}/records/9999`, { content: "x" })).status).toBe(404);
      expect((await call("PATCH", `/api/todos/9999/records/${rid}`, { content: "x" })).status).toBe(404);
      const revisions = await call("GET", `/api/todos/${id}/records/${rid}/revisions`);
      expect(revisions.body.revisions.map((r: { content: string }) => r.content)).toEqual(["Acceptance: 3 of 4 pass", "Acceptance: 3 of 5 pass"]);
      expect((await call("GET", `/api/todos/${id}/records/9999/revisions`)).status).toBe(404);

      // Capabilities: list gives an excerpt unless asked, task the full plan, plan writes with the caller in the event.
      setPlan(db, id, "p".repeat(400), "manual");
      const listed = (await call("POST", "/api/capabilities/list", {})).body.todos.find((t: { id: number }) => t.id === id);
      expect(listed.planExcerpt).toHaveLength(300);
      expect(listed).not.toHaveProperty("plan");
      expect(listed.planVersion).toBe(4);
      const full = (await call("POST", "/api/capabilities/list", { plan: true })).body.todos.find((t: { id: number }) => t.id === id);
      expect(full.plan).toHaveLength(400);
      expect(full).not.toHaveProperty("planExcerpt");
      expect((await call("POST", "/api/capabilities/task", { id })).body).toMatchObject({ todo: { planVersion: 4 }, planMeta: { version: 4 } });
      const viaBus = await call("POST", "/api/capabilities/plan", { id, content: "## from product-desk", expectedVersion: 4 }, { "x-space-caller": "product-desk" });
      expect(viaBus.body).toMatchObject({ todo: { plan: "## from product-desk", planVersion: 5 }, planMeta: { source: "ai" } });
      expect(listEvents(db, id)[0]).toMatchObject({ kind: "plan-edited", data: { source: "ai", version: 5, caller: "product-desk" } });
      expect((await call("POST", "/api/capabilities/plan", { id, content: "x", expectedVersion: 1 })).status).toBe(409);
      expect((await call("POST", "/api/capabilities/plan", { id: 9999, content: "x" })).status).toBe(404);

      // Chat operations.
      const applied = await call("POST", "/api/ai/apply", { actions: [
        { op: "plan", id, content: "## chat plan", expectedVersion: 5 },
        { op: "plan", id, content: "## stale", expectedVersion: 1 },
        { op: "edit-record", id, recordId: rid, content: "Acceptance: 4 of 5 pass" },
        { op: "edit-record", id, recordId: 9999, content: "nothing" },
        { op: "update", id, title: "With plan (renamed)", plan: "## via update" },
      ] });
      expect(applied.body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, true, false, true]);
      expect(getTodo(db, id)).toMatchObject({ title: "With plan (renamed)", plan: "## via update", planVersion: 7 });
      expect(listRecords(db, id)[0]).toMatchObject({ content: "Acceptance: 4 of 5 pass", revision: 2 });

      // CLI: plan --file, plan, plan-history, record-edit, show.
      const cli = async (...args: string[]) => {
        const p = Bun.spawn(["bun", "src/cli.ts", ...args], { env: { ...process.env, TODO_URL: base }, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { out, err, code };
      };
      const file = join(mkdtempSync(join(tmpdir(), "todo-plan-cli-")), "plan.md");
      await Bun.write(file, "## CLI plan\n\n- with `quotes` and $dollars\n");
      expect((await cli("plan", String(id), "--file", file)).out).toContain(`plan of #${id} is now v8`);
      expect((await cli("plan", String(id))).out).toContain("- with `quotes` and $dollars");
      expect((await cli("plan-history", String(id))).out.split("\n")[0]).toMatch(/^v8\t.*\tcli\t/);
      expect((await cli("plan-history", String(id), "--version", "1")).out).toContain("## v1");
      expect((await cli("record-edit", String(id), String(rid), "Acceptance: 5 of 5 pass")).out).toContain("revision 3");
      const shown = (await cli("show", String(id))).out;
      expect(shown.indexOf("=== plan v8")).toBeGreaterThan(-1);
      expect(shown.indexOf("=== plan v8")).toBeLessThan(shown.indexOf(`--- record ${rid}`));
      expect(shown).toContain("(revision 3)");
      const conflict = await cli("plan", String(id), "--set", "x", "--expect", "1");
      expect(conflict.code).toBe(1);
      expect(conflict.err).toContain("changed meanwhile");
    } finally { server.stop(true); db.close(); }
  });
});

describe("plans in the AI paths", () => {
  const base = createTodo(openDb(":memory:"), { title: "t" });
  test("the executor reads the plan, cut at its limit, and the parent's plan as an excerpt", () => {
    const todo = { ...base, notes: "short", plan: "P".repeat(PLAN_PROMPT_CHARS + 10), planVersion: 4 };
    const parent = { ...base, id: 99, title: "Parent", plan: "Q".repeat(1500), planVersion: 1 };
    const prompt = executePrompt(todo, { now: new Date(), timezone: "UTC", lang: "zh", parent });
    expect(prompt).toContain("Plan (v4, the current design; follow it unless told otherwise):");
    expect(prompt).toContain(`[… cut at ${PLAN_PROMPT_CHARS} of ${PLAN_PROMPT_CHARS + 10} characters]`);
    expect(prompt.indexOf("Notes from the person")).toBeLessThan(prompt.indexOf("Plan (v4"));
    expect(prompt).toContain("Its plan (excerpt): " + "Q".repeat(1000) + "\n[… cut at 1000 of 1500 characters]");
    expect(executePrompt({ ...base }, { now: new Date(), timezone: "UTC", lang: "zh" })).not.toContain("Plan (");
  });
  test("the chat sees an excerpt with the version and can write plans and edit records", () => {
    const ctx = chatContext([{ ...base, plan: "第一步\n\n" + "x".repeat(300), planVersion: 2 }], { now: new Date(), timezone: "UTC", lang: "zh" });
    const line = ctx.text.split("\n").find((l) => l.includes("plan (v2"))!;
    expect(line).toContain("plan (v2, excerpt; full text via the task's detail): 第一步 x");
    expect(line.length).toBeLessThan(300);
    expect(ctx.system).toContain('"op":"plan"');
    expect(ctx.system).toContain('"op":"edit-record"');
    expect(cleanAction({ op: "plan", id: 1, content: " ## p " })).toEqual({ op: "plan", id: 1, content: "## p" });
    expect(cleanAction({ op: "plan", id: 1, content: "", expectedVersion: 0 })).toEqual({ op: "plan", id: 1, content: "", expectedVersion: 0 });
    expect(cleanAction({ op: "edit-record", id: 1, recordId: 2, content: "fixed" })).toEqual({ op: "edit-record", id: 1, recordId: 2, content: "fixed" });
    expect(cleanAction({ op: "update", id: 1, plan: "p" })).toEqual({ op: "update", id: 1, plan: "p" });
    for (const bad of [{ op: "plan", id: 1 }, { op: "plan", id: 1, content: "x".repeat(50_001) }, { op: "plan", id: 1, content: "x", expectedVersion: -1 },
      { op: "edit-record", id: 1, content: "x" }, { op: "edit-record", id: 1, recordId: 2, content: "" }, { op: "rewrite", id: 1 }]) expect(() => cleanAction(bad)).toThrow();
  });
});
