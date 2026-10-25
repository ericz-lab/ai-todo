import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { chatContext, cleanAction, executePrompt } from "./ai.ts";
import {
  cleanStatus, ConflictError, countTodos, createTodo, cursorOf, getTodo, listEvents, listRecords, listTodos, listTodoSummaries, openDb, reviewTodo, statusCounts, updateTodo,
} from "./db.ts";
import { createServer } from "./index.ts";
import type { Todo, TodoSummary } from "./types.ts";
import { widgetPayload } from "./widget.ts";

describe("review (验收) in the store", () => {
  test("review is a status of its own, outside the active list, counted on its own", () => {
    const db = openDb(":memory:");
    expect(cleanStatus("review")).toBe("review");
    const a = createTodo(db, { title: "a" });
    const b = createTodo(db, { title: "b" });
    updateTodo(db, b.id, { status: "review" });
    const d = createTodo(db, { title: "d" });
    updateTodo(db, d.id, { status: "done" });
    expect(listTodos(db).map((t) => t.id)).toEqual([a.id]);
    expect(listTodos(db, { status: "review" }).map((t) => t.id)).toEqual([b.id]);
    expect(getTodo(db, b.id)!.doneAt).toBeNull();
    expect(statusCounts(db)).toEqual({ active: 1, review: 1, deferred: 0, done: 1 });
    // In the full list, finished work waiting for the person comes right after what is being done.
    updateTodo(db, a.id, { status: "doing" });
    expect(listTodos(db, { status: "all" }).map((t) => t.status)).toEqual(["doing", "review", "done"]);
  });

  test("accept closes the todo and its unfinished subtasks; reject needs a reason, keeps it as a record and goes back to doing", () => {
    const db = openDb(":memory:");
    const parent = createTodo(db, { title: "parent" });
    const step = createTodo(db, { title: "step", parentId: parent.id });
    updateTodo(db, step.id, { status: "review" });
    updateTodo(db, parent.id, { status: "review" }, "ai", { runId: 7 });
    expect(listEvents(db, parent.id)[0]).toMatchObject({ kind: "review", data: { source: "ai", runId: 7 } });

    expect(() => reviewTodo(db, parent.id, "reject", "  ")).toThrow("reason");
    expect(() => reviewTodo(db, parent.id, "maybe", "")).toThrow("verdict");
    const back = reviewTodo(db, parent.id, "reject", "缺少测试", "manual")!;
    expect(back.status).toBe("doing");
    const [record] = listRecords(db, parent.id);
    expect(record!.content).toBe("验收不通过：缺少测试");
    expect(listEvents(db, parent.id)[0]).toMatchObject({ kind: "review-rejected", data: { source: "manual", reason: "缺少测试", recordId: record!.id } });
    // Not in review any more: a second verdict is a conflict, nothing changes.
    expect(() => reviewTodo(db, parent.id, "accept", undefined)).toThrow(ConflictError);

    updateTodo(db, parent.id, { status: "review" });
    const done = reviewTodo(db, parent.id, "accept", undefined, "manual")!;
    expect(done.status).toBe("done");
    expect(done.doneAt).not.toBeNull();
    expect(getTodo(db, step.id)!.status).toBe("done");   // a step in review is finished with its parent
    expect(listEvents(db, parent.id)[0]).toMatchObject({ kind: "done", data: { verdict: "accept" } });
    expect(reviewTodo(db, 999, "accept", undefined)).toBeNull();
  });
});

