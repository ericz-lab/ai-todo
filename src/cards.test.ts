import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CARD_PREFIX, cardDate, cardItem, clip, itemState, listCard, PRIORITY_TONE, priorityTag, receiptCards, type CardTodo } from "./cards.ts";
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


/**
 * The limits of ai-space's card check (docs/chat-cards.md, `parseCard` in src/space/agents/cards.ts on the
 * cards v2 branch), written out here since that code is in another repository: a card that breaks one is
 * dropped whole. Answers what is wrong, an empty list when the card passes.
 */
const STYLES = ["rows", "compact", "gallery", "agenda", "stat"];
const TONES = ["neutral", "accent", "positive", "warning", "negative"];
const realDate = (v: unknown) => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate() && (m[4] === undefined || (Number(m[4]) < 24 && Number(m[5]) < 60));
};
const oneLine = (v: unknown, max: number, required = false) => (v === undefined ? !required : typeof v === "string" && v.replace(/\s+/g, " ").trim().length <= max && (!required || !!v.trim()));
function cardProblems(card: Record<string, unknown>, line?: string): string[] {
  const p: string[] = [];
  if (line !== undefined && line.length > 16 * 1024) p.push("line over 16 KB");
  if (card.v !== 1) p.push("v");
  if (!["receipt", "list", "value"].includes(card.kind as string)) p.push("kind");
  if (card.style !== undefined && !STYLES.includes(card.style as string)) p.push("style");
  if (!oneLine(card.title, 200)) p.push("title");
  const items = card.items as Record<string, unknown>[];
  if (!Array.isArray(items) || !items.length || items.length > 20) p.push(`items: ${Array.isArray(items) ? items.length : "none"}`);
  if (card.actions !== undefined && card.kind !== "receipt") p.push("actions on a card that is not a receipt");
  if (card.state !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(String(card.state))) p.push("state");
  const ids = new Set<string>();
  for (const it of Array.isArray(items) ? items : []) {
    const at = `item ${String(it.id)}`;
    if (typeof it.id !== "string" || !it.id.trim() || it.id.length > 100 || ids.has(it.id)) p.push(`${at}: id`);
    ids.add(String(it.id));
    if (!oneLine(it.title, 300, true)) p.push(`${at}: title`);
    if (!oneLine(it.detail, 300)) p.push(`${at}: detail`);
    if (it.url !== undefined && (typeof it.url !== "string" || !it.url.startsWith("/") || it.url.startsWith("//"))) p.push(`${at}: url`);
    if (it.version !== undefined && !(Number.isInteger(it.version) && (it.version as number) >= 0)) p.push(`${at}: version`);
    if (!oneLine(it.when, 40)) p.push(`${at}: when`);
    if (!oneLine(it.value, 24)) p.push(`${at}: value`);
    if (it.date !== undefined && !realDate(it.date)) p.push(`${at}: date ${String(it.date)}`);
    if (it.tags !== undefined) {
      const tags = it.tags as { text?: unknown; tone?: unknown }[];
      if (!Array.isArray(tags) || tags.length > 4) p.push(`${at}: tags`);
      else for (const t of tags) if (!oneLine(t.text, 24, true) || (t.tone !== undefined && !TONES.includes(t.tone as string))) p.push(`${at}: tag ${JSON.stringify(t)}`);
    }
  }
  return p;
}

