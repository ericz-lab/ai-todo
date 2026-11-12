import { describe, expect, test } from "bun:test";
import { mergeAnswers, type Answer } from "./machines.ts";

type Row = { id: number; title: string; doneAt: string | null };
const row = (id: number, doneAt: string | null = null): Row => ({ id, title: `t${id}`, doneAt });
const answer = (todos: Row[], o: Partial<Answer<Row>["r"]> & { a?: Row[]; w?: { t: string; v: number | null }[] } = {}): Answer<Row> => ({
  r: { todos, tags: [], projects: [], counts: { active: todos.length, review: 0, deferred: 0, done: 0 }, ...o },
  a: o.a ? { todos: o.a } : null,
  w: o.w ?? null,
});

describe("the list over the machines that have answered", () => {
  test("nothing yet: no rows and no counts", () => {
    const m = mergeAnswers<Row>([], { all: true, done: false });
    expect(m.todos).toEqual([]);
    expect(m.counts).toBeNull();
    expect(m.trend).toBeNull();
  });

  test("one machine's list is shown as it is, its rows untagged", () => {
    const a = answer([row(1), row(2)], { a: [row(1), row(2), row(3)], w: [{ t: "2026-11-10", v: 2 }] });
    const m = mergeAnswers([["peer", a]], { all: false, done: false });
    expect(m.todos).toEqual(a.r.todos);
    expect(m.active.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(m.todos[0]).not.toHaveProperty("m");
    expect(m.trend).toEqual([{ t: "2026-11-10", v: 2 }]);
  });

  test("the first machine to answer draws alone; the next one is added when it comes", () => {
    const here = answer([row(1)], { tags: [{ tag: "bug", n: 1 }], projects: [{ project: "todo", n: 1 }], w: [{ t: "2026-11-10", v: 1 }, { t: "2026-11-11", v: 0 }] });
    const there = answer([row(1), row(5)], { tags: [{ tag: "bug", n: 2 }, { tag: "ops", n: 3 }], w: [{ t: "2026-11-11", v: 2 }, { t: "2026-11-12", v: null }] });
    const first = mergeAnswers([["", here]], { all: true, done: false });
    expect(first.todos).toEqual([{ ...row(1), m: "" }]);
    expect(first.counts?.active).toBe(1);
    const both = mergeAnswers([["", here], ["peer", there]], { all: true, done: false });
    // Ids repeat across machines; the machine tells them apart.
    expect(both.todos.map((x) => `${x.m}#${x.id}`)).toEqual(["#1", "peer#1", "peer#5"]);
    expect(both.active).toEqual(both.todos);
    expect(both.counts).toEqual({ active: 3, review: 0, deferred: 0, done: 0 });
    expect(both.tags).toEqual([{ tag: "bug", n: 3 }, { tag: "ops", n: 3 }]);
    expect(both.projects).toEqual([{ project: "todo", n: 1 }]);
    expect(both.trend).toEqual([{ t: "2026-11-10", v: 1 }, { t: "2026-11-11", v: 2 }, { t: "2026-11-12", v: 0 }]);
  });

  test("the done list: newest finished first across machines, a cursor per machine with more, the totals added", () => {
    const here = answer([row(1, "2026-11-10T08:00:00Z"), row(2, "2026-11-08T08:00:00Z")], { total: 2, nextBefore: null });
    const there = answer([row(7, "2026-11-09T08:00:00Z")], { total: 60, nextBefore: "2026-11-09T08:00:00Z|7" });
    const m = mergeAnswers([["", here], ["peer", there]], { all: true, done: true });
    expect(m.todos.map((x) => `${x.m}#${x.id}`)).toEqual(["#1", "peer#7", "#2"]);
    expect([...m.doneCursors]).toEqual([["peer", "2026-11-09T08:00:00Z|7"]]);
    expect(m.doneTotal).toBe(62);
  });
});