describe("the done list, paged", () => {
  const seed = (db: Database, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = createTodo(db, { title: `done ${i}`, notes: `第 ${i} 条\n\n${"很长的备注 ".repeat(100)}` });
      updateTodo(db, t.id, { status: "done" });
      // Distinct finish times, plus a tie on the last two to exercise the id tie-break.
      db.query("UPDATE todos SET done_at = ? WHERE id = ?").run(new Date(Date.UTC(2026, 9, 1, 0, Math.min(i, n - 2))).toISOString(), t.id);
    }
  };
  test("summaries carry an excerpt of the notes and no plan", () => {
    const db = openDb(":memory:");
    createTodo(db, { title: "x", notes: "a\n\n  b   c" + "d".repeat(500), plan: "the plan" });
    const [s] = listTodoSummaries(db) as (TodoSummary & Record<string, unknown>)[];
    expect(s!.notesExcerpt.startsWith("a b cddd")).toBe(true);
    expect(s!.notesExcerpt.length).toBe(120);
    for (const k of ["notes", "plan", "position", "source"]) expect(s).not.toHaveProperty(k);
    expect(s).toMatchObject({ title: "x", planVersion: 1, subtasks: { total: 0, done: 0 } });
  });
  test("keyset pages: newest finished first, stable, no repeats, a null cursor at the end", () => {
    const db = openDb(":memory:");
    seed(db, 23);
    const all = listTodos(db, { status: "done" });
    expect(all.map((t) => t.doneAt)).toEqual([...all.map((t) => t.doneAt)].sort().reverse());
    const seen: number[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = listTodoSummaries(db, { status: "done", limit: 11, before });
      const more = rows.length > 10;
      seen.push(...rows.slice(0, 10).map((t) => t.id));
      if (!more) break;
      before = cursorOf(rows[9]!);
      // A todo finished meanwhile lands on top and does not shift the pages after it.
      if (page === 0) { const t = createTodo(db, { title: "new" }); updateTodo(db, t.id, { status: "done" }); }
    }
    expect(seen).toEqual(all.map((t) => t.id));
    expect(new Set(seen).size).toBe(23);
    expect(countTodos(db, { status: "done" })).toBe(24);
    expect(() => listTodos(db, { status: "done", before: "yesterday" })).toThrow("before");
    expect(() => listTodos(db, { status: "open", before: cursorOf(all[0]!) })).toThrow("done list");
    const plan = db.query("EXPLAIN QUERY PLAN SELECT id FROM todos WHERE status = 'done' ORDER BY done_at DESC, id DESC LIMIT 51").all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("todos_done");
  });
});

