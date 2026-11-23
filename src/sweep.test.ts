import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { appendRecord, createTodo, listEvents, listRecords, listRuns, openDb, updateTodo } from "./db.ts";
import { createServer } from "./index.ts";
import { abilitiesLine, readTriage, sweepVerdict, unsureRecord } from "./sweep.ts";

/**
 * A stand-in for ai-space's model service. The sweep's triage (tag `sweep`) answers what `verdict` says for
 * each task id in the prompt (or `raw` verbatim); an execution (tag `execute`) streams a result, fails when
 * `execFails`, and waits for `hold` when one is set. No real model, no real agent run.
 */
type Call = { tag: string; prompt: string; body: Record<string, unknown> };
const calls: Call[] = [];
let verdict: (id: number) => Record<string, unknown> | null = () => ({ verdict: "cannot", reason: "no" });
let raw: string | null = null;
let execFails = false;
let hold: Promise<void> | null = null;
const space = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (new URL(req.url).pathname !== "/api/model/run") return Response.json({ ok: true });
    calls.push({ tag: String(body.tag), prompt: String(body.prompt), body });
    if (body.tag === "sweep") {
      // The triage names no model: space.yaml's model.tags.sweep picks it.
      expect(body).not.toHaveProperty("model");
      expect(body.stream).toBe(false);
      if (raw !== null) return Response.json({ ok: true, text: raw, call: { id: 50 } });
      const ids = [...String(body.prompt).matchAll(/^### #(\d+) /gm)].map((m) => Number(m[1]));
      return Response.json({ ok: true, text: JSON.stringify(ids.map((id) => { const v = verdict(id); return v ? { id, ...v } : null; }).filter(Boolean)), call: { id: 51 } });
    }
    const wait = hold;
    const fails = execFails;
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('event: delta\ndata: {"text":"working"}\n\n'));
        if (wait) await wait;
        c.enqueue(enc.encode(fails ? 'event: error\ndata: {"error":"agent failed","call":{"id":61}}\n\n' : 'event: done\ndata: {"ok":true,"text":"## done","call":{"id":60,"model":"opus"}}\n\n'));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => space.stop(true));