describe("cards", () => {
  const todo = (over: Partial<Todo> = {}): Todo => ({ id: 128, title: "写周报", notes: "", plan: "", planVersion: 0, status: "open", priority: 3, due: "2026-11-22T15:00", tags: [], project: null, source: "cli", parentId: null, subtasks: { total: 0, done: 0 }, position: 1, version: 1, createdAt: "", updatedAt: "", doneAt: null, ...over });
  // Saturday 2026-11-21 10:00 in Shanghai.
  const clock = { now: new Date("2026-11-21T02:00:00Z"), timezone: "Asia/Shanghai" };
  const high = { text: "高", tone: "negative" as const };

  test("an item carries the due date as when and date, the priority as a tag, its stage and parent as the detail", () => {
    expect(cardItem(todo(), clock)).toEqual({ id: "128", title: "写周报", url: "/?todo=128", version: 1, when: "明天 15:00", date: "2026-11-22T15:00", tags: [high] });
    expect(cardItem(todo({ due: "2026-11-23", priority: 0, status: "doing" }), clock)).toMatchObject({ detail: "进行中", when: "后天 周一", date: "2026-11-23" });
    expect(cardItem(todo({ due: "2026-11-23", priority: 0 }), clock).tags).toBeUndefined();
    expect(cardItem(todo({ due: "2026-11-27T08:00", priority: 2, parentId: 7, status: "review" }), clock)).toMatchObject({ detail: "待验收 · #7 的子任务", when: "下周五 11-27 08:00", tags: [{ text: "中", tone: "neutral" }] });
    expect(cardItem(todo({ due: null, priority: 0, parentId: 7 }), clock, "en")).toEqual({ id: "128", title: "写周报", detail: "subtask of #7", url: "/?todo=128", version: 1 });
  });

  test("priority to tone: only high is marked; none has no tag", () => {
    expect(PRIORITY_TONE).toEqual(["neutral", "neutral", "neutral", "negative"]);
    expect([0, 1, 2, 3].map((n) => priorityTag(n))).toEqual([undefined, { text: "低", tone: "neutral" }, { text: "中", tone: "neutral" }, { text: "高", tone: "negative" }]);
    expect([1, 2, 3].map((n) => priorityTag(n, "en")!.text)).toEqual(["Low", "Med", "High"]);
  });

  test("the todo's own tags follow the priority as neutral tags, at most four in all, each cut to 24", () => {
    const long = "一个非常非常长的标签名字超过了二十四个字符的限制还要再长一点";
    const item = cardItem(todo({ tags: ["旅行", "家里", long, "四", "五"] }), clock);
    expect(item.tags!.map((t) => t.text)).toEqual(["高", "旅行", "家里", clip(long, 24)]);
    expect(item.tags!.slice(1).every((t) => t.tone === "neutral")).toBe(true);
    expect(clip(long, 24).length).toBe(24);
    expect(cardItem(todo({ priority: 0, tags: ["a", "b", "c", "d", "e"] }), clock).tags!.map((t) => t.text)).toEqual(["a", "b", "c", "d"]);
    expect(cardProblems(receiptCards([todo({ tags: ["旅行", "家里", long, "四", "五"], title: "x".repeat(400) })], clock)[0]!)).toEqual([]);
  });

  test("date: only a real day in the stored shape, else left out", () => {
    expect(cardDate("2026-11-22")).toBe("2026-11-22");
    expect(cardDate("2026-11-22T15:00")).toBe("2026-11-22T15:00");
    expect(cardDate("2026-11-22T15:00:30")).toBe("2026-11-22T15:00");
    expect(cardDate("2026-02-30")).toBeUndefined();
    expect(cardDate("someday")).toBeUndefined();
    expect(cardItem(todo({ due: "2026-02-30" }), clock).when).toBeUndefined();
  });

  test("when is said against the day the card is read", () => {
    const nextDay = { ...clock, now: new Date("2026-11-22T02:00:00Z") };
    expect(cardItem(todo(), nextDay)).toMatchObject({ when: "今天 15:00", date: "2026-11-22T15:00" });
    expect(cardItem(todo(), { ...clock, now: new Date("2026-11-24T02:00:00Z") }).when).toBe("周日 11-22 15:00");
    expect(itemState(todo({ status: "done" }), nextDay)).toMatchObject({ status: "done", when: "今天 15:00", tags: [high] });
  });

  test("a batch over twenty items is split into cards of twenty, each within the limits", () => {
    const cards = receiptCards(Array.from({ length: 23 }, (_, i) => todo({ id: i + 1, tags: ["a"] })), clock);
    expect(cards.map((c) => c.items.length)).toEqual([20, 3]);
    expect(cards[0]).toMatchObject({ title: "已添加 20 条待办", state: "card-state", actions: { undo: "card-undo" } });
    expect(cards[0]!.style).toBeUndefined();
    for (const c of cards) expect(cardProblems(c)).toEqual([]);
  });

  const many = (n: number) => Array.from({ length: n }, (_, i): CardTodo => todo({ id: i + 1, title: `任务 ${i + 1}`, due: i % 3 ? `2026-11-${String(22 + (i % 6)).padStart(2, "0")}` : null, priority: (i % 4) as Todo["priority"] }));
  test("a list card: compact, one line per todo with due words or priority on the right, state but no actions", () => {
    const card = listCard(many(3), { status: "active" }, 3, clock)!;
    expect(card).toEqual({ v: 1, kind: "list", style: "compact", title: "待办 3 条", state: "card-state", items: [
      { id: "1", title: "任务 1", url: "/?todo=1" },
      { id: "2", title: "任务 2", url: "/?todo=2", when: "后天 周一", date: "2026-11-23", value: "后天 周一" },
      { id: "3", title: "任务 3", url: "/?todo=3", when: "下周二 11-24", date: "2026-11-24", value: "下周二 11-24" },
    ] });
    expect(listCard([todo({ due: null, priority: 2 })], { status: "active" }, 1, clock)!.items[0]!.value).toBe("中");
    expect(cardProblems(card)).toEqual([]);
  });

  test("a list card holds at most twenty and says so; an empty listing has none", () => {
    const twenty = listCard(many(20), { status: "active" }, 20, clock)!;
    expect(twenty.title).toBe("待办 20 条");
    expect(twenty.items).toHaveLength(20);
    const more = listCard(many(37), { status: "active" }, 37, clock)!;
    expect(more.title).toBe("待办 37 条 · 显示前 20");
    expect(more.items.map((i) => i.id)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    for (const c of [twenty, more]) expect(cardProblems(c)).toEqual([]);
    expect(listCard([], { status: "active" }, 0, clock)).toBeNull();
  });

  test("a list card's title says the filters, in Chinese or English", () => {
    expect(listCard(many(2), { status: "done", tag: "旅行", project: "家", q: "票" }, 2, clock)!.title).toBe("已完成 #旅行 @家 “票” 2 条");
    expect(listCard(many(2), { status: "review" }, 2, clock, "en")!.title).toBe("Awaiting acceptance · 2");
    expect(listCard(many(25), { status: "active" }, 25, clock, "en")!.title).toBe("Open · 25 · first 20 shown");
    const long = listCard(many(2), { status: "all", q: "长".repeat(500) }, 2, clock)!;
    expect(cardProblems(long)).toEqual([]);
  });

  test("English: the items' words and tags", () => {
    expect(cardItem(todo({ status: "doing" }), clock, "en")).toMatchObject({ detail: "In progress", when: "Tomorrow 15:00", tags: [{ text: "High", tone: "negative" }] });
    expect(receiptCards([todo(), todo({ id: 2 })], clock, "en")[0]!.title).toBe("Added 2 todos");
    expect(listCard(many(3), { status: "active" }, 3, clock, "en")!.items[1]).toMatchObject({ when: "Mon 11-23", value: "Mon 11-23" });
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

  const cli = async (args: string[], stdin?: string, lang = "zh") => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], { env: { ...process.env, TODO_URL: base, TODO_LANG: lang }, stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  type Printed = { v: 1; kind: string; style?: string; title: string; state?: string; actions?: unknown; items: { id: string; version?: number; title: string; detail?: string; when?: string; date?: string; value?: string; tags?: { text: string; tone?: string }[] }[] };
  /** The card lines of an output, each checked against the contract's limits. */
  const cardsOf = (out: string) => out.split("\n").filter((l) => l.startsWith(CARD_PREFIX)).map((l) => {
    const card = JSON.parse(l.slice(CARD_PREFIX.length)) as Printed;
    expect(cardProblems(card, l)).toEqual([]);
    return card;
  });
  const post = async (path: string, body: unknown) => (await (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify(body) })).json()) as { ok: boolean; items: { id: string; status: string; changed?: boolean; title?: string; detail?: string; when?: string; date?: string; tags?: unknown }[] };

  // Tomorrow in the app zone (the tests pin TODO_TZ), so the card says 明天 whatever day the tests run.
  const tomorrow = addDays(localClock(new Date(), "Asia/Shanghai").slice(0, 10), 1);

  test("add prints its line and a receipt card with when, date and tags; a batch prints one card for all", async () => {
    const one = await cli(["add", "写周报", "--due", `${tomorrow}T15:00`, "--priority", "3", "--tags", "工作"]);
    expect(one).toContain("写周报");
    expect(cardsOf(one)).toEqual([{ v: 1, kind: "receipt", title: "已添加 1 条待办", items: [{ id: "1", title: "写周报", url: "/?todo=1", version: 1, when: "明天 15:00", date: `${tomorrow}T15:00`, tags: [{ text: "高", tone: "negative" }, { text: "工作", tone: "neutral" }] }], state: "card-state", actions: { undo: "card-undo" } }] as never);
    const many = await cli(["add", "--drafts", "-"], JSON.stringify([{ title: "订机票" }, { title: "订酒店", due: "2026-11-25", priority: 1 }]));
    const [card] = cardsOf(many);
    expect(card!.title).toBe("已添加 2 条待办");
    expect(card!.items.map((i) => i.title)).toEqual(["订机票", "订酒店"]);
    expect(card!.items[0]!.tags).toBeUndefined();
    expect(card!.items[1]).toMatchObject({ date: "2026-11-25", tags: [{ text: "低", tone: "neutral" }] });
    const subs = await cli(["add", "拆一步", "--parent", "1", "--priority", "2"]);
    const [sub] = cardsOf(subs);
    expect(sub!.title).toBe("已添加 1 条子任务");
    expect(sub!.items[0]).toMatchObject({ detail: "#1 的子任务", tags: [{ text: "中", tone: "neutral" }] });
  });

  test("card-state answers the current state with the same fields, card-undo deletes what is unchanged", async () => {
    await fetch(`${base}/api/todos/2`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
    const state = await post("/api/capabilities/card-state", { ids: ["1", "2", "99"] });
    expect(state.items.map((i) => i.status)).toEqual(["active", "done", "removed"]);
    // The same fields as the card the CLI printed.
    expect(state.items[0]).toMatchObject({ title: "写周报", when: "明天 15:00", date: `${tomorrow}T15:00`, tags: [{ text: "高", tone: "negative" }, { text: "工作", tone: "neutral" }] });
    expect(state.items[0]!.detail).toBeUndefined();
    // #2 changed since the card (it was finished): left alone, answered with its fields. #3 is deleted.
    await fetch(`${base}/api/todos/2`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ priority: 3 }) });
    const undo = await post("/api/capabilities/card-undo", { items: [{ id: "2", version: 1 }, { id: "3", version: 1 }] });
    expect(undo.items).toMatchObject([{ id: "2", status: "done", changed: true, tags: [{ text: "高", tone: "negative" }] }, { id: "3", status: "removed" }]);
    expect((await post("/api/capabilities/card-state", { ids: ["3"] })).items).toEqual([{ id: "3", status: "removed" }]);
    expect((await fetch(`${base}/api/capabilities/card-undo`, { method: "POST", body: JSON.stringify({ items: [{ id: "x" }] }) })).status).toBe(400);
  });
});