describe("review through the service", () => {
  const notified: Record<string, unknown>[] = [];
  let failRun = false;
  const space = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (url.pathname === "/api/notify") { notified.push({ ...body, auth: req.headers.get("authorization") }); return Response.json({ ok: true }, { status: 202 }); }
      if (url.pathname === "/api/model/run" && body.stream) {
        const text = failRun ? 'event: error\ndata: {"error":"quota"}\n\n' : 'event: done\ndata: {"ok":true,"text":"做完了","call":{"id":5}}\n\n';
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ ok: true });
    },
  });
  let db: Database;
  let base = "";
  let stop = () => {};
  beforeAll(() => {
    db = openDb(":memory:");
    const { server } = createServer({ db, port: 0, web: false, publicBase: "https://todo.test", spaceApiUrl: `http://127.0.0.1:${space.port}`, spaceAppToken: "sat_todo" });
    base = `http://127.0.0.1:${server.port}`;
    stop = () => server.stop(true);
  });
  afterAll(() => { stop(); space.stop(true); });
  const j = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST", headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { todo?: Todo; todos?: Todo[] } };
  };
  const execute = async (id: number) => { await (await fetch(`${base}/api/todos/${id}/execute`, { method: "POST", body: "{}" })).text(); };
  const until = async (ok: () => boolean) => { for (let i = 0; i < 50 && !ok(); i++) await Bun.sleep(10); };

  test("a successful run sends doing and open todos to review and notifies; a failed run changes nothing", async () => {
    const doing = (await j("/api/todos", { title: "做中" })).body.todo!;
    await j(`/api/todos/${doing.id}`, { status: "doing" }, "PATCH");
    await execute(doing.id);
    expect(getTodo(db, doing.id)!.status).toBe("review");
    expect(listEvents(db, doing.id)[0]).toMatchObject({ kind: "review", data: { source: "ai", runId: expect.any(Number) } });
    await until(() => notified.length > 0);
    expect(notified[0]).toMatchObject({ level: "info", title: `待验收 #${doing.id} 做中`, url: `https://todo.test/?todo=${doing.id}`, key: `review:${doing.id}`, auth: "Bearer sat_todo" });

    const open = (await j("/api/todos", { title: "未开始" })).body.todo!;
    await execute(open.id);
    expect(getTodo(db, open.id)!.status).toBe("review");

    failRun = true;
    const other = (await j("/api/todos", { title: "失败" })).body.todo!;
    await execute(other.id);
    failRun = false;
    expect(getTodo(db, other.id)!.status).toBe("open");

    // Executing a todo already in review leaves it there; nothing is notified twice.
    const before = notified.length;
    await execute(doing.id);
    expect(getTodo(db, doing.id)!.status).toBe("review");
    await Bun.sleep(30);
    expect(notified.length).toBe(before);
  });

  test("TODO_AUTO_REVIEW=0: a run keeps the status", async () => {
    const quiet = openDb(":memory:");
    const { server } = createServer({ db: quiet, port: 0, web: false, spaceApiUrl: `http://127.0.0.1:${space.port}`, spaceAppToken: "sat_todo", autoReview: false });
    try {
      const t = createTodo(quiet, { title: "stay" });
      updateTodo(quiet, t.id, { status: "doing" });
      await (await fetch(`http://127.0.0.1:${server.port}/api/todos/${t.id}/execute`, { method: "POST", body: "{}" })).text();
      expect(getTodo(quiet, t.id)!.status).toBe("doing");
    } finally { server.stop(true); }
  });

  test("POST /review: reject needs a reason, accept closes; 404 and 409 otherwise", async () => {
    const t = (await j("/api/todos", { title: "验收我" })).body.todo!;
    expect((await j(`/api/todos/${t.id}/review`, { verdict: "accept" })).status).toBe(409);
    await j(`/api/todos/${t.id}`, { status: "review", source: "cli" }, "PATCH");
    expect((await j(`/api/todos/${t.id}/review`, { verdict: "reject" })).status).toBe(400);
    expect((await j(`/api/todos/${t.id}/review`, { verdict: "nope" })).status).toBe(400);
    expect((await j("/api/todos/9999/review", { verdict: "accept" })).status).toBe(404);
    const rejected = await j(`/api/todos/${t.id}/review`, { verdict: "reject", reason: "截图不对", source: "manual" });
    expect(rejected.body.todo).toMatchObject({ status: "doing" });
    const detail = (await j(`/api/todos/${t.id}`)).body as { records: { content: string }[]; events: { kind: string }[] };
    expect(detail.records[0]!.content).toBe("验收不通过：截图不对");
    expect(detail.events.map((e) => e.kind)).toContain("review-rejected");
    await j(`/api/todos/${t.id}`, { status: "review" }, "PATCH");
    expect((await j(`/api/todos/${t.id}/review`, { verdict: "accept" })).body.todo).toMatchObject({ status: "done" });
  });

  test("chat operations: review, reject with a reason, done on a todo in review accepts", async () => {
    const t = (await j("/api/todos", { title: "chat" })).body.todo!;
    const apply = (ops: unknown[]) => j("/api/ai/apply", { text: "```todo-actions\n" + JSON.stringify(ops) + "\n```" });
    expect(((await apply([{ op: "review", id: t.id }])).body.results as { todo: Todo }[])[0]!.todo.status).toBe("review");
    const bad = await apply([{ op: "reject", id: t.id }]);
    expect(bad.body.rejected).toBe(1);
    expect(((await apply([{ op: "reject", id: t.id, reason: "再查一遍" }])).body.results as { todo: Todo }[])[0]!.todo.status).toBe("doing");
    await apply([{ op: "review", id: t.id }]);
    const done = (await apply([{ op: "done", id: t.id }])).body.results as { ok: boolean; todo: Todo }[];
    expect(done[0]!.todo.status).toBe("done");
    expect(listEvents(db, t.id)[0]).toMatchObject({ kind: "done", data: { source: "chat", verdict: "accept" } });
  });

  test("lists: status review in the API and the capability, counts in every answer", async () => {
    const t = (await j("/api/todos", { title: "等你" })).body.todo!;
    await j(`/api/todos/${t.id}`, { status: "review" }, "PATCH");
    const list = await j("/api/todos?status=review&fields=list");
    expect(list.body.todos!.map((x) => x.id)).toContain(t.id);
    expect(list.body.counts).toMatchObject({ review: countTodos(db, { status: "review" }) });
    expect((await j("/api/todos")).body.todos!.map((x) => x.id)).not.toContain(t.id);
    const cap = await j("/api/capabilities/list", { status: "review" });
    expect(cap.status).toBe(200);
    expect(cap.body.todos!.map((x) => x.id)).toContain(t.id);
    expect((await j("/api/todos?status=nope")).status).toBe(400);
  });

  test("the done list: lean rows, pages with a cursor, gzip for a caller that accepts it", async () => {
    for (let i = 0; i < 60; i++) {
      const t = createTodo(db, { title: `old ${i}`, notes: "备注".repeat(400) });
      updateTodo(db, t.id, { status: "done" });
    }
    const total = countTodos(db, { status: "done" });
    const first = await j("/api/todos?status=done&fields=list&limit=50");
    expect(first.body.todos).toHaveLength(50);
    expect(first.body.total).toBe(total);
    expect(first.body.todos![0]).not.toHaveProperty("notes");
    expect(typeof first.body.nextBefore).toBe("string");
    const second = await j(`/api/todos?status=done&fields=list&limit=50&before=${encodeURIComponent(String(first.body.nextBefore))}`);
    expect(second.body.todos).toHaveLength(total - 50);
    expect(second.body.nextBefore).toBeNull();
    expect(new Set([...first.body.todos!, ...second.body.todos!].map((t) => t.id)).size).toBe(total);
    expect((await j("/api/todos?status=done&before=x|1")).status).toBe(400);
    expect((await j("/api/todos?status=done&limit=0")).status).toBe(400);
    // Without fields=list the answer is what it was: full todos, no paging fields.
    const full = await j("/api/todos?status=done");
    expect(full.body.todos![0]).toHaveProperty("notes");
    expect(full.body).not.toHaveProperty("nextBefore");

    const raw = await fetch(`${base}/api/todos?status=done`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
    expect(raw.headers.get("content-encoding")).toBe("gzip");
    const zipped = new Uint8Array(await raw.arrayBuffer());
    const plain = await (await fetch(`${base}/api/todos?status=done`, { headers: { "accept-encoding": "identity" } })).text();
    expect(zipped.length).toBeLessThan(plain.length / 2);
    expect(new TextDecoder().decode(Bun.gunzipSync(zipped))).toBe(plain);
    const small = await fetch(`${base}/healthz`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
    expect(small.headers.get("content-encoding")).toBeNull();
  });

  test("the CLI: review, reject with a reason, accept, list --review", async () => {
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", "src/cli.ts", ...args], { env: { ...process.env, TODO_URL: base }, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return { code: await proc.exited, out };
    };
    const t = (await j("/api/todos", { title: "命令行" })).body.todo!;
    expect((await cli("review", String(t.id))).out).toContain("\treview\t");
    expect((await cli("list", "--review")).out).toContain("命令行");
    expect((await cli("reject", String(t.id))).code).toBe(1);
    expect((await cli("reject", String(t.id), "还差", "一步")).out).toContain("\tdoing\t");
    expect(listRecords(db, t.id)[0]!.content).toBe("验收不通过：还差 一步");
    await cli("review", String(t.id));
    expect((await cli("accept", String(t.id))).out).toContain("\tdone\t");
  });
});

