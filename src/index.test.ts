import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTodo, updateTodo, openDb } from "./db.ts";
import { actionDue, createServer } from "./index.ts";
import type { Run, Todo } from "./types.ts";

/** A stand-in for ai-space: the model service (parse answers JSON, execute streams) and the chat service. */
const calls: { path: string; auth: string | null; body: Record<string, unknown> }[] = [];
let failNext = false;
const space = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, auth: req.headers.get("authorization"), body });
    if (req.headers.get("cookie")) return new Response("cookie leaked", { status: 500 });
    if (url.pathname === "/api/model/run") {
      expect(body).not.toHaveProperty("model");
      if (failNext) { failNext = false; return new Response(JSON.stringify({ ok: false, error: "quota", call: { id: 9 } }), { status: 502, headers: { "content-type": "application/json" } }); }
      if (body.tag === "parse") return Response.json({ ok: true, text: '```json\n[{"title":"发周报给老板","due":"2026-09-23T15:00","priority":2,"tags":["工作"],"project":null,"notes":""},{"title":"订去上海的机票","due":"2026-09-26","tags":["出差"]}]\n```', call: { id: 1, model: "sonnet" } });
      if (body.stream) {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('event: delta\ndata: {"text":"## 结果\\n"}\n\n'));
            setTimeout(() => { c.enqueue(enc.encode(': keepalive\n\n')); c.enqueue(enc.encode('event: delta\ndata: {"text":"查好了。"}\n\n')); }, 20);
            setTimeout(() => { c.enqueue(enc.encode('event: done\ndata: {"ok":true,"text":"## 结果\\n查好了。","call":{"id":2,"model":"opus","costUsd":0.12}}\n\n')); c.close(); }, 40);
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      }
      return Response.json({ ok: true, text: "[]", call: { id: 3 } });
    }
    if (url.pathname.endsWith("/widget.js")) return new Response("window.SpaceChat={}", { headers: { "content-type": "application/javascript", etag: '"w1"' } });
    return Response.json({ ok: true, threads: [] });
  },
});

let base = "";
let stop = () => {};
beforeAll(() => {
  const { server } = createServer({ db: openDb(":memory:"), port: 0, web: false, publicBase: "https://todo.test", spaceApiUrl: `http://127.0.0.1:${space.port}`, spaceAppToken: "sat_todo", autoReview: false, now: () => new Date("2026-09-22T02:30:00Z") });
  base = `http://127.0.0.1:${server.port}`;
  stop = () => server.stop(true);
});
afterAll(() => { stop(); space.stop(true); });

const j = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const sse = async (res: Response) => {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
};

