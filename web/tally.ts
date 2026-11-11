/**
 * The left column's numbers after one change on the page, worked out at once: the machine's answer
 * comes a round trip later (through ai-space's bus for another machine, every machine for 全部机器),
 * and the next read of the list (`load()` in app.ts) replaces these with the machine's own.
 */

export type Counts = { active: number; review: number; deferred: number; done: number };
export type Stage = keyof Counts;
/** What a tally needs of a list row: `m` is its machine in the all-machines view. */
export type TallyRow = { id: number; status: string; parentId: number | null; tags: string[]; project: string | null; m?: string };
export type Tally<T extends TallyRow> = {
  /** The size of every stage, as the server's `statusCounts`; null when no machine answered. */
  counts: Counts | null;
  /** The active rows: 全部, 今天 and 即将 are counted from them. */
  active: T[];
  /** The tags and projects of the stage the view lists them for (`scopeOf`). */
  tags: { tag: string; n: number }[];
  projects: { project: string; n: number }[];
};
/** A row the change touched: its new status, or null when it is gone. */
export type Moved = { id: number; m?: string; status: string | null };

/** The stage a status counts in (dropped counts in none). */
export const stageOf = (status: string): Stage | null =>
  status === "open" || status === "doing" ? "active" : status === "review" || status === "deferred" || status === "done" ? status : null;

/** The stage whose tags and projects the list answer carries for a list status (the server's `scope`). */
export const scopeOf = (status: string): Stage => (status === "review" || status === "deferred" ? status : "active");

const same = (a: TallyRow, b: TallyRow) => a.id === b.id && a.m === b.m;

/** One name's count up or down; a name at zero leaves the list. Largest first, as the server sorts. */
function bump<K extends "tag" | "project">(list: ({ n: number } & Record<K, string>)[], k: K, names: string[], by: 1 | -1) {
  const out = list.map((x) => ({ ...x }));
  for (const name of names) {
    const x = out.find((y) => y[k] === name);
    if (x) x.n += by;
    else if (by > 0) out.push({ [k]: name, n: 1 } as { n: number } & Record<K, string>);
  }
  return out.filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a[k].localeCompare(b[k]));
}

/**
 * The tally after `row` became `to` ("deleted" when it was deleted). As the server does it, done on a
 * parent finishes its active subtasks, deleting a parent deletes them, and deferring a parent takes them
 * out of the active list (their own status stays). `activeDelta` is the change of the machine's open count.
 */
export function moveRow<T extends TallyRow>(t: Tally<T>, row: T, to: T["status"] | "deleted", scope: Stage): Tally<T> & { activeDelta: number; moved: Moved[] } {
  const status: T["status"] | null = to === "deleted" ? null : to;
  const changes: { row: T; status: T["status"] | null; stage: Stage | null }[] = [{ row, status, stage: status === null ? null : stageOf(status) }];
  if (row.parentId === null && (to === "done" || to === "deleted" || to === "deferred")) {
    for (const k of t.active) {
      if (k.parentId !== row.id || k.m !== row.m) continue;
      changes.push(to === "deferred" ? { row: k, status: k.status, stage: null } : { row: k, status, stage: status === null ? null : stageOf(status) });
    }
  }
  const counts = t.counts && { ...t.counts };
  const active = [...t.active];
  let { tags, projects } = t;
  let activeDelta = 0;
  for (const c of changes) {
    const from = stageOf(c.row.status);
    const i = active.findIndex((x) => same(x, c.row));
    if (c.stage === "active") {
      const next = { ...c.row, status: c.status! };
      if (i >= 0) active[i] = next; else active.push(next);
    } else if (i >= 0) active.splice(i, 1);
    if (from === c.stage) continue;
    // A subtask of a deferred parent (stage null, status kept) leaves the active count and joins no other.
    if (counts) {
      if (from) counts[from] = Math.max(0, counts[from] - 1);
      if (c.stage) counts[c.stage] += 1;
    }
    if (from === "active") activeDelta -= 1;
    if (c.stage === "active") activeDelta += 1;
    const by = from === scope ? -1 : c.stage === scope ? 1 : 0;
    if (by) {
      tags = bump(tags, "tag", c.row.tags, by);
      if (c.row.project) projects = bump(projects, "project", [c.row.project], by);
    }
  }
  return { counts, active, tags, projects, activeDelta, moved: changes.map((c) => ({ id: c.row.id, ...(c.row.m !== undefined ? { m: c.row.m } : {}), status: c.status })) };
}
