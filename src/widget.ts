/**
 * The panel card (`GET /api/widget`, ai-space docs/app-spec.md "Blocks: a state card instead of a
 * list"): the list as `items` for a panel without blocks, and `blocks` for a state card. The hero
 * counts what is due by today, overdue ones coloring it; the rows are the next tasks and the
 * completions of the last seven days; tasks awaiting acceptance (验收) get a row of their own on top and
 * a mention in the caption. Every number is counted from the store, nothing estimated.
 */
import type { Database } from "bun:sqlite";
import { cleanDraft, countTodos, createTodo, getTodo, listTodos, reviewTodo } from "./db.ts";
import { addDays, localClock } from "./dates.ts";
import type { Patch, Source, Todo } from "./types.ts";

export { localClock };

type Text = { en: string; zh: string };
type Tone = "positive" | "negative" | "warning" | "neutral";
/** A widget action (ai-space widget interactions, v1): block level `check` | `button`, card level `input` | `button`. */
export type BlockAction = { id: string; kind: "check" | "button"; label: Text };
export type CardAction = { id: string; kind: "input" | "button"; label: Text; placeholder?: Text };
export type Block =
  | { type: "metric"; label: Text; value: number | null; caption?: Text; tone?: Tone; url?: string }
  | { type: "status"; label: string; value: Text; tone?: Tone; url?: string; action?: BlockAction }
  | { type: "trend"; label: Text; style: "bar" | "line"; points: { t: string; v: number | null }[]; caption?: Text; url?: string };

export type WidgetPayload = { ok: true; items: { text: string; url?: string; time: string }[]; asOf: string; staleAfter: number; blocks: Block[]; actions: CardAction[] };

/** Rows that are tasks: the first ones before the trend, the rest after it (eight at most, each with its check). */
const ROWS_BEFORE_TREND = 3;
const ROWS_AFTER_TREND = 5;
const TREND_DAYS = 7;
/** The panel refreshes every two minutes; ten without a fresh answer means the service is gone. */
export const STALE_AFTER_S = 600;

/** Where a due date stands against the local clock. */
export function dueState(due: string | null, clock: string): "overdue" | "today" | "later" | "none" {
  if (!due) return "none";
  const today = clock.slice(0, 10);
  const day = due.slice(0, 10);
  if (day < today || (due.length > 10 && due < clock)) return "overdue";
  return day === today ? "today" : "later";
}

/** The due date as the row's text: relative for today and tomorrow, short otherwise. */
function dueText(due: string, clock: string): Text {
  const today = clock.slice(0, 10);
  const day = due.slice(0, 10);
  const time = due.length > 10 ? ` ${due.slice(11, 16)}` : "";
  if (day === today) return { en: `Today${time}`, zh: `今天${time}` };
  if (day === addDays(today, 1)) return { en: `Tomorrow${time}`, zh: `明天${time}` };
  const short = day.slice(0, 4) === today.slice(0, 4) ? day.slice(5) : day;
  return { en: `${short}${time}`, zh: `${short}${time}` };
}

const join = (parts: Text[]): Text => ({ en: parts.map((p) => p.en).join(" · "), zh: parts.map((p) => p.zh).join(" · ") });

function taskRow(t: Todo, clock: string): Block {
  const state = dueState(t.due, clock);
  const parts: Text[] = [];
  if (t.status === "doing") parts.push({ en: "Doing", zh: "进行中" });
  if (state === "overdue") parts.push({ en: `Overdue · ${dueText(t.due!, clock).en}`, zh: `逾期 · ${dueText(t.due!, clock).zh}` });
  else if (t.due) parts.push(dueText(t.due, clock));
  if (t.priority === 3) parts.push({ en: "High", zh: "高优先级" });
  else if (t.priority === 2 && !t.due) parts.push({ en: "Medium", zh: "中优先级" });
  if (!parts.length) parts.push({ en: "No due date", zh: "无截止" });
  return {
    type: "status",
    label: t.title,
    value: join(parts),
    tone: state === "overdue" ? "negative" : state === "today" ? "warning" : "neutral",
    url: `/?todo=${t.id}`,
    action: { id: `${DONE_PREFIX}${t.id}`, kind: "check", label: { en: "Mark done", zh: "标记完成" } },
  };
}