describe("service", () => {
  let todo: Todo;
  test("health, widget when empty", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await j("/api/widget")).body).toEqual({
      ok: true, items: [], asOf: "2026-09-22T02:30:00.000Z", staleAfter: 600,
      blocks: [{ type: "metric", label: { en: "Due by today", zh: "今天到期" }, value: 0, caption: { en: "Nothing open", zh: "清单已清空" }, tone: "neutral", url: "/" }],
    });
  });
  test("crud", async () => {
    const c = await j("/api/todos", { method: "POST", body: JSON.stringify({ title: " 买牛奶 ", due: "2026-09-23", tags: "购物", priority: 1 }) });
    expect(c.status).toBe(201);
    todo = c.body.todo as Todo;
    expect(todo).toMatchObject({ title: "买牛奶", due: "2026-09-23", tags: ["购物"], priority: 1, status: "open", source: "manual" });
    expect((await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "x", due: "soon" }) })).status).toBe(400);
    const p = await j(`/api/todos/${todo.id}`, { method: "PATCH", body: JSON.stringify({ status: "doing", notes: "全脂" }) });
    expect(p.body.todo).toMatchObject({ status: "doing", notes: "全脂" });
    const g = await j(`/api/todos/${todo.id}`);
    expect((g.body.events as unknown[]).length).toBe(2);
    const list = await j("/api/todos");
    expect((list.body.todos as Todo[]).length).toBe(1);
    expect(list.body.tags).toEqual([{ tag: "购物", n: 1 }]);
    const w = await j("/api/widget");
    expect((w.body.items as { text: string; url: string }[])[0]).toMatchObject({ text: "▶ 买牛奶 · 2026-09-23", url: `https://todo.test/?todo=${todo.id}` });
    expect((await j("/api/todos/999")).status).toBe(404);
  });
  test("parse: free text becomes drafts through the model service with the app token", async () => {
    const r = await j("/api/ai/parse", { method: "POST", body: JSON.stringify({ text: "明天下午三点前发周报给老板；周五订去上海的机票 #出差", timezone: "Asia/Shanghai" }) });
    expect(r.status).toBe(200);
    expect(r.body.drafts).toEqual([
      { title: "发周报给老板", notes: "", due: "2026-09-23T15:00", priority: 2, tags: ["工作"], project: null },
      { title: "订去上海的机票", notes: "", due: "2026-09-26", priority: 0, tags: ["出差"], project: null },
    ]);
    const call = calls.find((c) => c.body.tag === "parse")!;
    expect(call.auth).toBe("Bearer sat_todo");
    expect(call.body.thinking).toBe(0);
    expect(String(call.body.prompt)).toContain("Clock: 2026-09-22T10:30 (Tuesday, Asia/Shanghai)");
    expect(String(call.body.prompt)).toContain("Known tags: 购物");
    expect((await j("/api/ai/parse", { method: "POST", body: JSON.stringify({ text: "" }) })).status).toBe(400);
    failNext = true;
    const f = await j("/api/ai/parse", { method: "POST", body: JSON.stringify({ text: "x" }) });
    expect(f.status).toBe(502);
    expect(f.body.error).toBe("quota");
  });
  test("bulk add from drafts", async () => {
    const r = await j("/api/todos/bulk", { method: "POST", body: JSON.stringify({ drafts: [{ title: "a" }, { title: "b", due: "2026-10-01" }], source: "ai" }) });
    expect(r.status).toBe(201);
    expect((r.body.todos as Todo[]).map((t) => t.source)).toEqual(["ai", "ai"]);
    expect((await j("/api/todos/bulk", { method: "POST", body: JSON.stringify({ drafts: [{ title: "ok" }, { title: "" }] }) })).status).toBe(400);   // all or nothing
    expect(((await j("/api/todos")).body.todos as Todo[]).length).toBe(3);
  });
  test("execute: streamed, stored as a run with the ledger call, reattachable", async () => {
    const res = await fetch(`${base}/api/todos/${todo.id}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extra: "只要一句话", timezone: "Asia/Shanghai" }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await sse(res);
    expect(events.map((e) => e.event)).toEqual(["run", "delta", "delta", "done"]);
    expect((events[3]!.data.run as Run)).toMatchObject({ status: "ok", output: "## 结果\n查好了。", callId: 2, model: "opus", costUsd: 0.12 });
    const call = calls.find((c) => c.body.tag === "execute")!;
    expect(call.body.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(call.body.stream).toBe(true);
    expect(String(call.body.prompt)).toContain("Task: 买牛奶");
    expect(String(call.body.prompt)).toContain("Instructions for this run:\n只要一句话");
    const runs = (await j(`/api/todos/${todo.id}/runs`)).body.runs as Run[];
    expect(runs.length).toBe(1);
    expect(runs[0]!.status).toBe("ok");
    // A finished run is still in the live map for a minute: reattaching replays it whole.
    const again = await sse(await fetch(`${base}/api/runs/${runs[0]!.id}/stream`));
    expect(again.map((e) => e.event)).toEqual(["run", "delta", "done"]);
    expect((await j(`/api/todos/${todo.id}`)).body.events as unknown[]).toHaveLength(4);   // created, doing, run-started, run-finished
    expect((await fetch(`${base}/api/todos/999/execute`, { method: "POST" })).status).toBe(404);
  });
  test("chat context and applied actions", async () => {
    const ctx = await j("/api/ai/context?timezone=Asia/Shanghai");
    expect(ctx.body).not.toHaveProperty("model");
    expect(ctx.body.tools).toEqual(["WebSearch", "WebFetch"]);
    expect(String(ctx.body.text)).toContain(`- #${todo.id} · 买牛奶 · due 2026-09-23 · p1 · #购物 · (doing)`);
    const text = `改好了。\n\n\`\`\`todo-actions\n[{"op":"done","id":${todo.id}},{"op":"add","title":"写月报","due":"2026-09-30","priority":2},{"op":"delete","id":999},{"op":"update","id":${todo.id},"due":"bad"}]\n\`\`\``;
    const r = await j("/api/ai/apply", { method: "POST", body: JSON.stringify({ text }) });
    expect(r.status).toBe(200);
    const results = r.body.results as { op: string; ok: boolean; error?: string; todo?: Todo }[];
    expect(results.map((x) => [x.op, x.ok])).toEqual([["done", true], ["add", true], ["delete", false]]);
    expect(r.body.rejected).toBe(1);
    expect(results[1]!.todo).toMatchObject({ title: "写月报", source: "chat" });
    expect(((await j(`/api/todos/${todo.id}`)).body.todo as Todo).status).toBe("done");
    expect((await j("/api/ai/apply", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });
  test("the create action answers a receipt, and a repeated idempotency key answers the first todo", async () => {
    const send = (b: Record<string, unknown>) => j("/api/capabilities/create", { method: "POST", headers: { "x-space-caller": "space" }, body: JSON.stringify(b) });
    const first = await send({ title: "提交报告", dueDate: "2026-10-18", dueTime: "15:00", timezone: "Asia/Seoul", idempotencyKey: "k-1", now: "2026-10-16T23:30:00Z" });
    expect(first.status).toBe(201);
    const item = (first.body.items as { id: number; title: string; url: string; detail: string }[])[0]!;
    // 15:00 in Seoul is 14:00 on the list's Shanghai wall clock.
    expect(item).toEqual({ id: item.id, title: "提交报告", url: `https://todo.test/?todo=${item.id}`, detail: "2026-10-18 14:00 (Asia/Shanghai)" });
    const again = await send({ title: "提交报告", dueDate: "2026-10-18", dueTime: "15:00", timezone: "Asia/Seoul", idempotencyKey: "k-1" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ repeated: true, items: [{ id: item.id }] });
    const detail = (await j(`/api/todos/${item.id}`)).body as { events: { kind: string; data: Record<string, unknown> }[] };
    expect(detail.events.find((e) => e.kind === "created")?.data).toEqual({ source: "manual", caller: "space", idempotencyKey: "k-1" });
    expect((await send({ title: "" })).status).toBe(400);
    expect((await send({ title: "x", dueTime: "09:00" })).body.error).toContain("needs a date");
  });
  test("an action's date stays a date; a time moves to the list's zone", () => {
    expect(actionDue("2026-10-18", undefined, "Asia/Seoul", "Asia/Shanghai")).toBe("2026-10-18");
    expect(actionDue("2026-10-18", "00:30", "Asia/Seoul", "Asia/Shanghai")).toBe("2026-10-17T23:30");
    expect(actionDue("2026-10-18", "09:00", "Asia/Shanghai", "Asia/Shanghai")).toBe("2026-10-18T09:00");
    expect(actionDue("2026-07-01", "09:30", "America/New_York", "Asia/Shanghai")).toBe("2026-07-01T21:30");
    expect(() => actionDue("2026-03-08", "02:30", "America/New_York", "Asia/Shanghai")).toThrow(/does not exist/);
    expect(actionDue(undefined, undefined, "UTC", "Asia/Shanghai")).toBeNull();
  });
  test("list and task read for another app: tasks with records, one task in full, nothing changed", async () => {
    const call = (cap: string, b: Record<string, unknown>) => j(`/api/capabilities/${cap}`, { method: "POST", headers: { "x-space-caller": "product-desk" }, body: JSON.stringify(b) });
    const made = await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "Board page", tags: ["spec", "ready"], project: "product-desk", notes: "1. shows the columns" }) });
    const spec = made.body.todo as Todo;
    for (const content of ["spec written", "built in 1a2b3c", "accepted"]) await j(`/api/todos/${spec.id}/records`, { method: "POST", body: JSON.stringify({ content, source: "cli" }) });
    const list = await call("list", { tag: "spec", project: "product-desk", records: 2 });
    expect(list.status).toBe(200);
    const todos = list.body.todos as (Todo & { records: { content: string }[] })[];
    expect(todos.map((t) => t.id)).toEqual([spec.id]);
    expect(todos[0]!.records.map((r) => r.content)).toEqual(["accepted", "built in 1a2b3c"]);
    expect(((await call("list", { project: "nowhere" })).body.todos as unknown[]).length).toBe(0);
    expect(((await call("list", { status: "all", records: 0 })).body.todos as { records: unknown[] }[]).every((t) => t.records.length === 0)).toBe(true);
    expect((await call("list", { status: "later" })).status).toBe(400);
    const one = await call("task", { id: spec.id });
    expect(one.status).toBe(200);
    expect(one.body.todo).toMatchObject({ id: spec.id, title: "Board page", tags: ["spec", "ready"] });
    expect((one.body.records as { content: string }[]).map((r) => r.content)).toEqual(["accepted", "built in 1a2b3c", "spec written"]);
    expect(one.body).toHaveProperty("events"); expect(one.body).toHaveProperty("subtasks"); expect(one.body).toHaveProperty("runs");
    expect((await call("task", { id: 999999 })).status).toBe(404);
    expect((await call("task", {})).status).toBe(404);
    // Reads leave no trace: the task's events are still the create and the three records.
    expect(((await j(`/api/todos/${spec.id}`)).body.events as unknown[]).length).toBe(4);
  });
  test("status for another app: doing, review, back to open; a closed task stays closed", async () => {
    const call = (b: Record<string, unknown>) => j("/api/capabilities/status", { method: "POST", headers: { "x-space-caller": "space" }, body: JSON.stringify(b) });
    const made = await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "[Todo] button overlaps the list" }) });
    const id = (made.body.todo as Todo).id;
    expect((await call({ id, status: "doing" })).body.todo).toMatchObject({ id, status: "doing" });
    expect((await call({ id, status: "review" })).body.todo).toMatchObject({ id, status: "review" });
    const events = ((await j(`/api/todos/${id}`)).body.events as { kind: string; data: Record<string, unknown> }[]);
    expect(events.find((e) => e.kind === "review")?.data).toMatchObject({ source: "ai", caller: "space" });
    expect((await call({ id, status: "open" })).body.todo).toMatchObject({ status: "open" });
    expect((await call({ id, status: "done" })).status).toBe(400);
    expect((await call({ id: 999999, status: "doing" })).status).toBe(404);
    await j(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status: "done" }) });
    expect((await call({ id, status: "doing" })).status).toBe(409);
  });
  test("a todo added by another app through the bus records its caller", async () => {
    const r = await j("/api/todos/bulk", { method: "POST", headers: { "x-space-caller": "ai-spark" }, body: JSON.stringify({ drafts: [{ title: "from an idea" }], source: "ai" }) });
    const id = (r.body.todos as Todo[])[0]!.id;
    const detail = (await j(`/api/todos/${id}`)).body as { events: { kind: string; data: Record<string, unknown> }[] };
    expect(detail.events.find((e) => e.kind === "created")?.data).toEqual({ source: "ai", caller: "ai-spark" });
    const plain = await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "typed here" }) });
    const own = (await j(`/api/todos/${(plain.body.todo as Todo).id}`)).body as { events: { kind: string; data: Record<string, unknown> }[] };
    expect(own.events.find((e) => e.kind === "created")?.data).toEqual({ source: "manual" });
  });

  test("subtasks: created in bulk under a parent, shown with it, split by the chat", async () => {
    const p = (await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "年终总结", tags: ["工作"] }) })).body.todo as Todo;
    const bulk = await j("/api/todos/bulk", { method: "POST", body: JSON.stringify({ parentId: p.id, drafts: [{ title: "收集数据" }, { title: "写初稿" }] }) });
    expect((bulk.body.todos as Todo[]).map((t) => t.parentId)).toEqual([p.id, p.id]);
    const detail = (await j(`/api/todos/${p.id}`)).body;
    expect((detail.todo as Todo).subtasks).toEqual({ total: 2, done: 0 });
    expect((detail.subtasks as Todo[]).map((t) => t.title)).toEqual(["收集数据", "写初稿"]);
    const child = (detail.subtasks as Todo[])[0]!;
    expect(((await j(`/api/todos/${child.id}`)).body.parent as Todo).id).toBe(p.id);
    expect((await j("/api/todos", { method: "POST", body: JSON.stringify({ title: "x", parentId: child.id }) })).status).toBe(400);
    const ctx = String((await j("/api/ai/context?timezone=Asia/Shanghai")).body.text);
    expect(ctx).toContain(`- #${p.id} · 年终总结 · #工作 (0/2 subtasks done)\n  ↳ #${child.id} · 收集数据`);
    const text = `拆好了。\n\n\`\`\`todo-actions\n[{"op":"add","title":"定稿","parentId":${p.id}}]\n\`\`\``;
    const r = await j("/api/ai/apply", { method: "POST", body: JSON.stringify({ text }) });
    expect((r.body.results as { todo: Todo }[])[0]!.todo.parentId).toBe(p.id);
    // Execute sees the steps of the task it is given.
    await sse(await fetch(`${base}/api/todos/${p.id}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    const prompt = String(calls.filter((c) => c.body.tag === "execute").at(-1)!.body.prompt);
    expect(prompt).toContain("Its steps (subtasks):\n- [ ] 收集数据\n- [ ] 写初稿\n- [ ] 定稿");
  });
  test("drafts in a chat answer are cleaned for the preview", async () => {
    const r = await j("/api/ai/drafts", { method: "POST", body: JSON.stringify({ text: "```todo-drafts\n[{\"title\":\"a\",\"due\":\"2026-10-01\"},{\"due\":\"x\"}]\n```" }) });
    expect(r.body).toEqual({ ok: true, drafts: [{ title: "a", notes: "", due: "2026-10-01", priority: 0, tags: [], project: null }], rejected: 1, found: true });
    expect((await j("/api/ai/drafts", { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
  });
  test("the chat proxy forwards with the app token and never cookies", async () => {
    const r = await fetch(`${base}/space/chat/threads?scope=todo`, { headers: { cookie: "session=1" } });
    expect(r.status).toBe(200);
    const up = calls.at(-1)!;
    expect(up.path).toBe("/api/chat/threads");
    expect(up.auth).toBe("Bearer sat_todo");
    const w = await fetch(`${base}/space/chat/widget.js`);
    expect(w.headers.get("etag")).toBe('"w1"');
    expect(await w.text()).toBe("window.SpaceChat={}");
  });
  test("without ai-space the AI routes say so", async () => {
    const { server } = createServer({ db: openDb(":memory:"), port: 0, web: false });
    const r = await fetch(`http://127.0.0.1:${server.port}/api/ai/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
    expect(r.status).toBe(502);
    server.stop(true);
  });
});

test("defer through chat and CLI, filter through API, omit from widget, then restore", async () => {
  const db = openDb(":memory:");
  const { server } = createServer({ db, port: 0, web: false });
  const url = `http://127.0.0.1:${server.port}`;
  const request = async (path: string, body?: unknown, method = "POST") => {
    const res = await fetch(url + path, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.ok).toBe(true);
    return res.json();
  };
  const cli = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], { env: { ...process.env, TODO_URL: url }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return output;
  };
  try {
    const { todo } = await request("/api/todos", { title: "Deferred integration", due: "2026-01-01", tags: ["later"], project: "Later" });
    const { todo: child } = await request("/api/todos", { title: "Hidden child", parentId: todo.id });
    await request(`/api/todos/${todo.id}/records`, { content: "Keep this evidence" });
    const applied = await request("/api/ai/apply", { text: '```todo-actions\n' + JSON.stringify([{ op: "defer", id: todo.id }]) + '\n```' });
    expect(JSON.stringify(applied)).toContain('"deferred"');
    expect((await request("/api/todos")).todos).toEqual([]);
    expect((await request("/api/widget")).items).toEqual([]);
    const held = await request("/api/todos?status=deferred&tag=later&project=Later");
    expect(held.todos.map((t: Todo) => t.id)).toEqual([todo.id]);
    expect(held.tags).toEqual([{ tag: "later", n: 1 }]);
    expect(held.projects).toEqual([{ project: "Later", n: 1 }]);
    expect(await cli("list", "--deferred")).toContain("Deferred integration");
    await cli("reopen", String(todo.id));
    expect((await request("/api/todos")).todos).toHaveLength(2);
    expect((await request("/api/widget")).items).toHaveLength(2);
    await cli("defer", String(child.id));
    expect((await request("/api/todos")).todos.map((t: Todo) => t.id)).toEqual([todo.id]);
    const detail = await request(`/api/todos/${todo.id}`);
    expect(detail.todo.due).toBe("2026-01-01");
    expect(detail.records[0].content).toBe("Keep this evidence");
    expect(detail.events.some((e: { kind: string }) => e.kind === "deferred")).toBe(true);
  } finally { server.stop(true); db.close(); }
});


test("chat retains deferred parents beyond its list cap", async () => {
  const db = openDb(":memory:");
  const parent = createTodo(db, { title: "Deferred beyond cap" });
  updateTodo(db, parent.id, { status: "deferred" });
  const child = createTodo(db, { title: "Hidden doing step", parentId: parent.id });
  updateTodo(db, child.id, { status: "doing" });
  for (let i = 0; i < 301; i++) createTodo(db, { title: `Active ${i}`, project: "Active project" });
  const { server } = createServer({ db, port: 0, web: false });
  try {
    const ctx = await (await fetch(`http://127.0.0.1:${server.port}/api/ai/context`)).json();
    expect(ctx.text).toContain("Deferred tasks — exclude from daily plans (2)");
    expect(ctx.text.split("Deferred tasks")[0]).not.toContain("Hidden doing step");
  } finally { server.stop(true); db.close(); }
});
