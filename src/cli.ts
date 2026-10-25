/**
 * Command line over the running service, for the `planner` agent and for the shell:
 *   bun src/cli.ts list [--all|--done|--review|--deferred] [--q text] [--tag t] [--project p]
 *   bun src/cli.ts record <id> <content> | records <id> [--before id]
 *   bun src/cli.ts record-edit <id> <record-id> <content> [--file path] [--expect revision]   correct a record; the old text is kept
 *   bun src/cli.ts plan <id>                                      print the plan (方案)
 *   bun src/cli.ts plan <id> --set <text> | --file <path|->  [--expect version]   replace the plan; the old version is kept
 *   bun src/cli.ts plan-history <id> [--version n]                the plan's versions, or one in full
 *   bun src/cli.ts show <id>
 *   bun src/cli.ts add <title> [--due YYYY-MM-DD[THH:MM]] [--priority 0-3] [--tags a,b] [--project p] [--notes text] [--parent id]
 *   bun src/cli.ts done <id> | start <id> | defer <id> | reopen <id> | rm <id>      (done and rm take the subtasks along)
 *   bun src/cli.ts review <id>                   finished work: hand it to the person for acceptance (验收)
 *   bun src/cli.ts accept <id> | reject <id> <reason>   the person's verdict on a task in review
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
/** A long text from a file, or from standard input with `-`: no shell quoting to get wrong. */
const readText = async (path: string): Promise<string> => (path === "-" ? await new Response(Bun.stdin.stream()).text() : await Bun.file(path).text());
const call = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (await r.json()) as Record<string, unknown> & { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) die(`failed: ${body.error ?? `HTTP ${r.status}`}`);
  return body;
};
type Todo = { id: number; title: string; status: string; priority: number; due: string | null; tags: string[]; project: string | null; notes: string; plan: string; planVersion: number; source: string; parentId: number | null; subtasks: { total: number; done: number }; createdAt: string; doneAt: string | null };
const line = (t: Todo, indent = "") => `#${t.id}\t${t.status}\t${t.due ?? "-"}\t${"!".repeat(t.priority) || "-"}\t${indent}${t.title}${t.subtasks?.total ? ` [${t.subtasks.done}/${t.subtasks.total}]` : ""}${t.project ? ` @${t.project}` : ""}${t.tags.length ? ` ${t.tags.map((x) => `#${x}`).join(" ")}` : ""}`;

