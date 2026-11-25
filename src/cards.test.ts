import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CARD_PREFIX, cardItem, receiptCards } from "./cards.ts";
import { addDays, localClock } from "./dates.ts";
import { createTodo, getTodo, listEvents, openDb, setPlan, undoTodos, updateTodo } from "./db.ts";
import { createServer } from "./index.ts";
import type { Todo } from "./types.ts";

describe("versions", () => {
  test("a todo starts at 1 and goes up with each change of it or its plan, not with an unchanged save", () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "Write the report" });
    expect(t.version).toBe(1);
    expect(updateTodo(db, t.id, { priority: 2 })!.version).toBe(2);
    expect(updateTodo(db, t.id, { priority: 2 })!.version).toBe(2);
    expect(setPlan(db, t.id, "## Plan")!.todo.version).toBe(3);
    expect(setPlan(db, t.id, "## Plan")!.todo.version).toBe(3);
  });
});

describe("undo", () => {
  test("deletes what is unchanged, keeps what changed, answers a missing id as removed, logs who undid it", () => {
    const db = openDb(":memory:");
    const a = createTodo(db, { title: "a" });
    const b = createTodo(db, { title: "b" });
    updateTodo(db, b.id, { title: "b, edited" });
    const r = undoTodos(db, [{ id: a.id, version: 1 }, { id: b.id, version: 1 }, { id: 999, version: 1 }], "chat", { via: "card-undo", caller: "space" });
    expect(r.map((x) => x.removed)).toEqual([true, false, true]);
    expect(getTodo(db, a.id)).toBeNull();
    expect(getTodo(db, b.id)!.title).toBe("b, edited");
    expect(listEvents(db, a.id).find((e) => e.kind === "deleted")!.data).toMatchObject({ source: "chat", via: "card-undo", caller: "space", title: "a" });
    // Idempotent: the same undo again changes nothing more.
    expect(undoTodos(db, [{ id: a.id, version: 1 }], "chat").map((x) => x.removed)).toEqual([true]);
  });

  test("a parent goes only with all of its subtasks named and unchanged", () => {
    const db = openDb(":memory:");
    const p = createTodo(db, { title: "trip" });
    const s1 = createTodo(db, { title: "book", parentId: p.id });
    const s2 = createTodo(db, { title: "pack", parentId: p.id });
    expect(undoTodos(db, [{ id: p.id, version: 1 }, { id: s1.id, version: 1 }], "chat")[0]).toMatchObject({ removed: false });
    updateTodo(db, s2.id, { title: "pack light" });
    expect(undoTodos(db, [{ id: p.id, version: 1 }, { id: s1.id, version: 1 }, { id: s2.id, version: 1 }], "chat")[0]).toMatchObject({ removed: false });
    expect(undoTodos(db, [{ id: p.id, version: 1 }, { id: s1.id, version: 1 }, { id: s2.id, version: 2 }], "chat").map((x) => x.removed)).toEqual([true, true, true]);
    expect(getTodo(db, s2.id)).toBeNull();
  });
});

describe("cards", () => {
  const todo = (over: Partial<Todo> = {}): Todo => ({ id: 128, title: "写周报", notes: "", plan: "", planVersion: 0, status: "open", priority: 3, due: "2026-11-22T15:00", tags: [], project: null, source: "cli", parentId: null, subtasks: { total: 0, done: 0 }, position: 1, version: 1, createdAt: "", updatedAt: "", doneAt: null, ...over });
  // Saturday 2026-11-21 10:00 in Shanghai.
  const clock = { now: new Date("2026-11-21T02:00:00Z"), timezone: "Asia/Shanghai" };
  test("an item carries the due date in words and priority, a path to the todo and its version", () => {
    expect(cardItem(todo(), clock)).toEqual({ id: "128", title: "写周报", detail: "明天 15:00 · 高", url: "/?todo=128", version: 1 });
    expect(cardItem(todo({ due: "2026-11-23", priority: 0, status: "doing" }), clock).detail).toBe("后天 周一 · 进行中");
    expect(cardItem(todo({ due: "2026-11-27T08:00", priority: 2 }), clock).detail).toBe("下周五 11-27 08:00 · 中");
    expect(cardItem(todo({ due: null, priority: 0, parentId: 7 }), clock, "en")).toEqual({ id: "128", title: "写周报", detail: "subtask of #7", url: "/?todo=128", version: 1 });
  });
  test("the detail is said against the day the card is read", () => {
    const nextDay = { ...clock, now: new Date("2026-11-22T02:00:00Z") };
    expect(cardItem(todo(), nextDay).detail).toBe("今天 15:00 · 高");
    expect(cardItem(todo(), { ...clock, now: new Date("2026-11-24T02:00:00Z") }).detail).toBe("周日 11-22 15:00 · 高");
  });
  test("a batch over twenty items is split into cards of twenty", () => {
    const cards = receiptCards(Array.from({ length: 23 }, (_, i) => todo({ id: i + 1 })), clock) as { title: string; items: unknown[]; actions: unknown }[];
    expect(cards.map((c) => c.items.length)).toEqual([20, 3]);
    expect(cards[0]).toMatchObject({ title: "已添加 20 条待办", state: "card-state", actions: { undo: "card-undo" } });
  });
});