describe("list and its card", () => {
  let base = "";
  let stop = () => {};
  beforeAll(() => {
    const { server } = createServer({ db: openDb(":memory:"), port: 0, web: false });
    base = `http://127.0.0.1:${server.port}`;
    stop = () => server.stop(true);
  });
  afterAll(() => stop());

  const cli = async (args: string[], lang = "zh") => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...args], { env: { ...process.env, TODO_URL: base, TODO_LANG: lang }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  };
  const cardLines = (out: string) => out.split("\n").filter((l) => l.startsWith(CARD_PREFIX));
  const cardsOf = (out: string) => cardLines(out).map((l) => {
    const card = JSON.parse(l.slice(CARD_PREFIX.length)) as { kind: string; style: string; title: string; state: string; actions?: unknown; items: { id: string; title: string; when?: string; date?: string; value?: string }[] };
    expect(cardProblems(card as never, l)).toEqual([]);
    return card;
  });
  /** The ids of the todo lines (a subtask's too: its arrow is in the title column), in the order printed. */
  const printedIds = (out: string) => out.split("\n").map((l) => /^#(\d+)\t/.exec(l)?.[1]).filter((x): x is string => !!x);
  const add = async (n: number, from: number, extra: Record<string, unknown> = {}) => {
    const drafts = Array.from({ length: n }, (_, i) => ({ title: `任务 ${from + i}`, ...(i % 2 ? { due: `2027-01-${String((i % 28) + 1).padStart(2, "0")}` } : { priority: i % 4 }), ...extra }));
    const r = await fetch(`${base}/api/todos/bulk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ drafts, source: "cli" }) });
    expect(r.ok).toBe(true);
  };

  test("an empty listing prints no card", async () => {
    const out = await cli(["list"]);
    expect(out).toContain("(none)");
    expect(cardLines(out)).toEqual([]);
  });

  test("a few todos: a compact list card after the lines, in their order; --no-card leaves it out", async () => {
    await add(3, 1);
    const out = await cli(["list"]);
    const lines = out.trimEnd().split("\n");
    expect(lines.at(-1)!.startsWith(CARD_PREFIX)).toBe(true);
    const [card] = cardsOf(out);
    expect(card).toMatchObject({ kind: "list", style: "compact", title: "待办 3 条", state: "card-state" });
    expect(card!.actions).toBeUndefined();
    expect(card!.items.map((i) => i.id)).toEqual(printedIds(out));
    expect(card!.items.find((i) => i.title === "任务 2")).toMatchObject({ date: "2027-01-02", when: "周六 2027-01-02", value: "周六 2027-01-02" });
    expect(card!.items.find((i) => i.title === "任务 1")!.value).toBeUndefined();
    expect(card!.items.find((i) => i.title === "任务 3")!.value).toBe("中");
    const bare = await cli(["list", "--no-card"]);
    expect(cardLines(bare)).toEqual([]);
    expect(printedIds(bare)).toEqual(printedIds(out));
    // A switch takes no value: the tag after it still filters.
    expect(cardsOf(await cli(["list", "--no-card", "--tag", "x"]))).toEqual([]);
    expect(await cli(["list", "--all", "--q", "任务 2"])).toContain("任务 2");
    expect(cardsOf(await cli(["list", "--all", "--q", "任务 2"]))[0]!.title).toBe("全部 “任务 2” 1 条");
  });

  test("exactly twenty todos: all on the card", async () => {
    await add(17, 4);
    const [card] = cardsOf(await cli(["list"]));
    expect(card!.title).toBe("待办 20 条");
    expect(card!.items).toHaveLength(20);
  });

  test("more than twenty: the first twenty in the listing's order, and the title says so", async () => {
    await add(17, 21);
    const out = await cli(["list"]);
    expect(printedIds(out)).toHaveLength(37);
    const [card] = cardsOf(out);
    expect(card!.title).toBe("待办 37 条 · 显示前 20");
    expect(card!.items.map((i) => i.id)).toEqual(printedIds(out).slice(0, 20));
    const [en] = cardsOf(await cli(["list"], "en"));
    expect(en!.title).toBe("Open · 37 · first 20 shown");
  });

  test("subtasks are on the card where the list prints them, under their parent", async () => {
    const r = (await (await fetch(`${base}/api/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "父", due: "2026-01-01" }) })).json()) as { todo: { id: number } };
    await fetch(`${base}/api/todos/bulk`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ drafts: [{ title: "子" }], parentId: r.todo.id }) });
    const out = await cli(["list", "--no-card"]);
    const ids = printedIds(out);
    expect(ids[ids.indexOf(String(r.todo.id)) + 1]).toBe(String(r.todo.id + 1));
    const [card] = cardsOf(await cli(["list"]));
    expect(card!.items.map((i) => i.id)).toEqual(ids.slice(0, 20));
  });
});

