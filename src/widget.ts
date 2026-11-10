/**
 * The panel card (`GET /api/widget`, ai-space docs/app-spec.md "Blocks: a state card instead of a
 * list"): the list as `items` for a panel without blocks, and `blocks` for a state card. The hero
 * counts what is due by today, overdue ones coloring it; the rows are the next tasks and the
 * completions of the last seven days; tasks awaiting acceptance (验收) get a row of their own on top and
 * a mention in the caption. Every number is counted from the store, nothing estimated.
 */
import type { Database } from "bun:sqlite";
import { countTodos, listTodos } from "./db.ts";
import type { Todo } from "./types.ts";

type Text = { en: string; zh: string };
type Tone = "positive" | "negative" | "warning" | "neutral";
export type Block =
  | { type: "metric"; label: Text; value: number | null; caption?: Text; tone?: Tone; url?: string }
  | { type: "status"; label: string; value: Text; tone?: Tone; url?: string }
  | { type: "trend"; label: Text; style: "bar" | "line"; points: { t: string; v: number | null }[]; caption?: Text; url?: string };

export type WidgetPayload = { ok: true; items: { text: string; url?: string; time: string }[]; asOf: string; staleAfter: number; blocks: Block[] };

/** Rows that are tasks: the first ones before the trend, the rest after it. */
const ROWS_BEFORE_TREND = 3;
const ROWS_AFTER_TREND = 2;
const TREND_DAYS = 7;
/** The panel refreshes every two minutes; ten without a fresh answer means the service is gone. */
export const STALE_AFTER_S = 600;

/** `now` as a local wall-clock string `YYYY-MM-DDTHH:MM` in `timezone`, the shape `due` is stored in. */
/** One formatter per zone: building an Intl.DateTimeFormat costs far more than using one (the trend reads one per event). */
const clocks = new Map<string, Intl.DateTimeFormat>();
export function localClock(now: Date, timezone: string): string {
  let fmt = clocks.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(timezone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** `YYYY-MM-DD` shifted by `n` calendar days. */
const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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
  };
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

  return { ok: true, items, asOf: now.toISOString(), staleAfter: STALE_AFTER_S, blocks };
}
