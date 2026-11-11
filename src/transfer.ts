/**
 * Moving a todo to another machine's list. Every machine keeps its own list (remote.ts), so a move
 * is a copy made on the target through the page's own routes, then a delete on the source: the
 * todo with its notes, plan, stage, subtasks and records (pictures re-uploaded, since each machine
 * has its own store). The plan's older versions, the event history and the AI runs stay behind:
 * they are the source machine's history of it. A failure before the delete removes the copy, so
 * the todo is never on both lists nor on neither.
 */
import type { OperationRecord, Run, Todo } from "./types.ts";

/** One of the page's routes on a machine: "" is this one, else a peer (through the bus). */
export type MachineCall = (machine: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: { json: unknown } | { form: FormData }) => Promise<Response>;

export type TransferResult = { ok: true; todo: Todo; warning?: string } | { ok: false; status: number; error: string };

class Stop extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Detail = { todo: Todo; records: OperationRecord[]; recordsNextBefore: number | null; subtasks: Todo[]; runs: Run[] };

export async function transferTodo(call: MachineCall, o: { id: number; from: string; to: string; fromName: string; toName: string; lang?: string }): Promise<TransferResult> {
  const ask = async <T>(machine: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: { json: unknown } | { form: FormData }): Promise<T> => {
    const res = await call(machine, method, path, body);
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || out.ok === false) throw new Stop(res.status >= 400 ? res.status : 502, `${machine === o.from ? o.fromName : o.toName}: ${out.error ?? `HTTP ${res.status}`}`);
    return out as T;
  };

  /** Every record of a todo, oldest first. */
  const recordsOf = async (id: number, first?: Pick<Detail, "records" | "recordsNextBefore">): Promise<OperationRecord[]> => {
    let page = first ?? (await ask<Detail>(o.from, "GET", `/api/todos/${id}/records`));
    const all = [...page.records];
    while (page.recordsNextBefore) {
      page = await ask<Detail>(o.from, "GET", `/api/todos/${id}/records?before=${page.recordsNextBefore}`);
      all.push(...page.records);
    }
    return all.reverse();
  };

  /** A record on the target, with its pictures read from the source and its own time kept (a target that knows `createdAt`). */
  const copyRecord = async (to: number, r: OperationRecord): Promise<void> => {
    if (!r.attachments?.length) {
      await ask(o.to, "POST", `/api/todos/${to}/records`, { json: { content: r.content, source: r.source, createdAt: r.createdAt } });
      return;
    }
    const form = new FormData();
    form.set("content", r.content);
    form.set("source", r.source);
    form.set("createdAt", r.createdAt);
    for (const a of r.attachments) {
      const res = await call(o.from, "GET", `/blobs/${a.key}`);
      if (!res.ok) throw new Stop(502, `${o.fromName}: the picture ${a.name} could not be read (HTTP ${res.status})`);
      form.append("images", new File([await res.arrayBuffer()], a.name || "image", { type: a.mime }));
    }
    await ask(o.to, "POST", `/api/todos/${to}/records`, { form });
  };

  /** A todo on the target like the one given; its stage is set after its records and subtasks. */
  const create = async (t: Todo, parentId?: number): Promise<number> => {
    const draft = { title: t.title, notes: t.notes, ...(t.plan ? { plan: t.plan } : {}), due: t.due, priority: t.priority, tags: t.tags, project: t.project, source: t.source, ...(parentId ? { parentId } : {}) };
    return (await ask<{ todo: Todo }>(o.to, "POST", "/api/todos", { json: draft })).todo.id;
  };
  const setStatus = async (id: number, t: Todo): Promise<void> => {
    if (t.status !== "open") await ask(o.to, "PATCH", `/api/todos/${id}`, { json: { status: t.status, source: t.source } });
  };

  let made = 0;
  try {
    const src = await ask<Detail>(o.from, "GET", `/api/todos/${o.id}`);
    if (src.todo.parentId) throw new Stop(400, "a subtask moves with its parent task: move that one");
    if (src.runs.some((r) => r.status === "running")) throw new Stop(409, "an AI run is working on this task; move it when the run has ended");
    made = await create(src.todo);
    for (const sub of src.subtasks) {
      const id = await create(sub, made);
      for (const r of await recordsOf(sub.id)) await copyRecord(id, r);
      await setStatus(id, sub);
    }
    for (const r of await recordsOf(o.id, src)) await copyRecord(made, r);
    const note = o.lang === "en" ? `Moved here from ${o.fromName} (it was #${o.id} there).` : `从 ${o.fromName} 转移而来（在那边是 #${o.id}）。`;
    await ask(o.to, "POST", `/api/todos/${made}/records`, { json: { content: note, source: "manual" } });
    await setStatus(made, src.todo);
    const todo = (await ask<Detail>(o.to, "GET", `/api/todos/${made}`)).todo;
    // The copy is whole: only now does the source let go of it.
    const gone = await call(o.from, "DELETE", `/api/todos/${o.id}`);
    if (!gone.ok) return { ok: true, todo, warning: `it is on ${o.toName} now, but ${o.fromName} could not remove its own copy (HTTP ${gone.status}); delete #${o.id} there` };
    return { ok: true, todo };
  } catch (e) {
    // Leave nothing half-made on the target.
    if (made) await call(o.to, "DELETE", `/api/todos/${made}`).catch(() => {});
    return e instanceof Stop ? { ok: false, status: e.status, error: e.message } : { ok: false, status: 502, error: (e as Error).message };
  }
}
