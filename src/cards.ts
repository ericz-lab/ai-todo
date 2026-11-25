/**
 * Chat cards (ai-space docs/chat-cards.md, version 2 of the contract): what the CLI just added or listed, as
 * `::space-card` lines ai-space shows under the agent's reply, and the items the `card-state` and `card-undo`
 * capabilities answer. One shape for all of them, so a card shown again reads as it was printed, except the
 * due date, which is said relative to the day it is read (`明天` on the day it was added is `今天` the next day).
 * Pure: no database, no fetch.
 *
 * ai-space drops a whole card when one field breaks its rule, so every text here is cut to its limit before it
 * goes out: `when` 40, `value` and a tag's text 24, `title` 300 (an item's) or 200 (the card's), at most 4 tags
 * and 20 items, `date` only as `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` of a real day.
 */
import { dueWords } from "./dates.ts";
import type { Status, Todo } from "./types.ts";

export const CARD_PREFIX = "::space-card ";
/** ai-space shows at most this many items on a card; a longer batch is split into several cards. */
export const CARD_ITEMS = 20;
/** At most this many tags on an item. */
export const CARD_TAGS = 4;

/** What a card needs of a todo: the service's `Todo` or the CLI's copy of one. */
export type CardTodo = Pick<Todo, "id" | "title" | "due" | "parentId" | "version"> & { priority: number; status: Status | string; tags?: string[] };

export type CardTone = "neutral" | "accent" | "positive" | "warning" | "negative";
export type CardTag = { text: string; tone?: CardTone };
/** The structured fields of an item (contract version 2). */
export type CardFields = { when?: string; date?: string; tags?: CardTag[]; value?: string };
export type CardItem = { id: string; title: string; detail?: string; url: string; version?: number } & CardFields;
export type CardItemState = { id: string; status: "active" | "done" | "removed"; title?: string; detail?: string; url?: string; version?: number; changed?: boolean } & CardFields;
export type Card = { v: 1; kind: "receipt" | "list"; style?: "compact" | "stat"; title: string; items: CardItem[]; state?: string; actions?: { undo: string } };

const PRIORITY: Record<string, string[]> = { zh: ["", "低", "中", "高"], en: ["", "Low", "Med", "High"] };
/**
 * A priority's tag tone. The page draws every priority chip in the same ink and gives no level a colour, so only
 * the top level is marked here (red: do it first); low and medium stay neutral, no priority has no tag.
 */
export const PRIORITY_TONE: CardTone[] = ["neutral", "neutral", "neutral", "negative"];
const STATUS: Record<string, Partial<Record<Status, string>>> = {
  zh: { doing: "进行中", review: "待验收", deferred: "暂不处理", dropped: "已放弃" },
  en: { doing: "In progress", review: "Awaiting acceptance", deferred: "Deferred", dropped: "Dropped" },
};
const words = (lang: string | undefined) => (lang === "en" ? "en" : "zh");

/** When a card is read: `now` and the app zone (`appZone()`), the day its due dates are said against. */
export type CardClock = { now: Date; timezone: string };

/**
 * One line of at most `max` UTF-16 units, white space collapsed as ai-space counts it; a longer one is cut
 * with an ellipsis, never through a surrogate pair.
 */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  let cut = t.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/;
/** A due date as the card's `date`: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` of a real day, else undefined. */
export function cardDate(due: string | null | undefined): string | undefined {
  const m = due ? DATE_RE.exec(due) : null;
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return undefined;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return `${m[1]}-${m[2]}-${m[3]}`;
  return m[0];
}

/** The priority as a tag, toned by level; none for priority 0. */
export function priorityTag(priority: number, lang?: string): CardTag | undefined {
  const text = PRIORITY[words(lang)]![priority];
  return text ? { text, tone: PRIORITY_TONE[priority]! } : undefined;
}

/** The due date in words (`when`) and as a date (`date`), said against the day of `clock`. */
function dueFields(t: CardTodo, clock: CardClock, lang: string | undefined): CardFields {
  const date = cardDate(t.due);
  if (!t.due || !date) return {};
  return { when: clip(dueWords(date, clock.now, clock.timezone, words(lang)), 40), date };
}

/** An item's structured fields: the due date, then the priority and the todo's own tags (priority first, at most 4). */
export function cardFields(t: CardTodo, clock: CardClock, lang?: string): CardFields {
  const pri = priorityTag(t.priority, lang);
  const own = (t.tags ?? []).map((x) => clip(x, 24)).filter(Boolean).map((text): CardTag => ({ text, tone: "neutral" }));
  const tags = [...(pri ? [pri] : []), ...own].slice(0, CARD_TAGS);
  return { ...dueFields(t, clock, lang), ...(tags.length ? { tags } : {}) };
}

