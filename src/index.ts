/**
 * ai-todo service. Contract (ai-space docs/app-spec.md, "service"): read PORT, bind 127.0.0.1
 * only, answer GET /healthz with 200, log to stdout, exit on SIGTERM within 10 seconds.
 *
 * Routes: the page (/), todos (/api/todos…), the AI entry (/api/ai/parse: free text to drafts;
 * /api/todos/:id/execute: one todo carried out by a full-mode agent run, streamed and stored as a run;
 * /api/ai/context, /api/ai/drafts + /api/ai/apply: the chat's context, the drafts and the
 * operations an answer carries),
 * the panel widget (/api/widget), and a proxy of /space/chat/* to ai-space's chat service
 * with the app token, which is where the conversations live and where the chat widget comes from.
 */
import type { Database } from "bun:sqlite";
import { KEY_RE, mimeOfKey, newKey, openStore, sniffImage, type BlobStore } from "./blobs.ts";
import type { RecordImage } from "./types.ts";
import { callerAllowed, envelopeOf, forwarder, machineFinder, readEnvelope, type Envelope, type Machines } from "./remote.ts";
import index from "../web/index.html";
import {
  chatContext, draftsFromAnswer, executeAgentPrompt, executePrompt, extractActions, extractDrafts, modelClient, PARSE_SYSTEM, parsePrompt,
  type ModelClient,
} from "./ai.ts";
import { appZone, config, databasePath } from "./config.ts";
import {
  appendRecord, listRecords, abandonRuns, addEvent, cleanDraft, cleanParent, ConflictError, countTodos, createRun, createTodo, cursorOf, deleteTodo, editRecord, finishRun, getPlanVersion, getRun, getTodo,
  listEvents, listPlanVersions, listRecordRevisions, listRuns, listSubtasks, listTodos, listTodoSummaries, openDb, projectCounts, reorderTodos, reviewTodo, runningRun, setPlan, statusCounts, tagCounts, updateTodo,
} from "./db.ts";
import { STATUSES, type Action, type Draft, type Patch, type Run, type Source, type Status, type Todo } from "./types.ts";
import { widgetPayload } from "./widget.ts";

export interface ServerOptions {
  db: Database;
  blobs?: BlobStore;
  port?: number;
  publicBase?: string;
  /** ai-space's API and this app's token; every AI route answers 502 without them. */
  spaceApiUrl?: string;
  spaceAppToken?: string;
  web?: boolean;
  timezone?: string;
  lang?: string;
  executeTimeoutMs?: number;
  /** Model of an execution (a full-mode agent run); claude/intermediate (opus) when unset. */
  executeModel?: string;
  webTools?: boolean;
  /** A successful execution of an open or doing todo sends it to review (验收); false keeps its status (TODO_AUTO_REVIEW=0). */
  autoReview?: boolean;
  now?: () => Date;
  /** This machine's SPACE_NAME, the peers running ai-todo and how to reach one; absent: this machine only. */
  machine?: string;
  machines?: () => Promise<Machines>;
  forward?: (peer: string, env: Envelope) => Promise<Response>;
}

/** Request headers a proxied call carries to ai-space, and response headers it brings back; never cookies. */
const PROXY_REQUEST_HEADERS = ["content-type", "accept", "content-length", "if-none-match"];
const PROXY_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "content-length"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
const TZ_RE = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/;

/** Answers above this many bytes are gzipped for a caller that accepts it (the done list, the chat context). */
const GZIP_MIN_BYTES = 8 * 1024;
/**
 * A JSON answer. With `req`, a large one is gzipped when the caller's Accept-Encoding allows it: the
 * page reaches this service through a tunnel whose upload is the narrow part, and nothing in between
 * compresses.
 */
