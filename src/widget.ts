/**
 * The panel card (`GET /api/widget`, ai-space docs/app-spec.md "Blocks: a state card instead of a
 * list"): the tasks awaiting review (待验收) as `items` for a panel without blocks, and `blocks` for a
 * state card: a hero counting them, a row per task (at most ten) with an Accept check, and the
 * completions of the last seven days. Every number is counted from the store, nothing estimated.
 */
import type { Database } from "bun:sqlite";
import { cleanDraft, createTodo, getTodo, listTodos, reviewTodo } from "./db.ts";
import { addDays, localClock } from "./dates.ts";
import type { Todo } from "./types.ts";

export { localClock };

type Text = { en: string; zh: string };
type Tone = "positive" | "negative" | "warning" | "neutral";
/** A widget action (ai-space widget interactions, v1): block level `check` | `button`, card level `input` | `button`. */
export type BlockAction = { id: string; kind: "check" | "button"; label: Text };
export type CardAction = { id: string; kind: "input" | "button"; label: Text; placeholder?: Text };
export type Block =
  | { type: "metric"; label: Text; value: number | null; caption?: Text; tone?: Tone; url?: string }
  | { type: "status"; label: string; value: Text; tone?: Tone; time?: string; url?: string; action?: BlockAction }
  | { type: "trend"; label: Text; style: "bar" | "line"; points: { t: string; v: number | null }[]; caption?: Text; url?: string };

export type WidgetPayload = { ok: true; items: { text: string; url?: string; time: string }[]; asOf: string; staleAfter: number; blocks: Block[]; actions: CardAction[] };

/** Tasks in review as rows: at most ten, so the hero, the rows and the trend stay within the panel's twelve blocks. */
const REVIEW_ROWS = 10;
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

const join = (parts: Text[]): Text => ({ en: parts.map((p) => p.en).join(" · "), zh: parts.map((p) => p.zh).join(" · ") });

/** The event that put a task into review: the latest `review` event (status changed to review), if any. */
type Entered = { at: string; source: string; via?: string };
function enteredReview(db: Database, id: number): Entered | null {
  const r = db.query("SELECT data, at FROM todo_events WHERE todo_id = ? AND kind = 'review' ORDER BY id DESC LIMIT 1").get(id) as { data: string; at: string } | null;
  if (!r) return null;
  const d = JSON.parse(r.data) as { source?: unknown; via?: unknown };
  return { at: r.at, source: String(d.source ?? ""), ...(typeof d.via === "string" ? { via: d.via } : {}) };
}

/**
 * Who handed the task over, from its `review` event: an AI run (the executor, or the scheduled sweep's),
 * an agent through the chat or the CLI, or the person; then the project, as the page's review row shows it.
 */
function reviewRow(t: Todo, e: Entered | null): Block {
  const parts: Text[] = [];
  if (e?.source === "ai") parts.push(e.via === "sweep" ? { en: "AI finished · sweep", zh: "AI 完成 · 定时清理" } : { en: "AI finished", zh: "AI 完成" });
  else if (e?.source === "chat" || e?.source === "cli") parts.push({ en: "Submitted by an agent", zh: "智能体提交" });
  else if (e?.source === "manual") parts.push({ en: "Submitted", zh: "已提交" });
  else parts.push({ en: "In review", zh: "待验收" });
  if (t.project) parts.push({ en: t.project, zh: t.project });
  return {
    type: "status",
    label: t.title,
    value: join(parts),
    tone: "warning",
    ...(e && !Number.isNaN(Date.parse(e.at)) ? { time: new Date(e.at).toISOString() } : {}),
    url: `/?todo=${t.id}`,
    action: { id: `${DONE_PREFIX}${t.id}`, kind: "check", label: { en: "Accept", zh: "验收通过" } },
  };
}

/** The review list as the page draws it: the server's order, a subtask listed with it drawn under its parent. */
function reviewOrder(list: Todo[]): Todo[] {
  const ids = new Set(list.map((t) => t.id));
  const tops = list.filter((t) => !t.parentId || !ids.has(t.parentId));
  return tops.flatMap((t) => [t, ...list.filter((k) => k.parentId === t.id)]);
}

const DONE_PREFIX = "done:";
/** The card's one input: a task titled with what the person typed, as the page's add row makes it in the 全部 view. */
export const ADD_ACTION: CardAction = { id: "add", kind: "input", label: { en: "Add", zh: "添加" }, placeholder: { en: "Add a task…", zh: "添加待办…" } };
/** The page's add row takes 300 characters (`cleanTitle` keeps as many); the widget refuses more instead of cutting. */
export const ADD_MAX = 300;

export type ActionAnswer = { status: number; body: { ok: true; message?: Text; todo?: Todo } | { ok: false; error: string } };
/**
 * POST /api/widget, an action the card declared (ai-space widget interactions v1): body `{ action, value? }`.
 * `done:<id>` accepts a task in review through `reviewTodo`, as the page's 通过 does; one already done (accepted)
 * answers ok, any other state `not awaiting review` (the card is the review list and completes nothing else).
 * `add` creates a task titled `value` with the page's add-row defaults of the 全部 view (no due date, project or
 * tag). `origin` goes into the created event (`via: widget`, the caller when ai-space names one).
 */
export function widgetAction(db: Database, b: Record<string, unknown>, deps: { origin: Record<string, unknown> }): ActionAnswer {
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
    if (todo.status === "done") return { status: 200, body: { ok: true, message: { en: "Already accepted", zh: "已验收" }, todo } };
    if (todo.status !== "review") return { status: 409, body: { ok: false, error: "not awaiting review" } };
    const after = reviewTodo(db, id, "accept", undefined, "manual");
    if (!after) return { status: 404, body: { ok: false, error: "no such task" } };
    return { status: 200, body: { ok: true, message: { en: "Accepted", zh: "已验收" }, todo: after } };
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
  const review = reviewOrder(listTodos(db, { status: "review", limit: 2000 }));
  const entered = new Map(review.map((t) => [t.id, enteredReview(db, t.id)]));
  const items = review.slice(0, 20).map((t) => {
    const e = entered.get(t.id);
    return { text: t.title, url: publicBase ? `${publicBase}/?todo=${t.id}` : undefined, time: e && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : t.updatedAt };
  });

  const hero: Block = {
    type: "metric",
    label: { en: "Awaiting review", zh: "待验收" },
    value: review.length,
    ...(review.length ? { tone: "warning" as const } : { caption: { en: "Nothing to review", zh: "没有待验收的任务" } }),
    url: "/?view=review",
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

  const rows = review.slice(0, REVIEW_ROWS).map((t) => reviewRow(t, entered.get(t.id) ?? null));
  return { ok: true, items, asOf: now.toISOString(), staleAfter: STALE_AFTER_S, blocks: [hero, ...rows, trend], actions: [ADD_ACTION] };
}