const DONE_PREFIX = "done:";
/** The card's one input: a task titled with what the person typed, as the page's add row makes it in the 全部 view. */
export const ADD_ACTION: CardAction = { id: "add", kind: "input", label: { en: "Add", zh: "添加" }, placeholder: { en: "Add a task…", zh: "添加待办…" } };
/** The page's add row takes 300 characters (`cleanTitle` keeps as many); the widget refuses more instead of cutting. */
export const ADD_MAX = 300;

export type ActionAnswer = { status: number; body: { ok: true; message?: Text; todo?: Todo } | { ok: false; error: string } };
/**
 * POST /api/widget, an action the card declared (ai-space widget interactions v1): body `{ action, value? }`.
 * `done:<id>` finishes the task the way the page's row check does (`change` is the service's `changeTodo`;
 * a task in review is accepted, as the row's check does there); one already done answers ok. `add` creates
 * a task titled `value` with the page's add-row defaults of the 全部 view (no due date, project or tag).
 * `origin` goes into the event (`via: widget`, the caller when ai-space names one).
 */
export function widgetAction(
  db: Database,
  b: Record<string, unknown>,
  deps: { change: (id: number, patch: Patch, src: Source, origin: Record<string, unknown>) => Todo | null; origin: Record<string, unknown> },
): ActionAnswer {
  const action = typeof b.action === "string" ? b.action : "";
  const origin = { via: "widget", ...deps.origin };
  const unknown: ActionAnswer = { status: 400, body: { ok: false, error: "unknown action" } };
  if (action === ADD_ACTION.id) {
    const value = typeof b.value === "string" ? b.value.replace(/\s+/g, " ").trim() : "";
    if (!value) return { status: 400, body: { ok: false, error: "a task needs a title" } };
    if (value.length > ADD_MAX) return { status: 400, body: { ok: false, error: `a title is at most ${ADD_MAX} characters` } };
    const todo = createTodo(db, cleanDraft({ title: value }), "manual", origin);
    return { status: 201, body: { ok: true, message: { en: "Added", zh: "已添加" }, todo } };
  }
  if (action.startsWith(DONE_PREFIX)) {
    const raw = action.slice(DONE_PREFIX.length);
    const id = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
    if (!id) return unknown;
    const todo = getTodo(db, id);
    if (!todo) return { status: 404, body: { ok: false, error: "no such task" } };
    if (todo.status === "done") return { status: 200, body: { ok: true, message: { en: "Already done", zh: "已完成" }, todo } };
    if (todo.status === "dropped") return { status: 409, body: { ok: false, error: "the task was dropped" } };
    const after = todo.status === "review" ? reviewTodo(db, id, "accept", undefined, "manual") : deps.change(id, { status: "done" }, "manual", origin);
    if (!after) return { status: 404, body: { ok: false, error: "no such task" } };
    return { status: 200, body: { ok: true, message: { en: "Done", zh: "已完成" }, todo: after } };
  }
  return unknown;
}

/**
 * Completions per local day over the last `TREND_DAYS` days, from the history: a `done` event is
 * logged on every completion, including subtasks finished with their parent and todos deleted
 * since; a todo finished twice on one day counts once.
 */