let clock = new Date("2026-11-22T00:00:00Z");
const stops: (() => void)[] = [];
afterAll(() => { for (const s of stops) s(); });
function setup(o: { maxRuns?: number; permission?: string } = {}) {
  const db = openDb(":memory:");
  const { server, sweeper } = createServer({
    db, port: 0, web: false, spaceApiUrl: `http://127.0.0.1:${space.port}`, spaceAppToken: "sat_todo", now: () => clock,
    sweepMaxRuns: o.maxRuns ?? 2, sweepPermission: o.permission, timezone: "Asia/Shanghai", lang: "zh",
  });
  stops.push(() => server.stop(true));
  const base = `http://127.0.0.1:${server.port}`;
  const j = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const on = (intervalHours = 4) => j("/api/sweep", { method: "PATCH", body: JSON.stringify({ enabled: true, intervalHours }) });
  /** The scheduler's tick; `manual` is its run-now. Answers when the sweep is over. */
  const tick = (manual = false) => j("/jobs/sweep", { method: "POST", headers: manual ? { "x-space-trigger": "manual" } : {} });
  return { db, j, on, tick, sweeper };
}
const triageCalls = () => calls.filter((c) => c.tag === "sweep");
const execCalls = () => calls.filter((c) => c.tag === "execute");
const asked = (c: Call | undefined) => [...String(c?.prompt ?? "").matchAll(/^### #(\d+) /gm)].map((m) => Number(m[1]));

beforeEach(() => {
  calls.length = 0;
  verdict = () => ({ verdict: "cannot", reason: "no" });
  raw = null; execFails = false; hold = null;
  clock = new Date("2026-11-22T00:00:00Z");
});

describe("scheduled sweep", () => {
  test("off by default: a tick, a manual sweep and the page's button do nothing", async () => {
    const { db, j, tick } = setup();
    createTodo(db, { title: "整理会议纪要" });
    const st = await j("/api/sweep");
    expect(st.body.settings).toEqual({ enabled: false, intervalHours: 24, updatedAt: null });
    expect(st.body.nextAt).toBeNull();
    expect((await tick()).body).toEqual({ ok: true, status: "skipped", error: "the scheduled sweep is off" });
    expect((await tick(true)).body.status).toBe("skipped");
    expect((await j("/api/sweep/run", { method: "POST" })).status).toBe(409);
    expect(calls).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM sweeps").get()).toEqual({ n: 0 });
  });

  test("settings: on/off and 4, 8 or 24 hours, nothing else", async () => {
    const { j } = setup();
    expect((await j("/api/sweep", { method: "PATCH", body: JSON.stringify({ intervalHours: 5 }) })).status).toBe(400);
    expect((await j("/api/sweep", { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) })).status).toBe(400);
    expect((await j("/api/sweep", { method: "PATCH", body: "{}" })).status).toBe(400);
    const r = await j("/api/sweep", { method: "PATCH", body: JSON.stringify({ enabled: true, intervalHours: 8 }) });
    expect(r.body.settings).toMatchObject({ enabled: true, intervalHours: 8 });
    expect(r.body.nextAt).toBe(clock.toISOString());
    expect(r.body.permission).toEqual({ research: "default", code: "acceptEdits" });
    expect(r.body.maxRuns).toBe(2);
    expect((await j("/api/sweep", { method: "PATCH", body: JSON.stringify({ enabled: false }) })).body.settings).toMatchObject({ enabled: false, intervalHours: 8 });
  });

  test("only open todos are looked at; #人工, runs in flight and parents with open steps are skipped without a model call", async () => {
    const { db, on, tick } = setup();
    await on();
    const open = createTodo(db, { title: "查一下 Bun 1.3 的新特性" });
    const doing = createTodo(db, { title: "进行中" }); updateTodo(db, doing.id, { status: "doing" });
    const review = createTodo(db, { title: "验收中" }); updateTodo(db, review.id, { status: "review" });
    const deferred = createTodo(db, { title: "暂不处理" }); updateTodo(db, deferred.id, { status: "deferred" });
    const done = createTodo(db, { title: "已完成" }); updateTodo(db, done.id, { status: "done" });
    const manual = createTodo(db, { title: "去银行办卡", tags: ["人工", "生活"] });
    const manualTitle = createTodo(db, { title: "给房东打电话 #人工" });
    const manualParent = createTodo(db, { title: "装修", tags: ["人工"] });
    const manualStep = createTodo(db, { title: "比较三家报价", parentId: manualParent.id });
    const busy = createTodo(db, { title: "正在执行" });
    db.query("INSERT INTO runs (todo_id, prompt, started_at) VALUES (?, 'x', ?)").run(busy.id, clock.toISOString());
    const parent = createTodo(db, { title: "写年终总结" });
    const step = createTodo(db, { title: "列出今年的项目", parentId: parent.id });
    const r = await tick();
    expect(r.body.status).toBe("ok");
    expect(triageCalls()).toHaveLength(1);
    expect(asked(triageCalls()[0]).sort((a, b) => a - b)).toEqual([open.id, step.id]);
    for (const t of [doing, review, deferred, done, manual, manualTitle, manualParent, manualStep, busy, parent]) expect(triageCalls()[0]!.prompt).not.toContain(`### #${t.id} `);
    expect(r.body.sweep.counts).toMatchObject({ open: 8, manual: 4, running: 1, hasSteps: 1, triaged: 2, cannot: 2 });
    // The prompt tells the model what an unattended run cannot do.
    expect(triageCalls()[0]!.body.system).toContain("accounts");
    expect(triageCalls()[0]!.body.system).toContain("physical action");
    expect(triageCalls()[0]!.prompt).toContain(abilitiesLine("acceptEdits"));
  });

  test("cannot leaves no trace on the task and is not asked again until the task changes", async () => {
    const { db, on, tick } = setup();
    await on();
    const t = createTodo(db, { title: "去超市买牛奶" });
    const before = listEvents(db, t.id);
    await tick();
    expect(listEvents(db, t.id)).toEqual(before);
    expect(listRecords(db, t.id)).toHaveLength(0);
    expect(listRuns(db, t.id)).toHaveLength(0);
    expect(sweepVerdict(db, t.id)).toMatchObject({ verdict: "cannot", version: t.version });
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    const again = await tick();
    expect(again.body.sweep.counts).toMatchObject({ seen: 1, triaged: 0 });
    expect(triageCalls()).toHaveLength(1);
  });

  test("unsure writes exactly one record and is not repeated until the task changes or the person adds a record", async () => {
    const { db, on, tick } = setup();
    await on();
    const t = createTodo(db, { title: "订去上海的机票" });
    verdict = () => ({ verdict: "unsure", reason: "缺信息", unclear: "不知道出发日期和舱位", decide: "告诉我日期、时间段和预算" });
    await tick();
    let records = listRecords(db, t.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.source).toBe("ai");
    expect(records[0]!.content).toContain("不知道出发日期和舱位");
    expect(records[0]!.content).toContain("告诉我日期、时间段和预算");
    const ev = listEvents(db, t.id).find((e) => e.kind === "record-added")!;
    expect(ev.data).toMatchObject({ source: "ai", via: "sweep", recordId: records[0]!.id });
    expect(listRuns(db, t.id)).toHaveLength(0);

    // The next sweep: nothing new, no model call about it, still one record.
    clock = new Date(clock.getTime() + 4 * 3_600_000);
    const second = await tick();
    expect(second.body.sweep.counts).toMatchObject({ seen: 1, triaged: 0, unsure: 0 });
    expect(triageCalls()).toHaveLength(1);
    expect(listRecords(db, t.id)).toHaveLength(1);

    // The person answers in a record: looked at again.
    appendRecord(db, t.id, "12 月 3 日上午，经济舱", "manual");
    clock = new Date(clock.getTime() + 4 * 3_600_000);
    await tick();
    expect(triageCalls()).toHaveLength(2);
    expect(listRecords(db, t.id)).toHaveLength(3);

    // Unchanged again: skipped. A change to the task: looked at again.
    clock = new Date(clock.getTime() + 4 * 3_600_000);
    await tick();
    expect(triageCalls()).toHaveLength(2);
    updateTodo(db, t.id, { notes: "从北京出发" });
    clock = new Date(clock.getTime() + 4 * 3_600_000);
    await tick();
    expect(triageCalls()).toHaveLength(3);
    records = listRecords(db, t.id);
    expect(records).toHaveLength(4);
  });

  test("do starts an execution through the execute path: a run under the task, from the sweep, then review", async () => {
    const { db, on, tick } = setup();
    await on();
    const research = createTodo(db, { title: "调研三款笔记软件的导出格式" });
    const code = createTodo(db, { title: "给 README 加一段安装说明" });
    verdict = (id) => ({ verdict: "do", kind: id === code.id ? "code" : "research", reason: "可以直接做" });
    const r = await tick();
    expect(r.body.sweep.counts).toMatchObject({ do: 2, started: 2, ok: 2, failed: 0 });
    const ex = execCalls();
    expect(ex).toHaveLength(2);
    // Research reads only; code gets the sweep's own permission (acceptEdits by default), never the manual default.
    const of = (id: number) => ex.find((c) => c.prompt.includes(id === code.id ? "给 README 加一段安装说明" : "调研三款笔记软件"))!.body;
    expect(of(research.id)).not.toHaveProperty("permissionMode");
    expect(of(research.id).mode).toBe("full");
    expect(of(code.id).permissionMode).toBe("acceptEdits");
    expect(String(of(code.id).prompt)).toContain("Kind of run: write code");
    for (const t of [research, code]) {
      const runs = listRuns(db, t.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: "ok", output: "## done", callId: 60 });
      const events = listEvents(db, t.id);
      expect(events.find((e) => e.kind === "run-started")!.data).toMatchObject({ runId: runs[0]!.id, via: "sweep" });
      expect(events.find((e) => e.kind === "review")!.data).toMatchObject({ source: "ai", runId: runs[0]!.id, via: "sweep" });
      expect(sweepVerdict(db, t.id)).toMatchObject({ verdict: "do", runId: runs[0]!.id });
    }
    expect(db.query("SELECT status FROM todos WHERE id IN (?, ?)").all(research.id, code.id)).toEqual([{ status: "review" }, { status: "review" }]);
  });

  test("TODO_SWEEP_PERMISSION=default makes code work not runnable: the model is told so and a code verdict does nothing", async () => {
    const { db, on, tick } = setup({ permission: "default" });
    await on();
    const t = createTodo(db, { title: "改一下配置文件" });
    verdict = () => ({ verdict: "do", kind: "code", reason: "改文件" });
    const r = await tick();
    expect(triageCalls()[0]!.prompt).toContain("code run: not available");
    expect(r.body.sweep.counts).toMatchObject({ invalid: 1, started: 0 });
    expect(execCalls()).toHaveLength(0);
    expect(listEvents(db, t.id).map((e) => e.kind)).toEqual(["created"]);
  });

  test("a failed run is not retried until the task changes", async () => {
    const { db, on, tick } = setup();
    await on();
    const t = createTodo(db, { title: "汇总本周的提交记录" });
    verdict = () => ({ verdict: "do", kind: "research", reason: "ok" });
    execFails = true;
    expect((await tick()).body.sweep.counts).toMatchObject({ started: 1, failed: 1 });
    expect(listRuns(db, t.id)[0]!.status).toBe("error");
    expect(db.query("SELECT status FROM todos WHERE id = ?").get(t.id)).toEqual({ status: "open" });
    execFails = false;
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    expect((await tick()).body.sweep.counts).toMatchObject({ seen: 1, started: 0 });
    expect(execCalls()).toHaveLength(1);
    updateTodo(db, t.id, { notes: "只看 main 分支" });
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    expect((await tick()).body.sweep.counts).toMatchObject({ started: 1, ok: 1 });
    expect(execCalls()).toHaveLength(2);
  });

  test("a malformed or incomplete triage answer does nothing and is asked again next time", async () => {
    const { db, on, tick } = setup();
    await on();
    const a = createTodo(db, { title: "任务甲" });
    const b = createTodo(db, { title: "任务乙" });
    raw = "Sure! Here is what I think: do them all.";
    const r = await tick();
    expect(r.body.sweep.counts).toMatchObject({ triaged: 2, invalid: 2, do: 0, unsure: 0, cannot: 0 });
    for (const t of [a, b]) {
      expect(listEvents(db, t.id).map((e) => e.kind)).toEqual(["created"]);
      expect(sweepVerdict(db, t.id)).toBeNull();
    }
    expect(execCalls()).toHaveLength(0);
    // A list with bad elements: a do without a kind, an unsure without what is unclear, an unknown verdict, an id not asked.
    raw = JSON.stringify([{ id: a.id, verdict: "do" }, { id: b.id, verdict: "unsure", reason: "?" }, { id: 999, verdict: "do", kind: "research" }]);
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    expect((await tick()).body.sweep.counts).toMatchObject({ triaged: 2, invalid: 2 });
    expect(execCalls()).toHaveLength(0);
    for (const t of [a, b]) expect(listRecords(db, t.id)).toHaveLength(0);
  });

  test("readTriage keeps only clean verdicts for the ids asked; a repeated id counts as none", () => {
    const ids = new Set([1, 2, 3, 4]);
    const v = readTriage('```json\n[{"id":1,"verdict":"do","kind":"research","reason":"r"},{"id":2,"verdict":"cannot"},{"id":3,"verdict":"do","kind":"code"},{"id":3,"verdict":"cannot"},{"id":4,"verdict":"maybe"}]\n```', ids);
    expect([...v.keys()]).toEqual([1, 2]);
    expect(v.get(1)).toEqual({ verdict: "do", kind: "research", reason: "r" });
    expect(readTriage('[{"id":3,"verdict":"do","kind":"code"}]', ids, false).size).toBe(0);
    expect(readTriage("{}", ids).size).toBe(0);
    expect(unsureRecord({ verdict: "unsure", reason: "", unclear: "A", decide: "B" }, "en")).toContain("**What you need to decide:** B");
  });

  test("interval: a tick runs only once the chosen hours have passed; a manual sweep skips the wait", async () => {
    const { db, on, tick, j } = setup();
    await on(4);
    createTodo(db, { title: "x" });
    expect((await tick()).body.status).toBe("ok");
    clock = new Date(clock.getTime() + 3_600_000);
    const early = await tick();
    expect(early.body).toMatchObject({ ok: true, status: "skipped" });
    expect(early.body.error).toContain("not due until 2026-11-22T04:00:00.000Z");
    expect((await j("/api/sweep")).body.nextAt).toBe("2026-11-22T04:00:00.000Z");
    expect((await tick(true)).body.status).toBe("ok");
    // The manual one counts as the last sweep: the clock starts again from it.
    clock = new Date(Date.parse("2026-11-22T04:00:00Z"));
    expect((await tick()).body.status).toBe("skipped");
    clock = new Date(Date.parse("2026-11-22T05:00:00Z"));
    expect((await tick()).body.status).toBe("ok");
    // 24 hours chosen: the next one waits a day.
    await on(24);
    clock = new Date(Date.parse("2026-11-22T10:00:00Z"));
    expect((await tick()).body.status).toBe("skipped");
    expect(db.query("SELECT COUNT(*) AS n FROM sweeps").get()).toEqual({ n: 3 });
  });

  test("never two sweeps at once", async () => {
    const { db, on, tick, j } = setup();
    await on();
    createTodo(db, { title: "整理下载目录里的文档清单" });
    verdict = () => ({ verdict: "do", kind: "research", reason: "ok" });
    let release = () => {};
    hold = new Promise((r) => { release = r; });
    const started = await j("/api/sweep/run", { method: "POST" });
    expect(started.status).toBe(202);
    expect(started.body.started.trigger).toBe("manual");
    // Wait until its run is in flight.
    for (let i = 0; i < 100 && !execCalls().length; i++) await Bun.sleep(10);
    expect(execCalls()).toHaveLength(1);
    expect((await j("/api/sweep/run", { method: "POST" })).status).toBe(409);
    const busy = await tick(true);
    expect(busy.body.status).toBe("skipped");
    expect(busy.body.error).toContain("still running");
    expect((await j("/api/sweep")).body.running.id).toBe(started.body.started.id);
    release();
    for (let i = 0; i < 100 && (await j("/api/sweep")).body.running; i++) await Bun.sleep(10);
    const st = (await j("/api/sweep")).body;
    expect(st.running).toBeNull();
    expect(st.last).toMatchObject({ status: "ok", counts: { started: 1, ok: 1 } });
    expect(triageCalls()).toHaveLength(1);
  });

  test("the cap: at most maxRuns executions per sweep, one at a time; the rest is looked at next time", async () => {
    const { db, on, tick } = setup({ maxRuns: 2 });
    await on();
    const ts = [createTodo(db, { title: "一" }), createTodo(db, { title: "二" }), createTodo(db, { title: "三" })];
    verdict = () => ({ verdict: "do", kind: "research", reason: "ok" });
    const r = await tick();
    expect(r.body.sweep.counts).toMatchObject({ do: 3, started: 2, ok: 2, overCap: 1 });
    expect(execCalls()).toHaveLength(2);
    const left = ts.filter((t) => !listRuns(db, t.id).length);
    expect(left).toHaveLength(1);
    expect(sweepVerdict(db, left[0]!.id)).toBeNull();
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    const next = await tick();
    expect(asked(triageCalls()[1])).toEqual([left[0]!.id]);
    expect(next.body.sweep.counts).toMatchObject({ started: 1 });
  });

  test("a task changed while the sweep ran its other executions is left alone", async () => {
    const { db, on, j } = setup({ maxRuns: 5 });
    await on();
    const a = createTodo(db, { title: "甲" });
    const b = createTodo(db, { title: "乙" });
    verdict = () => ({ verdict: "do", kind: "research", reason: "ok" });
    let release = () => {};
    hold = new Promise((r) => { release = r; });
    await j("/api/sweep/run", { method: "POST" });
    for (let i = 0; i < 100 && !execCalls().length; i++) await Bun.sleep(10);
    // The first one runs; the person edits the second meanwhile.
    const second = listRuns(db, a.id).length ? b : a;
    updateTodo(db, second.id, { title: "乙（改了）" });
    release();
    for (let i = 0; i < 100 && (await j("/api/sweep")).body.running; i++) await Bun.sleep(10);
    expect((await j("/api/sweep")).body.last.counts).toMatchObject({ started: 1, changed: 1 });
    expect(listRuns(db, second.id)).toHaveLength(0);
  });
});