const json = (body: unknown, status = 200, req?: Request) => {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (req && text.length >= GZIP_MIN_BYTES / 3 && /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length >= GZIP_MIN_BYTES) return new Response(Bun.gzipSync(bytes), { status, headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" } });
  }
  return new Response(text, { status, headers });
};
const fail = (error: string, status = 400) => json({ ok: false, error }, status);
/** A refused write: 409 with what is stored now when it was based on an older version, else 400. */
const refuse = (e: unknown) => (e instanceof ConflictError ? json({ ok: false, error: e.message, conflict: true, ...e.current }, 409) : fail((e as Error).message));
/** An optional version number from a body: undefined when absent, else a non-negative integer. */
const versionOf = (v: unknown, name: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a version number`);
  return n;
};
/** How much of a plan the `list` capability answers unless asked for the whole text. */
const PLAN_EXCERPT = 300;
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
  const blobs = opts.blobs ?? openStore();
  const now = opts.now ?? (() => new Date());
  const spaceApiUrl = opts.spaceApiUrl ?? "";
  const spaceAppToken = opts.spaceAppToken ?? "";
  const publicBase = opts.publicBase ?? "";
  const lang = opts.lang ?? "zh";
  const defaultTz = opts.timezone ?? appZone();
  const executeTimeoutMs = opts.executeTimeoutMs ?? 600_000;
  const executeModel = opts.executeModel || "claude/intermediate";
  const autoReview = opts.autoReview ?? true;
  const tools = (opts.webTools ?? true) ? WEB_TOOLS : [];
  const model: ModelClient | null = spaceApiUrl && spaceAppToken ? modelClient(spaceApiUrl, spaceAppToken) : null;
  const live = new Map<number, Live>();

  const tz = (v: unknown) => { const s = String(v ?? "").trim(); return s && TZ_RE.test(s) ? s : defaultTz; };
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try { const v = await req.json(); return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; }
  };
  /** A created todo as an action receipt: its id, title, link and due date in the list's zone. */
  const receipt = (t: Todo) => ({ id: t.id, title: t.title, ...(publicBase ? { url: `${publicBase}/?todo=${t.id}` } : {}), ...(t.due ? { detail: `${t.due.replace("T", " ")} (${defaultTz})` } : {}) });
  const idOf = (s: string): number | null => { const n = Number(s); return Number.isInteger(n) && n > 0 ? n : null; };
  /** A call through ai-space's bus (space.yaml `provides`) names the calling app; it goes into the todo's `created` event. */
  const caller = (req: Request): Record<string, unknown> => { const app = req.headers.get("x-space-caller")?.trim().slice(0, 100); return app ? { caller: app } : {}; };
  const source = (v: unknown): Source => (["manual", "ai", "chat", "cli"].includes(String(v)) ? (v as Source) : "manual");
  /**
   * GET /api/todos. `fields=list` answers the lean rows the page draws (no plan, a notes excerpt);
   * `limit` and `before` page the done list (`nextBefore` is the next cursor, null on the last page,
   * `total` how many match). `counts` is the size of every stage, for the sidebar.
   */
  const listBody = (p: URLSearchParams) => {
    const status = (p.get("status") || "active") as Status | "active" | "all";
    if (!["active", "all", ...STATUSES].includes(status)) throw new Error(`status must be active, all or one of ${STATUSES.join(", ")}`);
    const rawLimit = p.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error("limit must be 1..500");
    const before = p.get("before") ?? undefined;
    const filter = { status, q: p.get("q") || undefined, tag: p.get("tag") || undefined, project: p.get("project") || undefined, before };
    const lean = p.get("fields") === "list";
    // One row past the page tells whether there is another.
    const rows = (lean ? listTodoSummaries : listTodos)(db, { ...filter, limit: limit === undefined ? undefined : limit + 1 });
    const more = limit !== undefined && rows.length > limit;
    const todos = more ? rows.slice(0, limit) : rows;
    const scope = status === "deferred" || status === "review" ? status : "active";
    return {
      ok: true, todos,
      ...(limit !== undefined ? { total: countTodos(db, filter), nextBefore: more && status === "done" ? cursorOf(todos.at(-1)!) : null } : {}),
      counts: statusCounts(db),
      tags: tagCounts(db, scope),
      projects: projectCounts(db, scope),
    };
  };

  /** Tell the person a todo waits for their acceptance (ai-space docs/notify.md); never blocks or fails the change. */
  const notifyReview = (t: Todo, src: Source) => {
    if (!spaceApiUrl || !spaceAppToken) return;
    const zh = lang === "zh";
    const body = {
      level: "info",
      title: `${zh ? "待验收" : "Awaiting acceptance"} #${t.id} ${t.title}`.slice(0, 200),
      text: src === "ai" ? (zh ? "AI 执行完成，请查看结果后通过或退回。" : "The AI finished; accept it or send it back.") : (zh ? "已提交验收，请查看后通过或退回。" : "Submitted for acceptance; accept it or send it back."),
      ...(publicBase ? { url: `${publicBase}/?todo=${t.id}` } : {}),
      key: `review:${t.id}`, window: "1m",
    };
    void fetch(`${spaceApiUrl}/api/notify`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${spaceAppToken}` }, body: JSON.stringify(body) })
      .then((r) => { if (!r.ok) log(`notify review #${t.id}: HTTP ${r.status}`); }, (e) => log(`notify review #${t.id}: ${(e as Error).message}`));
  };
  /** Every status change from a request or a run goes through here, so entering review notifies once. */
  const changeTodo = (id: number, patch: Patch, src: Source, origin: Record<string, unknown> = {}): Todo | null => {
    const before = getTodo(db, id);
    const after = updateTodo(db, id, patch, src, origin);
    if (before && after && before.status !== "review" && after.status === "review") notifyReview(after, src);
    return after;
  };

  /** A record from a multipart form (`content`, `source`, up to six `images`): the images go to the blob store first and are removed again when the record is not written. */
  const saveRecord = async (id: number, form: FormData): Promise<Response> => {
    const staged: RecordImage[] = [];
    let committed = false;
    try {
      const raw = form.get("content") ?? "";
      const files = form.getAll("images");
      if (files.length > 6) return fail("at most 6 images per record");
      if (typeof raw !== "string" || raw.length > 20_000) return fail("invalid record content");
      const images = [];
      for (const file of files) {
        if (!(file instanceof File) || !file.size || file.size > 10 * 1024 * 1024) return fail("each image must be between 1 byte and 10 MB", 413);
        const mime = sniffImage(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
        if (!mime) return fail("only PNG, JPEG, GIF and WebP images are supported", 415);
        images.push({ file, mime });
      }
      for (const { file, mime } of images) {
        const key = newKey(`records/${id}`, mime, Date.now());
        staged.push({ key, name: file.name.slice(0, 255), mime, size: file.size });
        await blobs.put(key, file, mime);
      }
      const record = appendRecord(db, id, raw.trim(), source(form.get("source")), staged);
      committed = !!record;
      return record ? json({ ok: true, record }, 201) : fail("no such todo", 404);
    } catch (e) { return fail((e as Error).message); }
    finally { if (!committed) await Promise.allSettled(staged.map(image => blobs.remove(image.key))); }
  };

  /** The latest plan version without its text (the todo carries the text): who wrote it and when. */
  const planMeta = (t: Todo) => { const v = t.planVersion ? getPlanVersion(db, t.id, t.planVersion) : null; return v ? { version: v.version, source: v.source, createdAt: v.createdAt } : null; };
  /** One todo in full: GET /api/todos/:id and the `task` capability. */
  const detail = (todo: Todo) => ({
    ok: true, todo, planMeta: planMeta(todo), parent: todo.parentId ? getTodo(db, todo.parentId) : null,
    ...recordPage(todo.id), subtasks: listSubtasks(db, todo.id), events: listEvents(db, todo.id), runs: listRuns(db, todo.id),
  });
  /** A plan write from a JSON body { content, source?, expectedVersion?, session? }. */
  const writePlan = (id: number, b: Record<string, unknown>, src: Source, origin: Record<string, unknown> = {}): Response => {
    try {
      const r = setPlan(db, id, b.content, src, { expectedVersion: versionOf(b.expectedVersion, "expectedVersion"), session: typeof b.session === "string" ? b.session : undefined, origin });
      if (!r) return fail("no such todo", 404);
      return json({ ok: true, todo: r.todo, planMeta: planMeta(r.todo), merged: r.merged });
    } catch (e) { return refuse(e); }
  };

  const recordPage = (id: number, before?: number) => {
    const rows = listRecords(db, id, 51, before);
    const records = rows.slice(0, 50);
    return { records, recordsNextBefore: rows.length > 50 ? records.at(-1)!.id : null };
  };

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
    // `todo` carries the plan; executePrompt cuts it (and the parent's) to what a prompt can hold.
    const prompt = executePrompt(todo, { now: now(), timezone, lang, extra, parent: todo.parentId ? getTodo(db, todo.parentId) : null, subtasks: listSubtasks(db, todo.id), records: listRecords(db, todo.id, 5) });
    const run = createRun(db, todo.id, prompt, null);
    const l = new Live(run);
    live.set(run.id, l);
    void (async () => {
      let finished: Run;
      try {
        let text = "";
        let ended = false;
        // A full-mode agent run, not a chat answer: the CLI keeps its native context and tools; no `system`, so its own agent instructions stay.
        for await (const ev of model!.stream({ prompt: executeAgentPrompt(prompt), mode: "full", model: executeModel, tag: "execute", timeoutMs: executeTimeoutMs })) {
          if (ev.event === "delta") { text += ev.text; l.text = text; l.emit("delta", { text: ev.text }); }
          else if (ev.event === "done") { ended = true; finished = finishRun(db, run.id, { ok: true, output: ev.text || text, callId: ev.call?.id ?? null, model: ev.call?.model ?? null, costUsd: ev.call?.costUsd ?? null }); }
          else { ended = true; finished = finishRun(db, run.id, { ok: false, output: text, error: ev.error, callId: ev.call?.id ?? null, costUsd: ev.call?.costUsd ?? null }); }
        }
        if (!ended) finished = finishRun(db, run.id, { ok: false, output: text, error: "the stream ended without an answer" });
      } catch (e) {
        finished = finishRun(db, run.id, { ok: false, output: l.text, error: (e as Error).message });
      }
      // A finished run hands the work to the person: open or doing becomes review (验收); a failure changes nothing.
      if (finished!.status === "ok" && autoReview) {
        const current = getTodo(db, todo.id);
        if (current && (current.status === "open" || current.status === "doing")) {
          try { changeTodo(todo.id, { status: "review" }, "ai", { runId: run.id }); } catch (e) { log(`review #${todo.id}: ${(e as Error).message}`); }
        }
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
    const detached = new URL(req.url).searchParams.get("detach") === "1";
    const running = runningRun(db, id);
    if (running) {
      const l = live.get(running.id);
      if (l) return detached ? json({ ok: true, run: l.run }) : streamRun(l, req);
      // A run left over from a crash: close it and go on.
      finishRun(db, running.id, { ok: false, output: "", error: "abandoned: the service restarted" });
    }
    const extra = String(b.extra ?? "").slice(0, 4000);
    const l = startExecution(todo, extra, tz(b.timezone));
    // Detached (a page on another machine, through the bus, which cannot stream): the run, then GET /api/runs/:id.
    return detached ? json({ ok: true, run: l.run }) : streamRun(l, req);
  };

  /** One run as it stands: the text so far while it is in flight, its end once it is over. */
  const runNow = (id: number): Response => {
    const l = live.get(id);
    if (l) return json({ ok: true, run: l.done?.run ?? l.run, text: l.text, done: l.done });
    const run = getRun(db, id);
    if (!run) return fail("no such run", 404);
    return json({ ok: true, run, text: run.output, done: run.status === "running" ? null : { ok: run.status === "ok", run, ...(run.error ? { error: run.error } : {}) } });
  };

  const apply = (actions: Action[], src: Source) => {
    const results: { op: string; id?: number; ok: boolean; error?: string; todo?: Todo | null }[] = [];
    for (const a of actions) {
      try {
        if (a.op === "add") { const { op: _o, ...draft } = a; results.push({ op: a.op, ok: true, todo: createTodo(db, draft, src) }); continue; }
        const before = getTodo(db, a.id);
        if (!before) { results.push({ op: a.op, id: a.id, ok: false, error: "no such todo" }); continue; }
        if (a.op === "record") { appendRecord(db, a.id, a.content, src); results.push({ op: a.op, id: a.id, ok: true, todo: getTodo(db, a.id) }); continue; }
        if (a.op === "plan") { results.push({ op: a.op, id: a.id, ok: true, todo: setPlan(db, a.id, a.content, src, { expectedVersion: a.expectedVersion })!.todo }); continue; }
        if (a.op === "edit-record") {
          const r = editRecord(db, a.id, a.recordId, a.content, src);
          results.push(r ? { op: a.op, id: a.id, ok: true, todo: getTodo(db, a.id) } : { op: a.op, id: a.id, ok: false, error: `no record #${a.recordId} on this todo` });
          continue;
        }
        if (a.op === "delete") { deleteTodo(db, a.id, src); results.push({ op: a.op, id: a.id, ok: true }); continue; }
        // Accepting is `accept`, or `done` on a todo in review; a rejection carries its reason.
        if (a.op === "reject" || a.op === "accept" || (a.op === "done" && before.status === "review")) {
          results.push({ op: a.op, id: a.id, ok: true, todo: reviewTodo(db, a.id, a.op === "reject" ? "reject" : "accept", a.op === "reject" ? a.reason : undefined, src) });
          continue;
        }
        if (a.op === "update" && a.plan !== undefined) setPlan(db, a.id, a.plan, src);
        const patch = a.op === "update" ? (({ op: _o, id: _i, plan: _p, ...rest }) => rest)(a)
          : a.op === "defer" ? { status: "deferred" as const } : a.op === "done" ? { status: "done" as const } : a.op === "start" ? { status: "doing" as const } : a.op === "review" ? { status: "review" as const } : { status: "open" as const };
        results.push({ op: a.op, id: a.id, ok: true, todo: changeTodo(a.id, patch, src) });
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

  const widget = () => widgetPayload(db, { now: now(), timezone: defaultTz, publicBase });

  const machine = opts.machine ?? "";
  const machines = opts.machines ?? (async (): Promise<Machines> => ({ local: machine, peers: [], error: null }));
  let selfPort = 0;

  /** A page request for another machine: `/api/m/<peer>/<route>` goes to that machine's instance through the bus. */
  const viaPeer = async (req: Request & { params: Record<string, string> }): Promise<Response> => {
    const method = req.method.toUpperCase();
    // A write must come from this app's page: a browser names its origin, and it is this host.
    if (method !== "GET") {
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
      try { if (origin && new URL(origin).host !== host) return fail("writes must come from this app's page", 403); } catch { return fail("writes must come from this app's page", 403); }
    }
    const peer = req.params.peer!;
    const { peers } = await machines();
    if (!opts.forward || !peers.includes(peer)) return fail(`no machine ${peer} runs ai-todo`, 404);
    const url = new URL(req.url);
    const rest = url.pathname.slice(`/api/m/${encodeURIComponent(peer)}`.length) + url.search;
    const env = await envelopeOf(req, rest);
    if (env === "too-large") return fail("too large to send to another machine (about 2.9 MB at most)", 413);
    if (!env) return fail("not found", 404);
    return opts.forward(peer, env);
  };

  /** The bus capability `ops`: ai-todo on another space asks for one of this page's routes. */
  const remote = async (req: Request): Promise<Response> => {
    if (!callerAllowed(req.headers.get("x-space-caller"), "ai-todo")) return fail("only ai-todo on another space may call ops", 403);
    let env: Envelope | null = null;
    try { env = readEnvelope(await req.json()); } catch { /* not JSON */ }
    if (!env) return fail("not a route of this page", 404);
    const res = await fetch(`http://127.0.0.1:${selfPort}${env.path}`, {
      method: env.method,
      headers: { ...(env.contentType ? { "content-type": env.contentType } : {}), "accept-encoding": "identity" },
      ...(env.body64 ? { body: Buffer.from(env.body64, "base64") } : {}),
    });
    const headers = new Headers({ "cache-control": "no-store" });
    const type = res.headers.get("content-type");
    if (type) headers.set("content-type", type);
    return new Response(await res.arrayBuffer(), { status: res.status, headers });
  };

  const server = Bun.serve({
    maxRequestBodySize: 61 * 1024 * 1024,
    hostname: "127.0.0.1",
    port: opts.port ?? config.port,
    // A streamed answer can stay quiet during a long think; the keepalive keeps it under this.
    idleTimeout: 255,
    routes: {
      "/": opts.web === false ? () => new Response("no page", { status: 404 }) : index,
      "/healthz": () => new Response("ok"),
      "/icon.png": () => new Response(Bun.file(new URL("../icon.png", import.meta.url).pathname)),
      "/api/widget": (req) => json(widget(), 200, req),
      // The machines this page shows: this one, then the peers running ai-todo (on a hub).
      "/api/machines": async () => json({ ok: true, ...(await machines()) }),
      "/api/m/:peer/*": { GET: viaPeer, POST: viaPeer, PATCH: viaPeer, PUT: viaPeer, DELETE: viaPeer },
      "/api/remote": { POST: remote },

      "/api/todos": {
        GET: (req) => { try { return json(listBody(new URL(req.url).searchParams), 200, req); } catch (e) { return fail((e as Error).message); } },
        POST: async (req) => {
          const b = await body(req);
          try { return json({ ok: true, todo: createTodo(db, cleanDraft(b), source(b.source), caller(req)) }, 201); } catch (e) { return fail((e as Error).message); }
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
            const origin = caller(req);
            const todos = db.transaction(() => drafts.map((d) => createTodo(db, d, source(b.source ?? "ai"), origin)))();
            return json({ ok: true, todos }, 201);
          } catch (e) { return fail((e as Error).message); }
        },
      },
      // The `create` action ai-space's command box and Shortcuts panel run (space.yaml `provides.create.action`).
      // A repeated idempotencyKey answers the todo the first request created, so ai-space can retry a lost answer.
      "/api/capabilities/create": {
        POST: async (req) => {
          const b = await body(req);
          const key = typeof b.idempotencyKey === "string" && b.idempotencyKey.trim() ? b.idempotencyKey.trim().slice(0, 100) : undefined;
          if (key) {
            const seen = db.query("SELECT todo_id FROM todo_events WHERE kind = 'created' AND json_extract(data, '$.idempotencyKey') = ? LIMIT 1").get(key) as { todo_id: number } | null;
            const todo = seen && getTodo(db, seen.todo_id);
            if (todo) return json({ ok: true, items: [receipt(todo)], repeated: true });
          }
          try {
            const due = actionDue(b.dueDate, b.dueTime, b.timezone, defaultTz);
            const todo = createTodo(db, cleanDraft({ title: b.title, notes: b.notes, due }), "manual", { ...caller(req), ...(key ? { idempotencyKey: key } : {}) });
            return json({ ok: true, items: [receipt(todo)] }, 201);
          } catch (e) { return fail((e as Error).message); }
        },
      },
      // `list` for other apps (space.yaml `provides.list`): tasks with their latest records, for a page that
      // shows the list's work elsewhere (product-desk's board). Body { status?, q?, tag?, project?, limit?, records?, plan? }.
      // A plan comes as `planExcerpt` (its first PLAN_EXCERPT characters) unless `plan: true` asks for the text.
      "/api/capabilities/list": {
        POST: async (req) => {
          const b = await body(req);
          const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : undefined);
          const status = str(b.status) ?? "active";
          if (!["active", "all", ...STATUSES].includes(status)) return fail(`status must be active, all or one of ${STATUSES.join(", ")}`);
          const limit = Math.min(Math.max(Number(b.limit) || 200, 1), 500);
          const perTodo = Math.min(Math.max(b.records === undefined || b.records === null ? 5 : Number(b.records) || 0, 0), 20);
          const todos = listTodos(db, { status: status as Status | "active" | "all", q: str(b.q), tag: str(b.tag), project: str(b.project) }).slice(0, limit);
          const fullPlan = b.plan === true;
          return json({ ok: true, todos: todos.map(({ plan, ...t }) => ({ ...t, ...(fullPlan ? { plan } : { planExcerpt: plan.slice(0, PLAN_EXCERPT) }), records: perTodo ? listRecords(db, t.id, perTodo) : [] })) }, 200, req);
        },
      },
      // `task` for other apps (space.yaml `provides.task`): one task in full, by id in the body since a bus call
      // has no path. The same shape as GET /api/todos/:id.
      "/api/capabilities/task": {
        POST: async (req) => {
          const b = await body(req);
          const id = idOf(String(b.id ?? "")); const todo = id && getTodo(db, id);
          if (!todo) return fail("no such todo", 404);
          return json(detail(todo), 200, req);
        },
      },
      // `plan` for other apps (space.yaml `provides.plan`): replace a task's plan, by id in the body.
      // Body { id, content, source? (default ai), expectedVersion? }; a stale expectedVersion answers 409 with the current plan.
      "/api/capabilities/plan": {
        POST: async (req) => {
          const b = await body(req);
          const id = idOf(String(b.id ?? ""));
          if (!id || !getTodo(db, id)) return fail("no such todo", 404);
          return writePlan(id, { ...b, session: undefined }, source(b.source ?? "ai"), caller(req));
        },
      },
      // `status` for other apps (space.yaml `provides.status`): move a task to doing, review or back to open, by id in
      // the body, through changeTodo so entering review notifies once. A task the person closed stays closed (409).
      "/api/capabilities/status": {
        POST: async (req) => {
          const b = await body(req);
          const id = idOf(String(b.id ?? "")); const todo = id && getTodo(db, id);
          if (!id || !todo) return fail("no such todo", 404);
          if (!["doing", "review", "open"].includes(String(b.status))) return fail("status must be doing, review or open");
          if (todo.status === "done" || todo.status === "dropped") return fail(`the task is ${todo.status}`, 409);
          try { return json({ ok: true, todo: changeTodo(id, { status: b.status as Status }, source(b.source ?? "ai"), caller(req)) }); }
          catch (e) { return fail((e as Error).message); }
        },
      },
      // `record` for other apps (space.yaml `provides.record`): a record with images on a task, by id in the body,
      // since a bus call has no path. Multipart { todoId, content?, source?, images[] }; same limits as the page's.
      "/api/capabilities/record": {
        POST: async (req) => {
          const form = await req.formData().catch(() => null);
          if (!form) return fail("a multipart body with todoId is required");
          const id = idOf(String(form.get("todoId") ?? ""));
          if (!id || !getTodo(db, id)) return fail("no such todo", 404);
          return saveRecord(id, form);
        },
      },
      // `capture-image` (space.yaml `provides`): ai-space hands over a screenshot the operator chose to keep as a
      // task. Multipart { file (PNG or JPEG), text?, via?, id? }: the first line of the text is the title
      // ("截图" without one), the rest the notes, and the picture the task's first record. A repeated id
      // answers the task the first call made.
      "/api/capabilities/capture-image": {
        POST: async (req) => {
          const form = await req.formData().catch(() => null);
          const file = form?.get("file");
          if (!form || !(file instanceof File)) return fail("a multipart body with a file is required");
          const rawId = form.get("id");
          const key = typeof rawId === "string" && rawId.trim() ? `capture:${rawId.trim().slice(0, 100)}` : undefined;
          const answer = (t: Todo, status = 201) => json({ ok: true, todo: t, ...(publicBase ? { url: `${publicBase}/?todo=${t.id}` } : {}), label: `${lang === "zh" ? "待办" : "Todo"} #${t.id}` }, status);
          if (key) {
            const seen = db.query("SELECT todo_id FROM todo_events WHERE kind = 'created' AND json_extract(data, '$.idempotencyKey') = ? LIMIT 1").get(key) as { todo_id: number } | null;
            const todo = seen && getTodo(db, seen.todo_id);
            if (todo) return answer(todo, 200);
          }
          const text = String(form.get("text") ?? "").replace(/\r\n?/g, "\n").trim();
          const [first = "", ...rest] = text.split("\n");
          let todo: Todo;
          try {
            todo = createTodo(db, cleanDraft({ title: first.trim().slice(0, 200) || (lang === "zh" ? "截图" : "Screenshot"), notes: rest.join("\n").trim() || undefined }), "manual", { ...caller(req), via: String(form.get("via") ?? "").slice(0, 40) || undefined, ...(key ? { idempotencyKey: key } : {}) });
          } catch (e) { return fail((e as Error).message); }
          const record = new FormData();
          record.append("images", file);
          const saved = await saveRecord(todo.id, record);
          if (!saved.ok) { deleteTodo(db, todo.id); return saved; }
          return answer(getTodo(db, todo.id) ?? todo);
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
          return json(detail(todo), 200, req);
        },
        PATCH: async (req) => {
          const id = idOf(req.params.id); if (!id) return fail("no such todo", 404);
          const b = await body(req);
          try { const todo = changeTodo(id, b, source(b.source)); return todo ? json({ ok: true, todo }) : fail("no such todo", 404); } catch (e) { return fail((e as Error).message); }
        },
        DELETE: (req) => { const id = idOf(req.params.id); return id && deleteTodo(db, id) ? json({ ok: true }) : fail("no such todo", 404); },
      },
      // The person's verdict on a todo in review: { verdict: "accept" | "reject", reason (required to reject), source? }.
      // accept -> done; reject -> the reason as a record, back to doing, a `review-rejected` event. 409 when not in review.
      "/api/todos/:id/review": {
        POST: async (req) => {
          const id = idOf(req.params.id); if (!id) return fail("no such todo", 404);
          const b = await body(req);
          try { const todo = reviewTodo(db, id, b.verdict, b.reason, source(b.source)); return todo ? json({ ok: true, todo }) : fail("no such todo", 404); }
          catch (e) { return refuse(e); }
        },
      },
      "/api/todos/:id/records": {
        GET: (req) => {
          const id = idOf(req.params.id);
          if (!id || !getTodo(db, id)) return fail("no such todo", 404);
          const cursor = new URL(req.url).searchParams.get("before");
          const before = cursor === null ? undefined : idOf(cursor);
          if (before === null) return fail("before must be a positive record id");
          return json({ ok: true, ...recordPage(id, before) });
        },
        POST: async (req) => {
          const id = idOf(req.params.id);
          if (!id || !getTodo(db, id)) return fail("no such todo", 404);
          if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
            const form = await req.formData().catch(() => null);
            if (!form) return fail("invalid multipart body");
            return saveRecord(id, form);
          }
          try {
            const b = await body(req);
            const record = appendRecord(db, id, b.content, source(b.source));
            return record ? json({ ok: true, record }, 201) : fail("no such todo", 404);
          } catch (e) { return fail((e as Error).message); }
        },
      },
      // The plan: PUT { content, source?, expectedVersion?, session? } writes a version (409 when expectedVersion is stale).
      "/api/todos/:id/plan": {
        GET: (req) => { const id = idOf(req.params.id); const todo = id && getTodo(db, id); return todo ? json({ ok: true, plan: todo.plan, planVersion: todo.planVersion, planMeta: planMeta(todo) }) : fail("no such todo", 404); },
        PUT: async (req) => {
          const id = idOf(req.params.id); if (!id) return fail("no such todo", 404);
          const b = await body(req);
          return writePlan(id, b, source(b.source));
        },
      },
      // Every version newest first without text; `?version=n` answers that version in full.
      "/api/todos/:id/plan/versions": {
        GET: (req) => {
          const id = idOf(req.params.id);
          if (!id || !getTodo(db, id)) return fail("no such todo", 404);
          const wanted = new URL(req.url).searchParams.get("version");
          if (wanted === null) return json({ ok: true, versions: listPlanVersions(db, id) });
          const n = Number(wanted); const v = Number.isInteger(n) && n > 0 ? getPlanVersion(db, id, n) : null;
          return v ? json({ ok: true, version: v }) : fail("no such version", 404);
        },
      },
      // Edit a record's text: PATCH { content, source?, expectedRevision? }; the earlier text is kept as a revision.
      "/api/todos/:id/records/:rid": {
        PATCH: async (req) => {
          const id = idOf(req.params.id); const rid = idOf(req.params.rid);
          if (!id || !rid) return fail("no such record", 404);
          const b = await body(req);
          try {
            const record = editRecord(db, id, rid, b.content, source(b.source), versionOf(b.expectedRevision, "expectedRevision"));
            return record ? json({ ok: true, record }) : fail("no such record", 404);
          } catch (e) { return refuse(e); }
        },
      },
      "/api/todos/:id/records/:rid/revisions": {
        GET: (req) => {
          const id = idOf(req.params.id); const rid = idOf(req.params.rid);
          const revisions = id && rid && getTodo(db, id) ? listRecordRevisions(db, id, rid) : null;
          return revisions ? json({ ok: true, revisions }) : fail("no such record", 404);
        },
      },
      "/api/todos/:id/execute": { POST: (req) => { const id = idOf(req.params.id); return id ? execute(req, id) : fail("no such todo", 404); } },
      "/api/todos/:id/runs": { GET: (req) => { const id = idOf(req.params.id); return id ? json({ ok: true, runs: listRuns(db, id) }) : fail("no such todo", 404); } },
      "/api/runs/:id": { GET: (req) => { const id = idOf(req.params.id); return id ? runNow(id) : fail("no such run", 404); } },
      "/api/runs/:id/stream": {
        GET: (req) => { const id = idOf(req.params.id); const l = id ? live.get(id) : undefined; return l ? streamRun(l, req) : fail("that run is not in flight", 404); },
      },

      "/api/ai/parse": { POST: parse },
      "/api/ai/context": {
        GET: (req) => {
          const u = new URL(req.url);
          const todos = listTodos(db, { status: "all", limit: 300 });
          // The list cap must not hide a deferred parent and make its children look active.
          const ids = new Set(todos.map((t) => t.id));
          for (const t of [...todos]) if (t.parentId !== null && !ids.has(t.parentId)) {
            const parent = getTodo(db, t.parentId);
            if (parent) { todos.push(parent); ids.add(parent.id); }
          }
          const records = Object.fromEntries(todos.map((t) => [t.id, listRecords(db, t.id, 3)]));
          const ctx = chatContext(todos, { now: now(), timezone: tz(u.searchParams.get("timezone")), lang, records });
          return json({ ok: true, ...ctx, tools, timeoutMs: 300_000 }, 200, req);
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
      if (req.method === "GET" && url.pathname.startsWith("/blobs/")) {
        const key = url.pathname.slice(7);
        if (!KEY_RE.test(key)) return fail("not found", 404);
        const todoId = Number(key.split("/")[1]);
        if (!getTodo(db, todoId)) return fail("not found", 404);
        const linked = db.query("SELECT 1 FROM todo_records, json_each(todo_records.attachments) image WHERE todo_id = ? AND json_extract(image.value, '$.key') = ?").get(todoId, key);
        if (!linked) return fail("not found", 404);
        const stream = await blobs.stream(key);
        return stream ? new Response(stream, { headers: { "content-type": mimeOfKey(key), "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } }) : fail("not found", 404);
      }
      if (url.pathname.startsWith("/space/chat/")) return proxyChat(req, url.pathname.slice("/space/chat/".length) + url.search);
      return new Response("not found", { status: 404 });
    },
  });

  selfPort = server.port ?? 0;
  return { server, startExecution, live };
}

if (import.meta.main) {
  const db = openDb(databasePath());
  const abandoned = abandonRuns(db);
  if (abandoned) log(`closed ${abandoned} run(s) left running by the last stop`);
  const machine = process.env.SPACE_NAME?.trim() ?? "";
  const machines = machineFinder({ apiUrl: config.spaceApiUrl, app: "ai-todo", local: machine, token: config.spaceAppToken });
  const forward = forwarder({ apiUrl: config.spaceApiUrl, app: "ai-todo", token: config.spaceAppToken });
  const { server } = createServer({
    machine, machines, forward,
    db, port: config.port, publicBase: config.publicBase, spaceApiUrl: config.spaceApiUrl, spaceAppToken: config.spaceAppToken,
    timezone: config.timezone, lang: config.lang, executeTimeoutMs: config.executeTimeoutSec * 1000, executeModel: config.executeModel, webTools: config.web, autoReview: config.autoReview,
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

/**
 * An action's date and time (docs/time.md: a calendar date, a local time and the operator's zone) as this
 * list's due, a wall clock in `listTz`. A bare date stays that date; a time in another zone is moved to
 * the same instant here. A wall clock the zone skips (a clock change) is refused.
 */
export function actionDue(date: unknown, time: unknown, zone: unknown, listTz: string): string | null {
  if (date === undefined || date === null || date === "") {
    if (time) throw new Error("a time needs a date");
    return null;
  }
  const d = String(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`dueDate must be YYYY-MM-DD, got ${d}`);
  if (time === undefined || time === null || time === "") return d;
  const t = String(time);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`dueTime must be HH:MM, got ${t}`);
  const tz = typeof zone === "string" && zone ? zone : listTz;
  if (tz === listTz) return `${d}T${t}`;
  const wall = (at: number, z: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  // The instant whose wall clock in `tz` is d T t: try the zone's offsets around that moment.
  const naive = Date.parse(`${d}T${t}:00Z`);
  for (const probe of [naive, naive - 86_400_000, naive + 86_400_000]) {
    const offset = Date.parse(`${wall(probe, tz)}:00Z`) - probe;
    const at = naive - offset;
    if (wall(at, tz) === `${d}T${t}`) return wall(at, listTz);
  }
  throw new Error(`${d} ${t} does not exist in ${tz}`);
}
