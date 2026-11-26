import { describe, expect, test } from "bun:test";
import { addEvent, createTodo, getTodo, listEvents, openDb, updateTodo } from "./db.ts";
import { ADD_MAX, completionsByDay, dueState, localClock, widgetAction, widgetPayload } from "./widget.ts";

// 2026-10-08 10:30 in Shanghai.
const now = new Date("2026-10-08T02:30:00Z");
const tz = "Asia/Shanghai";

describe("clock and due", () => {
  test("local wall clock in the zone", () => {
    expect(localClock(now, tz)).toBe("2026-10-08T10:30");
    expect(localClock(new Date("2026-10-07T23:30:00Z"), tz)).toBe("2026-10-08T07:30");
  });
  test("due states", () => {
    const clock = "2026-10-08T10:30";
    expect(dueState(null, clock)).toBe("none");
    expect(dueState("2026-10-07", clock)).toBe("overdue");
    expect(dueState("2026-10-08T09:00", clock)).toBe("overdue");
    expect(dueState("2026-10-08", clock)).toBe("today");
    expect(dueState("2026-10-08T18:00", clock)).toBe("today");
    expect(dueState("2026-10-09", clock)).toBe("later");
  });
});

describe("widget payload", () => {
  test("the review list: a hero counting it, a row per task with an Accept check, the trend last", () => {
    const db = openDb(":memory:");
    createTodo(db, { title: "Pay rent", due: "2026-10-06" }); // open, overdue: not on this card
    const byAi = createTodo(db, { title: "Write report", project: "Work", due: "2026-10-09" });
    updateTodo(db, byAi.id, { status: "review" }, "ai", { runId: 4 });
    const bySweep = createTodo(db, { title: "Fix tests" });
    updateTodo(db, bySweep.id, { status: "review" }, "ai", { runId: 5, via: "sweep" });
    const byMe = createTodo(db, { title: "Book flight", due: "2026-10-08" });
    updateTodo(db, byMe.id, { status: "review" });
    const byAgent = createTodo(db, { title: "Draft spec" });
    updateTodo(db, byAgent.id, { status: "review" }, "cli");
    const finished = createTodo(db, { title: "Old" });
    updateTodo(db, finished.id, { status: "done" });

    const p = widgetPayload(db, { now, timezone: tz, publicBase: "https://todo.test" });
    expect(p).toMatchObject({ ok: true, asOf: "2026-10-08T02:30:00.000Z", staleAfter: 600 });
    // The review list's own order: due first (earliest), then the rest.
    expect(p.items.map((i) => i.text)).toEqual(["Book flight", "Write report", "Fix tests", "Draft spec"]);
    expect(p.items[0]).toMatchObject({ url: `https://todo.test/?todo=${byMe.id}` });
    expect(p.blocks[0]).toEqual({ type: "metric", label: { en: "Awaiting review", zh: "待验收" }, value: 4, tone: "warning", url: "/?view=review" });
    expect(p.blocks.map((b) => b.type)).toEqual(["metric", "status", "status", "status", "status", "trend"]);
    const accept = (id: number) => ({ id: `done:${id}`, kind: "check" as const, label: { en: "Accept", zh: "验收通过" } });
    expect(p.blocks[1]).toEqual({
      type: "status", label: "Book flight", value: { en: "Submitted", zh: "已提交" }, tone: "warning",
      time: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), url: `/?todo=${byMe.id}`, action: accept(byMe.id),
    });
    expect(p.blocks[2]).toMatchObject({ label: "Write report", value: { en: "AI finished · Work", zh: "AI 完成 · Work" }, action: accept(byAi.id) });
    expect(p.blocks[3]).toMatchObject({ label: "Fix tests", value: { en: "AI finished · sweep", zh: "AI 完成 · 定时清理" } });
    expect(p.blocks[4]).toMatchObject({ label: "Draft spec", value: { en: "Submitted by an agent", zh: "智能体提交" } });
    expect(p.blocks[5]).toMatchObject({ type: "trend", style: "bar", label: { en: "Done, last 7 days", zh: "近 7 天完成" } });
  });

  test("nothing in review: the hero says so, no tone; the trend stays", () => {
    const db = openDb(":memory:");
    createTodo(db, { title: "Someday", due: "2026-10-08" });
    const p = widgetPayload(db, { now, timezone: tz });
    expect(p.items).toEqual([]);
    expect(p.blocks.map((b) => b.type)).toEqual(["metric", "trend"]);
    expect(p.blocks[0]).toEqual({ type: "metric", label: { en: "Awaiting review", zh: "待验收" }, value: 0, caption: { en: "Nothing to review", zh: "没有待验收的任务" }, url: "/?view=review" });
  });

  test("ten rows at most, twelve blocks; the hero counts them all; a subtask follows its parent", () => {
    const db = openDb(":memory:");
    const parent = createTodo(db, { title: "Parent" });
    const kid = createTodo(db, { title: "Kid", parentId: parent.id });
    for (let i = 1; i <= 12; i++) { const t = createTodo(db, { title: `T${i}` }); updateTodo(db, t.id, { status: "review" }); }
    updateTodo(db, kid.id, { status: "review" });
    updateTodo(db, parent.id, { status: "review" });
    const p = widgetPayload(db, { now, timezone: tz });
    expect(p.blocks).toHaveLength(12);
    expect(p.blocks[0]).toMatchObject({ value: 14 });
    const labels = p.items.map((i) => i.text);
    expect(labels.indexOf("Kid")).toBe(labels.indexOf("Parent") + 1);
    expect(p.items).toHaveLength(14);
  });
});

