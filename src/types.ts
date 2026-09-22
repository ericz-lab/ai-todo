/** Data model of ai-todo. Dates are local wall-clock strings: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, no zone. */

export type Status = "open" | "doing" | "done" | "dropped";
/** 0 none, 1 low, 2 medium, 3 high. */
export type Priority = 0 | 1 | 2 | 3;
export type Source = "manual" | "ai" | "chat" | "cli";

export type Todo = {
  id: number;
  title: string;
  notes: string;
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

/** What the AI (or the person) proposes before it becomes a todo. */
export type Draft = {
  title: string;
  notes?: string;
  due?: string | null;
  priority?: Priority;
  tags?: string[];
  project?: string | null;
  /** Make it a subtask of this todo. */
  parentId?: number | null;
};

export type Patch = Partial<Pick<Todo, "title" | "notes" | "status" | "priority" | "due" | "tags" | "project" | "parentId">>;

/** One line of a todo's history; appended, never rewritten. */
export type TodoEvent = { id: number; todoId: number; kind: string; data: Record<string, unknown>; at: string };

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
  | { op: "done" | "reopen" | "delete" | "start"; id: number }
  | ({ op: "update"; id: number } & Patch);

export const STATUSES: Status[] = ["open", "doing", "done", "dropped"];
export const PRIORITIES: Priority[] = [0, 1, 2, 3];
export const SOURCES: Source[] = ["manual", "ai", "chat", "cli"];