describe("card-state over days", () => {
  test("a card read again on a later day says the due date against that day", async () => {
    const db = openDb(":memory:");
    const t = createTodo(db, { title: "交报告", due: "2026-11-26T08:00", priority: 3 });
    let at = new Date("2026-11-24T02:00:00Z"); // Tuesday 10:00 in Shanghai
    const { server } = createServer({ db, port: 0, web: false, now: () => at, timezone: "Asia/Shanghai" });
    try {
      const state = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/api/capabilities/card-state`, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify({ ids: [t.id] }) })).json()) as { items: { when?: string; date?: string }[] }).items[0]!;
      expect(await state()).toMatchObject({ when: "后天 周四 08:00", date: "2026-11-26T08:00" });
      at = new Date("2026-11-25T02:00:00Z");
      expect((await state()).when).toBe("明天 08:00");
      at = new Date("2026-11-26T16:00:00Z"); // midnight into Friday in Shanghai
      expect((await state()).when).toBe("周四 11-26 08:00");
      const undo = (await (await fetch(`http://127.0.0.1:${server.port}/api/capabilities/card-undo`, { method: "POST", headers: { "content-type": "application/json", "x-space-caller": "space" }, body: JSON.stringify({ items: [{ id: t.id, version: 0 }] }) })).json()) as { items: { when?: string; tags?: unknown; changed?: boolean }[] };
      expect(undo.items[0]).toMatchObject({ changed: true, when: "周四 11-26 08:00", tags: [{ text: "高", tone: "negative" }] });
    } finally { server.stop(true); }
  });
});