test("completions per local day from the history, each todo once a day, zero on days without any", () => {
  const db = openDb(":memory:");
  const a = createTodo(db, { title: "a" });
  const b = createTodo(db, { title: "b" });
  addEvent(db, a.id, "done", {}, "2026-10-07T17:00:00.000Z"); // 10-08 01:00 local
  addEvent(db, a.id, "done", {}, "2026-10-08T01:00:00.000Z"); // same local day, same todo
  addEvent(db, b.id, "done", {}, "2026-10-07T15:00:00.000Z"); // 10-07 23:00 local
  addEvent(db, b.id, "done", {}, "2026-09-30T12:00:00.000Z"); // before the window
  addEvent(db, b.id, "open", {}, "2026-10-08T01:00:00.000Z");
  expect(completionsByDay(db, now, tz)).toEqual([
    { t: "2026-10-02", v: 0 }, { t: "2026-10-03", v: 0 }, { t: "2026-10-04", v: 0 }, { t: "2026-10-05", v: 0 },
    { t: "2026-10-06", v: 0 }, { t: "2026-10-07", v: 1 }, { t: "2026-10-08", v: 1 },
  ]);
});

/** Every action of a payload, card and block level, checked against the widget interactions contract (v1). */
function actionsOf(p: ReturnType<typeof widgetPayload>) {
  const blockActions = p.blocks.flatMap((b) => ("action" in b && b.action ? [b.action] : []));
  return { card: p.actions, blocks: blockActions, all: [...p.actions, ...blockActions] };
}

