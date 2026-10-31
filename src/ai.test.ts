import { describe, expect, test } from "bun:test";
import { CHAT_SYSTEM, chatContext, clockLine, draftsFromAnswer, extractActions, extractDrafts, extractJsonArray, parsePrompt, stripBlocks } from "./ai.ts";
import type { Todo } from "./types.ts";

describe("parse answers", () => {
  test("a bare array, a fenced one, and one inside a sentence", () => {
    expect(extractJsonArray('[{"title":"a"}]')).toEqual([{ title: "a" }]);
    expect(extractJsonArray('```json\n[{"title":"a"}]\n```')).toEqual([{ title: "a" }]);
    expect(extractJsonArray('Here you go: [{"title":"a"}] done.')).toEqual([{ title: "a" }]);
    expect(() => extractJsonArray("no tasks")).toThrow();
  });
  test("bad elements are dropped, good ones cleaned", () => {
    const d = draftsFromAnswer('[{"title":"发周报","due":"2026-09-23T15:00","priority":3,"tags":["#工作"]},{"title":""},{"title":"订机票","due":"周五"}]');
    expect(d).toEqual([{ title: "发周报", notes: "", due: "2026-09-23T15:00", priority: 3, tags: ["工作"], project: null }]);
  });
  test("the clock carries the weekday and the zone", () => {
    expect(clockLine(new Date("2026-09-22T02:30:00Z"), "Asia/Shanghai")).toBe("2026-09-22T10:30 (Tuesday, Asia/Shanghai)");
    expect(parsePrompt("明天开会", { now: new Date("2026-09-22T02:30:00Z"), timezone: "Asia/Shanghai", tags: ["工作"], projects: [], lang: "zh" })).toContain("Known tags: 工作");
  });
});

describe("chat actions", () => {
  test("a block is read, cleaned, and stripped for display", () => {
    const text = '好的，我加了两项。\n\n```todo-actions\n[{"op":"add","title":"买菜","due":"2026-09-23"},{"op":"done","id":3},{"op":"update","id":4,"priority":3},{"op":"fly","id":1},{"op":"delete"}]\n```\n';
    const { actions, rejected } = extractActions(text);
    expect(actions).toEqual([
      { op: "add", title: "买菜", notes: "", due: "2026-09-23", priority: 0, tags: [], project: null },
      { op: "done", id: 3 },
      { op: "update", id: 4, priority: 3 },
    ]);
    expect(rejected).toBe(2);
    expect(stripBlocks(text)).toBe("好的，我加了两项。");
    expect(extractActions("no block").actions).toEqual([]);
  });
  test("a drafts block is read like a parse answer; an answer without one says so", () => {
    const text = '这些是我看到的任务：\n\n```todo-drafts\n[{"title":"发周报给老板","due":"2026-09-23T15:00","priority":2,"tags":["#工作"]},{"title":""}]\n```';
    expect(extractDrafts(text)).toEqual({ drafts: [{ title: "发周报给老板", notes: "", due: "2026-09-23T15:00", priority: 2, tags: ["工作"], project: null }], rejected: 1, found: true });
    expect(stripBlocks(text)).toBe("这些是我看到的任务：");
    expect(extractDrafts("今天先做 #3。").found).toBe(false);
  });
  test("the context lists open tasks with ids and the recent done", () => {
    const t = (id: number, status: Todo["status"], due: string | null = null): Todo => ({ id, title: `t${id}`, notes: "", plan: "", planVersion: 0, status, priority: 0, due, tags: [], project: null, source: "manual", parentId: null, subtasks: { total: 0, done: 0 }, position: id, createdAt: "", updatedAt: "", doneAt: null });
    const ctx = chatContext([t(1, "open", "2026-09-23"), t(2, "doing"), t(3, "done")], { now: new Date("2026-09-22T02:30:00Z"), timezone: "Asia/Shanghai", lang: "zh" });
    expect(ctx.text).toContain("Open tasks (2)");
    expect(ctx.text).toContain("- #1 · t1 · due 2026-09-23");
    expect(ctx.text).toContain("- #2 · t2 · (doing)");
    expect(ctx.text).toContain("Recently done (1)");
    expect(ctx.system).toContain("todo-actions");
    expect(ctx.system).toContain("todo-drafts");
  });
  test("the chat prompt creates todos by default and researches only when asked", () => {
    expect(CHAT_SYSTEM).toContain("Do not research");
    expect(CHAT_SYSTEM).toContain("explicitly asks for it now");
    expect(CHAT_SYSTEM).toContain("create the todo (case 1)");
  });
});

test("deferred tasks and hidden children stay out of the active chat plan", () => {
  const t = (id: number, status: Todo["status"], parentId: number | null = null): Todo => ({ id, title: `t${id}`, notes: "", plan: "", planVersion: 0, status, priority: 0, due: null, tags: [], project: null, source: "manual", parentId, subtasks: { total: 0, done: 0 }, position: id, createdAt: "", updatedAt: "", doneAt: null });
  const ctx = chatContext([t(1, "deferred"), t(2, "doing", 1), t(3, "open")], { now: new Date("2026-10-08T00:00:00Z"), timezone: "Asia/Seoul", lang: "zh" });
  const active = ctx.text.split("Open tasks (1):")[1]!.split("Deferred tasks")[0]!;
  expect(active).toContain("#3");
  expect(active).not.toContain("#1");
  expect(active).not.toContain("#2");
  expect(ctx.text).toContain("Deferred tasks — exclude from daily plans (2)");
  expect(ctx.text).toContain("subtask of #1");
  expect(extractActions('```todo-actions\n[{"op":"defer","id":1},{"op":"reopen","id":1}]\n```').actions).toEqual([{ op: "defer", id: 1 }, { op: "reopen", id: 1 }]);
});
