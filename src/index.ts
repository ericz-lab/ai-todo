/**
 * ai-todo service. Contract (ai-space docs/app-spec.md, "service"): read PORT, bind 127.0.0.1
 * only, answer GET /healthz with 200, log to stdout, exit on SIGTERM within 10 seconds.
 *
 * Routes: the page (/), todos (/api/todos…), the AI entry (/api/ai/parse: free text to drafts;
 * /api/todos/:id/execute: one todo done by the model, streamed and stored as a run;
 * /api/ai/context, /api/ai/drafts + /api/ai/apply: the chat's context, the drafts and the
 * operations an answer carries),
 * the panel widget (/api/widget), and a proxy of /space/chat/* to ai-space's chat service
 * with the app token, which is where the conversations live and where the chat widget comes from.
 */
import type { Database } from "bun:sqlite";
import index from "../web/index.html";
import {
  chatContext, draftsFromAnswer, EXECUTE_SYSTEM, executePrompt, extractActions, extractDrafts, modelClient, PARSE_SYSTEM, parsePrompt,
  type ModelClient,
} from "./ai.ts";
import { config, databasePath } from "./config.ts";
import {
  abandonRuns, addEvent, cleanDraft, cleanParent, createRun, createTodo, deleteTodo, finishRun, getTodo, listEvents, listRuns, listSubtasks, listTodos,
  openDb, projectCounts, reorderTodos, runningRun, tagCounts, updateTodo,
} from "./db.ts";
import type { Action, Draft, Run, Source, Status, Todo } from "./types.ts";

export interface ServerOptions {
  db: Database;
  port?: number;
  publicBase?: string;
  /** ai-space's API and this app's token; every AI route answers 502 without them. */
  spaceApiUrl?: string;
  spaceAppToken?: string;
  web?: boolean;
  timezone?: string;
  lang?: string;
  executeTimeoutMs?: number;
  webTools?: boolean;
  now?: () => Date;
}

/** Request headers a proxied call carries to ai-space, and response headers it brings back; never cookies. */
const PROXY_REQUEST_HEADERS = ["content-type", "accept", "content-length", "if-none-match"];
const PROXY_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "content-length"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);
const log = (msg: string) => console.log(`[ai-todo] ${new Date().toISOString()} ${msg}`);

