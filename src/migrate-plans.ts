/**
 * One-time copy of the evaluations written before plans existed into the plans:
 *   bun src/migrate-plans.ts [--dry-run] [--db path]
 * For every todo whose newest record starting with `## AI 评估` exists and that has never had a plan
 * (planVersion 0), that record's text becomes plan v1, source `ai`, with `migratedFrom: <record id>` in
 * its `plan-edited` event. The records stay as they are. Running it again changes nothing; `--dry-run`
 * prints the same list and writes nothing. The database is DATABASE_URL (as the service), or `--db`.
 */
import { databasePath } from "./config.ts";
import { getTodo, openDb, setPlan } from "./db.ts";

export type Migration = { todoId: number; recordId: number; title: string | null; chars: number; action: "copy" | "has-plan" | "no-todo" };

export function migratePlans(db: ReturnType<typeof openDb>, dryRun: boolean): Migration[] {
  // The newest evaluation per todo: the highest record id among those starting with the heading.
  const rows = db.query(`SELECT r.id, r.todo_id, r.content FROM todo_records r
    WHERE r.content LIKE '## AI 评估%' AND r.id = (SELECT MAX(x.id) FROM todo_records x WHERE x.todo_id = r.todo_id AND x.content LIKE '## AI 评估%')
    ORDER BY r.todo_id`).all() as { id: number; todo_id: number; content: string }[];
  const out: Migration[] = [];
  const run = () => {
    for (const r of rows) {
      const todo = getTodo(db, r.todo_id);
      const action = !todo ? "no-todo" : todo.planVersion > 0 ? "has-plan" : "copy";
      out.push({ todoId: r.todo_id, recordId: r.id, title: todo?.title ?? null, chars: r.content.length, action });
      if (action === "copy" && !dryRun) setPlan(db, r.todo_id, r.content, "ai", { origin: { migratedFrom: r.id } });
    }
  };
  db.transaction(run)();
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const i = argv.indexOf("--db");
  const path = i >= 0 ? argv[i + 1]! : databasePath();
  const db = openDb(path);
  const list = migratePlans(db, dryRun);
  console.log(`${dryRun ? "dry run, nothing written" : "written"}: ${path}`);
  for (const m of list) console.log(`#${m.todoId}\trecord ${m.recordId}\t${m.chars} chars\t${m.action === "copy" ? (dryRun ? "would copy" : "copied") : m.action === "has-plan" ? "skip: has a plan" : "skip: todo deleted"}\t${m.title ?? ""}`);
  console.log(`${list.filter((m) => m.action === "copy").length} of ${list.length} evaluation(s) ${dryRun ? "would become" : "became"} plan v1`);
  db.close();
}
