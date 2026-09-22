import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { createServer } from "./index.ts";
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
  const { server } = createServer({ db: openDb(":memory:"), port: 0, web: false, publicBase: "https://todo.test", spaceApiUrl: `http://127.0.0.1:${space.port}`, spaceAppToken: "sat_todo", now: () => new Date("2026-09-22T02:30:00Z") });
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
    expect((await j("/api/widget")).body).toEqual({ ok: true, items: [] });
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
