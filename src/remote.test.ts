import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "./blobs.ts";
import { openDb } from "./db.ts";
import { createServer } from "./index.ts";
import { callerAllowed, forwarder, machineFinder, readEnvelope, timeoutOf, TIMEOUTS } from "./remote.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

describe("readEnvelope", () => {
  test("only the page's routes, with their methods", () => {
    expect(readEnvelope({ method: "get", path: "/api/todos?status=active&fields=list" })).toEqual({ method: "GET", path: "/api/todos?status=active&fields=list" });
    expect(readEnvelope({ method: "PATCH", path: "/api/todos/3", contentType: "application/json", body64: "e30=" })).toMatchObject({ method: "PATCH", body64: "e30=" });
    expect(readEnvelope({ method: "GET", path: "/blobs/records/3/1-ab.png" })?.path).toBe("/blobs/records/3/1-ab.png");
    expect(readEnvelope({ method: "POST", path: "/api/todos/3/execute?detach=1" })?.path).toBe("/api/todos/3/execute?detach=1");
    expect(readEnvelope({ method: "GET", path: "/api/execute/models" })?.path).toBe("/api/execute/models");
    expect(readEnvelope({ method: "GET", path: "/api/runs/3/stream" })).toBeNull();
    expect(readEnvelope({ method: "POST", path: "/space/chat/threads" })).toBeNull();
    expect(readEnvelope({ method: "POST", path: "/api/remote" })).toBeNull();
    expect(readEnvelope({ method: "POST", path: "/api/capabilities/create" })).toBeNull();
    expect(readEnvelope({ method: "GET", path: "/api/m/x/api/todos" })).toBeNull();
    expect(readEnvelope({ method: "DELETE", path: "/api/todos" })).toBeNull();
    expect(readEnvelope({ method: "GET", path: "/api/../healthz" })).toBeNull();
    expect(readEnvelope({ method: "GET", path: "//evil.example/api/todos" })).toBeNull();
    expect(readEnvelope({ method: "GET", path: "/api/todos", body64: "eA==" })).toEqual({ method: "GET", path: "/api/todos" });
  });

  test("callers: ai-todo here or on another space", () => {
    expect(callerAllowed("seoul/ai-todo", "ai-todo")).toBe(true);
    expect(callerAllowed("ai-todo", "ai-todo")).toBe(true);
    expect(callerAllowed("seoul/space", "ai-todo")).toBe(false);
    expect(callerAllowed(null, "ai-todo")).toBe(false);
  });

  test("machines: the peers whose ai-space lists ai-todo's ops, asked with the app token", async () => {
    const f = (async (_u: string, init: RequestInit) => (init.headers as Record<string, string>).authorization !== "Bearer t" ? new Response("{}", { status: 401 }) : Response.json({ ok: true, apps: [
      { app: "ai-todo", provides: [{ name: "ops" }] },
      { app: "thinkbook/ai-todo", peer: "thinkbook", provides: [{ name: "ops" }, { name: "add" }] },
      { app: "david/ai-todo", peer: "david", provides: [{ name: "ops" }] },
      { app: "old/ai-todo", peer: "old", provides: [{ name: "add" }] },
      { app: "x/keep", peer: "x", provides: [{ name: "ops" }] },
    ] })) as unknown as typeof fetch;
    expect(await machineFinder({ apiUrl: "http://s", app: "ai-todo", local: "seoul", token: "t", fetch: f })()).toEqual({ local: "seoul", peers: ["david", "thinkbook"], peerHealth: [{ name: "david", online: true }, { name: "thinkbook", online: true }], error: null });
  });

  test("machines: a peer ai-space marks down is listed offline; one without health (an older ai-space) is online", async () => {
    const f = (async () => Response.json({ apps: [
      { app: "asleep/ai-todo", peer: "asleep", provides: ["ops"], health: "down", asOf: "2026-11-11T08:00:00.000Z" },
      { app: "up/ai-todo", peer: "up", provides: ["ops"], health: "ok", asOf: "2026-11-11T09:00:00.000Z" },
      { app: "old/ai-todo", peer: "old", provides: ["ops"] },
      { app: "asleep/keep", peer: "asleep", provides: ["ops"], health: "ok" },
    ] })) as unknown as typeof fetch;
    expect(await machineFinder({ apiUrl: "http://s", app: "ai-todo", local: "hub", token: "t", fetch: f })()).toEqual({
      local: "hub", peers: ["asleep", "old", "up"], error: null,
      peerHealth: [{ name: "asleep", online: false, asOf: "2026-11-11T08:00:00.000Z" }, { name: "old", online: true }, { name: "up", online: true, asOf: "2026-11-11T09:00:00.000Z" }],
    });
  });

  test("machines: no ai-space answering leaves this machine alone, with the reason", async () => {
    const f = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    expect(await machineFinder({ apiUrl: "http://s", app: "ai-todo", local: "solo", token: "", fetch: f })()).toEqual({ local: "solo", peers: [], peerHealth: [], error: "connection refused" });
  });

  test("forward waits: 12 s for a read, a minute for a write or a picture, the long wait for an execution and a parse", () => {
    expect(timeoutOf({ method: "GET", path: "/api/todos?status=active&fields=list&limit=1" })).toBe(12_000);
    expect(timeoutOf({ method: "GET", path: "/api/ai/context?lang=en" })).toBe(12_000);
    expect(timeoutOf({ method: "GET", path: "/blobs/records/3/1-ab.png" })).toBe(60_000);
    expect(timeoutOf({ method: "PATCH", path: "/api/todos/3" })).toBe(60_000);
    expect(timeoutOf({ method: "POST", path: "/api/todos/3/records" })).toBe(60_000);
    expect(timeoutOf({ method: "POST", path: "/api/todos/3/execute?detach=1" })).toBe(TIMEOUTS.long);
    expect(timeoutOf({ method: "POST", path: "/api/ai/parse" })).toBe(TIMEOUTS.long);
    expect(timeoutOf({ method: "GET", path: "/api/todos/3" }, TIMEOUTS, true)).toBe(TIMEOUTS.long);
    expect(TIMEOUTS.long).toBeGreaterThanOrEqual(15 * 60_000);
  });

  test("machines: past 30 s the kept list answers at once while the catalogue is read again", async () => {
    let clock = 0;
    let peers = ["david"];
    let release = () => {};
    let reads = 0;
    const f = (async () => {
      reads++;
      if (reads > 1) await new Promise<void>((r) => { release = r; });
      return Response.json({ apps: peers.map((p) => ({ app: `${p}/ai-todo`, peer: p, provides: ["ops"] })) });
    }) as unknown as typeof fetch;
    const find = machineFinder({ apiUrl: "http://s", app: "ai-todo", local: "seoul", token: "t", fetch: f, now: () => clock });
    expect((await find()).peers).toEqual(["david"]);
    clock = 31_000; peers = ["david", "thinkbook"];
    // The catalogue is slow now: the answer does not wait for it, and two requests read it once.
    expect((await find()).peers).toEqual(["david"]);
    expect((await find()).peers).toEqual(["david"]);
    expect(reads).toBe(2);
    release();
    await Bun.sleep(0);
    expect((await find()).peers).toEqual(["david", "thinkbook"]);
  });
});

