import { describe, expect, test } from "bun:test";
import { moveRow, scopeOf, stageOf, type TallyRow } from "./tally.ts";

const row = (id: number, status: string, o: Partial<TallyRow> = {}): TallyRow => ({ id, status, parentId: null, tags: [], project: null, ...o });

describe("the left column after a change on the page", () => {
  const a = row(1, "open", { tags: ["bug", "web"], project: "todo" });
  const b = row(2, "doing", { tags: ["bug"] });
  const start = () => ({
    counts: { active: 2, review: 1, deferred: 0, done: 5 },
    active: [a, b],
    tags: [{ tag: "bug", n: 2 }, { tag: "web", n: 1 }],
    projects: [{ project: "todo", n: 1 }],
  });

  test("checking a task done moves it out of 全部 and the machine's count at once", () => {
    const r = moveRow(start(), a, "done", "active");
    expect(r.counts).toEqual({ active: 1, review: 1, deferred: 0, done: 6 });
    expect(r.active.map((x) => x.id)).toEqual([2]);
    expect(r.tags).toEqual([{ tag: "bug", n: 1 }]);
    expect(r.projects).toEqual([]);
    expect(r.activeDelta).toBe(-1);
    expect(r.moved).toEqual([{ id: 1, status: "done" }]);
  });

  test("unchecking (reopening) a done task puts it back", () => {
    const done = row(9, "done", { tags: ["web"], project: "home" });
    const r = moveRow(start(), done, "open", "active");
    expect(r.counts).toEqual({ active: 3, review: 1, deferred: 0, done: 4 });
    expect(r.active.find((x) => x.id === 9)?.status).toBe("open");
    expect(r.tags).toEqual([{ tag: "bug", n: 2 }, { tag: "web", n: 2 }]);
    expect(r.projects).toEqual([{ project: "home", n: 1 }, { project: "todo", n: 1 }]);
    expect(r.activeDelta).toBe(1);
  });

  test("done then undone gives back the numbers it started with", () => {
    const s = start();
    const once = moveRow(s, a, "done", "active");
    const back = moveRow(once, { ...a, status: "done" }, "open", "active");
    expect(back.counts).toEqual(s.counts);
    expect(back.tags).toEqual(s.tags);
    expect(back.projects).toEqual(s.projects);
    expect(back.active.map((x) => x.id).sort()).toEqual([1, 2]);
  });

  test("starting a task keeps the counts and changes its status (今天 counts tasks in progress)", () => {
    const r = moveRow(start(), a, "doing", "active");
    expect(r.counts).toEqual(start().counts);
    expect(r.active.find((x) => x.id === 1)?.status).toBe("doing");
    expect(r.activeDelta).toBe(0);
  });

  test("done on a parent finishes its active subtasks too", () => {
    const parent = row(10, "open");
    const kid = row(11, "open", { parentId: 10, tags: ["web"] });
    const s = { ...start(), counts: { active: 4, review: 1, deferred: 0, done: 5 }, active: [a, b, parent, kid] };
    const r = moveRow(s, parent, "done", "active");
    expect(r.counts).toEqual({ active: 2, review: 1, deferred: 0, done: 7 });
    expect(r.active.map((x) => x.id)).toEqual([1, 2]);
    expect(r.tags).toEqual([{ tag: "bug", n: 2 }]);
    expect(r.activeDelta).toBe(-2);
    expect(r.moved).toEqual([{ id: 10, status: "done" }, { id: 11, status: "done" }]);
  });

  test("deferring a parent takes its subtasks out of the active list, their status kept", () => {
    const parent = row(10, "open");
    const kid = row(11, "doing", { parentId: 10 });
    const s = { ...start(), counts: { active: 4, review: 1, deferred: 0, done: 5 }, active: [a, b, parent, kid] };
    const r = moveRow(s, parent, "deferred", "active");
    expect(r.counts).toEqual({ active: 2, review: 1, deferred: 1, done: 5 });
    expect(r.activeDelta).toBe(-2);
    expect(r.moved).toEqual([{ id: 10, status: "deferred" }, { id: 11, status: "doing" }]);
  });

  test("a deleted task leaves every count; its subtasks with it", () => {
    const kid = row(3, "open", { parentId: 1 });
    const s = { ...start(), counts: { active: 3, review: 1, deferred: 0, done: 5 }, active: [a, b, kid] };
    const r = moveRow(s, a, "deleted", "active");
    expect(r.counts).toEqual({ active: 1, review: 1, deferred: 0, done: 5 });
    expect(r.active.map((x) => x.id)).toEqual([2]);
    expect(r.moved).toEqual([{ id: 1, status: null }, { id: 3, status: null }]);
  });

  test("accepting in the review view counts the review view's tags", () => {
    const inReview = row(7, "review", { tags: ["ship"] });
    const s = { ...start(), tags: [{ tag: "ship", n: 1 }], projects: [] };
    const r = moveRow(s, inReview, "done", scopeOf("review"));
    expect(r.counts).toEqual({ active: 2, review: 0, deferred: 0, done: 6 });
    expect(r.tags).toEqual([]);
    expect(r.active).toEqual(s.active);
    expect(r.activeDelta).toBe(0);
  });

  test("in 全部机器 the same id on another machine is another task", () => {
    const here = row(1, "open", { m: "" });
    const there = row(1, "open", { m: "mac", parentId: null });
    const kidThere = row(2, "open", { m: "mac", parentId: 1 });
    const s = { counts: { active: 3, review: 0, deferred: 0, done: 0 }, active: [here, there, kidThere], tags: [], projects: [] };
    const r = moveRow(s, there, "done", "active");
    expect(r.active).toEqual([here]);
    expect(r.moved).toEqual([{ id: 1, m: "mac", status: "done" }, { id: 2, m: "mac", status: "done" }]);
  });

  test("no counts (no machine answered) stays none; the input is not changed", () => {
    const s = { ...start(), counts: null };
    const before = JSON.stringify(s);
    expect(moveRow(s, a, "done", "active").counts).toBeNull();
    expect(JSON.stringify(s)).toBe(before);
  });

  test("stages and scopes follow the server", () => {
    expect(["open", "doing", "review", "deferred", "done", "dropped"].map(stageOf)).toEqual(["active", "active", "review", "deferred", "done", null]);
    expect(["active", "done", "review", "deferred"].map(scopeOf)).toEqual(["active", "active", "review", "deferred"]);
  });
});