export function completionsByDay(db: Database, now: Date, timezone: string): { t: string; v: number }[] {
  const today = localClock(now, timezone).slice(0, 10);
  const days = Array.from({ length: TREND_DAYS }, (_, i) => addDays(today, i - TREND_DAYS + 1));
  // A day's start in any zone is within 14 hours of UTC midnight; filter wide, bucket exactly.
  const since = new Date(Date.parse(`${days[0]}T00:00:00Z`) - 15 * 3600_000).toISOString();
  const rows = db.query("SELECT todo_id, at FROM todo_events WHERE kind = 'done' AND at >= ?").all(since) as { todo_id: number; at: string }[];
  const seen = new Map<string, Set<number>>(days.map((d) => [d, new Set()]));
  for (const r of rows) seen.get(localClock(new Date(r.at), timezone).slice(0, 10))?.add(r.todo_id);
  return days.map((d) => ({ t: d, v: seen.get(d)!.size }));
}

export function widgetPayload(db: Database, opts: { now: Date; timezone: string; publicBase?: string }): WidgetPayload {
  const { now, timezone, publicBase } = opts;
  const active = listTodos(db, { status: "active", limit: 2000 });
  const items = active.slice(0, 20).map((t) => ({
    text: `${t.parentId ? "↳ " : ""}${t.status === "doing" ? "▶ " : ""}${t.priority === 3 ? "‼ " : t.priority === 2 ? "! " : ""}${t.title}${t.due ? ` · ${t.due.replace("T", " ")}` : ""}`,
    url: publicBase ? `${publicBase}/?todo=${t.id}` : undefined,
    time: t.updatedAt,
  }));

  const clock = localClock(now, timezone);
  const overdue = active.filter((t) => dueState(t.due, clock) === "overdue").length;
  const dueToday = active.filter((t) => dueState(t.due, clock) === "today").length;
  const nextDue = active.filter((t) => dueState(t.due, clock) === "later").map((t) => t.due!).sort()[0];
  const open = active.length;

  let caption: Text;
  if (!open) caption = { en: "Nothing open", zh: "清单已清空" };
  else if (overdue) caption = { en: `${overdue} overdue · ${open} open`, zh: `逾期 ${overdue} · 未完成 ${open}` };
  else if (!dueToday && nextDue) {
    const d = dueText(nextDue, clock);
    caption = { en: `${open} open · next due ${d.en}`, zh: `未完成 ${open} · 下个截止 ${d.zh}` };
  } else caption = { en: `${open} open`, zh: `未完成 ${open}` };
  // Finished work waiting for the person is not on the active list; the card still says so.
  const review = countTodos(db, { status: "review" });
  if (review) caption = { en: `${caption.en} · ${review} to accept`, zh: `${caption.zh} · 待验收 ${review}` };
  const reviewRow: Block[] = review ? [{ type: "status", label: "待验收", value: { en: `${review} awaiting acceptance`, zh: `${review} 项等你验收` }, tone: "warning", url: "/?view=review" }] : [];

  const hero: Block = {
    type: "metric",
    label: { en: "Due by today", zh: "今天到期" },
    value: overdue + dueToday,
    caption,
    tone: overdue ? "negative" : dueToday ? "warning" : "neutral",
    url: "/",
  };

  const points = completionsByDay(db, now, timezone);
  const done = points.reduce((s, p) => s + p.v, 0);
  const trend: Block = {
    type: "trend",
    label: { en: "Done, last 7 days", zh: "近 7 天完成" },
    style: "bar",
    points,
    caption: { en: `${done} completed`, zh: `共完成 ${done}` },
  };

  const rows = active.map((t) => taskRow(t, clock));
  const blocks: Block[] = open
    ? [hero, ...reviewRow, ...rows.slice(0, ROWS_BEFORE_TREND), trend, ...rows.slice(ROWS_BEFORE_TREND, ROWS_BEFORE_TREND + ROWS_AFTER_TREND)]
    : done ? [hero, ...reviewRow, trend] : [hero, ...reviewRow];

  return { ok: true, items, asOf: now.toISOString(), staleAfter: STALE_AFTER_S, blocks, actions: [ADD_ACTION] };
}
