/**
 * The list the page shows, made from each machine's answer as it comes: `load()` in app.ts draws
 * after every one, so a slow or silent machine does not hold the others back. One machine's list is
 * shown as it is; 全部机器 tags every row with its machine, adds up the counts, tags, projects and
 * the week's trend, and sorts the done list newest first across machines.
 */
import type { Counts } from "./tally.ts";

export type Point = { t: string; v: number | null };
type Named<K extends string> = { n: number } & Record<K, string>;
/** What the merge needs of a list answer (`GET /api/todos?fields=list`). */
export type ListPart<T> = { todos: T[]; tags: Named<"tag">[]; projects: Named<"project">[]; counts: Counts; total?: number; nextBefore?: string | null };
/** One machine's answer: the view's list, the unfiltered active list (null when the view's list is that one), the week's completions (null when unread). */
export type Answer<T> = { r: ListPart<T>; a: { todos: T[] } | null; w: Point[] | null };
export type Merged<T> = {
  todos: T[];
  active: T[];
  tags: Named<"tag">[];
  projects: Named<"project">[];
  /** null while no machine has answered. */
  counts: Counts | null;
  /** The next done page's cursor per machine that has more. */
  doneCursors: Map<string, string>;
  doneTotal: number;
  trend: Point[] | null;
};

/** Sums of the same key over several machines' lists (projects, tags), largest first. */
export const sumBy = <K extends string>(lists: Named<K>[][], k: K): Named<K>[] => {
  const n = new Map<string, number>();
  for (const l of lists) for (const x of l) n.set(x[k], (n.get(x[k]) ?? 0) + x.n);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, v]) => ({ [k]: key, n: v }) as Named<K>);
};

/** The all-machines done list: newest finished first across machines. */
export const byDone = (a: { doneAt?: string | null }, b: { doneAt?: string | null }) => (b.doneAt ?? "").localeCompare(a.doneAt ?? "");

/**
 * The answers so far, in the order the machines are listed, as one list. `all` tags each row with its
 * machine (`m`); `done` sorts the rows of several machines by when they were finished.
 */
export function mergeAnswers<T extends { doneAt?: string | null }>(answers: [string, Answer<T>][], o: { all: boolean; done: boolean }): Merged<T & { m?: string }> {
  const tagged = (xs: T[], m: string): (T & { m?: string })[] => (o.all ? xs.map((t) => ({ ...t, m })) : xs);
  const todos = answers.flatMap(([m, x]) => tagged(x.r.todos, m));
  if (o.all && o.done) todos.sort(byDone);
  const ws = answers.flatMap(([, x]) => (x.w ? [x.w] : []));
  let trend: Point[] | null = ws[0] ?? null;
  // The week's completions, day by day, added up over the machines that answered it.
  if (ws.length > 1) {
    const days = new Map<string, number>();
    for (const w of ws) for (const p of w) days.set(p.t, (days.get(p.t) ?? 0) + (p.v ?? 0));
    trend = [...days].sort((a, b) => a[0].localeCompare(b[0])).slice(-7).map(([t, v]) => ({ t, v }));
  }
  return {
    todos,
    active: answers.flatMap(([m, x]) => tagged((x.a ?? x.r).todos, m)),
    tags: sumBy(answers.map(([, x]) => x.r.tags), "tag"),
    projects: sumBy(answers.map(([, x]) => x.r.projects), "project"),
    counts: answers.length ? answers.reduce((s, [, x]) => ({ active: s.active + x.r.counts.active, review: s.review + x.r.counts.review, deferred: s.deferred + x.r.counts.deferred, done: s.done + x.r.counts.done }), { active: 0, review: 0, deferred: 0, done: 0 }) : null,
    doneCursors: new Map(answers.flatMap(([m, x]) => (x.r.nextBefore ? [[m, x.r.nextBefore] as const] : []))),
    doneTotal: answers.reduce((s, [, x]) => s + (x.r.total ?? x.r.todos.length), 0),
    trend,
  };
}
