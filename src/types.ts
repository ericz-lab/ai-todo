/** Data model of ai-todo. Dates are local wall-clock strings: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, no zone. */

/**
 * `review` (验收): the work is finished and waits for the person to accept it (then done) or reject it
 * with a reason (back to doing). Like `deferred` it is a stage of its own, not part of the active list.
 */
export type Status = "open" | "doing" | "review" | "deferred" | "done" | "dropped";
/** 0 none, 1 low, 2 medium, 3 high. */
export type Priority = 0 | 1 | 2 | 3;
export type Source = "manual" | "ai" | "chat" | "cli";

export type Todo = {
  id: number;
  title: string;
  notes: string;
  /** The current plan (方案): a Markdown document of how the task is done; its old versions are kept. */
  plan: string;
  /** The plan's version number, 0 for a todo that never had one. */
  planVersion: number;
  status: Status;
  priority: Priority;
  due: string | null;
  tags: string[];
  project: string | null;
  source: Source;
  /** The todo this one is a step of; one level only, a subtask has no subtasks. */
  parentId: number | null;
  /** How many subtasks it has and how many are done; zeros for a todo without any. */
  subtasks: { total: number; done: number };
  position: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
};

/**
 * A todo as the page's list shows it (`GET /api/todos?fields=list`): no plan, no full notes, only
 * the first characters of the notes; the detail (`GET /api/todos/:id`) has the rest.
 */
export type TodoSummary = Omit<Todo, "notes" | "plan" | "position" | "source"> & { notesExcerpt: string };

/** How many todos each stage holds; `active` is what the active list shows (open and doing, not under a deferred parent). */
export type StatusCounts = { active: number; review: number; deferred: number; done: number };

/** What the AI (or the person) proposes before it becomes a todo. */
export type Draft = {
  title: string;
  notes?: string;
  /** The initial plan, stored as version 1. */
  plan?: string;
  due?: string | null;
  priority?: Priority;
  tags?: string[];
  project?: string | null;
  /** Make it a subtask of this todo. */
  parentId?: number | null;
};

export type Patch = Partial<Pick<Todo, "title" | "notes" | "status" | "priority" | "due" | "tags" | "project" | "parentId">>;

/** One line of a todo's history; appended, never rewritten (a typing session extends its own line). */
export type TodoEvent = { id: number; todoId: number; kind: string; data: Record<string, unknown>; at: string };

/** A progress or acceptance note, appended separately from editable task notes; editable, every revision kept. */
export type RecordImage = { key: string; name: string; mime: string; size: number };
export type OperationRecord = {
  attachments?: RecordImage[]; id: number; todoId: number; content: string; source: Source; createdAt: string;
  /** 0 for a record never edited; each edit adds one. */
  revision: number;
  /** When it was last edited; null when never. */
  editedAt: string | null;
};
/** One revision of a record: revision 0 is what was appended, the last one is the current text. */
export type RecordRevision = { recordId: number; revision: number; content: string; attachments: RecordImage[]; source: Source; createdAt: string };
/** One version of a todo's plan, in full. */
export type PlanVersion = { todoId: number; version: number; content: string; source: Source; createdAt: string };

/** One AI execution of a todo. */
export type Run = {
  id: number;
  todoId: number;
  status: "running" | "ok" | "error";
  prompt: string;
  output: string;
  error: string | null;
  callId: number | null;
  model: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
};

/** An operation the chat assistant asks the app to perform. */
export type Action =
  | ({ op: "add" } & Draft)
  | { op: "done" | "reopen" | "delete" | "start" | "defer" | "review" | "accept"; id: number }
  | { op: "reject"; id: number; reason: string }
  | ({ op: "update"; id: number; plan?: string } & Patch)
  | { op: "record"; id: number; content: string }
  | { op: "plan"; id: number; content: string; expectedVersion?: number }
  | { op: "edit-record"; id: number; recordId: number; content: string };

export const STATUSES: Status[] = ["open", "doing", "review", "deferred", "done", "dropped"];
export const PRIORITIES: Priority[] = [0, 1, 2, 3];
export const SOURCES: Source[] = ["manual", "ai", "chat", "cli"];
