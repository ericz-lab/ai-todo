import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore } from "./blobs.ts";
import { openDb } from "./db.ts";
import { createServer } from "./index.ts";
import { callerAllowed, forwarder, machineFinder, readEnvelope } from "./remote.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

describe("readEnvelope", () => {
  test("only the page's routes, with their methods", () => {
    expect(readEnvelope({ method: "get", path: "/api/todos?status=active&fields=list" })).toEqual({ method: "GET", path: "/api/todos?status=active&fields=list" });
    expect(readEnvelope({ method: "PATCH", path: "/api/todos/3", contentType: "application/json", body64: "e30=" })).toMatchObject({ method: "PATCH", body64: "e30=" });
    expect(readEnvelope({ method: "GET", path: "/blobs/records/3/1-ab.png" })?.path).toBe("/blobs/records/3/1-ab.png");
    expect(readEnvelope({ method: "POST", path: "/api/todos/3/execute?detach=1" })?.path).toBe("/api/todos/3/execute?detach=1");
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
    expect(await machineFinder({ apiUrl: "http://s", app: "ai-todo", local: "seoul", token: "t", fetch: f })()).toEqual({ local: "seoul", peers: ["david", "thinkbook"], error: null });
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
    machines: async () => ({ local: "seoul", peers: ["david"], error: null }),
    forward: forwarder({ apiUrl: "http://space", app: "ai-todo", token: "t", fetch: bus }),
  }).server;
  const base = `http://127.0.0.1:${hub.port}`;
  afterAll(() => { hub.stop(true); peer.stop(true); rmSync(dir, { recursive: true, force: true }); });
  const send = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("the hub lists its machines; a peer lists none", async () => {
    expect(await (await fetch(`${base}/api/machines`)).json()).toEqual({ ok: true, local: "seoul", peers: ["david"], error: null });
    expect(await (await fetch(`${peerBase}/api/machines`)).json()).toEqual({ ok: true, local: "david", peers: [], error: null });
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

  test("a run is read as it stands", async () => {
    expect((await fetch(`${base}/api/m/david/api/runs/999`)).status).toBe(404);
  });
});