describe("widget actions", () => {
  const ID = /^[A-Za-z0-9._:-]{1,128}$/;

  test("payload: one input on the card, an Accept check per review row, ids unique and valid", () => {
    const db = openDb(":memory:");
    for (let i = 1; i <= 3; i++) { const t = createTodo(db, { title: `Task ${i}` }); updateTodo(db, t.id, { status: "review" }); }
    createTodo(db, { title: "Open one" });
    const p = widgetPayload(db, { now, timezone: tz });
    const a = actionsOf(p);
    expect(a.card).toEqual([{ id: "add", kind: "input", label: { en: "Add", zh: "添加" }, placeholder: { en: "Add a task…", zh: "添加待办…" } }]);
    expect(a.card.length).toBeLessThanOrEqual(3);
    expect(a.card.filter((x) => x.kind === "input")).toHaveLength(1);
    expect(a.card.every((x) => x.kind === "input" || x.kind === "button")).toBe(true);
    expect(a.blocks.map((x) => x.id)).toEqual(["done:1", "done:2", "done:3"]);
    expect(a.blocks.every((x) => x.kind === "check" && x.label.en === "Accept" && x.label.zh === "验收通过")).toBe(true);
    expect(a.all.every((x) => ID.test(x.id))).toBe(true);
    expect(new Set(a.all.map((x) => x.id)).size).toBe(a.all.length);
  });

  test("done: accepts a task in review through reviewTodo, with its subtasks; idempotent", () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "Built" });
    const sub = createTodo(db, { title: "Step", parentId: t.id });
    updateTodo(db, t.id, { status: "review" });
    const r = widgetAction(db, { action: `done:${t.id}` }, { origin: { caller: "space" } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, message: { en: "Accepted", zh: "已验收" } } });
    expect(getTodo(db, t.id)!.status).toBe("done");
    expect(getTodo(db, sub.id)!.status).toBe("done");
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "done", data: { source: "manual", verdict: "accept" } });
    expect(widgetAction(db, { action: `done:${t.id}` }, { origin: {} })).toMatchObject({ status: 200, body: { ok: true } });
    expect(listEvents(db, t.id).filter((e) => e.kind === "done")).toHaveLength(1);
  });

  test("done on a task not in review completes nothing", () => {
    const db = openDb(":memory:");
    const deps = { origin: {} };
    for (const status of ["open", "doing", "deferred", "dropped"] as const) {
      const t = createTodo(db, { title: status });
      if (status !== "open") updateTodo(db, t.id, { status });
      expect(widgetAction(db, { action: `done:${t.id}` }, deps)).toEqual({ status: 409, body: { ok: false, error: "not awaiting review" } });
      expect(getTodo(db, t.id)!.status).toBe(status);
    }
  });

  test("unknown actions, bad ids and missing tasks are refused", () => {
    const db = openDb(":memory:");
    const deps = { origin: {} };
    for (const action of ["", "rerun", "done:", "done:abc", "done:0", "done:-1", "done:1.5", undefined, 42]) {
      expect(widgetAction(db, { action }, deps)).toEqual({ status: 400, body: { ok: false, error: "unknown action" } });
    }
    expect(widgetAction(db, { action: "done:999" }, deps)).toEqual({ status: 404, body: { ok: false, error: "no such task" } });
  });

  test("add: a task with the add row's defaults; empty or too long is refused", () => {
    const db = openDb(":memory:");
    const deps = { origin: { caller: "space" } };
    const r = widgetAction(db, { action: "add", value: "  Buy   milk " }, deps);
    expect(r).toMatchObject({ status: 201, body: { ok: true, message: { en: "Added", zh: "已添加" } } });
    const t = getTodo(db, (r.body as { todo: { id: number } }).todo.id)!;
    expect(t).toMatchObject({ title: "Buy milk", status: "open", source: "manual", due: null, project: null, tags: [], priority: 0, parentId: null });
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "created", data: { source: "manual", via: "widget", caller: "space" } });
    for (const value of [undefined, "", "   ", 12]) expect(widgetAction(db, { action: "add", value }, deps)).toEqual({ status: 400, body: { ok: false, error: "a task needs a title" } });
    expect(widgetAction(db, { action: "add", value: "x".repeat(ADD_MAX) }, deps).body.ok).toBe(true);
    expect(widgetAction(db, { action: "add", value: "x".repeat(ADD_MAX + 1) }, deps)).toMatchObject({ status: 400, body: { ok: false } });
    // A new task is open, not in review: it is not on this card.
    expect(widgetPayload(db, { now, timezone: tz }).items).toHaveLength(0);
  });
});