describe("review for the AI and the panel", () => {
  const t = (id: number, status: Todo["status"]): Todo => ({ id, title: `t${id}`, notes: "", plan: "", planVersion: 0, status, priority: 0, due: null, tags: [], project: null, source: "manual", parentId: null, subtasks: { total: 0, done: 0 }, position: id, createdAt: "", updatedAt: "", doneAt: null });
  test("chat context and prompts", () => {
    const ctx = chatContext([t(1, "open"), t(2, "review")], { now: new Date("2026-10-25T00:00:00Z"), timezone: "Asia/Shanghai", lang: "zh" });
    expect(ctx.text).toContain("Open tasks (1)");
    expect(ctx.text).toContain("Awaiting your acceptance (1)");
    expect(ctx.text.split("Awaiting your acceptance")[1]).toContain("#2");
    expect(ctx.system).toContain('{"op":"reject","id":N,"reason":"…"}');
    expect(cleanAction({ op: "review", id: 2 })).toEqual({ op: "review", id: 2 });
    expect(cleanAction({ op: "reject", id: 2, reason: " 不行 " })).toEqual({ op: "reject", id: 2, reason: "不行" });
    expect(() => cleanAction({ op: "reject", id: 2 })).toThrow("reason");
    expect(executePrompt(t(2, "review"), { now: new Date(), timezone: "UTC", lang: "zh" })).toContain("awaiting the person's acceptance");
  });
  test("the panel card says how many wait for acceptance and links the view", () => {
    const db = openDb(":memory:");
    createTodo(db, { title: "open one" });
    const r = createTodo(db, { title: "finished" });
    updateTodo(db, r.id, { status: "review" });
    const p = widgetPayload(db, { now: new Date("2026-10-25T00:00:00Z"), timezone: "Asia/Shanghai" });
    expect(p.blocks[0]).toMatchObject({ caption: { zh: "未完成 1 · 待验收 1" } });
    expect(p.blocks[1]).toEqual({ type: "status", label: "待验收", value: { en: "1 awaiting acceptance", zh: "1 项等你验收" }, tone: "warning", url: "/?view=review" });
    expect(p.items.map((i) => i.text)).toEqual(["open one"]);
  });
});