describe("one page over two machines", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-remote-"));
  const peer = createServer({ db: openDb(":memory:"), port: 0, web: false, blobs: fileStore(join(dir, "peer")), machine: "david" }).server;
  const peerBase = `http://127.0.0.1:${peer.port}`;
  // The bus between them: the hub's call reaches the peer's /api/remote as `<hub>/ai-todo`, the answer comes back whole.
  const bus = (async (_url: string, init: RequestInit) => {
    const res = await fetch(`${peerBase}/api/remote`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-space-caller": "seoul/ai-todo" } });
    return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "" } });
  }) as unknown as typeof fetch;
  const hub = createServer({
    db: openDb(":memory:"), port: 0, web: false, blobs: fileStore(join(dir, "hub")), machine: "seoul",
    machines: async () => ({ local: "seoul", peers: ["david"], peerHealth: [{ name: "david", online: true }], error: null }),
    forward: forwarder({ apiUrl: "http://space", app: "ai-todo", token: "t", fetch: bus }),
  }).server;
  const base = `http://127.0.0.1:${hub.port}`;
  afterAll(() => { hub.stop(true); peer.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const send = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("the hub lists its machines; a peer lists none", async () => {
    expect(await (await fetch(`${base}/api/machines`)).json()).toEqual({ ok: true, local: "seoul", peers: ["david"], peerHealth: [{ name: "david", online: true }], error: null });
    expect(await (await fetch(`${peerBase}/api/machines`)).json()).toEqual({ ok: true, local: "david", peers: [], peerHealth: [], error: null });
  });

  test("a task made on the hub's page for the peer lives on the peer, and changes there", async () => {
    const res = await send("/api/m/david/api/todos", "POST", { title: "Back up the GPU box" });
    expect(res.status).toBe(201);
    const { todo } = (await res.json()) as { todo: { id: number } };
    const there = (await (await fetch(`${peerBase}/api/todos?fields=list`)).json()) as { todos: { title: string }[] };
    expect(there.todos.map((t) => t.title)).toEqual(["Back up the GPU box"]);
    const here = (await (await fetch(`${base}/api/todos?fields=list`)).json()) as { todos: unknown[] };
    expect(here.todos).toEqual([]);
    const patched = (await (await send(`/api/m/david/api/todos/${todo.id}`, "PATCH", { status: "doing" })).json()) as { todo: { status: string } };
    expect(patched.todo.status).toBe("doing");
    expect((await send(`/api/m/david/api/todos/${todo.id}`, "DELETE")).status).toBe(200);
    expect((await fetch(`${peerBase}/api/todos/${todo.id}`)).status).toBe(404);
  });

  test("a record with a picture goes up as multipart, and the picture comes back", async () => {
    const { todo } = (await (await send("/api/m/david/api/todos", "POST", { title: "Screenshot" })).json()) as { todo: { id: number } };
    const form = new FormData();
    form.append("content", "see the picture");
    form.append("images", new File([png], "shot.png", { type: "image/png" }));
    const up = await fetch(`${base}/api/m/david/api/todos/${todo.id}/records`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    const { record } = (await up.json()) as { record: { attachments: { key: string }[] } };
    const key = record.attachments[0]!.key;
    const img = await fetch(`${base}/api/m/david/blobs/${key}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer())).toEqual(png);
  });

  test("refused: an unknown machine, a write from another site, a route outside the page, a body too large", async () => {
    expect((await fetch(`${base}/api/m/nowhere/api/todos`)).status).toBe(404);
    expect((await send("/api/m/david/api/todos", "POST", { title: "x" }, { origin: "https://evil.example", host: "todo.example" })).status).toBe(403);
    expect((await fetch(`${base}/api/m/david/healthz`)).status).toBe(404);
    expect((await fetch(`${base}/api/m/david/api/runs/1/stream`)).status).toBe(404);
    expect((await send("/api/m/david/api/todos", "POST", { title: "x", notes: "y".repeat(3_000_000) })).status).toBe(413);
  });

  test("ops answers only ai-todo", async () => {
    const call = (caller?: string) => fetch(`${peerBase}/api/remote`, { method: "POST", headers: { "content-type": "application/json", ...(caller ? { "x-space-caller": caller } : {}) }, body: JSON.stringify({ method: "GET", path: "/api/widget" }) });
    expect((await call("seoul/ai-todo")).status).toBe(200);
    expect((await call("seoul/keep")).status).toBe(403);
    expect((await call()).status).toBe(403);
  });

  test("a large answer from the peer comes to the page gzipped", async () => {
    for (let i = 0; i < 6; i++) await fetch(`${peerBase}/api/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: `Long ${i}`, notes: "note ".repeat(600) }) });
    const res = await fetch(`${base}/api/m/david/api/todos`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())))) as { todos: unknown[] };
    expect(body.todos.length).toBeGreaterThanOrEqual(6);
    const small = await fetch(`${base}/api/m/david/api/runs/999`, { headers: { "accept-encoding": "gzip" }, decompress: false } as RequestInit);
    expect(small.headers.get("content-encoding")).toBeNull();
  });

  test("a task moves to the peer and back with its plan, stage, subtasks, records and pictures", async () => {
    type Detail = { todo: { id: number; title: string; status: string; plan: string; tags: string[] }; subtasks: { title: string; status: string }[]; records: { content: string; createdAt: string; attachments?: { key: string }[] }[] };
    const { todo } = (await (await send("/api/todos", "POST", { title: "Move me", notes: "n", plan: "# How", tags: ["ops"], priority: 2 })).json()) as { todo: { id: number } };
    await send(`/api/todos/${todo.id}`, "PATCH", { status: "doing" });
    const sub = (await (await send("/api/todos", "POST", { title: "Step one", parentId: todo.id })).json()) as { todo: { id: number } };
    await send(`/api/todos/${sub.todo.id}`, "PATCH", { status: "done" });
    await send(`/api/todos/${todo.id}/records`, "POST", { content: "first note", createdAt: "2026-01-02T03:04:05.000Z" });
    const form = new FormData();
    form.append("content", "with a picture");
    form.append("images", new File([png], "shot.png", { type: "image/png" }));
    expect((await fetch(`${base}/api/todos/${todo.id}/records`, { method: "POST", body: form })).status).toBe(201);

    const moved = await send("/api/transfer", "POST", { id: todo.id, from: "", to: "david" });
    expect(moved.status).toBe(200);
    const out = (await moved.json()) as { todo: { id: number }; machine: string };
    expect(out.machine).toBe("david");
    expect((await fetch(`${base}/api/todos/${todo.id}`)).status).toBe(404);
    const there = (await (await fetch(`${peerBase}/api/todos/${out.todo.id}`)).json()) as Detail;
    expect(there.todo).toMatchObject({ title: "Move me", status: "doing", plan: "# How", tags: ["ops"] });
    expect(there.subtasks).toMatchObject([{ title: "Step one", status: "done" }]);
    // Newest first: the note of the move, then the records in their order, the first with its own time.
    expect(there.records.map((r) => r.content)).toEqual(["从 seoul 转移而来（在那边是 #" + todo.id + "）。", "with a picture", "first note"]);
    expect(there.records[2]!.createdAt).toBe("2026-01-02T03:04:05.000Z");
    const img = await fetch(`${peerBase}/blobs/${there.records[1]!.attachments![0]!.key}`);
    expect(Buffer.from(await img.arrayBuffer())).toEqual(png);

    // And back to the hub from the peer, asked on the hub's page.
    const back = (await (await send("/api/transfer", "POST", { id: out.todo.id, from: "david", to: "", lang: "en" })).json()) as { todo: { id: number }; machine: string };
    expect(back.machine).toBe("");
    expect((await fetch(`${peerBase}/api/todos/${out.todo.id}`)).status).toBe(404);
    const here = (await (await fetch(`${base}/api/todos/${back.todo.id}`)).json()) as Detail;
    expect(here.todo).toMatchObject({ title: "Move me", status: "doing" });
    expect(here.records[0]!.content).toBe(`Moved here from david (it was #${out.todo.id} there).`);
    expect(here.records).toHaveLength(4);
  });

  test("a move is refused for a subtask, the same machine, an unknown machine or another site, and a failed one leaves nothing behind", async () => {
    const { todo } = (await (await send("/api/todos", "POST", { title: "Parent" })).json()) as { todo: { id: number } };
    const sub = (await (await send("/api/todos", "POST", { title: "Child", parentId: todo.id })).json()) as { todo: { id: number } };
    expect((await send("/api/transfer", "POST", { id: sub.todo.id, from: "", to: "david" })).status).toBe(400);
    expect((await send("/api/transfer", "POST", { id: todo.id, from: "", to: "" })).status).toBe(400);
    expect((await send("/api/transfer", "POST", { id: todo.id, from: "", to: "nowhere" })).status).toBe(404);
    expect((await send("/api/transfer", "POST", { id: 99999, from: "", to: "david" })).status).toBe(404);
    expect((await send("/api/transfer", "POST", { id: todo.id, from: "", to: "david" }, { origin: "https://evil.example", host: "todo.example" })).status).toBe(403);
    // A record too large for the bus stops the move: the task stays here and the peer keeps no copy.
    await send(`/api/todos/${todo.id}/records`, "POST", { content: "small" });
    const big = new FormData();
    big.append("content", "big picture");
    big.append("images", new File([Buffer.concat([png, Buffer.alloc(3_000_000)])], "big.png", { type: "image/png" }));
    expect((await fetch(`${base}/api/todos/${todo.id}/records`, { method: "POST", body: big })).status).toBe(201);
    const before = ((await (await fetch(`${peerBase}/api/todos?status=all`)).json()) as { todos: unknown[] }).todos.length;
    expect((await send("/api/transfer", "POST", { id: todo.id, from: "", to: "david" })).status).toBe(413);
    expect((await fetch(`${base}/api/todos/${todo.id}`)).status).toBe(200);
    expect(((await (await fetch(`${peerBase}/api/todos?status=all`)).json()) as { todos: unknown[] }).todos.length).toBe(before);
  });

  test("a run is read as it stands", async () => {
    expect((await fetch(`${base}/api/m/david/api/runs/999`)).status).toBe(404);
  });
});