/** One execution in flight: the text so far and whoever is watching; the model call outlives the page. */
class Live {
  text = "";
  done: { ok: boolean; run: Run; error?: string } | null = null;
  private listeners = new Set<(e: { event: string; data: unknown }) => void>();
  constructor(public run: Run) {}
  emit(event: string, data: unknown) { for (const l of this.listeners) l({ event, data }); }
  subscribe(l: (e: { event: string; data: unknown }) => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export function createServer(opts: ServerOptions) {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const spaceApiUrl = opts.spaceApiUrl ?? "";
  const spaceAppToken = opts.spaceAppToken ?? "";
  const publicBase = opts.publicBase ?? "";
  const lang = opts.lang ?? "zh";
  const defaultTz = opts.timezone ?? "Asia/Shanghai";
  const executeTimeoutMs = opts.executeTimeoutMs ?? 600_000;
  const tools = (opts.webTools ?? true) ? WEB_TOOLS : [];
  const model: ModelClient | null = spaceApiUrl && spaceAppToken ? modelClient(spaceApiUrl, spaceAppToken) : null;
  const live = new Map<number, Live>();

  const tz = (v: unknown) => { const s = String(v ?? "").trim(); return s && TZ_RE.test(s) ? s : defaultTz; };
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try { const v = await req.json(); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
  };
  const idOf = (s: string): number | null => { const n = Number(s); return Number.isInteger(n) && n > 0 ? n : null; };
  const source = (v: unknown): Source => (["manual", "ai", "chat", "cli"].includes(String(v)) ? (v as Source) : "manual");
  const listBody = (status: string | null, q: string | null, tag: string | null, project: string | null) => ({
    ok: true,
    todos: listTodos(db, { status: (status as Status | "active" | "all") || "active", q: q || undefined, tag: tag || undefined, project: project || undefined }),
    tags: tagCounts(db),
    projects: projectCounts(db),
  });

  // ---- the AI entry

  const parse = async (req: Request): Promise<Response> => {
    if (!model) return fail("the AI is not configured (SPACE_API_URL, SPACE_APP_TOKEN)", 502);
    const b = await body(req);
    const text = String(b.text ?? "").trim();
    if (!text) return fail("text is required");
    if (text.length > 20_000) return fail("text is too long (20000 characters)", 413);
    const prompt = parsePrompt(text, { now: now(), timezone: tz(b.timezone), tags: tagCounts(db).map((x) => x.tag), projects: projectCounts(db).map((x) => x.project), lang });
    const r = await model.run({ prompt, system: PARSE_SYSTEM, tag: "parse", thinking: 0, timeoutMs: 120_000 });
    if (!r.ok) return json({ ok: false, error: r.error, call: r.call }, 502);
    let drafts: Draft[];
    try { drafts = draftsFromAnswer(r.text); } catch (e) { return json({ ok: false, error: (e as Error).message, raw: r.text.slice(0, 2000), call: r.call }, 502); }
    log(`parse: ${text.length} chars -> ${drafts.length} drafts`);
    return json({ ok: true, drafts, call: r.call });
  };

  /** Start the model on a todo; the run is stored first and finished whatever the page does. */
  const startExecution = (todo: Todo, extra: string, timezone: string): Live => {
    const prompt = executePrompt(todo, { now: now(), timezone, lang, extra, parent: todo.parentId ? getTodo(db, todo.parentId) : null, subtasks: listSubtasks(db, todo.id) });
    const run = createRun(db, todo.id, prompt, null);
    const l = new Live(run);
    live.set(run.id, l);
    void (async () => {
      let finished: Run;
      try {
        let text = "";
        let ended = false;
        for await (const ev of model!.stream({ prompt, system: EXECUTE_SYSTEM, tag: "execute", tools, timeoutMs: executeTimeoutMs })) {
          if (ev.event === "delta") { text += ev.text; l.text = text; l.emit("delta", { text: ev.text }); }
          else if (ev.event === "done") { ended = true; finished = finishRun(db, run.id, { ok: true, output: ev.text || text, callId: ev.call?.id ?? null, model: ev.call?.model ?? null, costUsd: ev.call?.costUsd ?? null }); }
          else { ended = true; finished = finishRun(db, run.id, { ok: false, output: text, error: ev.error, callId: ev.call?.id ?? null, costUsd: ev.call?.costUsd ?? null }); }
        }
        if (!ended) finished = finishRun(db, run.id, { ok: false, output: text, error: "the stream ended without an answer" });
      } catch (e) {
        finished = finishRun(db, run.id, { ok: false, output: l.text, error: (e as Error).message });
      }
      l.run = finished!;
      l.done = { ok: finished!.status === "ok", run: finished!, error: finished!.error ?? undefined };
      l.emit(l.done.ok ? "done" : "error", { ok: l.done.ok, run: finished!, error: l.done.error });
      log(`execute #${todo.id} run ${run.id}: ${finished!.status}${finished!.error ? ` (${finished!.error})` : ""} ${finished!.output.length} chars`);
      setTimeout(() => live.delete(run.id), 60_000).unref();
    })();
    return l;
  };

  /** The run as server-sent events: what has arrived, then the rest as it comes, then done or error. */
  const streamRun = (l: Live, req: Request): Response => {
    const enc = new TextEncoder();
    let unsubscribe = () => {};
    let keepalive: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (event: string, data: unknown) => { try { c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* closed */ } };
        send("run", { run: l.run });
        if (l.text) send("delta", { text: l.text });
        if (l.done) { send(l.done.ok ? "done" : "error", { ok: l.done.ok, run: l.done.run, error: l.done.error }); c.close(); return; }
        keepalive = setInterval(() => { try { c.enqueue(enc.encode(": keepalive\n\n")); } catch { /* closed */ } }, 15_000);
        unsubscribe = l.subscribe(({ event, data }) => {
          send(event, data);
          if (event === "done" || event === "error") { clearInterval(keepalive); try { c.close(); } catch { /* closed */ } }
        });
        req.signal.addEventListener("abort", () => { unsubscribe(); clearInterval(keepalive); try { c.close(); } catch { /* closed */ } });
      },
      cancel() { unsubscribe(); clearInterval(keepalive); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  };

  const execute = async (req: Request, id: number): Promise<Response> => {
    if (!model) return fail("the AI is not configured (SPACE_API_URL, SPACE_APP_TOKEN)", 502);
    const todo = getTodo(db, id);
    if (!todo) return fail("no such todo", 404);
    const b = await body(req);
    const running = runningRun(db, id);
    if (running) {
      const l = live.get(running.id);
      if (l) return streamRun(l, req);
      // A run left over from a crash: close it and go on.
      finishRun(db, running.id, { ok: false, output: "", error: "abandoned: the service restarted" });
    }
    const extra = String(b.extra ?? "").slice(0, 4000);
    return streamRun(startExecution(todo, extra, tz(b.timezone)), req);
  };

  const apply = (actions: Action[], src: Source) => {
    const results: { op: string; id?: number; ok: boolean; error?: string; todo?: Todo | null }[] = [];
    for (const a of actions) {
      try {
        if (a.op === "add") { const { op: _o, ...draft } = a; results.push({ op: a.op, ok: true, todo: createTodo(db, draft, src) }); continue; }
        const before = getTodo(db, a.id);
        if (!before) { results.push({ op: a.op, id: a.id, ok: false, error: "no such todo" }); continue; }
        if (a.op === "delete") { deleteTodo(db, a.id, src); results.push({ op: a.op, id: a.id, ok: true }); continue; }
        const patch = a.op === "update" ? (({ op: _o, id: _i, ...rest }) => rest)(a)
          : a.op === "done" ? { status: "done" as const } : a.op === "start" ? { status: "doing" as const } : { status: "open" as const };
        results.push({ op: a.op, id: a.id, ok: true, todo: updateTodo(db, a.id, patch, src) });
      } catch (e) {
        results.push({ op: a.op, id: "id" in a ? a.id : undefined, ok: false, error: (e as Error).message });
      }
    }
    return results;
  };

  /** One call to ai-space's chat service on the app's behalf: `/space/chat/<rest>` → `/api/chat/<rest>`, streaming both ways. */
  const proxyChat = async (req: Request, rest: string): Promise<Response> => {
    if (!spaceApiUrl || !spaceAppToken) return fail("the chat service is not configured (SPACE_API_URL, SPACE_APP_TOKEN)", 502);
    const headers = new Headers({ authorization: `Bearer ${spaceAppToken}` });
    for (const h of PROXY_REQUEST_HEADERS) if (req.headers.has(h)) headers.set(h, req.headers.get(h)!);
    let up: Response;
    try {
      // Bun drops a connection idle for five minutes; a turn may stay quiet longer while the model thinks.
      up = await fetch(`${spaceApiUrl}/api/chat/${rest}`, { method: req.method, headers, body: req.body, signal: req.signal, timeout: false } as RequestInit);
    } catch (e) {
      return fail(`ai-space unreachable: ${(e as Error).message}`, 502);
    }
    const out = new Headers();
    for (const h of PROXY_RESPONSE_HEADERS) if (up.headers.has(h)) out.set(h, up.headers.get(h)!);
    return new Response(up.body, { status: up.status, headers: out });
  };

  const widget = () => {
    const todos = listTodos(db, { status: "active", limit: 20 });
    const items = todos.map((t) => ({
      text: `${t.parentId ? "↳ " : ""}${t.status === "doing" ? "▶ " : ""}${t.priority === 3 ? "‼ " : t.priority === 2 ? "! " : ""}${t.title}${t.due ? ` · ${t.due.replace("T", " ")}` : ""}`,
      url: publicBase ? `${publicBase}/?todo=${t.id}` : undefined,
      time: t.updatedAt,
    }));
    return { ok: true, items };
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? config.port,
    // A streamed answer can stay quiet during a long think; the keepalive keeps it under this.
    idleTimeout: 255,
    routes: {
      "/": opts.web === false ? () => new Response("no page", { status: 404 }) : index,
      "/healthz": () => new Response("ok"),
      "/icon.svg": () => new Response(Bun.file(new URL("../icon.svg", import.meta.url).pathname)),
      "/api/widget": () => json(widget()),

      "/api/todos": {
        GET: (req) => { const u = new URL(req.url); return json(listBody(u.searchParams.get("status"), u.searchParams.get("q"), u.searchParams.get("tag"), u.searchParams.get("project"))); },
        POST: async (req) => {
          const b = await body(req);
          try { return json({ ok: true, todo: createTodo(db, cleanDraft(b), source(b.source)) }, 201); } catch (e) { return fail((e as Error).message); }
        },
      },
      "/api/todos/bulk": {
        POST: async (req) => {
          const b = await body(req);
          const list = Array.isArray(b.drafts) ? b.drafts : [];
          if (!list.length) return fail("drafts is required");
          if (list.length > 50) return fail("at most 50 drafts at once");
          try {
            // `parentId` at the top makes every draft without its own a subtask of that todo.
            const parentId = cleanParent(b.parentId);
            const drafts = list.map(cleanDraft).map((d) => (parentId && !d.parentId ? { ...d, parentId } : d));
            const todos = db.transaction(() => drafts.map((d) => createTodo(db, d, source(b.source ?? "ai"))))();
            return json({ ok: true, todos }, 201);
          } catch (e) { return fail((e as Error).message); }
        },
      },
      "/api/todos/reorder": {
        POST: async (req) => {
          const b = await body(req);
          const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
          if (!ids.length) return fail("ids is required");
          reorderTodos(db, ids);
          return json({ ok: true });
        },
      },
      "/api/todos/:id": {
        GET: (req) => {
          const id = idOf(req.params.id); const todo = id && getTodo(db, id);
          if (!todo) return fail("no such todo", 404);
          const parent = todo.parentId ? getTodo(db, todo.parentId) : null;
          return json({ ok: true, todo, parent, subtasks: listSubtasks(db, todo.id), events: listEvents(db, todo.id), runs: listRuns(db, todo.id) });
        },
        PATCH: async (req) => {
          const id = idOf(req.params.id); if (!id) return fail("no such todo", 404);
          const b = await body(req);
          try { const todo = updateTodo(db, id, b, source(b.source)); return todo ? json({ ok: true, todo }) : fail("no such todo", 404); } catch (e) { return fail((e as Error).message); }
        },
        DELETE: (req) => { const id = idOf(req.params.id); return id && deleteTodo(db, id) ? json({ ok: true }) : fail("no such todo", 404); },
      },
      "/api/todos/:id/execute": { POST: (req) => { const id = idOf(req.params.id); return id ? execute(req, id) : fail("no such todo", 404); } },
      "/api/todos/:id/runs": { GET: (req) => { const id = idOf(req.params.id); return id ? json({ ok: true, runs: listRuns(db, id) }) : fail("no such todo", 404); } },
      "/api/runs/:id/stream": {
        GET: (req) => { const id = idOf(req.params.id); const l = id ? live.get(id) : undefined; return l ? streamRun(l, req) : fail("that run is not in flight", 404); },
      },

      "/api/ai/parse": { POST: parse },
      "/api/ai/context": {
        GET: (req) => {
          const u = new URL(req.url);
          const ctx = chatContext(listTodos(db, { status: "all", limit: 300 }), { now: now(), timezone: tz(u.searchParams.get("timezone")), lang });
          return json({ ok: true, ...ctx, tools, timeoutMs: 300_000 });
        },
      },
      // The drafts in a chat answer, cleaned, for the page to preview; adding them is POST /api/todos/bulk.
      "/api/ai/drafts": {
        POST: async (req) => {
          const b = await body(req);
          if (typeof b.text !== "string") return fail("text is required");
          return json({ ok: true, ...extractDrafts(b.text) });
        },
      },
      "/api/ai/apply": {
        POST: async (req) => {
          const b = await body(req);
          const src = source(b.source ?? "chat");
          let actions: Action[]; let rejected = 0;
          if (typeof b.text === "string") ({ actions, rejected } = extractActions(b.text));
          else if (Array.isArray(b.actions)) ({ actions, rejected } = extractActions("```todo-actions\n" + JSON.stringify(b.actions) + "\n```"));
          else return fail("actions or text is required");
          const results = apply(actions, src);
          if (results.length) log(`apply (${src}): ${results.filter((r) => r.ok).length}/${results.length} ok, ${rejected} rejected`);
          return json({ ok: true, results, rejected });
        },
      },
    },
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/space/chat/")) return proxyChat(req, url.pathname.slice("/space/chat/".length) + url.search);
      return new Response("not found", { status: 404 });
    },
  });

  return { server, startExecution, live };
}

if (import.meta.main) {
  const db = openDb(databasePath());
  const abandoned = abandonRuns(db);
  if (abandoned) log(`closed ${abandoned} run(s) left running by the last stop`);
  const { server } = createServer({
    db, port: config.port, publicBase: config.publicBase, spaceApiUrl: config.spaceApiUrl, spaceAppToken: config.spaceAppToken,
    timezone: config.timezone, lang: config.lang, executeTimeoutMs: config.executeTimeoutSec * 1000, webTools: config.web,
  });
  log(`listening on http://127.0.0.1:${server.port} (db ${databasePath()}, ai ${config.spaceApiUrl ? "on" : "off"})`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      log(`${signal}, shutting down`);
      server.stop();
      setTimeout(() => process.exit(0), 8_000).unref();
    });
  }
}
