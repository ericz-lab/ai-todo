/**
 * Everything the AI entry needs: the model-service client, the three prompts (parse free text
 * into drafts, execute one todo, the chat's context) and the readers of what the model sends
 * back (a JSON array of drafts, a fenced `todo-actions` block in a chat answer).
 */
import { cleanDraft, cleanPatch, cleanPlan, cleanReason, cleanRecord } from "./db.ts";
import type { Action, Draft, Todo, OperationRecord } from "./types.ts";

// ---- the model service (docs/model.md)

/** `mode`: slim is a bare completion; full keeps the CLI's native agent context and tools (ai-space docs/model-tiers-and-modes.md). */
export type ModelRequest = { prompt: string; system?: string; tag: string; tools?: string[]; thinking?: number; timeoutMs?: number; model?: string; mode?: "slim" | "full" };
export type ModelCall = { id: number; model?: string; backend?: string; costUsd?: number | null; durationMs?: number };
export type ModelResult = { ok: true; text: string; call?: ModelCall } | { ok: false; error: string; call?: ModelCall };
export type ModelEvent = { event: "delta"; text: string } | { event: "done"; text: string; call?: ModelCall } | { event: "error"; error: string; call?: ModelCall };

export type ModelClient = {
  run(req: ModelRequest): Promise<ModelResult>;
  /** The same call as server-sent events; the `done` (or `error`) event is always the last. */
  stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
};

