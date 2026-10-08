import { describe, expect, test } from "bun:test";
import { addEvent, createTodo, openDb, updateTodo } from "./db.ts";
import { completionsByDay, dueState, localClock, widgetPayload } from "./widget.ts";

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
    expect(p.blocks.length).toBeLessThanOrEqual(8);
    expect(rows.map((b) => b.type)).toEqual(["status", "status", "status", "trend", "status", "status"]);
    expect(rows[0]).toEqual({ type: "status", label: "Write report", value: { en: "Doing · High", zh: "进行中 · 高优先级" }, tone: "neutral", url: `/?todo=${doing.id}` });
    expect(rows[1]).toMatchObject({ label: "Pay rent", value: { en: "Overdue · 10-06", zh: "逾期 · 10-06" }, tone: "negative", url: `/?todo=${late.id}` });
    expect(rows[2]).toMatchObject({ label: "Call bank", value: { en: "Today 18:00", zh: "今天 18:00" }, tone: "warning", url: `/?todo=${today.id}` });
    expect(rows[4]).toMatchObject({ label: "Book flight", value: { en: "Tomorrow 09:00", zh: "明天 09:00" }, tone: "neutral" });
    expect(rows[5]).toMatchObject({ label: "Read book", value: { en: "2027-01-02", zh: "2027-01-02" } });
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
