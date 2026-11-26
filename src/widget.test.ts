import { describe, expect, test } from "bun:test";
import { addEvent, createTodo, getTodo, listEvents, openDb, updateTodo } from "./db.ts";
import type { Patch, Source } from "./types.ts";
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
  test("hero counts what is due by today, overdue tones it; rows are the next tasks with the trend after three", () => {
    const db = openDb(":memory:");
    const late = createTodo(db, { title: "Pay rent", due: "2026-10-06" });
    const today = createTodo(db, { title: "Call bank", due: "2026-10-08T18:00" });
    const doing = createTodo(db, { title: "Write report", priority: 3 });
    updateTodo(db, doing.id, { status: "doing" });
    createTodo(db, { title: "Book flight", due: "2026-10-09T09:00" });
    createTodo(db, { title: "Read book", due: "2027-01-02" });
    createTodo(db, { title: "Someday" });
    const finished = createTodo(db, { title: "Old" });
    updateTodo(db, finished.id, { status: "done" });

    const p = widgetPayload(db, { now, timezone: tz, publicBase: "https://todo.test" });
    expect(p.ok).toBe(true);
    expect(p.asOf).toBe("2026-10-08T02:30:00.000Z");
    expect(p.staleAfter).toBe(600);
    // The list stays as it was, for a panel without blocks.
    expect(p.items[0]).toMatchObject({ text: "▶ ‼ Write report", url: `https://todo.test/?todo=${doing.id}` });
    expect(p.items).toHaveLength(6);

    const [hero, ...rows] = p.blocks;
    expect(hero).toEqual({
      type: "metric", label: { en: "Due by today", zh: "今天到期" }, value: 2,
      caption: { en: "1 overdue · 6 open", zh: "逾期 1 · 未完成 6" }, tone: "negative", url: "/",
    });
    expect(p.blocks.length).toBeLessThanOrEqual(12);
    expect(rows.map((b) => b.type)).toEqual(["status", "status", "status", "trend", "status", "status", "status"]);
    expect(rows[0]).toEqual({
      type: "status", label: "Write report", value: { en: "Doing · High", zh: "进行中 · 高优先级" }, tone: "neutral", url: `/?todo=${doing.id}`,
      action: { id: `done:${doing.id}`, kind: "check", label: { en: "Mark done", zh: "标记完成" } },
    });
    expect(rows[1]).toMatchObject({ label: "Pay rent", value: { en: "Overdue · 10-06", zh: "逾期 · 10-06" }, tone: "negative", url: `/?todo=${late.id}` });
    expect(rows[2]).toMatchObject({ label: "Call bank", value: { en: "Today 18:00", zh: "今天 18:00" }, tone: "warning", url: `/?todo=${today.id}` });
    expect(rows[4]).toMatchObject({ label: "Book flight", value: { en: "Tomorrow 09:00", zh: "明天 09:00" }, tone: "neutral" });
    expect(rows[5]).toMatchObject({ label: "Read book", value: { en: "2027-01-02", zh: "2027-01-02" } });
    expect(rows[6]).toMatchObject({ label: "Someday", value: { en: "No due date", zh: "无截止" } });
    expect(rows[3]).toMatchObject({ type: "trend", style: "bar", label: { en: "Done, last 7 days", zh: "近 7 天完成" } });
  });

  test("nothing due today: the caption names the next due date", () => {
    const db = openDb(":memory:");
    createTodo(db, { title: "Book flight", due: "2026-10-10T09:00" });
    createTodo(db, { title: "Someday" });
    const [hero] = widgetPayload(db, { now, timezone: tz }).blocks;
    expect(hero).toMatchObject({ value: 0, tone: "neutral", caption: { en: "2 open · next due 10-10 09:00", zh: "未完成 2 · 下个截止 10-10 09:00" } });
  });

  test("empty list: a compact card, the trend only when something was finished", () => {
    const db = openDb(":memory:");
    expect(widgetPayload(db, { now, timezone: tz }).blocks).toHaveLength(1);
    const t = createTodo(db, { title: "Done thing" });
    updateTodo(db, t.id, { status: "done" });
    const p = widgetPayload(db, { now: new Date(), timezone: tz });
    expect(p.items).toEqual([]);
    expect(p.blocks.map((b) => b.type)).toEqual(["metric", "trend"]);
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
  const change = (db: ReturnType<typeof openDb>) => (id: number, patch: Patch, src: Source, origin: Record<string, unknown>) => updateTodo(db, id, patch, src, origin);

  test("payload: one input on the card, a check on each task row (eight at most), ids unique and valid", () => {
    const db = openDb(":memory:");
    for (let i = 1; i <= 10; i++) createTodo(db, { title: `Task ${i}`, due: i === 1 ? "2026-10-07" : i === 2 ? "2026-10-08" : null });
    const review = createTodo(db, { title: "Check me" });
    updateTodo(db, review.id, { status: "review" });
    const p = widgetPayload(db, { now, timezone: tz });
    const a = actionsOf(p);
    expect(p.blocks.length).toBeLessThanOrEqual(12);
    // The order an older panel knows: hero, the review row, three tasks, the trend, then more tasks.
    expect(p.blocks.map((b) => b.type)).toEqual(["metric", "status", "status", "status", "status", "trend", "status", "status", "status", "status", "status"]);
    expect(p.blocks[1]).not.toHaveProperty("action");
    expect(a.card).toEqual([{ id: "add", kind: "input", label: { en: "Add", zh: "添加" }, placeholder: { en: "Add a task…", zh: "添加待办…" } }]);
    expect(a.card.length).toBeLessThanOrEqual(3);
    expect(a.card.filter((x) => x.kind === "input")).toHaveLength(1);
    expect(a.card.every((x) => x.kind === "input" || x.kind === "button")).toBe(true);
    expect(a.blocks).toHaveLength(8);
    expect(a.blocks.every((x) => x.kind === "check" && x.label.en === "Mark done" && x.label.zh === "标记完成")).toBe(true);
    expect(a.all.every((x) => ID.test(x.id))).toBe(true);
    expect(new Set(a.all.map((x) => x.id)).size).toBe(a.all.length);
    // Overdue and due today lead, in the app's own order, toned as before.
    expect(p.blocks[2]).toMatchObject({ label: "Task 1", tone: "negative", action: { id: `done:1` } });
    expect(p.blocks[3]).toMatchObject({ label: "Task 2", tone: "warning", action: { id: `done:2` } });
  });

  test("done: through the completion path, with the subtasks, idempotent", () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "Parent" });
    const sub = createTodo(db, { title: "Step", parentId: t.id });
    const r = widgetAction(db, { action: `done:${t.id}` }, { change: change(db), origin: { caller: "space" } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, message: { en: "Done", zh: "已完成" } } });
    expect(getTodo(db, t.id)!.status).toBe("done");
    expect(getTodo(db, sub.id)!.status).toBe("done");
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "done", data: { source: "manual", via: "widget", caller: "space" } });
    const again = widgetAction(db, { action: `done:${t.id}` }, { change: change(db), origin: {} });
    expect(again).toMatchObject({ status: 200, body: { ok: true } });
    expect(listEvents(db, t.id).filter((e) => e.kind === "done")).toHaveLength(1);
  });

  test("done on a task in review accepts it, as the row's check does", () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "Built" });
    updateTodo(db, t.id, { status: "review" });
    expect(widgetAction(db, { action: `done:${t.id}` }, { change: change(db), origin: {} }).body.ok).toBe(true);
    expect(getTodo(db, t.id)!.status).toBe("done");
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "done", data: { verdict: "accept" } });
  });

  test("unknown actions, bad ids, missing and dropped tasks are refused", () => {
    const db = openDb(":memory:");
    const dropped = createTodo(db, { title: "Gone" });
    updateTodo(db, dropped.id, { status: "dropped" });
    const deps = { change: change(db), origin: {} };
    for (const action of ["", "rerun", "done:", "done:abc", "done:0", "done:-1", "done:1.5", undefined, 42]) {
      expect(widgetAction(db, { action }, deps)).toEqual({ status: 400, body: { ok: false, error: "unknown action" } });
    }
    expect(widgetAction(db, { action: "done:999" }, deps)).toEqual({ status: 404, body: { ok: false, error: "no such task" } });
    expect(widgetAction(db, { action: `done:${dropped.id}` }, deps)).toMatchObject({ status: 409, body: { ok: false } });
    expect(getTodo(db, dropped.id)!.status).toBe("dropped");
  });

  test("add: a task with the add row's defaults; empty or too long is refused", () => {
    const db = openDb(":memory:");
    const deps = { change: change(db), origin: { caller: "space" } };
    const r = widgetAction(db, { action: "add", value: "  Buy   milk " }, deps);
    expect(r).toMatchObject({ status: 201, body: { ok: true, message: { en: "Added", zh: "已添加" } } });
    const t = getTodo(db, (r.body as { todo: { id: number } }).todo.id)!;
    expect(t).toMatchObject({ title: "Buy milk", status: "open", source: "manual", due: null, project: null, tags: [], priority: 0, parentId: null });
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "created", data: { source: "manual", via: "widget", caller: "space" } });
    for (const value of [undefined, "", "   ", 12]) expect(widgetAction(db, { action: "add", value }, deps)).toEqual({ status: 400, body: { ok: false, error: "a task needs a title" } });
    expect(widgetAction(db, { action: "add", value: "x".repeat(ADD_MAX) }, deps).body.ok).toBe(true);
    expect(widgetAction(db, { action: "add", value: "x".repeat(ADD_MAX + 1) }, deps)).toMatchObject({ status: 400, body: { ok: false } });
    expect(widgetPayload(db, { now, timezone: tz }).items).toHaveLength(2);
  });
});
