/**
 * Command line over the running service, for the `planner` agent and for the shell:
 *   bun src/cli.ts list [--all|--done] [--q text] [--tag t] [--project p]
 *   bun src/cli.ts show <id>
 *   bun src/cli.ts add <title> [--due YYYY-MM-DD[THH:MM]] [--priority 0-3] [--tags a,b] [--project p] [--notes text] [--parent id]
 *   bun src/cli.ts done <id> | start <id> | reopen <id> | rm <id>      (done and rm take the subtasks along)
 *   bun src/cli.ts move <id> <parent-id|none>   make it a subtask of another todo, or take it out
 *   bun src/cli.ts parse <text>         free text -> drafts (printed, not added)
 *   bun src/cli.ts execute <id> [--extra text]   hand the todo to the AI, print the result
 * The base URL is TODO_URL, else http://127.0.0.1:${PORT:-8970}.
 */
const base = (process.env.TODO_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8970}`).replace(/\/$/, "");
const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) { flags[a.slice(2)] = rest[i + 1] ?? ""; i++; } else args.push(a);
}
const die = (msg: string): never => { console.error(msg); process.exit(1); };
const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (await r.json()) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) die(`failed: ${body.error ?? `HTTP ${r.status}`}`);
  return body;
};
type Todo = { id: number; title: string; status: string; priority: number; due: string | null; tags: string[]; project: string | null; notes: string; source: string; parentId: number | null; subtasks: { total: number; done: number }; createdAt: string; doneAt: string | null };
const line = (t: Todo, indent = "") => `#${t.id}\t${t.status}\t${t.due ?? "-"}\t${"!".repeat(t.priority) || "-"}\t${indent}${t.title}${t.subtasks?.total ? ` [${t.subtasks.done}/${t.subtasks.total}]` : ""}${t.project ? ` @${t.project}` : ""}${t.tags.length ? ` ${t.tags.map((x) => `#${x}`).join(" ")}` : ""}`;

try {
  switch (cmd) {
    case "list": {
      const q = new URLSearchParams({ status: "all" in flags ? "all" : "done" in flags ? "done" : "active" });
      for (const k of ["q", "tag", "project"]) if (flags[k]) q.set(k, flags[k]!);
      const { todos } = (await call(`/api/todos?${q}`)) as { todos: Todo[] };
      if (!todos.length) console.log("(none)");
      // Subtasks under their parent when both are listed; a subtask alone names its parent.
      const ids = new Set(todos.map((t) => t.id));
      for (const t of todos) {
        if (t.parentId && ids.has(t.parentId)) continue;
        console.log(line(t) + (t.parentId ? ` (subtask of #${t.parentId})` : ""));
        for (const s of todos) if (s.parentId === t.id) console.log(line(s, "  ↳ "));
      }
      break;
    }
    case "show": {
      const id = Number(args[0]); if (!id) die("usage: show <id>");
      const r = (await call(`/api/todos/${id}`)) as { todo: Todo; parent: Todo | null; subtasks: Todo[]; events: { kind: string; at: string; data: Record<string, unknown> }[]; runs: { id: number; status: string; startedAt: string; output: string; error: string | null }[] };
      console.log(line(r.todo));
      if (r.parent) console.log(`subtask of ${line(r.parent)}`);
      if (r.subtasks.length) { console.log("\nsubtasks:"); for (const s of r.subtasks) console.log(line(s, "  ↳ ")); }
      if (r.todo.notes) console.log(`\n${r.todo.notes}`);
      console.log(`\ncreated ${r.todo.createdAt} (${r.todo.source})${r.todo.doneAt ? `, done ${r.todo.doneAt}` : ""}`);
      for (const run of r.runs) console.log(`\n--- run ${run.id} ${run.status} ${run.startedAt}${run.error ? ` (${run.error})` : ""}\n${run.output}`);
      break;
    }
    case "add": {
      const title = args.join(" ").trim(); if (!title) die("usage: add <title> [--due ...] [--priority n] [--tags a,b] [--project p] [--notes text]");
      const { todo } = (await call("/api/todos", { method: "POST", body: JSON.stringify({ title, due: flags.due || null, priority: flags.priority ?? 0, tags: flags.tags ?? [], project: flags.project || null, notes: flags.notes ?? "", parentId: flags.parent ? Number(flags.parent) : null, source: "cli" }) })) as { todo: Todo };
      console.log(line(todo));
      break;
    }
    case "move": {
      const id = Number(args[0]); const to = args[1];
      if (!id || !to) die("usage: move <id> <parent-id|none>");
      const { todo } = (await call(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ parentId: to === "none" ? null : Number(to), source: "cli" }) })) as { todo: Todo };
      console.log(line(todo) + (todo.parentId ? ` (subtask of #${todo.parentId})` : ""));
      break;
    }
    case "done": case "start": case "reopen": {
      const id = Number(args[0]); if (!id) die(`usage: ${cmd} <id>`);
      const status = cmd === "done" ? "done" : cmd === "start" ? "doing" : "open";
      const { todo } = (await call(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status, source: "cli" }) })) as { todo: Todo };
      console.log(line(todo));
      break;
    }
    case "rm": {
      const id = Number(args[0]); if (!id) die("usage: rm <id>");
      await call(`/api/todos/${id}`, { method: "DELETE" });
      console.log(`deleted #${id}`);
      break;
    }
    case "parse": {
      const text = args.join(" ").trim(); if (!text) die("usage: parse <text>");
      const { drafts } = (await call("/api/ai/parse", { method: "POST", body: JSON.stringify({ text }) })) as { drafts: unknown[] };
      console.log(JSON.stringify(drafts, null, 2));
      break;
    }
    case "execute": {
      const id = Number(args[0]); if (!id) die("usage: execute <id> [--extra text]");
      const r = await fetch(`${base}/api/todos/${id}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ extra: flags.extra ?? "" }) });
      if (!r.ok) die(`failed: ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`}`);
      const dec = new TextDecoder(); let buf = "";
      const reader = r.body!.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const p = JSON.parse(data) as { text?: string; error?: string };
          if (ev === "delta") process.stdout.write(p.text ?? "");
          else if (ev === "error") { console.error(`\nfailed: ${p.error}`); process.exit(1); }
          else if (ev === "done") process.stdout.write("\n");
        }
      }
      break;
    }
    default:
      console.log("usage: list [--all|--done] [--q text] [--tag t] [--project p] | show <id> | add <title> [--due d] [--priority n] [--tags a,b] [--project p] [--notes text] [--parent id] | done <id> | start <id> | reopen <id> | rm <id> | move <id> <parent-id|none> | parse <text> | execute <id> [--extra text]");
  }
} catch (e) {
  die((e as Error).message);
}