try {
  switch (cmd) {
    case "list": {
      const q = new URLSearchParams({ status: "all" in flags ? "all" : "done" in flags ? "done" : "review" in flags ? "review" : "deferred" in flags ? "deferred" : "active" });
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
      const r = (await call(`/api/todos/${id}`)) as { todo: Todo; planMeta: { version: number; source: string; createdAt: string } | null; parent: Todo | null; subtasks: Todo[]; events: { kind: string; at: string; data: Record<string, unknown> }[]; records: { id: number; content: string; source: string; createdAt: string; revision: number; editedAt: string | null }[]; recordsNextBefore: number | null; runs: { id: number; status: string; startedAt: string; output: string; error: string | null }[] };
      console.log(line(r.todo));
      if (r.parent) console.log(`subtask of ${line(r.parent)}`);
      if (r.subtasks.length) { console.log("\nsubtasks:"); for (const s of r.subtasks) console.log(line(s, "  ↳ ")); }
      if (r.todo.notes) console.log(`\n${r.todo.notes}`);
      console.log(`\ncreated ${r.todo.createdAt} (${r.todo.source})${r.todo.doneAt ? `, done ${r.todo.doneAt}` : ""}`);
      if (r.todo.plan) console.log(`\n=== plan v${r.todo.planVersion}${r.planMeta ? ` ${r.planMeta.createdAt} (${r.planMeta.source})` : ""}\n${r.todo.plan}\n=== end of plan`);
      for (const entry of r.records) console.log(`\n--- record ${entry.id} ${entry.createdAt} (${entry.source})${entry.revision ? ` edited ${entry.editedAt} (revision ${entry.revision})` : ""}\n${entry.content}`);
      if (r.recordsNextBefore) console.log(`\nEarlier records: records ${id} --before ${r.recordsNextBefore}`);
      for (const run of r.runs) console.log(`\n--- run ${run.id} ${run.status} ${run.startedAt}${run.error ? ` (${run.error})` : ""}\n${run.output}`);
      break;
    }
    case "record": {
      const id = Number(args[0]); const content = args.slice(1).join(" ");
      if (!Number.isInteger(id) || id <= 0 || !content.trim()) die("usage: record <id> <content>");
      console.log(JSON.stringify(await call(`/api/todos/${id}/records`, { method: "POST", body: JSON.stringify({ content, source: "cli" }) }), null, 2));
      break;
    }
    case "record-edit": {
      const id = Number(args[0]); const rid = Number(args[1]);
      const content = flags.file !== undefined ? await readText(flags.file) : args.slice(2).join(" ");
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(rid) || rid <= 0 || !content.trim()) die("usage: record-edit <id> <record-id> <content> [--file path] [--expect revision]");
      const { record } = (await call(`/api/todos/${id}/records/${rid}`, { method: "PATCH", body: JSON.stringify({ content, source: "cli", ...(flags.expect ? { expectedRevision: Number(flags.expect) } : {}) }) })) as { record: { id: number; revision: number } };
      console.log(`record ${record.id} of #${id} is now revision ${record.revision}; earlier text kept (record-revisions via the API)`);
      break;
    }
    case "plan": {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) die("usage: plan <id> [--set text | --file path|-] [--expect version]");
      if (flags.set === undefined && flags.file === undefined) {
        const r = (await call(`/api/todos/${id}/plan`)) as { plan: string; planVersion: number; planMeta: { createdAt: string; source: string } | null };
        if (!r.planVersion) { console.log("(no plan)"); break; }
        console.log(`plan v${r.planVersion}${r.planMeta ? ` ${r.planMeta.createdAt} (${r.planMeta.source})` : ""}\n\n${r.plan}`);
        break;
      }
      const content = flags.file !== undefined ? await readText(flags.file) : flags.set!;
      const r = (await call(`/api/todos/${id}/plan`, { method: "PUT", body: JSON.stringify({ content, source: "cli", ...(flags.expect ? { expectedVersion: Number(flags.expect) } : {}) }) })) as { todo: Todo };
      console.log(`plan of #${id} is now v${r.todo.planVersion} (${r.todo.plan.length} characters)`);
      break;
    }
    case "plan-history": {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) die("usage: plan-history <id> [--version n]");
      if (flags.version) {
        const { version } = (await call(`/api/todos/${id}/plan/versions?version=${Number(flags.version)}`)) as { version: { version: number; source: string; createdAt: string; content: string } };
        console.log(`plan v${version.version} ${version.createdAt} (${version.source})\n\n${version.content}`);
        break;
      }
      const { versions } = (await call(`/api/todos/${id}/plan/versions`)) as { versions: { version: number; source: string; createdAt: string; chars: number; excerpt: string }[] };
      if (!versions.length) console.log("(no plan)");
      for (const v of versions) console.log(`v${v.version}\t${v.createdAt}\t${v.source}\t${v.chars} chars\t${v.excerpt.slice(0, 60)}`);
      break;
    }
    case "records": {
      const id = Number(args[0]);
      if (!Number.isInteger(id) || id <= 0) die("usage: records <id> [--before id]");
      const q = new URLSearchParams();
      if (flags.before) q.set("before", flags.before);
      console.log(JSON.stringify(await call(`/api/todos/${id}/records?${q}`), null, 2));
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
    case "accept": case "reject": {
      const id = Number(args[0]); const reason = args.slice(1).join(" ").trim();
      if (!id || (cmd === "reject" && !reason)) die(cmd === "reject" ? "usage: reject <id> <reason>" : "usage: accept <id>");
      const { todo } = (await call(`/api/todos/${id}/review`, { method: "POST", body: JSON.stringify({ verdict: cmd, reason: reason || undefined, source: "cli" }) })) as { todo: Todo };
      console.log(line(todo));
      break;
    }
    case "defer": case "done": case "start": case "reopen": case "review": {
      const id = Number(args[0]); if (!id) die(`usage: ${cmd} <id>`);
      const status = cmd === "defer" ? "deferred" : cmd === "done" ? "done" : cmd === "start" ? "doing" : cmd === "review" ? "review" : "open";
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
      console.log("usage: list [--all|--done|--review|--deferred] [--q text] [--tag t] [--project p] | show <id> | record <id> <content> | records <id> [--before id] | record-edit <id> <record-id> <content> [--file path] [--expect revision] | plan <id> [--set text | --file path|-] [--expect version] | plan-history <id> [--version n] | add <title> [--due d] [--priority n] [--tags a,b] [--project p] [--notes text] [--parent id] | done <id> | start <id> | review <id> | accept <id> | reject <id> <reason> | defer <id> | reopen <id> | rm <id> | move <id> <parent-id|none> | parse <text> | execute <id> [--extra text]");
  }
} catch (e) {
  die((e as Error).message);
}