describe("a machine that does not answer", () => {
  // ai-space for the hub: its catalogue lists a peer that is asleep, whose tunnel takes the call and never answers.
  let calls = 0;
  const space = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    routes: {
      "/api/capabilities": () => Response.json({ apps: [
        { app: "asleep/ai-todo", peer: "asleep", provides: ["ops"], health: "down", asOf: "2026-11-11T08:00:00.000Z" },
        { app: "old/ai-todo", peer: "old", provides: ["ops"] },
      ] }),
    },
    fetch: () => { calls++; return new Promise<Response>(() => {}); },
  });
  const spaceUrl = `http://127.0.0.1:${space.port}`;
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-silent-"));
  const hub = createServer({
    db: openDb(":memory:"), port: 0, web: false, blobs: fileStore(dir), machine: "hub",
    machines: machineFinder({ apiUrl: spaceUrl, app: "ai-todo", local: "hub", token: "t" }),
    // Short waits stand in for 12 s, a minute and the long wait.
    forward: forwarder({ apiUrl: spaceUrl, app: "ai-todo", token: "t", timeouts: { read: 60, write: 150, long: 300 } }),
  }).server;
  const base = `http://127.0.0.1:${hub.port}`;
  afterAll(() => { hub.stop(true); space.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const timed = async (res: Promise<Response>) => { const t0 = performance.now(); const r = await res; return { r, ms: performance.now() - t0, body: (await r.json()) as { ok: boolean; error: string } }; };

  test("the machine list says which peer is offline", async () => {
    expect(await (await fetch(`${base}/api/machines`)).json()).toEqual({
      ok: true, local: "hub", peers: ["asleep", "old"], error: null,
      peerHealth: [{ name: "asleep", online: false, asOf: "2026-11-11T08:00:00.000Z" }, { name: "old", online: true }],
    });
  });

  test("a read gives up after its short wait with 504 and names the machine", async () => {
    const { r, ms, body } = await timed(fetch(`${base}/api/m/old/api/todos?status=active&fields=list&limit=1`));
    expect(r.status).toBe(504);
    expect(body).toEqual({ ok: false, error: "machine old did not answer in 60 ms" });
    expect(ms).toBeLessThan(140);
    expect(calls).toBeGreaterThan(0);
  });

  test("a write waits longer, an execution the longest", async () => {
    const w = await timed(fetch(`${base}/api/m/old/api/todos/1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(w.r.status).toBe(504);
    expect(w.body.error).toBe("machine old did not answer in 150 ms");
    expect(w.ms).toBeGreaterThanOrEqual(140);
    const x = await timed(fetch(`${base}/api/m/old/api/todos/1/execute?detach=1`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(x.r.status).toBe(504);
    expect(x.body.error).toBe("machine old did not answer in 300 ms");
  });

  test("a move's calls keep the long wait, and the task stays here", async () => {
    const { todo } = (await (await fetch(`${base}/api/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Stay" }) })).json()) as { todo: { id: number } };
    const { r, body } = await timed(fetch(`${base}/api/transfer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: todo.id, from: "", to: "old" }) }));
    expect(r.status).toBe(504);
    expect(body.error).toBe("old: machine old did not answer in 300 ms");
    expect((await fetch(`${base}/api/todos/${todo.id}`)).status).toBe(200);
  });
});
