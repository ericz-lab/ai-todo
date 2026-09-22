/**
 * Everything the AI entry needs: the model-service client, the three prompts (parse free text
 * into drafts, execute one todo, the chat's context) and the readers of what the model sends
 * back (a JSON array of drafts, a fenced `todo-actions` block in a chat answer).
 */
import { cleanDraft, cleanPatch } from "./db.ts";
import type { Action, Draft, Todo } from "./types.ts";

// ---- the model service (docs/model.md)

export type ModelRequest = { prompt: string; system?: string; tag: string; tools?: string[]; thinking?: number; timeoutMs?: number; model?: string };
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

export const EXECUTE_SYSTEM = `You are the executor behind a todo app. A person hands you one task from their list and you do as much of it as a model with the web can honestly do: research, compare, draft, plan, compute, write the text they will send, list the steps they still have to take themselves.
Rules:
- Do the task, do not describe how one would do it. If it asks for a draft, write the draft. If it asks for a decision, make a recommendation with reasons.
- Facts you look up carry their source (a link). Facts you cannot verify are marked as unverified. Never invent names, prices, dates or links.
- Actions only the person can take (pay, send, call, book, sign) are listed under a final heading as a short checklist; say clearly what is done and what is not.
- Answer in the person's language, in Markdown, concise: lead with the result, then the evidence, then the checklist. No preamble.`;

export function executePrompt(todo: Todo, opts: { now: Date; timezone: string; lang: string; extra?: string }): string {
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
  if (opts.extra?.trim()) lines.push("", "Instructions for this run:", opts.extra.trim());
  return lines.join("\n");
}

export const ACTIONS_FENCE = "todo-actions";

export const CHAT_SYSTEM = `You are the assistant inside a todo app. The person's whole list is given to you before the conversation, with ids. Help them plan, prioritise, split, reschedule and clear tasks; answer briefly in their language.
You may change the list. To do so, put one fenced block in your answer, language \`${ACTIONS_FENCE}\`, holding a JSON array of operations; the app applies them and shows the person what changed. Operations:
  {"op":"add","title":"…","due":"YYYY-MM-DD"|"YYYY-MM-DDTHH:MM"|null,"priority":0|1|2|3,"tags":[…],"project":"…"|null,"notes":"…"}
  {"op":"update","id":N, …any of title, notes, due, priority, tags, project…}
  {"op":"done","id":N}   {"op":"start","id":N}   {"op":"reopen","id":N}   {"op":"delete","id":N}
Rules:
- Only ids from the list. Never delete without being asked; prefer done or update.
- Resolve relative dates against the clock given. Never invent a date the person did not imply.
- Outside the block, tell the person in one or two lines what you did or propose; when you only propose, put no block.
- When asked to split a task, add the parts with the same project and tags and mark the original done or update its notes, as fits.`;

/** What the model reads before every chat turn: the list, with ids, grouped by state. */
export function chatContext(todos: Todo[], opts: { now: Date; timezone: string; lang: string }): { system: string; text: string; ack: string } {
  const line = (t: Todo) => {
    const bits = [`#${t.id}`, t.title];
    if (t.due) bits.push(`due ${t.due}`);
    if (t.priority) bits.push(`p${t.priority}`);
    if (t.project) bits.push(`@${t.project}`);
    if (t.tags.length) bits.push(t.tags.map((x) => `#${x}`).join(" "));
    if (t.status === "doing") bits.push("(doing)");
    return `- ${bits.join(" · ")}${t.notes ? `\n  notes: ${t.notes.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
  };
  const active = todos.filter((t) => t.status === "open" || t.status === "doing");
  const done = todos.filter((t) => t.status === "done").slice(0, 15);
  const text = [
    `Clock: ${clockLine(opts.now, opts.timezone)}`,
    `Answer language: ${opts.lang}`,
    "",
    `Open tasks (${active.length}):`,
    active.length ? active.map(line).join("\n") : "- (none)",
    "",
    `Recently done (${done.length}):`,
    done.length ? done.map(line).join("\n") : "- (none)",
  ].join("\n");
  return { system: CHAT_SYSTEM, text, ack: "I have the list. What would you like to do with it?" };
}

/** The operations in a chat answer's `todo-actions` block; none when there is no block. Bad elements are dropped, the rest survive. */
export function extractActions(text: string): { actions: Action[]; rejected: number } {
  const re = new RegExp("```" + ACTIONS_FENCE + "\\s*\\n([\\s\\S]*?)```", "g");
  const actions: Action[] = [];
  let rejected = 0;
  for (const m of text.matchAll(re)) {
    let arr: unknown;
    try { arr = JSON.parse(m[1]!.trim()); } catch { rejected++; continue; }
    if (!Array.isArray(arr)) { rejected++; continue; }
    for (const el of arr) {
      try { actions.push(cleanAction(el)); } catch { rejected++; }
    }
  }
  return { actions: actions.slice(0, 50), rejected };
}

export function cleanAction(v: unknown): Action {
  const a = (v ?? {}) as Record<string, unknown>;
  const op = String(a.op ?? "");
  const id = () => { const n = Number(a.id); if (!Number.isInteger(n) || n <= 0) throw new Error("id required"); return n; };
  switch (op) {
    case "add": return { op, ...cleanDraft(a) };
    case "update": { const { op: _o, id: _i, ...rest } = a; return { op, id: id(), ...cleanPatch(rest) }; }
    case "done": case "start": case "reopen": case "delete": return { op, id: id() };
    default: throw new Error(`unknown op ${op}`);
  }
}

/** A chat answer without its actions block, for display. */
export function stripActions(text: string): string {
  return text.replace(new RegExp("```" + ACTIONS_FENCE + "\\s*\\n[\\s\\S]*?```\\s*", "g"), "").trim();
}