/** A todo as a receipt item: due and tags as fields, its stage and parent as the detail, its page as a path on the app's URL. */
export function cardItem(t: CardTodo, clock: CardClock, lang?: string): CardItem {
  const l = words(lang);
  const parts = [STATUS[l]![t.status as Status], t.parentId ? (l === "zh" ? `#${t.parentId} 的子任务` : `subtask of #${t.parentId}`) : ""].filter(Boolean);
  return { id: String(t.id), title: clip(t.title, 300), ...(parts.length ? { detail: parts.join(" · ") } : {}), url: `/?todo=${t.id}`, version: t.version, ...cardFields(t, clock, lang) };
}

/** What `card-state` and `card-undo` answer for a todo that is still there: the same item, said against today. */
export function itemState(t: CardTodo, clock: CardClock, lang?: string): CardItemState {
  return { ...cardItem(t, clock, lang), status: t.status === "done" ? "done" : "active" };
}

/** The receipt cards of todos just added, one per CARD_ITEMS, each with its state and undo capabilities; style `rows`. */
export function receiptCards(todos: CardTodo[], clock: CardClock, lang?: string): Card[] {
  const l = words(lang);
  const cards: Card[] = [];
  for (let i = 0; i < todos.length; i += CARD_ITEMS) {
    const chunk = todos.slice(i, i + CARD_ITEMS);
    const subs = chunk.every((t) => t.parentId);
    const title = l === "zh" ? `已添加 ${chunk.length} 条${subs ? "子任务" : "待办"}` : `Added ${chunk.length} ${subs ? "subtask" : "todo"}${chunk.length > 1 ? "s" : ""}`;
    cards.push({ v: 1, kind: "receipt", title, items: chunk.map((t) => cardItem(t, clock, lang)), state: "card-state", actions: { undo: "card-undo" } });
  }
  return cards;
}

/** What a listing asked for: its stage and its filters, as `list` takes them. */
export type ListQuery = { status: "active" | "all" | "done" | "review" | "deferred"; q?: string; tag?: string; project?: string };
const LIST_WORDS: Record<"zh" | "en", Record<ListQuery["status"], string>> = {
  zh: { active: "待办", all: "全部", done: "已完成", review: "待验收", deferred: "暂不处理" },
  en: { active: "Open", all: "All", done: "Done", review: "Awaiting acceptance", deferred: "Deferred" },
};

/** The words of a listing's title: its stage, then the filters (`#tag`, `@project`, “text”). */
export function listWords(q: ListQuery, lang?: string): string {
  const l = words(lang);
  const parts = [LIST_WORDS[l][q.status], q.tag ? `#${clip(q.tag, 30)}` : "", q.project ? `@${clip(q.project, 30)}` : "", q.q ? `“${clip(q.q, 30)}”` : ""].filter(Boolean);
  return parts.join(" ");
}

/** A listed todo as a compact line: the title, its page, the due date, and on the right the due words or else the priority. */
export function listItem(t: CardTodo, clock: CardClock, lang?: string): CardItem {
  const due = dueFields(t, clock, lang);
  const value = due.when ?? PRIORITY[words(lang)]![t.priority];
  return { id: String(t.id), title: clip(t.title, 300), url: `/?todo=${t.id}`, ...due, ...(value ? { value: clip(value, 24) } : {}) };
}

/**
 * The `list` card of a listing (style `compact`), in the listing's order; `total` is how many matched. Over
 * CARD_ITEMS it holds the first ones and its title says so. No card for an empty listing.
 */
export function listCard(todos: CardTodo[], query: ListQuery, total: number, clock: CardClock, lang?: string): Card | null {
  if (!todos.length) return null;
  const l = words(lang);
  const shown = todos.slice(0, CARD_ITEMS);
  const n = Math.max(total, todos.length);
  const head = l === "zh" ? `${listWords(query, lang)} ${n} 条` : `${listWords(query, lang)} · ${n}`;
  const more = n > shown.length ? (l === "zh" ? ` · 显示前 ${shown.length}` : ` · first ${shown.length} shown`) : "";
  return { v: 1, kind: "list", style: "compact", title: clip(head, 200 - more.length) + more, items: shown.map((t) => listItem(t, clock, lang)), state: "card-state" };
}

/** A card as the line the CLI prints. */
export function cardLine(card: object): string {
  return CARD_PREFIX + JSON.stringify(card);
}
