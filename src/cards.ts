/**
 * Chat cards (ai-space docs/chat-cards.md): what the CLI just added, as a `::space-card` line ai-space
 * shows under the agent's reply, and the items the `card-state` and `card-undo` capabilities answer.
 * One shape for both, so a card shown again reads as it was printed, except the due date, which is said
 * relative to the day it is read (`明天` on the day it was added is `今天` the next day). Pure: no database, no fetch.
 */
import { dueWords } from "./dates.ts";
import type { Status, Todo } from "./types.ts";

export const CARD_PREFIX = "::space-card ";
/** ai-space shows at most this many items on a card; a longer batch is split into several cards. */
export const CARD_ITEMS = 20;

/** What a card needs of a todo: the service's `Todo` or the CLI's copy of one. */
export type CardTodo = Pick<Todo, "id" | "title" | "due" | "parentId" | "version"> & { priority: number; status: Status | string };

export type CardItem = { id: string; title: string; detail?: string; url: string; version: number };
export type CardItemState = { id: string; status: "active" | "done" | "removed"; title?: string; detail?: string; url?: string; version?: number; changed?: boolean };

const PRIORITY: Record<string, string[]> = { zh: ["", "低", "中", "高"], en: ["", "Low", "Med", "High"] };
const STATUS: Record<string, Partial<Record<Status, string>>> = {
  zh: { doing: "进行中", review: "待验收", deferred: "暂不处理", dropped: "已放弃" },
  en: { doing: "In progress", review: "Awaiting acceptance", deferred: "Deferred", dropped: "Dropped" },
};
const words = (lang: string) => (lang === "en" ? "en" : "zh");

/** When a card is read: `now` and the app zone (`appZone()`), the day its due dates are said against. */
export type CardClock = { now: Date; timezone: string };

/** A todo as a card item: its due date (`dueWords`) and priority as the detail, its page as a path on the app's URL. */
export function cardItem(t: CardTodo, clock: CardClock, lang = "zh"): CardItem {
  const l = words(lang);
  const parts = [t.due ? dueWords(t.due, clock.now, clock.timezone, l) : "", PRIORITY[l]![t.priority], STATUS[l]![t.status as Status], t.parentId ? (l === "zh" ? `#${t.parentId} 的子任务` : `subtask of #${t.parentId}`) : ""].filter(Boolean);
  return { id: String(t.id), title: t.title.slice(0, 300), ...(parts.length ? { detail: parts.join(" · ") } : {}), url: `/?todo=${t.id}`, version: t.version };
}

/** What `card-state` and `card-undo` answer for a todo that is still there. */
export function itemState(t: CardTodo, clock: CardClock, lang = "zh"): CardItemState {
  return { ...cardItem(t, clock, lang), status: t.status === "done" ? "done" : "active" };
}

/** The receipt cards of todos just added, one per CARD_ITEMS, each with its state and undo capabilities. */
export function receiptCards(todos: CardTodo[], clock: CardClock, lang = "zh"): object[] {
  const l = words(lang);
  const cards: object[] = [];
  for (let i = 0; i < todos.length; i += CARD_ITEMS) {
    const chunk = todos.slice(i, i + CARD_ITEMS);
    const subs = chunk.every((t) => t.parentId);
    const title = l === "zh" ? `已添加 ${chunk.length} 条${subs ? "子任务" : "待办"}` : `Added ${chunk.length} ${subs ? "subtask" : "todo"}${chunk.length > 1 ? "s" : ""}`;
    cards.push({ v: 1, kind: "receipt", title, items: chunk.map((t) => cardItem(t, clock, lang)), state: "card-state", actions: { undo: "card-undo" } });
  }
  return cards;
}

/** A card as the line the CLI prints. */
export function cardLine(card: object): string {
  return CARD_PREFIX + JSON.stringify(card);
}