export function modelClient(apiUrl: string, token: string): ModelClient {
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const body = (req: ModelRequest, stream: boolean) => JSON.stringify({ ...req, model: req.model || undefined, stream });
  return {
    async run(req) {
      let res: Response;
      try {
        // Bun drops a connection idle for five minutes; a non-streamed call sends nothing until it answers.
        res = await fetch(`${apiUrl}/api/model/run`, { method: "POST", headers, body: body(req, false), timeout: false } as RequestInit);
      } catch (e) {
        return { ok: false, error: `ai-space unreachable: ${(e as Error).message}` };
      }
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string; call?: ModelCall };
      if (!res.ok || !out.ok) return { ok: false, error: out.error ?? `HTTP ${res.status}`, call: out.call };
      return { ok: true, text: out.text ?? "", call: out.call };
    },
    async *stream(req, signal) {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/api/model/run`, { method: "POST", headers, body: body(req, true), signal, timeout: false } as RequestInit);
      } catch (e) {
        yield { event: "error", error: `ai-space unreachable: ${(e as Error).message}` };
        return;
      }
      if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
        const out = (await res.json().catch(() => ({}))) as { error?: string; call?: ModelCall };
        yield { event: "error", error: out.error ?? `HTTP ${res.status}`, call: out.call };
        return;
      }
      for await (const { event, data } of readSse(res.body!)) {
        const d = JSON.parse(data) as { text?: string; error?: string; call?: ModelCall };
        if (event === "delta") yield { event, text: d.text ?? "" };
        else if (event === "done") { yield { event, text: d.text ?? "", call: d.call }; return; }
        else if (event === "error") { yield { event, error: d.error ?? "model failed", call: d.call }; return; }
      }
      yield { event: "error", error: "the stream ended without an answer" };
    },
  };
}

/** Server-sent events from a body: `event:` and `data:` lines per blank-line block; comments skipped. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = "message"; const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

// ---- prompts

/** The clock the model reasons with: local wall time of the person, with the weekday, so "明天" and "周五" resolve. */
export function clockLine(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long" }).formatToParts(now);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === "24" ? "00" : p.hour}:${p.minute} (${p.weekday}, ${timezone})`;
}

export const PARSE_SYSTEM = `You turn a person's free text into todo items. Answer with a JSON array only, no prose, no code fence.
Each element: {"title": string, "notes": string, "due": "YYYY-MM-DD" | "YYYY-MM-DDTHH:MM" | null, "priority": 0|1|2|3, "tags": string[], "project": string | null}.
Rules:
- One element per distinct task. A line that is not a task (a greeting, a question) yields nothing; an empty array is a valid answer.
- title: short, imperative, in the person's language; keep the essential object ("发周报给老板", not "周报"). Do not repeat the date or the tags in it.
- due: resolve relative dates ("明天", "周五", "下周一", "月底", "3 天后") against the clock given; a bare date with no time is "YYYY-MM-DD"; a time of day gives "YYYY-MM-DDTHH:MM"; nothing said means null. Never invent a date.
- priority: 3 only for words like 紧急/ASAP/must; 2 for 重要/尽快; 1 for 有空/顺便; else 0.
- tags: words marked with # and clear categories the text implies (购物, 出差, 家庭); reuse the known tags when they fit; keep them short; no #.
- project: the known project the task belongs to, or a project the text names; else null.
- notes: details the title does not carry (links, amounts, names, sub-steps as lines); "" when none.`;

export function parsePrompt(text: string, opts: { now: Date; timezone: string; tags: string[]; projects: string[]; lang: string }): string {
  return [
    `Clock: ${clockLine(opts.now, opts.timezone)}`,
    `Known tags: ${opts.tags.length ? opts.tags.join(", ") : "(none)"}`,
    `Known projects: ${opts.projects.length ? opts.projects.join(", ") : "(none)"}`,
    `Answer language for titles and notes: ${opts.lang}`,
    "",
    "Text:",
    text.trim(),
  ].join("\n");
}

/** The JSON array in a model answer, tolerant of a code fence or a sentence around it. */
export function extractJsonArray(text: string): unknown[] {
  const s = text.trim();
  const candidates = [s, s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")];
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i >= 0 && j > i) candidates.push(s.slice(i, j + 1));
  for (const c of candidates) {
    try { const v = JSON.parse(c); if (Array.isArray(v)) return v; } catch { /* next */ }
  }
  throw new Error("the model did not answer with a JSON array");
}

/** Drafts from a parse answer; an element that is not a usable task is dropped, the rest survive. */
export function draftsFromAnswer(text: string): Draft[] {
  const out: Draft[] = [];
  for (const el of extractJsonArray(text)) {
    try { out.push(cleanDraft(el)); } catch { /* skip the bad element */ }
  }
  return out.slice(0, 50);
}

/**
 * The executor's brief. The run is a full-mode agent (the CLI with its native tools), so the brief
 * goes at the head of the prompt instead of `system`: a `system` would replace the agent's own
 * base instructions.
 */
export const EXECUTE_SYSTEM = `You are the executor behind a todo app, running as a full agent with your native tools. A person hands you one task from their list: carry it out as far as you honestly can (research, compare, draft, plan, compute, inspect or change what the task names, write the text they will send) and list the steps they still have to take themselves.
Rules:
- Do the task, do not describe how one would do it. If it asks for a draft, write the draft. If it asks for a decision, make a recommendation with reasons.
- Stay inside the task: change nothing it does not ask for, and nothing irreversible (deleting data, sending messages, spending money, publishing) unless the task or the run's instructions say so explicitly.
- Facts you look up carry their source (a link or a path). Facts you cannot verify are marked as unverified. Never invent names, prices, dates or links.
- Actions only the person can take (pay, send, call, book, sign) are listed under a final heading as a short checklist; say clearly what is done and what is not.
- Your final answer is the run's report: in the person's language, in Markdown, concise: lead with the result, then the evidence (what you did and checked), then the checklist. No preamble.`;

/** What the full-mode agent reads: the brief, then the task. */
export const executeAgentPrompt = (task: string) => `${EXECUTE_SYSTEM}\n\n---\n\n${task}`;

export function executePrompt(todo: Todo, opts: { now: Date; timezone: string; lang: string; extra?: string; parent?: Todo | null; subtasks?: Todo[]; records?: OperationRecord[] }): string {
  const lines = [
    `Clock: ${clockLine(opts.now, opts.timezone)}`,
    `Answer language: ${opts.lang}`,
    "",
    `Task: ${todo.title}`,
  ];
  if (todo.due) lines.push(`Due: ${todo.due}`);
  if (todo.priority) lines.push(`Priority: ${["", "low", "medium", "high"][todo.priority]}`);
  if (todo.project) lines.push(`Project: ${todo.project}`);
  if (todo.tags.length) lines.push(`Tags: ${todo.tags.join(", ")}`);
  if (todo.notes) lines.push("", "Notes from the person:", todo.notes);
  if (todo.plan) lines.push("", `Plan (v${todo.planVersion}, the current design; follow it unless told otherwise):`, clip(todo.plan, PLAN_PROMPT_CHARS));
  if (opts.parent) lines.push("", `This is one step of the larger task: ${opts.parent.title}${opts.parent.notes ? `\nIts notes: ${opts.parent.notes.slice(0, 1000)}` : ""}${opts.parent.plan ? `\nIts plan (excerpt): ${clip(opts.parent.plan, 1000)}` : ""}`);
  if (opts.subtasks?.length) lines.push("", "Its steps (subtasks):", ...opts.subtasks.map((s) => `- [${s.status === "done" ? "x" : " "}] ${s.title}`));
  if (todo.status === "review") lines.push("", "This task is awaiting the person's acceptance; a rejection reason may be in the records below.");
  if (opts.records?.length) lines.push("", "Recent operation records (newest first; older entries may be omitted):", ...opts.records.map((r) => `[${r.createdAt}, ${r.source}] ${r.content.slice(0, 4000)}`));
  if (opts.extra?.trim()) lines.push("", "Instructions for this run:", opts.extra.trim());
  return lines.join("\n");
}

/** How much of a plan the executor reads; the rest is cut with a note saying so. */
export const PLAN_PROMPT_CHARS = 8000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[… cut at ${n} of ${s.length} characters]` : s);

export const ACTIONS_FENCE = "todo-actions";
export const DRAFTS_FENCE = "todo-drafts";

export const CHAT_SYSTEM = `You are the single AI entry of a todo app. The person's whole list is given to you before the conversation, with ids. Every message is one of three things; decide which and answer accordingly, briefly, in the person's language.
A message may carry images (a screenshot, a photo of a note or a whiteboard, a chat): read them and treat what they show as part of the message; a picture of things to do is case 1, with the details it shows in the drafts. Never invent what an image does not show.
You manage the list; you do not do the work. Act on the message as written: create, change or answer about todos, straight away. Do not research: no web search, no fetching pages, no looking things up, no working out how a task is done before recording it. A task that is itself research ("调研一下 X", "查查 Y 的价格", "研究下怎么做 Z") is a todo to create, not something to do now. Search or research only when the person explicitly asks for it now ("先调研一下再建", "现在帮我查一下"); then do just that and keep it short. When in doubt between creating a todo and anything else, create the todo (case 1).

1. THINGS TO DO. The message is a note of tasks ("明天下午三点前发周报，周五订机票 #出差", a pasted list, a meeting note). Turn it into drafts: one fenced block, language \`${DRAFTS_FENCE}\`, holding a JSON array; the app shows the drafts for the person to check and add. Say nothing else, or one short line at most. Never add these yourself.
   Draft: {"title": string, "notes": string, "due": "YYYY-MM-DD" | "YYYY-MM-DDTHH:MM" | null, "priority": 0|1|2|3, "tags": string[], "project": string | null, "parentId"?: N}
   - One draft per distinct task. title: short, imperative, keeps the essential object ("发周报给老板", not "周报"); no date or tags repeated in it.
   - due: resolve relative dates ("明天", "周五", "下周一", "月底", "3 天后") against the clock given; a bare day is "YYYY-MM-DD"; a time of day gives "YYYY-MM-DDTHH:MM"; nothing said means null. Never invent a date.
   - priority: 3 only for 紧急/ASAP/must; 2 for 重要/尽快; 1 for 有空/顺便; else 0.
   - tags: words marked with # and clear categories the text implies; reuse the known tags when they fit; no #. project: a known project it belongs to, else null. notes: details the title does not carry; "" when none.
   - A task already on the list (same thing, by meaning) is not drafted again; mention it with its id instead.
   - parentId: only when the person says the new items are steps of a task on the list; that task's id.

2. A CHANGE TO THE LIST ("把明天的都推到周五", "3 完成了", "把年终总结拆成三步", "删掉那条买牛奶"). Do it: one fenced block, language \`${ACTIONS_FENCE}\`, holding a JSON array of operations; the app applies them and shows the person what changed. Outside the block, one or two lines saying what you did. Operations:
   {"op":"add","title":"…","due":…,"priority":…,"tags":[…],"project":…,"notes":"…","parentId":N}  (same fields as a draft; parentId makes it a subtask)
   {"op":"update","id":N, …any of title, notes, due, priority, tags, project, parentId…}  (parentId null takes a subtask out of its parent)
   {"op":"defer","id":N}   {"op":"done","id":N}   {"op":"start","id":N}   {"op":"reopen","id":N}   {"op":"delete","id":N}
   {"op":"review","id":N}  (work finished: hand it to the person for acceptance, 验收)   {"op":"accept","id":N}   {"op":"reject","id":N,"reason":"…"}
   {"op":"record","id":N,"content":"…"}  (append progress, actions taken or acceptance results; never replace notes for these)
   {"op":"plan","id":N,"content":"…","expectedVersion":V}  (replace the task's plan (方案) with this whole Markdown text; V is the version the list shows, so a plan changed meanwhile is not overwritten)
   {"op":"edit-record","id":N,"recordId":R,"content":"…"}  (rewrite operation record R of task N)
   - The plan holds the design and how the task is done: it is one living document, rewritten as a whole and always the latest; earlier versions are kept. Progress, actions taken and acceptance results go into records, never into the plan. Notes stay the short description.
   - The list shows only the start of a plan; never rewrite a plan you have not seen in full (ask the person, or leave it), and keep what the person wrote in it.
   - Operation records are appended. Edit one only to correct a fact in it (a wrong id, a typo, a wrong number), never to change what was concluded at the time: append a new record for that. The earlier text is kept. Distinguish verified facts from unverified claims.
   - "暂不处理" uses defer; "恢复待办" uses reopen. Deferred tasks and unfinished children of deferred parents are excluded from daily plans unless explicitly requested. Deferring keeps dates and child statuses; reopening a parent makes its active children visible again.
   - Review (验收): finished work waits for the person. When you (or another agent) finished a task that was being done, use review, not done; only the person closes it. "通过/验收通过" on a task awaiting acceptance is accept (done does the same); "退回/不通过" is reject with the person's reason, which is kept as a record and sends the task back to doing. Reject only with a reason the person gave.
   - Only ids from the list. Never delete without being asked; prefer done or update.
   - Subtasks go one level deep: a task listed under another (↳) cannot have its own, and a task with subtasks cannot become one. Marking a task done also finishes its unfinished subtasks, including deferred ones; deleting it deletes them.
   - Splitting a task ("拆成三步", "拆分"): add each part as a subtask with "parentId" set to the original's id, keeping its project and tags; leave the original open.
   - When the request is ambiguous (which task? which day?), ask instead and put no block.

3. A QUESTION OR A PLAN ("今天先做什么", "这周压着什么", "帮我安排一下"). Answer from the list only (no research): short, concrete, ids or titles, ordered. Tasks awaiting acceptance are not work to do: list them separately as 需要你验收. No block.

Never put both blocks in one answer. Dates outside a block are written as the person would say them.`;

/** What the model reads before every chat turn: the list, with ids, grouped by state. */
export function chatContext(todos: Todo[], opts: { now: Date; timezone: string; lang: string; records?: Record<number, OperationRecord[]> }): { system: string; text: string; ack: string } {
  const line = (t: Todo) => {
    const bits = [`#${t.id}`, t.title];
    if (t.due) bits.push(`due ${t.due}`);
    if (t.priority) bits.push(`p${t.priority}`);
    if (t.project) bits.push(`@${t.project}`);
    if (t.tags.length) bits.push(t.tags.map((x) => `#${x}`).join(" "));
    if (t.status === "doing") bits.push("(doing)");
    const records = opts.records?.[t.id] ?? [];
    const history = records.length ? "\n  Recent operation records (newest first, excerpts):\n" + records.map((r) => `    [${r.createdAt}, ${r.source}] ${r.content.replace(/\s+/g, " ").slice(0, 500)}`).join("\n") : "";
    const plan = t.plan ? `\n  plan (v${t.planVersion}, excerpt; full text via the task's detail): ${t.plan.replace(/\s+/g, " ").slice(0, 200)}` : "";
    return `- ${bits.join(" · ")}${t.notes ? `\n  notes: ${t.notes.replace(/\s+/g, " ").slice(0, 200)}` : ""}${plan}${history}`;
  };
  const deferredIds = new Set(todos.filter((t) => t.status === "deferred").map((t) => t.id));
  const deferred = todos.filter((t) => t.status === "deferred" || ((t.status === "open" || t.status === "doing") && t.parentId !== null && deferredIds.has(t.parentId)));
  const hiddenIds = new Set(deferred.map((t) => t.id));
  const active = todos.filter((t) => (t.status === "open" || t.status === "doing") && !hiddenIds.has(t.id));
  const review = todos.filter((t) => t.status === "review");
  const done = todos.filter((t) => t.status === "done").slice(0, 15);
  // Subtasks follow their parent, indented; one whose parent is not open says whose step it is.
  const openIds = new Set(active.map((t) => t.id));
  const tree = active.filter((t) => t.parentId === null || !openIds.has(t.parentId)).flatMap((t) => [
    line(t) + (t.parentId ? ` (subtask of #${t.parentId})` : t.subtasks.total ? ` (${t.subtasks.done}/${t.subtasks.total} subtasks done)` : ""),
    ...active.filter((s) => s.parentId === t.id).map((s) => "  " + line(s).replace(/^- /, "↳ ")),
  ]);
  const text = [
    `Clock: ${clockLine(opts.now, opts.timezone)}`,
    `Answer language: ${opts.lang}`,
    "",
    `Open tasks (${active.length}):`,
    tree.length ? tree.join("\n") : "- (none)",
    "",
    `Awaiting your acceptance (${review.length}) — finished work the person accepts or rejects, not work to do:`,
    review.length ? review.map((t) => line(t) + (t.parentId ? ` (subtask of #${t.parentId})` : "")).join("\n") : "- (none)",
    "",
    `Deferred tasks — exclude from daily plans (${deferred.length}):`,
    deferred.length ? deferred.map((t) => line(t) + (t.parentId ? ` (subtask of #${t.parentId})` : "")).join("\n") : "- (none)",
    "",
    `Recently done (${done.length}):`,
    done.length ? done.map(line).join("\n") : "- (none)",
  ].join("\n");
  return { system: CHAT_SYSTEM, text, ack: "I have the list. Tell me what to do, what to add, or ask about it." };
}

/** The elements of every fenced JSON array of the given language in a chat answer, cleaned one by one; bad ones are counted, the rest survive. */
function extractFenced<T>(text: string, fence: string, clean: (el: unknown) => T): { items: T[]; rejected: number; found: boolean } {
  const re = new RegExp("```" + fence + "[ \\t]*\\r?\\n([\\s\\S]*?)```", "g");
  const items: T[] = [];
  let rejected = 0;
  let found = false;
  for (const m of text.matchAll(re)) {
    found = true;
    let arr: unknown;
    try { arr = JSON.parse(m[1]!.trim()); } catch { rejected++; continue; }
    if (!Array.isArray(arr)) { rejected++; continue; }
    for (const el of arr) {
      try { items.push(clean(el)); } catch { rejected++; }
    }
  }
  return { items: items.slice(0, 50), rejected, found };
}

/** The operations in a chat answer's `todo-actions` block; none when there is no block. */
export function extractActions(text: string): { actions: Action[]; rejected: number } {
  const { items, rejected } = extractFenced(text, ACTIONS_FENCE, cleanAction);
  return { actions: items, rejected };
}

/** The drafts in a chat answer's `todo-drafts` block; `found` tells a block from an answer without one. */
export function extractDrafts(text: string): { drafts: Draft[]; rejected: number; found: boolean } {
  const { items, rejected, found } = extractFenced(text, DRAFTS_FENCE, cleanDraft);
  return { drafts: items, rejected, found };
}

export function cleanAction(v: unknown): Action {
  const a = (v ?? {}) as Record<string, unknown>;
  const op = String(a.op ?? "");
  const id = () => { const n = Number(a.id); if (!Number.isInteger(n) || n <= 0) throw new Error("id required"); return n; };
  switch (op) {
    case "record": return { op, id: id(), content: cleanRecord(a.content) };
    case "plan": {
      const v = a.expectedVersion;
      if (v !== undefined && v !== null && (!Number.isInteger(v) || (v as number) < 0)) throw new Error("expectedVersion must be a version number");
      return { op, id: id(), content: cleanPlan(a.content), ...(typeof v === "number" ? { expectedVersion: v } : {}) };
    }
    case "edit-record": {
      const r = Number(a.recordId);
      if (!Number.isInteger(r) || r <= 0) throw new Error("recordId required");
      return { op, id: id(), recordId: r, content: cleanRecord(a.content) };
    }
    case "add": return { op, ...cleanDraft(a) };
    case "update": {
      const { op: _o, id: _i, plan, ...rest } = a;
      return { op, id: id(), ...cleanPatch(rest), ...(plan !== undefined ? { plan: cleanPlan(plan) } : {}) };
    }
    case "done": case "start": case "reopen": case "delete": case "defer": case "review": case "accept": return { op, id: id() };
    case "reject": return { op, id: id(), reason: cleanReason(a.reason) };
    default: throw new Error(`unknown op ${op}`);
  }
}

/** A chat answer without its blocks, for display. */
export function stripBlocks(text: string): string {
  return text.replace(new RegExp("```(?:" + ACTIONS_FENCE + "|" + DRAFTS_FENCE + ")[ \\t]*\\r?\\n[\\s\\S]*?```\\s*", "g"), "").trim();
}
