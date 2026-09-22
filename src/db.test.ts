import { describe, expect, test } from "bun:test";
import { cleanDraft, cleanDue, cleanTags, createRun, createTodo, deleteTodo, finishRun, listEvents, listRuns, listTodos, openDb, projectCounts, runningRun, tagCounts, updateTodo, abandonRuns } from "./db.ts";

describe("cleaning", () => {
  test("due accepts a day or a minute, nothing else", () => {
    expect(cleanDue("2026-09-23")).toBe("2026-09-23");
    expect(cleanDue("2026-09-23T15:00")).toBe("2026-09-23T15:00");
    expect(cleanDue("")).toBeNull();
    expect(() => cleanDue("tomorrow")).toThrow();
    expect(() => cleanDue("2026-13-40")).toThrow();
  });
  test("tags lose their # and duplicates, from a list or a string", () => {
    expect(cleanTags(["#出差", "出差", " 购物 "])).toEqual(["出差", "购物"]);
    expect(cleanTags("a, b，c")).toEqual(["a", "b", "c"]);
  });
  test("a draft needs a title", () => {
    expect(() => cleanDraft({ title: "  " })).toThrow();
    expect(cleanDraft({ title: "  发 周报 ", priority: "2", due: null })).toEqual({ title: "发 周报", notes: "", due: null, priority: 2, tags: [], project: null });
  });
});

describe("todos", () => {
  const db = openDb(":memory:");
  test("create, order, update, done, delete, with history", () => {
    const a = createTodo(db, { title: "订机票", due: "2026-09-26", priority: 2, tags: ["出差"], project: "上海" }, "ai");
    const b = createTodo(db, { title: "发周报", due: "2026-09-23T15:00", priority: 3 });
    const c = createTodo(db, { title: "整理书房" });
    expect(listTodos(db).map((t) => t.id)).toEqual([b.id, a.id, c.id]);   // due first, undated last
    expect(tagCounts(db)).toEqual([{ tag: "出差", n: 1 }]);
    expect(projectCounts(db)).toEqual([{ project: "上海", n: 1 }]);

    const doing = updateTodo(db, c.id, { status: "doing" })!;
    expect(doing.status).toBe("doing");
    expect(listTodos(db)[0]!.id).toBe(c.id);                              // doing on top

    const done = updateTodo(db, b.id, { status: "done" }, "chat")!;
    expect(done.doneAt).not.toBeNull();
    expect(listTodos(db).map((t) => t.id)).toEqual([c.id, a.id]);
    expect(listTodos(db, { status: "done" }).map((t) => t.id)).toEqual([b.id]);
    expect(updateTodo(db, b.id, { status: "open" })!.doneAt).toBeNull();

    expect(updateTodo(db, a.id, { title: a.title })).toEqual(a);          // no change, no event
    expect(deleteTodo(db, a.id)).toBe(true);
    expect(deleteTodo(db, a.id)).toBe(false);
    expect(listEvents(db, a.id).map((e) => e.kind)).toEqual(["deleted", "created"]);
    expect(listEvents(db, b.id).map((e) => e.kind)).toEqual(["open", "done", "created"]);
    expect(listEvents(db, b.id)[1]!.data).toMatchObject({ source: "chat", changed: { status: { from: "open", to: "done" } } });
  });
  test("search and filters", () => {
    createTodo(db, { title: "买牛奶", tags: ["购物"], project: "家" });
    expect(listTodos(db, { q: "牛奶" }).length).toBe(1);
    expect(listTodos(db, { tag: "购物" }).length).toBe(1);
    expect(listTodos(db, { project: "家" }).length).toBe(1);
    expect(listTodos(db, { project: "无" }).length).toBe(0);
  });
  test("runs: one in flight, finished with its call, abandoned on boot", () => {
    const t = createTodo(db, { title: "查一下签证材料" });
    const run = createRun(db, t.id, "prompt", null);
    expect(runningRun(db, t.id)!.id).toBe(run.id);
    const ok = finishRun(db, run.id, { ok: true, output: "## 结果", callId: 7, model: "sonnet", costUsd: 0.01 });
    expect(ok).toMatchObject({ status: "ok", output: "## 结果", callId: 7, model: "sonnet", costUsd: 0.01 });
    expect(runningRun(db, t.id)).toBeNull();
    createRun(db, t.id, "again", null);
    expect(abandonRuns(db)).toBe(1);
    expect(listRuns(db, t.id).map((r) => r.status)).toEqual(["error", "ok"]);
    expect(listEvents(db, t.id).map((e) => e.kind)).toEqual(["run-failed", "run-started", "run-finished", "run-started", "created"]);
  });
});