describe("the CLI and the capabilities", () => {
  let base = "";
  let stop = () => {};
  beforeAll(() => {
    const { server } = createServer({ db: openDb(":memory:"), port: 0, web: false });
    base = `http://127.0.0.1:${server.port}`;
    stop = () => server.stop(true);
  });
  afterAll(() => stop());

  const cli = async (args: string[], stdin?: string) => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], { env: { ...process.env, TODO_URL: base, TODO_LANG: "zh" }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  const cardsOf = (out: string) => out.split("\n").filter((l) => l.startsWith(CARD_PREFIX)).map((l) => JSON.parse(l.slice(CARD_PREFIX.length)) as { title: string; items: { id: string; version: number; title: string }[] });
  const post = async (path: string, body: unknown) => (await (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify(body) })).json()) as { ok: boolean; items: { id: string; status: string; changed?: boolean; title?: string }[] };

  // Tomorrow in the app zone (the tests pin TODO_TZ), so the card says 明天 whatever day the tests run.
  const tomorrow = addDays(localClock(new Date(), "Asia/Shanghai").slice(0, 10), 1);

  test("add prints its line and a receipt card; a batch prints one card for all", async () => {
    const one = await cli(["add", "写周报", "--due", `${tomorrow}T15:00`, "--priority", "3"]);
    expect(one).toContain("写周报");
    expect(cardsOf(one)).toEqual([{ v: 1, kind: "receipt", title: "已添加 1 条待办", items: [{ id: "1", title: "写周报", detail: "明天 15:00 · 高", url: "/?todo=1", version: 1 }], state: "card-state", actions: { undo: "card-undo" } }] as never);
    const many = await cli(["add", "--drafts", "-"], JSON.stringify([{ title: "订机票" }, { title: "订酒店", due: "2026-11-25" }]));
    const [card] = cardsOf(many);
    expect(card!.title).toBe("已添加 2 条待办");
    expect(card!.items.map((i) => i.title)).toEqual(["订机票", "订酒店"]);
    const subs = await cli(["add", "拆一步", "--parent", "1"]);
    expect(cardsOf(subs)[0]!.title).toBe("已添加 1 条子任务");
  });

  test("card-state answers the current state, card-undo deletes what is unchanged", async () => {
    await fetch(`${base}/api/todos/2`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
    const state = await post("/api/capabilities/card-state", { ids: ["1", "2", "99"] });
    expect(state.items.map((i) => i.status)).toEqual(["active", "done", "removed"]);
    // The same words as the card the CLI printed.
    expect(state.items[0]).toMatchObject({ title: "写周报", detail: "明天 15:00 · 高" });
    // #2 changed since the card (it was finished): left alone. #3 is deleted.
    const undo = await post("/api/capabilities/card-undo", { items: [{ id: "2", version: 1 }, { id: "3", version: 1 }] });
    expect(undo.items).toMatchObject([{ id: "2", status: "done", changed: true }, { id: "3", status: "removed" }]);
    expect((await post("/api/capabilities/card-state", { ids: ["3"] })).items).toEqual([{ id: "3", status: "removed" }]);
    expect((await fetch(`${base}/api/capabilities/card-undo`, { method: "POST", body: JSON.stringify({ items: [{ id: "x" }] }) })).status).toBe(400);
  });
});

describe("card-state over days", () => {
  test("a card read again on a later day says the due date against that day", async () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "交报告", due: "2026-11-26T08:00", priority: 3 });
    let at = new Date("2026-11-24T02:00:00Z"); // Tuesday 10:00 in Shanghai
    const { server } = createServer({ db, port: 0, web: false, now: () => at, timezone: "Asia/Shanghai" });
    try {
      const state = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/api/capabilities/card-state`, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify({ ids: [t.id] }) })).json()) as { items: { detail?: string }[] }).items[0]!.detail;
      expect(await state()).toBe("后天 周四 08:00 · 高");
      at = new Date("2026-11-25T02:00:00Z");
      expect(await state()).toBe("明天 08:00 · 高");
      at = new Date("2026-11-26T16:00:00Z"); // midnight into Friday in Shanghai
      expect(await state()).toBe("周四 11-26 08:00 · 高");
      const undo = (await (await fetch(`http://127.0.0.1:${server.port}/api/capabilities/card-undo`, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify({ items: [{ id: t.id, version: 0 }] }) })).json()) as { items: { detail?: string; changed?: boolean }[] };
      expect(undo.items[0]).toMatchObject({ changed: true, detail: "周四 11-26 08:00 · 高" });
    } finally { server.stop(true); }
  });
});
