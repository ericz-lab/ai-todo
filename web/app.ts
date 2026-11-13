/**
 * The page: sidebar (views, projects, tags), the AI panel, the grouped list (subtasks under
 * their parent) and the detail modal (fields, plan with its versions, subtasks, editable records, AI execution runs, history). The AI panel is ai-space's chat widget fed with
 * the whole list: an answer may carry a `todo-drafts` block (rendered as editable drafts the
 * person adds) or a `todo-actions` block (applied by the server, the results listed under the
 * answer).
 */
import { mergeAnswers, type Answer, type Point } from "./machines.ts";
import { moveRow, scopeOf, type Counts } from "./tally.ts";

type Status = "open" | "doing" | "review" | "deferred" | "done" | "dropped";
type Todo = { id: number; title: string; notes: string; plan: string; planVersion: number; status: Status; priority: 0 | 1 | 2 | 3; due: string | null; tags: string[]; project: string | null; source: string; parentId: number | null; subtasks: { total: number; done: number }; createdAt: string; updatedAt: string; doneAt: string | null };
/** A row of the list (`GET /api/todos?fields=list`): no plan, the notes cut to an excerpt; the detail has the rest. */
type Item = Omit<Todo, "notes" | "plan" | "position" | "source"> & { notesExcerpt: string; m?: string };
type ListAnswer = { todos: Item[]; tags: { tag: string; n: number }[]; projects: { project: string; n: number }[]; counts: Counts; total?: number; nextBefore?: string | null; trend?: { t: string; v: number }[] };
type Draft = { title: string; notes?: string; due?: string | null; priority?: number; tags?: string[]; project?: string | null };
type Run = { id: number; todoId: number; status: "running" | "ok" | "error"; output: string; error: string | null; model: string | null; costUsd: number | null; startedAt: string; finishedAt: string | null };
type TodoEvent = { id: number; kind: string; data: Record<string, unknown>; at: string };
type OperationRecord = { attachments?: { key: string; name: string }[]; id: number; todoId: number; content: string; source: string; createdAt: string; revision: number; editedAt: string | null };
type PlanMeta = { version: number; source: string; createdAt: string };
type PlanVersionRow = { version: number; source: string; createdAt: string; chars: number; excerpt: string };
type RecordRevision = { revision: number; content: string; source: string; createdAt: string };
type RecordPage = { records: OperationRecord[]; recordsNextBefore: number | null };
type ChatMessage = { id: number; role: "user" | "assistant"; content: string; error?: string; live?: boolean };
type ChatContext = { system?: string; text?: string; ack?: string; tools?: string[]; model?: string; thinking?: number };
type ChatWidget = { fill(text: string): void; send(text: string): Promise<void>; destroy(): void };
/** ai-space's chat widget, loaded from /space/chat/widget.js; it also exports the Markdown renderer the space uses everywhere. */
declare const SpaceChat: {
  renderMd(src: string): string;
  esc(s: unknown): string;
  mount(el: HTMLElement, opts: {
    scope: string; context: () => Promise<ChatContext>; timeoutMs?: number;
    presets?: { label: string; prompt: string; send?: boolean }[];
    renderAssistant?: (m: ChatMessage) => string | Node | undefined;
    onReply?: (m: ChatMessage) => void;
    theme?: "light" | "dark" | "auto"; lang?: string; emptyText?: string; placeholder?: string; attachments?: boolean;
  }): ChatWidget;
} | undefined;

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

// ---- language: 中 or EN, set on html[lang] by the head script (?lang= from the panel → the saved choice → the browser)
const EN = document.documentElement.lang === "en";
/** Every string the page writes, in both languages. */
const L = (zh: string, en: string): string => (EN ? en : zh);
// The shell is written in Chinese with the English beside it: data-en (text), data-en-title, data-en-aria, data-en-ph.
if (EN) {
  document.querySelectorAll<HTMLElement>("[data-en]").forEach((x) => { x.textContent = x.dataset.en!; });
  document.querySelectorAll<HTMLElement>("[data-en-title]").forEach((x) => { x.title = x.dataset.enTitle!; });
  document.querySelectorAll<HTMLElement>("[data-en-aria]").forEach((x) => { x.setAttribute("aria-label", x.dataset.enAria!); });
  document.querySelectorAll<HTMLElement>("[data-en-ph]").forEach((x) => { x.setAttribute("placeholder", x.dataset.enPh!); });
}
document.querySelectorAll<HTMLElement>("#lang [data-lang]").forEach((b) => {
  b.setAttribute("aria-pressed", String((b.dataset.lang === "en") === EN));
  // A switch reloads the page in the other language (the choice is kept in this browser and in the address).
  b.onclick = () => {
    if ((b.dataset.lang === "en") === EN) return;
    try { localStorage.setItem("todo-lang", b.dataset.lang!); } catch { /* private mode */ }
    const u = new URL(location.href);
    u.searchParams.set("lang", b.dataset.lang!);
    location.replace(u.toString());
  };
});
/** Weekday names: 日一二三四五六 in Chinese, short English names. */
const WEEKDAY = EN ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : [..."日一二三四五六"];
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Markdown through the space's renderer; plain paragraphs when the widget (and so ai-space) is not there. */
const renderMd = (src: string): string => (typeof SpaceChat !== "undefined" ? SpaceChat.renderMd(src) : String(src ?? "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join(""));
// ---- machines
/**
 * The machine whose list the page shows: "" for this one, else a peer running ai-todo, whose routes
 * this service forwards (`/api/m/<peer>/…`, through ai-space's bus). Only a hub has peers to show.
 */
type Machine = { via: string; name: string; online: boolean; asOf?: string; active: number | null; error: string | null };
let machines: Machine[] = [];
/** `via` for 全部机器: every machine's list on one page, each row with its machine. */
const ALL = "*";
/** `?m=` first, else the machine picked last in this browser. */
let via = new URLSearchParams(location.search).get("m") ?? (() => { try { return localStorage.getItem("todo-machine") ?? ""; } catch { return ""; } })();
const allMode = () => via === ALL;
/** In the all-machines view, the machine of the todo opened from the list: the detail's routes go there. */
let detailVia = "";
/** The machine a page route goes to: the one shown, or in the all-machines view the opened todo's. */
const at = () => (allMode() ? detailVia : via);
/** The machine picked in the AI panel's own menu for this browser; null = follow the list on the left. */
let aiVia: string | null = (() => { try { const v = localStorage.getItem("todo-ai-machine"); return v?.startsWith("m:") ? v.slice(2) : null; } catch { return null; } })();
/** Whether the AI panel keeps its own machine (one that is still listed) instead of following the list. */
const aiPinned = () => aiVia !== null && machines.some((x) => x.via === aiVia);
/** The AI panel's machine: the one picked in its menu; else the one shown, and in the all-machines view this one. */
const chatVia = () => (aiPinned() ? aiVia! : allMode() ? "" : via);
/** A page route on a machine (the one shown by default): the API and the record pictures; the chat stays on this machine. */
const on = (path: string, m = at()): string => (m && (path.startsWith("/api/") || path.startsWith("/blobs/")) ? `/api/m/${encodeURIComponent(m)}${path}` : path);
const nameOf = (m: string) => machines.find((x) => x.via === m)?.name ?? m;

/** How long the page waits for a read: past it the machine is named as not answering, instead of waiting for the edge's own cut-off. */
const READ_WAIT_MS = 15_000;
const api = async <T>(path: string, init: RequestInit = {}, m = at()): Promise<T> => {
  const read = (init.method ?? "GET").toUpperCase() === "GET";
  let r: Response;
  let body: T & { ok?: boolean; error?: string };
  try {
    r = await fetch(on(path, m), { ...(read && !init.signal ? { signal: AbortSignal.timeout(READ_WAIT_MS) } : {}), ...init, headers: { ...(init.body instanceof FormData ? {} : { "content-type": "application/json" }), ...(init.headers ?? {}) } });
    body = (await r.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  } catch (e) {
    if ((e as Error).name !== "TimeoutError") throw e;
    const who = nameOf(m) || L("本机", "This machine");
    throw new Error(L(`${who} ${READ_WAIT_MS / 1000} 秒内没有回答`, `${who} did not answer in ${READ_WAIT_MS / 1000} s`));
  }
  if (!r.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const PRI = EN ? ["", "Low", "Med", "High"] : ["", "低", "中", "高"];
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** One kit toast at a time (`.sp-toast`), shown for a few seconds. */
const toast = (text: string) => {
  document.querySelectorAll(".sp-toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "sp-toast"; el.setAttribute("role", "status"); el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("show")));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 250); }, 2400);
};

// ---- dates (local wall clock, like the server's strings)
const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); };
const dayOf = (due: string) => due.slice(0, 10);
const isLate = (t: { due: string | null }) => !!t.due && (t.due.length > 10 ? t.due < `${todayStr()}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}` : dayOf(t.due) < todayStr());
const fmtDue = (due: string) => {
  const day = dayOf(due), today = todayStr();
  const time = due.length > 10 ? ` ${due.slice(11)}` : "";
  if (day === today) return L(`今天${time}`, `Today${time}`);
  if (day === addDays(1)) return L(`明天${time}`, `Tomorrow${time}`);
  if (day === addDays(-1)) return L(`昨天${time}`, `Yesterday${time}`);
  const d = new Date(`${day}T00:00`);
  const wd = WEEKDAY[d.getDay()];
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  const md = `${sameYear ? "" : `${day.slice(0, 4)}/`}${d.getMonth() + 1}/${d.getDate()}`;
  return EN ? `${wd} ${md}${time}` : `${md} 周${wd}${time}`;
};
const fmtAgo = (iso: string) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return L("刚刚", "just now");
  if (diff < 3600) return L(`${Math.floor(diff / 60)} 分钟前`, `${Math.floor(diff / 60)} min ago`);
  if (diff < 86400) return L(`${Math.floor(diff / 3600)} 小时前`, `${Math.floor(diff / 3600)} h ago`);
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---- theme: follow the system → light → dark, saved in this browser; the head script applied it before first paint
type ThemeMode = "system" | "light" | "dark";
const THEME_LABEL: Record<ThemeMode, string> = EN ? { system: "System", light: "Light", dark: "Dark" } : { system: "跟随系统", light: "浅色", dark: "深色" };
const applyTheme = (mode: ThemeMode, save = true) => {
  const root = document.documentElement;
  if (mode === "system") delete root.dataset.theme; else root.dataset.theme = mode;
  root.dataset.mode = mode;
  if (save) { try { if (mode === "system") localStorage.removeItem("todo-theme"); else localStorage.setItem("todo-theme", mode); } catch { /* private mode */ } }
  $("#theme-label").textContent = THEME_LABEL[mode];
  $("#theme").title = L(`主题：${THEME_LABEL[mode]}，点按切换`, `Theme: ${THEME_LABEL[mode]}, click to change`);
};
/** Stroke icons (24px box) drawn by the page; the static ones live in index.html. */
const ICON = {
  moon: `<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>`,
  sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>`,
  folder: `<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>`,
  hash: `<path d="M9 4 7.5 20M16.5 4 15 20M4.5 9h16M3.5 15h16"/>`,
  alert: `<path d="M12 4 21 19.5H3Z"/><path d="M12 10v4M12 17v.01"/>`,
  check: `<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-5"/>`,
  x: `<path d="M6 6l12 12M18 6 6 18"/>`,
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  spark: `<path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9Z"/>`,
  chart: `<path d="M4 4v16h16"/><path d="m7.5 14 3.5-4 3 3 5-6"/>`,
  layers: `<path d="m12 4 8.5 4.5L12 13 3.5 8.5Z"/><path d="m3.5 12.5 8.5 4.5 8.5-4.5"/><path d="m3.5 16.5 8.5 4.5 8.5-4.5"/>`,
};
const svg = (name: keyof typeof ICON) => `<svg class="ic" viewBox="0 0 24 24">${ICON[name]}</svg>`;
/** The kit's square checkbox (`.sp-check`): the tick inside is drawn in the ink when checked. */
const checkHtml = (checked: boolean, label = "") => `<label class="sp-check"><input type="checkbox"${checked ? " checked" : ""}${label ? ` aria-label="${esc(label)}"` : ""}><span><svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span></label>`;
const modeNow = (): ThemeMode => { const m = document.documentElement.dataset.mode; return m === "light" || m === "dark" ? m : "system"; };
applyTheme(modeNow(), false);
$("#theme").onclick = () => applyTheme(({ system: "light", light: "dark", dark: "system" } as const)[modeNow()]);

// ---- state
type View = "today" | "upcoming" | "all" | "review" | "done" | "deferred";
const VIEW_TITLE: Record<View, string> = EN
  ? { all: "All", today: "Today", upcoming: "Upcoming", review: "Review", deferred: "Deferred", done: "Done" }
  : { all: "全部", today: "今天", upcoming: "即将", review: "验收", deferred: "暂不处理", done: "已完成" };
const VIEWS = Object.keys(VIEW_TITLE) as View[];
/** `/?view=review` opens that view (the panel card and the review notification link there). */
const viewParam = new URLSearchParams(location.search).get("view") as View | null;
let view: View = viewParam && VIEWS.includes(viewParam) ? viewParam : "all";
/** The done list comes a page at a time, newest finished first. */
const DONE_PAGE = 50;
/** The next done page's cursor per machine that has more. */
let doneCursors = new Map<string, string>();
let doneTotal = 0;
let counts: Counts | null = null;
let filterTag: string | null = null;
let filterProject: string | null = null;
let query = "";
let todos: Item[] = [];
let active: Item[] = [];
let tags: { tag: string; n: number }[] = [];
let projects: { project: string; n: number }[] = [];
/** Completions per day over the last week, from the panel card's trend (`/api/widget`); null when it could not be read. */
let trend: { t: string; v: number | null }[] | null = null;
/** The segmented filter over the open views: every row, the ones in progress, the ones with an AI run going. */
type Seg = "" | "doing" | "ai";
let seg: Seg = "";
/**
 * AI runs this page started or followed and has not seen end, by `<machine>#<todo id>` → run id. The list rows
 * carry no run state, so this is what the page knows; `checkRuns` drops the ones that ended while nobody watched.
 */
const aiRuns = new Map<string, number>();
const runKey = (id: number, m = at()) => `${m}#${id}`;
const rowRunning = (t: Item) => aiRuns.has(runKey(t.id, t.m ?? via));
const els = { list: $("#list"), side: $("#side"), rail: $("#rail"), scrim: $("#scrim"), chat: $("#chat"), detail: $("#detail") };
$("#tz").textContent = TZ;

/** Only the newest load draws: a slow answer for a view already left is dropped. */
let loadSeq = 0;
const statusOf = (v: View) => (v === "done" ? "done" : v === "deferred" ? "deferred" : v === "review" ? "review" : "active");
const listQuery = (extra: Record<string, string> = {}) => {
  const q = new URLSearchParams({ status: statusOf(view), fields: "list", ...extra });
  if (filterTag) q.set("tag", filterTag);
  if (filterProject) q.set("project", filterProject);
  if (query) q.set("q", query);
  if (view === "done") q.set("limit", String(DONE_PAGE));
  return q;
};
/** A todo's key on the page: ids are per machine, so the all-machines view adds the machine. */
const keyOf = (id: number, m?: string) => `${m ?? ""}#${id}`;
/**
 * What each machine shown answered for the view (`web/machines.ts` merges them): the list draws again as
 * each one comes, and a change on the page (`showStatus`, 加载更多) is made to its machine's answer.
 */
let answers = new Map<string, Answer<Item>>();
/** The view the answers are for; a read of the same view keeps them until each machine answers again, so nothing blinks out. */
let answersKey = "";
/** The machines shown, in the order they are listed. */
let shownOrder: string[] = [];
/** Machines whose list is not shown: null when offline (not asked), else why the read failed. One row each at the top of the list. */
const unread = new Map<string, string | null>();
/** Machines being asked again from their row's 重试. */
const retrying = new Set<string>();
/** Machines asked by the newest load that have not answered yet: an empty list is not "all clear" while they may still add to it. */
const waiting = new Set<string>();
const offline = (m: string) => machines.find((x) => x.via === m)?.online === false;
/** One machine's answer for the view: the list (with the week's trend) and the unfiltered active list, in parallel. */
const readMachine = (m: string): Promise<Answer<Item>> => {
  const plain = statusOf(view) === "active" && !filterTag && !filterProject && !query;
  // A machine on an older version answers no trend; its widget has it.
  return Promise.all([
    api<ListAnswer>(`/api/todos?${listQuery()}&trend=1`, {}, m).then(async (r) => [r, r.trend ?? await api<{ blocks?: { type: string; points?: Point[] }[] }>("/api/widget", {}, m)
      .then((x) => x.blocks?.find((b) => b.type === "trend")?.points ?? [], () => null)] as const),
    plain ? null : api<ListAnswer>("/api/todos?status=active&fields=list", {}, m),
  ]).then(([[r, w], a]) => ({ r, a, w }));
};
/** The answers so far as the page's list, then every part of the page that shows it. */
function draw() {
  const m = mergeAnswers(shownOrder.flatMap((x) => { const a = answers.get(x); return a ? [[x, a] as [string, Answer<Item>]] : []; }), { all: allMode(), done: view === "done" });
  ({ todos, active, tags, projects, counts, doneCursors, doneTotal, trend } = m);
  renderMachines();
  renderSide();
  renderHead();
  renderKpis();
  renderList();
  if (!waiting.size && answers.size) numsStill = false;
}
/** Ask one machine for the view; its answer (or why there is none) is drawn at once, unless a newer load started. */
async function readInto(seq: number, m: string) {
  try {
    const p = await readMachine(m);
    if (seq !== loadSeq) return;
    answers.set(m, p);
    unread.delete(m);
    const mc = machines.find((y) => y.via === m);
    // The 机器 section's open count too: on its own it is read only at boot.
    if (mc) { mc.active = p.r.counts.active; mc.error = null; mc.online = true; }
  } catch (e) {
    if (seq !== loadSeq) return;
    answers.delete(m);
    unread.set(m, (e as Error).message);
    const mc = machines.find((y) => y.via === m);
    if (mc) mc.error = (e as Error).message;
  } finally { retrying.delete(m); if (seq === loadSeq) waiting.delete(m); }
  draw();
}
async function load() {
  const seq = ++loadSeq;
  // 全部机器 asks every machine at once and draws each answer as it comes; an offline one is not asked.
  const ask = allMode() ? machines.map((x) => x.via) : [via];
  const key = `${via}|${ask.join(",")}|${listQuery()}`;
  if (key !== answersKey) { answers = new Map(); unread.clear(); answersKey = key; }
  shownOrder = ask;
  for (const m of [...answers.keys()]) if (!ask.includes(m)) answers.delete(m);
  for (const m of [...unread.keys()]) if (!ask.includes(m)) unread.delete(m);
  const asking = ask.filter((m) => !offline(m));
  for (const m of ask) if (offline(m)) { answers.delete(m); unread.set(m, null); }
  waiting.clear();
  for (const m of asking) waiting.add(m);
  markBusy();
  if (asking.length < ask.length) draw();
  await Promise.all(asking.map((m) => readInto(seq, m)));
  if (seq === loadSeq) void checkRuns();
}
/** 重试 on a machine's row: ask it again (an offline one too: it may be back before ai-space has seen it). */
function retryMachine(m: string) {
  retrying.add(m);
  renderList();
  void readInto(loadSeq, m);
}
/** Runs marked as going that this page no longer streams (the detail was closed): ask whether they ended. */
async function checkRuns() {
  const watched = liveAbort && cur ? runKey(cur.id) : "";
  let changed = false;
  await Promise.all([...aiRuns].filter(([k]) => k !== watched).map(async ([k, runId]) => {
    const m = k.slice(0, k.lastIndexOf("#"));
    try {
      const s = await api<{ done: unknown }>(`/api/runs/${runId}`, {}, m);
      if (s.done) { aiRuns.delete(k); changed = true; }
    } catch { aiRuns.delete(k); changed = true; }
  }));
  // A run that ended may have moved its todo (to review): read the list again; the map is smaller, so this stops.
  if (changed) void load();
}
/** The next page of the done list (of every machine that has more), added to that machine's answer. */
async function loadMore(btn: HTMLButtonElement) {
  if (!doneCursors.size || view !== "done") return;
  const seq = loadSeq;
  btn.disabled = true; btn.textContent = L("加载中…", "Loading…");
  try {
    const pages = await Promise.all([...doneCursors].map(([m, before]) => api<ListAnswer>(`/api/todos?${listQuery({ before })}`, {}, m).then((r) => ({ m, r }))));
    if (seq !== loadSeq) return;
    for (const { m, r } of pages) {
      const a = answers.get(m);
      if (!a) continue;
      const seen = new Set(a.r.todos.map((t) => t.id));
      answers.set(m, { ...a, r: { ...a.r, todos: [...a.r.todos, ...r.todos.filter((t) => !seen.has(t.id))], nextBefore: r.nextBefore ?? null } });
    }
    draw();
  } catch (e) { toast((e as Error).message); btn.disabled = false; btn.textContent = L("加载更多", "Load more"); }
}
/** The address keeps the view and the machine, so a link reopens the same list. */
const syncUrl = () => {
  const q = new URLSearchParams();
  if (view !== "all") q.set("view", view);
  if (via) q.set("m", via);
  const s = q.toString();
  history.replaceState(null, "", s ? `?${s}` : location.pathname);
};
const setView = (v: View) => { view = v; syncUrl(); };

// ---- sidebar
const isToday = (t: Item) => t.status === "doing" || (!!t.due && dayOf(t.due) <= todayStr());
function renderSide() {
  const today = todayStr();
  // 今天's calendar carries the day of the month.
  $("#today-day").textContent = String(Number(today.slice(8, 10)));
  const late = active.filter(isLate).length;
  const n = { today: active.filter(isToday).length, upcoming: active.filter((t) => t.due && dayOf(t.due) > today).length, all: active.length };
  /** A count in the left column; a state waiting for the person adds a dot with its word in the title. */
  const count = (sel: string, v: number, dot = "", word = "") => {
    const c = $(sel);
    c.innerHTML = v ? `${dot ? `<span class="sp-dot ${dot}" aria-hidden="true"></span>` : ""}${numHtml(sel, v)}` : numHtml(sel, v);
    c.title = word;
    if (word) c.setAttribute("aria-label", L(`${v}，${word}`, `${v}, ${word}`)); else c.removeAttribute("aria-label");
  };
  // 今天 wears a pill, red while something is overdue.
  count("#n-today", n.today, "", late ? L(`${late} 项已过期`, `${late} overdue`) : "");
  $("#n-today").classList.toggle("late", late > 0);
  count("#n-upcoming", n.upcoming);
  count("#n-all", n.all);
  // Every stage's size, whatever view is open; finished work waiting for the person stands out.
  count("#n-review", counts?.review ?? 0, counts?.review ? "warn" : "", counts?.review ? L(`${counts.review} 项待验收`, `${counts.review} awaiting review`) : "");
  count("#n-deferred", counts?.deferred ?? 0);
  count("#n-done", counts?.done ?? 0);
  document.querySelectorAll<HTMLElement>(".sp-nitem[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view && !filterProject && !filterTag)));
  const items = (kind: "folder" | "hash", list: { key: string; n: number }[], on: string | null) =>
    list.length ? list.map((x) => `<li><button type="button" class="sp-nitem" data-key="${esc(x.key)}" aria-pressed="${on === x.key}">${navIcon(kind)}<span class="nl">${esc(x.key)}</span><span class="sp-nc">${numHtml(`${kind}:${x.key}`, x.n)}</span></button></li>`).join("") : `<li class="none">${L("暂无", "None yet")}</li>`;
  $("#projects").innerHTML = items("folder", projects.map((p) => ({ key: p.project, n: p.n })), filterProject);
  $("#tags").innerHTML = items("hash", tags.map((t) => ({ key: t.tag, n: t.n })), filterTag);
  $("#project-list").innerHTML = projects.map((p) => `<option value="${esc(p.project)}">`).join("");
  $("#projects").querySelectorAll<HTMLElement>("[data-key]").forEach((c) => { c.onclick = () => { filterProject = filterProject === c.dataset.key ? null : c.dataset.key!; closeDrawers(); void load(); }; });
  $("#tags").querySelectorAll<HTMLElement>("[data-key]").forEach((c) => { c.onclick = () => { filterTag = filterTag === c.dataset.key ? null : c.dataset.key!; closeDrawers(); void load(); }; });
  if (tickDone) {
    tickDone = false;
    const tick = $("#side .tick");
    tick.classList.remove("draw");
    void tick.getBoundingClientRect();
    tick.classList.add("draw");
  }
  placeInd();
}
document.querySelectorAll<HTMLElement>(".sp-nitem[data-view]").forEach((b) => { b.onclick = () => { stillNums(); setView(b.dataset.view as View); closeDrawers(); void load(); }; });

/** A row's 16px line icon in the left column. */
const navIcon = (name: keyof typeof ICON) => `<svg class="ic ni" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

/**
 * A count that rolls one line when its number changes: the old one leaves upward as the new one follows it in
 * (downward for a smaller number). The lists are redrawn whole and often, so a roll under way is resumed at
 * the point it had reached (`--roll-at`), not started again. Numbers that change because another list is being
 * read (a view, a machine, the first load) are set without a roll: `numsStill`.
 */
const ROLL_MS = 200;
const nums = new Map<string, { v: number; prev: number; at: number }>();
let numsStill = true;
const stillNums = () => { numsStill = true; };
function numHtml(key: string, v: number): string {
  const now = performance.now();
  let s = nums.get(key);
  if (!s) nums.set(key, s = { v, prev: v, at: -ROLL_MS });
  else if (s.v !== v) nums.set(key, s = { v, prev: s.v, at: numsStill ? -ROLL_MS : now });
  if (!v) return "";
  const gone = now - s.at;
  if (gone >= ROLL_MS) return `<span class="num"><span>${v}</span></span>`;
  return `<span class="num roll${v < s.prev ? " down" : ""}" data-prev="${s.prev || ""}" style="--roll-at:-${Math.round(gone)}ms"><span>${v}</span></span>`;
}
/** Set by a task finished on this page: the next draw of the left column draws 已完成's tick. */
let tickDone = false;

/**
 * The wash behind the selected list: one element that slides to the row chosen. It lies under the rows of the
 * scrolling part and is placed from the row's box; machines (the scope) and rows in a folded group take none.
 */
const sideScroll = $(".sp-side-scroll");
const navInd = document.createElement("div");
navInd.className = "nav-ind snap";
navInd.setAttribute("aria-hidden", "true");
sideScroll.prepend(navInd);
function placeInd(slide = true) {
  const row = [...sideScroll.querySelectorAll<HTMLElement>('.sp-nitem[aria-pressed="true"]')].find((b) => !b.closest("#machines"));
  sideScroll.querySelectorAll(".ind-on").forEach((x) => { if (x !== row) x.classList.remove("ind-on"); });
  const box = row?.getBoundingClientRect();
  if (!row || !box || box.height < 8 || row.closest(".sp-ngroup.closed")) {
    row?.classList.remove("ind-on");
    navInd.classList.add("snap");
    navInd.style.opacity = "0";
    return;
  }
  const home = sideScroll.getBoundingClientRect();
  // The first placing, and one that follows a layout change (a group folding, a resize), does not slide.
  navInd.classList.toggle("snap", !slide || navInd.style.opacity !== "1");
  navInd.style.width = `${box.width}px`;
  navInd.style.height = `${box.height}px`;
  navInd.style.transform = `translate(${box.left - home.left + sideScroll.scrollLeft}px, ${box.top - home.top + sideScroll.scrollTop}px)`;
  navInd.style.opacity = "1";
  row.classList.add("ind-on");
}
// Rows move when a group folds, a list above grows or the column is resized: the wash keeps to its row.
const navWatch = new ResizeObserver(() => placeInd(false));
sideScroll.querySelectorAll(".sp-ngroup").forEach((g) => navWatch.observe(g));
navWatch.observe(sideScroll);

// Folding a group: its label is the switch; which ones are folded is kept in this browser.
{
  const KEY = "todo-side-folded";
  let folded: string[] = [];
  try { const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); if (Array.isArray(v)) folded = v.filter((x): x is string => typeof x === "string"); } catch { /* private mode, or not a list */ }
  const set = (g: HTMLElement, closed: boolean) => {
    g.classList.toggle("closed", closed);
    g.querySelector(".ng-toggle")!.setAttribute("aria-expanded", String(!closed));
    g.querySelector<HTMLElement>(".ng-body")!.inert = closed;
  };
  sideScroll.classList.add("booting");
  sideScroll.querySelectorAll<HTMLElement>(".sp-ngroup[data-group]").forEach((g) => {
    const key = g.dataset.group!;
    if (folded.includes(key)) set(g, true);
    g.querySelector<HTMLElement>(".ng-toggle")!.onclick = () => {
      const closed = !g.classList.contains("closed");
      set(g, closed);
      folded = closed ? [...folded, key] : folded.filter((x) => x !== key);
      try { localStorage.setItem(KEY, JSON.stringify(folded)); } catch { /* private mode */ }
    };
  });
  requestAnimationFrame(() => requestAnimationFrame(() => sideScroll.classList.remove("booting")));
}

// ---- header and toolbar
const longDay = (d = new Date()) => (EN ? `${WEEKDAY[d.getDay()]}, ${d.toLocaleDateString("en", { month: "short", day: "numeric" })}` : `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAY[d.getDay()]}`);
/** The segmented filter applies to the open views; the archive views (review, deferred, done) are one state each. */
const segApplies = () => view === "all" || view === "today" || view === "upcoming";
function renderHead() {
  // The heading names the view and the day; the counts are in the left column and the stats tile, not repeated here.
  $("#view-title").textContent = VIEW_TITLE[view];
  $("#today-chip").textContent = longDay();
  document.title = `${VIEW_TITLE[view]} · ${L("AI 待办", "AI Todo")}`;
  $("#seg").hidden = !segApplies();
  $("#seg").querySelectorAll<HTMLElement>("[data-seg]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.seg === seg)));
  const f: string[] = [];
  const chip = (k: string, icon: keyof typeof ICON, label: string, value: string) =>
    `<button type="button" class="sp-chip filter" data-clear="${k}" title="${L("清除这个筛选", "Clear this filter")}">${svg(icon)}<i>${label}</i>${esc(value)}${svg("x")}</button>`;
  if (filterProject) f.push(chip("project", "folder", L("项目", "Project"), filterProject));
  if (filterTag) f.push(chip("tag", "hash", L("标签", "Tag"), filterTag));
  if (query) f.push(chip("query", "search", L("搜索", "Search"), query));
  $("#filters").innerHTML = f.join("");
  $("#filters").querySelectorAll<HTMLElement>("[data-clear]").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.clear;
      if (k === "project") filterProject = null; else if (k === "tag") filterTag = null; else { query = ""; searchBox.value = ""; }
      void load();
    };
  });
}
$("#seg").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
  if (!b) return;
  seg = (b.dataset.seg ?? "") as Seg;
  renderHead();
  renderList();
});

// ---- search: by title, notes, plan, project and tags, on the server (the list rows carry only a notes excerpt, the done list one page)
const searchBox = $<HTMLInputElement>("#search");
const visible = () => (!segApplies() || !seg ? todos : todos.filter((t) => (seg === "doing" ? t.status === "doing" : rowRunning(t))));
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const search = (text: string, now = false) => {
  clearTimeout(searchTimer);
  if (text === query) return;
  const go = () => { query = text; void load(); };
  if (now) go(); else searchTimer = setTimeout(go, 250);
};
// While an IME composes, the box holds raw syllables: search when the word is committed.
searchBox.oninput = (e) => { if (!(e as InputEvent).isComposing) search(searchBox.value.trim()); };
searchBox.addEventListener("compositionend", () => search(searchBox.value.trim()));
searchBox.onkeydown = (e) => { if (e.key === "Escape") { searchBox.value = ""; search("", true); searchBox.blur(); } else if (e.key === "Enter" && !e.isComposing) search(searchBox.value.trim(), true); };
document.addEventListener("keydown", (e) => {
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && els.detail.hidden && !(document.activeElement as HTMLElement | null)?.isContentEditable) {
    e.preventDefault();
    // Below 960 px the search is in the left column's drawer.
    if (!matchMedia("(min-width: 960px)").matches) openDrawer("sp-open-nav");
    searchBox.focus(); searchBox.select();
  }
});

// ---- the stats tile: today, overdue and the week's completions (the trend) in one slim tile
function renderKpis() {
  const today = todayStr();
  const todayN = active.filter(isToday);
  const dueToday = active.filter((t) => t.due && dayOf(t.due) === today).length;
  const doing = active.filter((t) => t.status === "doing").length;
  const late = active.filter(isLate).sort((a, b) => a.due!.localeCompare(b.due!));
  const done = trend ? trend.reduce((s, p) => s + (p.v ?? 0), 0) : null;
  const doneToday = trend?.at(-1)?.v ?? 0;
  // Today's share already finished: what was finished today over that plus what is still on today's list.
  const share = todayN.length + doneToday ? Math.round((doneToday / (todayN.length + doneToday)) * 100) : 0;
  const label = (text: string) => `<span class="sp-tt st-label"><span class="sp-sq" aria-hidden="true"></span>${text}</span>`;
  const fig = (v: string) => `<span class="sp-fig">${v}</span>${EN ? "" : `<span class="sp-unit">项</span>`}`;
  const todayTitle = L(`今天到期 ${dueToday} 项 · ${doing ? `进行中 ${doing} 项` : "没有进行中"}`, `${dueToday} due today · ${doing ? `${doing} in progress` : "nothing in progress"}`);
  const todayStat = `<div class="stat st-today" title="${esc(todayTitle)}">${label(L("今天", "Today"))}${fig(String(todayN.length))}
      <span class="sp-meter" role="img" aria-label="${esc(L(`今天完成 ${doneToday} 项`, `${doneToday} done today`))}"><i style="--v:${share}%"></i></span>
      <span class="st-note">${L(`${doneToday} 已完成`, `${doneToday} done`)}</span><span class="st-note st-more">${L(`到期 ${dueToday} · ${doing ? `进行中 ${doing}` : "没有进行中"}`, `Due ${dueToday} · ${doing ? `in progress ${doing}` : "nothing in progress"}`)}</span></div>`;
  // Overdue is a state, so it is a badge with its word: the count and the earliest one; nothing late, a quiet note.
  const lateStat = late.length
    ? `<div class="stat st-late"><span class="sp-badge bad st-first" title="${L("最早：", "Earliest: ")}${esc(late[0]!.title)} · ${esc(fmtDue(late[0]!.due!))}"><span class="tx">${L(`已过期 ${late.length} 项 · 最早`, `${late.length} overdue · earliest`)} ${esc(late[0]!.title)} · ${esc(fmtDue(late[0]!.due!))}</span></span></div>`
    : `<div class="stat st-late st-more"><span class="st-note">${L("没有逾期任务", "Nothing overdue")}</span></div>`;
  $("#kpis").innerHTML = `<div class="stats-in">${todayStat}${lateStat}${weekStat(done)}</div>`;
}
/** The week's completions: the figure, then one bar a day with its day under it (today in the accent). */
function weekStat(done: number | null): string {
  const head = `<span class="sp-tt st-label"><span class="sp-sq" aria-hidden="true"></span>${L("近 7 天完成", "Done, last 7 days")}</span>`;
  if (!trend || done === null) return `<div class="stat st-week">${head}<span class="sp-fig">–</span><span class="st-note">${L("完成记录读取失败", "Could not read completions")}</span></div>`;
  // A machine that has finished nothing has no trend block at all: zero, not a crash.
  if (!trend.length) return `<div class="stat st-week">${head}<span class="sp-fig">0</span>${EN ? "" : `<span class="sp-unit">项</span>`}<span class="st-note">${L("这 7 天还没有完成的任务", "Nothing finished in the last 7 days")}</span></div>`;
  const max = Math.max(1, ...trend.map((p) => p.v ?? 0));
  const best = trend.reduce((a, p) => ((p.v ?? 0) > (a.v ?? 0) ? p : a), trend[0]!);
  const md = (t: string) => `${Number(t.slice(5, 7))}/${Number(t.slice(8, 10))}`;
  const wd = (t: string) => WEEKDAY[new Date(`${t}T00:00`).getDay()]!.slice(0, EN ? 2 : 1);
  const lateN = active.filter(isLate).length;
  const bestDay = best.t === trend.at(-1)!.t ? L("今天", "today") : md(best.t);
  const text = !done ? L("这 7 天还没有完成的任务。挑一件小的先做掉。", "Nothing finished in the last 7 days. Pick a small one and get it done.")
    : L(`这 7 天完成了 ${done} 项，${bestDay} 最多，${best.v} 项。${lateN ? `还有 ${lateN} 项过期没处理。` : ""}`,
      `${done} done in the last 7 days, the most on ${bestDay} (${best.v}).${lateN ? ` ${lateN} overdue still waiting.` : ""}`);
  const last = trend.length - 1;
  return `<div class="stat st-week" title="${esc(text)}">${head}<span class="sp-fig">${done}</span>${EN ? "" : `<span class="sp-unit">项</span>`}
      <div class="week" role="img" aria-label="${esc(text)} ${L("每天：", "Per day: ")}${trend.map((p) => L(`${md(p.t)} ${p.v ?? 0} 项`, `${md(p.t)} ${p.v ?? 0}`)).join(L("，", ", "))}">
        ${trend.map((p, i) => `<span class="day" title="${L(`${md(p.t)}：完成 ${p.v ?? 0} 项`, `${md(p.t)}: ${p.v ?? 0} done`)}"><i class="b${i === last ? " now" : ""}" style="--h:${Math.max(2, Math.round(((p.v ?? 0) / max) * 24))}px"></i><small>${i === last && !EN ? "今" : wd(p.t)}</small></span>`).join("")}
      </div><span class="st-note st-more">${L("日均", "Daily mean")} ${(done / 7).toFixed(1)}</span></div>`;
}

// ---- the list
type Group = { key: string; title: string; late?: boolean; items: Item[] };
/** Subtasks by parent id, among the todos listed; a subtask whose parent is listed is drawn under it, not on its own. */
let kids = new Map<string, Item[]>();
function nest() {
  const shown = visible();
  const ids = new Set(shown.map((t) => keyOf(t.id, t.m)));
  const parentKey = (t: Item) => (t.parentId ? keyOf(t.parentId, t.m) : "");
  kids = new Map();
  for (const t of shown) if (t.parentId && ids.has(parentKey(t))) kids.set(parentKey(t), [...(kids.get(parentKey(t)) ?? []), t]);
  return shown.filter((t) => !t.parentId || !ids.has(parentKey(t)));
}
/** A todo's title by id (on the same machine), from whatever the page has; for the "↳ parent" line. */
const titleOf = (id: number, m?: string) => (todos.find((t) => t.id === id && t.m === m) ?? active.find((t) => t.id === id && t.m === m))?.title;
function groups(): Group[] {
  const today = todayStr(), tomorrow = addDays(1), week = addDays(7);
  const tops = nest();
  if (view === "deferred") return [{ key: "deferred", title: L("暂不处理", "Deferred"), items: tops }];
  if (view === "review") return [{ key: "review", title: L("待验收", "Awaiting review"), items: tops }];
  if (view === "done") return [{ key: "done", title: L("已完成", "Done"), items: tops }];
  const g: Record<string, Group> = {
    doing: { key: "doing", title: L("进行中", "In progress"), items: [] }, late: { key: "late", title: L("已过期", "Overdue"), late: true, items: [] }, today: { key: "today", title: L("今天", "Today"), items: [] },
    tomorrow: { key: "tomorrow", title: L("明天", "Tomorrow"), items: [] }, week: { key: "week", title: L("本周", "This week"), items: [] }, later: { key: "later", title: L("以后", "Later"), items: [] }, none: { key: "none", title: L("未定日期", "No date"), items: [] },
  };
  for (const t of tops) {
    const day = t.due ? dayOf(t.due) : null;
    const key = t.status === "doing" ? "doing" : !day ? "none" : day < today ? "late" : day === today ? "today" : day === tomorrow ? "tomorrow" : day <= week ? "week" : "later";
    g[key]!.items.push(t);
  }
  const order = view === "today" ? ["doing", "late", "today"] : view === "upcoming" ? ["tomorrow", "week", "later"] : ["doing", "late", "today", "tomorrow", "week", "later", "none"];
  return order.map((k) => g[k]!).filter((x) => x.items.length);
}
/** The add row at the foot of an open view: a todo typed there lands on the view's day and the project and tag filtered on. */
const addDefaults = () => ({ due: view === "today" ? todayStr() : view === "upcoming" ? addDays(1) : null, project: filterProject, tags: filterTag ? [filterTag] : [] });
const addHint = () => EN
  ? `${view === "today" ? "Add for today" : view === "upcoming" ? "Add for tomorrow" : "Add a todo"}${allMode() ? ` (${nameOf("")})` : ""}, Enter to save`
  : `${view === "today" ? "添加到今天" : view === "upcoming" ? "添加到明天" : "添加待办"}${allMode() ? `（${nameOf("")}）` : ""}，回车保存`;
/** A row at the top of the list for each machine not shown: offline, or why its read failed, with 重试. */
const unreadHtml = () => [...unread].map(([m, why]) => `<div class="sp-banner warn unread" role="status">${svg("alert")}<span class="grow">${why === null
  ? L(`<b>${esc(nameOf(m))}</b> 离线，没有去读它的清单`, `<b>${esc(nameOf(m))}</b> is offline; its list was not read`)
  : L(`<b>${esc(nameOf(m))}</b> 读取失败：${esc(why)}`, `Could not read <b>${esc(nameOf(m))}</b>: ${esc(why)}`)}</span><button type="button" class="sp-btn sm" data-retry="${esc(m)}"${retrying.has(m) ? " disabled" : ""}>${retrying.has(m) ? L("读取中…", "Reading…") : L("重试", "Retry")}</button></div>`).join("");
function renderList() {
  markBusy();
  const gs = groups();
  // The add row goes to the machine shown (this one in 全部机器); not while that machine's list could not be read.
  const adds = segApplies() && !unread.has(allMode() ? "" : via);
  // A machine's answer redraws the list: what was being typed in the add row stays.
  const typing = els.list.querySelector<HTMLInputElement>("#add-input");
  const typed = typing && !typing.disabled ? typing.value : "";
  const focused = !!typing && document.activeElement === typing;
  const banners = unreadHtml();
  const addRow = adds ? `<label class="add-row"><svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span class="sp-sr">${L("新建待办", "New todo")}</span><input id="add-input" placeholder="${esc(addHint())}" maxlength="300" autocomplete="off"></label>` : "";
  if (!gs.length && waiting.size) {
    els.list.innerHTML = `${banners}<div class="sp-state"><span class="ico" aria-hidden="true">${svg("layers")}</span><b>${L("读取中…", "Reading…")}</b><p>${esc([...waiting].map(nameOf).map((x) => x || L("本机", "This machine")).join(L("、", ", ")))}</p></div>`;
    bindList(typed, focused);
    return;
  }
  if (!gs.length && banners && !answers.size) {
    els.list.innerHTML = banners + addRow;
    bindList(typed, focused);
    return;
  }
  if (!gs.length) {
    const hint = query ? L(`没有和「${esc(query)}」匹配的任务。`, `No task matches “${esc(query)}”.`)
      : seg === "doing" && adds ? L("没有进行中的任务。", "Nothing in progress.")
      : seg === "ai" && adds ? L("这个页面没有正在进行的 AI 执行。在任务详情里点「AI 执行」开始一次。", "No AI run going from this page. Open a task and press “Run with AI” to start one.")
      : view === "review" ? L("没有等待验收的任务。AI 或你做完一项后提交验收，会出现在这里。", "Nothing awaits review. When the AI or you finish a task and submit it, it shows here.")
      : view === "deferred" ? L("没有暂不处理的任务。可在任务详情中暂缓，之后在这里恢复。", "Nothing deferred. Defer a task from its detail and bring it back from here.")
      : view === "today" ? L("今天没有安排。看看「即将」，或在右边写下要做的事。", "Nothing planned today. Look at Upcoming, or write what to do on the right.")
      : view === "upcoming" ? L("接下来几天没有安排。", "Nothing planned for the next days.")
      : view === "done" ? L("还没有完成的任务。", "Nothing finished yet.")
      : L("清单是空的。在右边写点什么，让 AI 拆成任务。", "The list is empty. Write something on the right and the AI turns it into tasks.");
    els.list.innerHTML = `${banners}<div class="sp-state"><span class="ico" aria-hidden="true">${svg(query ? "search" : "check")}</span><b>${query ? L("没有结果", "No results") : view === "done" || view === "review" ? L("空", "Empty") : L("轻松", "All clear")}</b><p>${hint}</p></div>${addRow}`;
    bindList(typed, focused);
    return;
  }
  const total = gs.reduce((s, g) => s + g.items.reduce((n, t) => n + 1 + (kids.get(keyOf(t.id, t.m))?.length ?? 0), 0), 0);
  // The done list pages: how much of it is shown, and the next page. Elsewhere the count is in the left column already.
  const foot = view === "done" ? `<div class="list-foot">${doneCursors.size ? `<button type="button" class="sp-btn sm" id="load-more">${L("加载更多", "Load more")}</button>` : ""}<span>${L(`已显示 ${total} / ${doneTotal} 项`, `Showing ${total} of ${doneTotal}`)}</span></div>` : "";
  els.list.innerHTML = `${banners}<div class="cols" aria-hidden="true"><span></span><span>${L("待办", "Todo")}</span><span>${L("截止", "Due")}</span><span>${L("优先", "Priority")}</span><span class="c-proj-h">${L("项目", "Project")}</span><span>${L("状态", "State")}</span></div>`
    + gs.map((g) => `
    <div class="grp" role="group" aria-label="${esc(g.title)}">
      <div class="sp-gh${g.late ? " late" : ""}">${g.title}<span class="n">${g.items.length}</span></div>
      ${g.items.map((t) => rowHtml(t) + (kids.get(keyOf(t.id, t.m)) ?? []).map((k) => rowHtml(k, true)).join("")).join("")}
    </div>`).join("") + addRow + foot;
  els.list.querySelectorAll<HTMLElement>(".todo").forEach((row) => {
    const id = Number(row.dataset.id);
    // In the all-machines view, what a row does goes to that row's machine.
    const pick = () => { if (allMode()) detailVia = row.dataset.m ?? ""; };
    const open = (execute = false) => { pick(); return openDetail(id, execute); };
    row.onclick = (e) => { if ((e.target as HTMLElement).closest("button, label, input")) return; void open(); };
    row.onkeydown = (e) => { if (e.key === "Enter" && e.target === row) void open(); };
    const inReview = row.classList.contains("review");
    $<HTMLInputElement>("input[type=checkbox]", row).onchange = (e) => {
      const on = (e.target as HTMLInputElement).checked;
      pick();
      void (inReview && on ? verdict(id, "accept") : setStatus(id, on ? "done" : "open"));
    };
    row.querySelector<HTMLElement>("[data-op=run]")?.addEventListener("click", () => void open(true));
    row.querySelector<HTMLElement>("[data-op=edit]")?.addEventListener("click", () => void open());
    row.querySelector<HTMLElement>("[data-op=accept]")?.addEventListener("click", () => { pick(); void verdict(id, "accept"); });
    row.querySelector<HTMLElement>("[data-op=reject]")?.addEventListener("click", () => void open().then(() => openReject()));
  });
  const more = els.list.querySelector<HTMLButtonElement>("#load-more");
  if (more) more.onclick = () => void loadMore(more);
  bindList(typed, focused);
}
/** What every state of the list has: the machines' 重试 and the add row, with what was being typed in it. */
function bindList(typed: string, focused: boolean) {
  els.list.querySelectorAll<HTMLButtonElement>("[data-retry]").forEach((b) => { b.onclick = () => retryMachine(b.dataset.retry ?? ""); });
  const input = els.list.querySelector<HTMLInputElement>("#add-input");
  if (input && typed) input.value = typed;
  if (input && focused) input.focus();
  bindAdd();
}
/** Enter in the add row creates the todo (on this machine in the all-machines view) and keeps the row ready for the next. */
function bindAdd() {
  const input = els.list.querySelector<HTMLInputElement>("#add-input");
  if (!input) return;
  input.onkeydown = async (e) => {
    if (e.key === "Escape") { input.value = ""; input.blur(); return; }
    if (e.key !== "Enter" || e.isComposing) return;
    const title = input.value.trim();
    if (!title) return;
    input.disabled = true;
    try {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ title, source: "manual", ...addDefaults() }) }, allMode() ? "" : via);
      input.value = "";
      toast(L("已添加", "Added"));
      await load();
    } catch (err) { toast((err as Error).message); input.disabled = false; return; }
    els.list.querySelector<HTMLInputElement>("#add-input")?.focus();
  };
}
/** 新建待办: the add row of an open view; from an archive view it first goes to 全部. */
$("#new-todo").onclick = async () => {
  if (!segApplies()) { setView("all"); await load(); }
  if (seg) { seg = ""; renderHead(); renderList(); }
  const input = els.list.querySelector<HTMLInputElement>("#add-input");
  input?.scrollIntoView({ block: "nearest" });
  input?.focus();
};
/** A row's state in words: the badge, and for a task in review the verdict buttons. */
function statusHtml(t: Item, late: boolean): string {
  if (t.status === "review") return `<span class="sp-badge warn">${L("待验收", "In review")}</span>`;
  if (rowRunning(t)) return `<span class="sp-badge ai live">${L("AI 执行中", "AI running")}</span>`;
  if (t.status === "doing") return `<span class="sp-badge run">${L("进行中", "In progress")}</span>`;
  if (late) return `<span class="sp-badge bad">${L("已过期", "Overdue")}</span>`;
  if (t.status === "deferred") return `<span class="sp-badge off">${L("暂不处理", "Deferred")}</span>`;
  if (t.status === "done") return `<span class="sp-badge ok">${L("已完成", "Done")}</span>`;
  return "";
}
function rowHtml(t: Item, nested = false): string {
  const line: string[] = [];
  const open = t.status !== "done" && t.status !== "deferred" && t.status !== "review";
  if (t.m !== undefined) line.push(`<span class="mach">${esc(nameOf(t.m))}</span>`);
  if (t.subtasks.total) line.push(`<span class="subp"><span class="sp-meter" aria-hidden="true"><i style="--v:${Math.round((t.subtasks.done / t.subtasks.total) * 100)}%"></i></span>${L("子任务", "Subtasks")} ${t.subtasks.done}/${t.subtasks.total}</span>`);
  if (t.parentId && !nested) line.push(`↳ ${esc(titleOf(t.parentId, t.m) ?? `#${t.parentId}`)}`);
  if (t.tags.length) line.push(t.tags.map((tag) => `#${esc(tag)}`).join(" "));
  if (t.status === "done" && t.doneAt) line.push(`${L("完成于", "Done")} ${esc(fmtAgo(t.doneAt))}`);
  if (t.notesExcerpt) line.push(esc(t.notesExcerpt.slice(0, 80)));
  const late = !!t.due && isLate(t) && open;
  const due = !t.due ? `<span class="dash">—</span>`
    : `<span class="due${late ? " late" : open && dayOf(t.due) === todayStr() ? " today" : ""}">${esc(fmtDue(t.due))}</span>`;
  const pri = t.priority ? `<span class="sp-chip pri p${t.priority}">${PRI[t.priority]}</span>` : `<span class="dash">—</span>`;
  const review = t.status === "review";
  return `<div class="todo ${t.status}${nested ? " sub" : ""}" data-id="${t.id}"${t.m !== undefined ? ` data-m="${esc(t.m)}"` : ""} tabindex="0">
    ${checkHtml(t.status === "done", `${L("完成", "Done:")} ${t.title}`)}
    <div class="t"><span class="title">${esc(t.title)}</span><span class="line">${line.join(" · ")}</span></div>
    <div class="c-due">${due}</div>
    <div class="c-pri">${pri}</div>
    <div class="c-proj">${t.project ? esc(t.project) : `<span class="dash">—</span>`}</div>
    <div class="c-st">${statusHtml(t, late)}${review ? `<span class="verdict"><button type="button" class="sp-btn sm" data-op="accept" title="${L("验收通过，标为完成", "Accept and mark done")}">${L("通过", "Accept")}</button><button type="button" class="sp-btn ghost sm" data-op="reject" title="${L("验收不通过，写明原因后退回", "Not accepted: say why and send it back")}">${L("退回", "Send back")}</button></span>` : ""}</div>
    ${review ? "" : `<div class="ops"><button type="button" class="sp-btn sm" data-op="run" title="${L("交给 AI 智能体执行：先选仅调研还是写代码，以及权限", "Hand it to an AI agent: choose research or code, and what it may do")}"><span class="spark" aria-hidden="true">✦</span>${L("执行", "Run")}</button><button type="button" class="sp-btn sm" data-op="edit">${L("详情", "Open")}</button></div>`}
  </div>`;
}
/**
 * The row and the left column (lists, projects, tags, the machine's count) show the new state at once;
 * the list is read again once the machine has it (and put back when it refused).
 */
function showStatus(id: number, status: Status | "deleted") {
  // The change is made to its machine's answer, so the other machines' answers still coming merge with it.
  const m = at();
  const ans = answers.get(m);
  const act = ans && (ans.a ?? ans.r).todos;
  const t = ans && (ans.r.todos.find((x) => x.id === id) ?? act!.find((x) => x.id === id));
  if (!ans || !t) return;
  // A read already on its way has the state from before: it is dropped, the read after the change draws.
  loadSeq++;
  waiting.clear();
  const r = moveRow({ counts: ans.r.counts, active: act!, tags: ans.r.tags, projects: ans.r.projects }, t, status, scopeOf(statusOf(view)));
  if (status === "done") tickDone = true;
  let rows = ans.r.todos;
  for (const x of r.moved) {
    const row = rows.find((y) => y.id === x.id);
    if (!row) continue;
    if (x.status === null) rows = rows.filter((y) => y !== row);
    else if (x.status !== row.status) { row.status = x.status as Status; row.doneAt = x.status === "done" ? new Date().toISOString() : null; }
  }
  answers.set(m, { r: { ...ans.r, todos: rows, counts: r.counts ?? ans.r.counts, tags: r.tags, projects: r.projects }, a: { todos: r.active }, w: ans.w });
  const mc = machines.find((x) => x.via === m);
  if (mc && mc.active !== null) mc.active = Math.max(0, mc.active + r.activeDelta);
  draw();
}
async function setStatus(id: number, status: Status) {
  showStatus(id, status);
  try { await api(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); }
  catch (e) { toast((e as Error).message); }
  await load().catch((e) => toast((e as Error).message));
}
/** The person's verdict on a task in review: accept closes it, reject sends it back to doing with the reason as a record. */
async function verdict(id: number, v: "accept" | "reject", reason?: string): Promise<boolean> {
  showStatus(id, v === "accept" ? "done" : "doing");
  try {
    await api(`/api/todos/${id}/review`, { method: "POST", body: JSON.stringify({ verdict: v, reason, source: "manual" }) });
    toast(v === "accept" ? L("验收通过，已完成", "Accepted and done") : L("已退回，原因已写入操作记录", "Sent back; the reason is in the operation records"));
    if (cur?.id === id) await openDetail(id);
    await load().catch((e) => toast((e as Error).message));
    return true;
  } catch (e) { toast((e as Error).message); await load(); return false; }
}

// ---- detail modal
let cur: Todo | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let liveAbort: AbortController | null = null;
const d = {
  done: $<HTMLInputElement>("#d-done"), title: $<HTMLInputElement>("#d-title"), due: $<HTMLInputElement>("#d-due"), priority: $<HTMLSelectElement>("#d-priority"),
  project: $<HTMLInputElement>("#d-project"), tags: $<HTMLInputElement>("#d-tags"), notes: $<HTMLTextAreaElement>("#d-notes"), notesView: $("#d-notes-view"), extra: $<HTMLInputElement>("#d-extra"),
  records: $("#d-records"), recordContent: $<HTMLTextAreaElement>("#d-record-content"), recordAdd: $<HTMLButtonElement>("#d-record-add"), recordMore: $<HTMLButtonElement>("#d-record-more"),
  runs: $("#d-runs"), events: $("#d-events"), execute: $<HTMLButtonElement>("#d-execute"), doing: $<HTMLButtonElement>("#d-doing"), defer: $<HTMLButtonElement>("#d-defer"),
  review: $<HTMLButtonElement>("#d-review"), accept: $<HTMLButtonElement>("#d-accept"), reject: $<HTMLButtonElement>("#d-reject"),
  rejectBox: $("#d-reject-box"), rejectReason: $<HTMLTextAreaElement>("#d-reject-reason"), rejectSend: $<HTMLButtonElement>("#d-reject-send"),
  subsN: $("#d-subs-n"), subsList: $("#d-subs-list"), subAdd: $<HTMLInputElement>("#d-sub-add"), parent: $("#d-parent"),
};
let curSubs: Todo[] = [];
type Detail = RecordPage & { todo: Todo; planMeta: PlanMeta | null; parent: Todo | null; subtasks: Todo[]; events: TodoEvent[]; runs: Run[] };
/** The detail is a modal over the page: the page behind it does not scroll while it is open. */
function showDetailEl(on: boolean) {
  els.detail.hidden = !on;
  document.body.classList.toggle("modal-open", on);
  if (on) closeDrawers();
}
async function openDetail(id: number, execute = false) {
  // Moving from one todo to another (a subtask, its parent) keeps what was typed in the first.
  if (cur) { clearTimeout(saveTimer); await flushSave(); await flushPlan(); liveAbort?.abort(); liveAbort = null; }
  const r = await api<Detail>(`/api/todos/${id}`).catch((e) => { toast((e as Error).message); return null; });
  if (!r) return;
  cur = r.todo;
  fillDetail(r.todo);
  fillPlan(r.todo, r.planMeta);
  renderSubs(r.parent, r.subtasks);
  renderRuns(r.runs);
  renderEvents(r.events);
  renderRecords(r);
  d.recordContent.value = recordDrafts.get(id) ?? "";
  renderRecordImages();
  showDetailEl(true);
  // In the all-machines view the address names the todo's machine too (`at`), so a reload opens the same one.
  history.replaceState(null, "", allMode() ? `?${new URLSearchParams({ m: ALL, ...(detailVia ? { at: detailVia } : {}), todo: String(id) })}` : `?todo=${id}`);
  const running = r.runs.find((x) => x.status === "running");
  if (!running && aiRuns.delete(runKey(id))) renderList();
  if (running) followRun(`/api/runs/${running.id}/stream`, {});
  else if (execute) askRun();
  else d.title.focus();
}
function fillDetail(t: Todo) {
  d.done.checked = t.status === "done"; d.title.value = t.title; d.due.value = t.due ? (t.due.length > 10 ? t.due : `${t.due}T09:00`) : "";
  d.due.dataset.dayOnly = t.due && t.due.length === 10 ? "1" : "";
  d.priority.value = String(t.priority); d.project.value = t.project ?? ""; d.tags.value = t.tags.join(", "); d.notes.value = t.notes;
  d.doing.textContent = t.status === "doing" ? L("返回待办", "Back to open") : L("开始做", "Start");
  d.defer.textContent = t.status === "deferred" ? L("恢复待办", "Restore") : L("暂不处理", "Defer");
  d.defer.hidden = t.status === "done" || t.status === "dropped" || t.status === "review";
  // A subtask moves with its parent, so only a top-level task offers the move, and only with somewhere to go.
  $("#d-move").hidden = machines.length < 2 || t.parentId !== null;
  d.doing.hidden = t.status === "deferred" || t.status === "review";
  d.review.hidden = t.status !== "open" && t.status !== "doing";
  d.accept.hidden = d.reject.hidden = t.status !== "review";
  d.rejectBox.hidden = true;
  showNotes(t.notes ? "view" : "edit");
}
/** Notes are Markdown: rendered until clicked, a textarea while editing, rendered again on blur. */
function showNotes(mode: "view" | "edit") {
  if (mode === "view" && d.notes.value.trim()) { d.notesView.innerHTML = renderMd(d.notes.value); d.notesView.hidden = false; d.notes.hidden = true; }
  else { d.notesView.hidden = true; d.notes.hidden = false; sizeNotes(); }
}
/** The textarea grows with its content up to the viewport cap in CSS; past that it scrolls inside. */
function sizeNotes() { d.notes.style.height = "auto"; d.notes.style.height = `${Math.max(84, d.notes.scrollHeight + 2)}px`; }
d.notesView.onclick = (e) => { if ((e.target as HTMLElement).closest("a")) return; showNotes("edit"); d.notes.focus(); };
d.notes.onblur = () => showNotes("view");
function closeDetail() {
  if (!cur) return;
  clearTimeout(saveTimer); void flushSave(); void flushPlan();
  liveAbort?.abort(); liveAbort = null;
  if (plan.full.open) plan.full.close();
  if (ask.dialog.open) ask.dialog.close();
  if (move.dialog.open) move.dialog.close();
  cur = null; showDetailEl(false);
  syncUrl();
  void load();
}
$("#d-close").onclick = closeDetail;
els.scrim.onclick = () => closeDrawers();
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.detail.hidden && !plan.full.open && !$<HTMLDialogElement>("#run-ask").open && !$<HTMLDialogElement>("#move-ask").open && !$<HTMLDialogElement>("#image-view").open && document.activeElement?.tagName !== "TEXTAREA") closeDetail(); });
// A plan typed but not saved yet (the half second, or a conflict waiting for a choice) is worth a warning.
window.addEventListener("beforeunload", (e) => { if (plan.dirty) { void flushPlan(); e.preventDefault(); } });

// ---- the plan (方案): one living Markdown document, autosaved as a version; earlier versions can be read and restored
const plan = {
  text: $<HTMLTextAreaElement>("#d-plan"), view: $("#d-plan-view"), meta: $("#d-plan-meta"), state: $("#d-plan-state"),
  conflictBar: $("#d-plan-conflict"), drawer: $("#d-plan-drawer"), list: $("#d-plan-list"), show: $("#d-plan-show"), versionsBtn: $<HTMLButtonElement>("#d-plan-versions"),
  read: $("#d-plan-read"), empty: $("#d-plan-empty"), more: $<HTMLButtonElement>("#d-plan-more"), editBtn: $<HTMLButtonElement>("#d-plan-edit"),
  full: $<HTMLDialogElement>("#plan-full"), fullBody: $("#pf-body"), fullMeta: $("#pf-meta"),
  /** Read-only (rendered, two lines) until 编辑; 完成 goes back. */
  mode: "view" as "view" | "edit",
  /** The version the text in the box is based on; a save says so, and the server answers 409 when it moved on. */
  version: 0,
  /** One id per opened detail: saves with it merge into this editor's own latest version for a minute. */
  session: "",
  dirty: false,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  saving: null as Promise<void> | null,
  /** What the server holds when a save was refused; the bar offers it or an overwrite. */
  conflict: null as { plan: string; planVersion: number } | null,
};
const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 64);
function planMetaText(meta: PlanMeta | null) {
  plan.meta.textContent = plan.fullMeta.textContent = meta ? `v${meta.version} · ${fmtAgo(meta.createdAt)} · ${meta.source}` : "";
}
function fillPlan(t: Todo, meta: PlanMeta | null) {
  clearTimeout(plan.timer);
  plan.version = t.planVersion; plan.session = newSession(); plan.dirty = false; plan.conflict = null;
  plan.text.value = t.plan; plan.state.textContent = ""; plan.conflictBar.hidden = true;
  plan.drawer.hidden = true; plan.versionsBtn.setAttribute("aria-expanded", "false"); plan.versionsBtn.hidden = !t.planVersion;
  planMetaText(meta);
  if (plan.full.open) plan.full.close();
  showPlan("view");
}
/**
 * The plan is read-only by default: rendered Markdown cut to two lines, 更多 (only when it is longer) opens the
 * whole of it in an overlay, and 编辑 turns the section into the textarea until 完成. Clicking the text never edits it.
 */
function showPlan(mode: "view" | "edit") {
  plan.mode = mode;
  const editing = mode === "edit";
  plan.text.hidden = !editing; plan.read.hidden = editing;
  plan.editBtn.textContent = editing ? L("完成", "Done") : L("编辑", "Edit");
  plan.editBtn.title = editing ? L("保存并回到只读", "Save and go back to reading") : L("编辑方案", "Edit the plan");
  if (editing) { sizePlan(); return; }
  const has = !!plan.text.value.trim();
  plan.view.innerHTML = has ? renderMd(plan.text.value) : "";
  plan.view.hidden = !has; plan.empty.hidden = has;
  measurePlan();
}
/** 更多 only when the rendered plan is taller than its two lines; measured again whenever the box changes size. */
function measurePlan() {
  plan.more.hidden = plan.view.hidden || plan.view.scrollHeight <= plan.view.clientHeight + 1;
  plan.read.classList.toggle("clipped", !plan.more.hidden);
}
new ResizeObserver(() => { if (plan.mode === "view") measurePlan(); }).observe(plan.view);
function sizePlan() { plan.text.style.height = "auto"; plan.text.style.height = `${Math.max(84, plan.text.scrollHeight + 2)}px`; }
function editPlan() {
  if (plan.full.open) plan.full.close();
  showPlan("edit");
  plan.text.focus();
}
/** 完成: save what is pending, then back to read-only; a conflict keeps the editor until it is resolved in the bar. */
async function finishPlan() {
  await flushPlan();
  if (plan.conflict) { toast(L("先处理方案冲突", "Resolve the plan conflict first")); plan.text.focus(); return; }
  showPlan("view");
  plan.editBtn.focus();
}
plan.editBtn.onclick = () => { if (plan.mode === "edit") void finishPlan(); else editPlan(); };
plan.text.addEventListener("keydown", (e) => { if (e.key === "Escape" && !e.isComposing) { e.preventDefault(); e.stopPropagation(); void finishPlan(); } });
plan.more.onclick = () => {
  plan.fullBody.innerHTML = renderMd(plan.text.value);
  plan.full.showModal();
  plan.fullBody.scrollTop = 0;
  plan.fullBody.focus();
};
$("#pf-close").onclick = () => plan.full.close();
$("#pf-edit").onclick = editPlan;
// A click on the backdrop lands on the dialog itself (the card fills it); Esc closes it natively.
plan.full.onclick = (e) => { if (e.target === plan.full) plan.full.close(); };
plan.full.addEventListener("close", () => { if (plan.mode === "view" && !els.detail.hidden) plan.more.focus(); });
function schedulePlan() {
  plan.dirty = true;
  if (plan.conflict) return;   // nothing is saved until the person chooses in the bar
  plan.state.textContent = L("未保存", "Unsaved");
  clearTimeout(plan.timer);
  plan.timer = setTimeout(() => void flushPlan(), 500);
}
// As for the notes: while an IME composes, the box holds raw syllables; save when the word is committed.
plan.text.oninput = (e) => { sizePlan(); if (!(e as InputEvent).isComposing) schedulePlan(); };
plan.text.addEventListener("compositionend", () => schedulePlan());
/** One PUT of the plan; answers the parsed body and the status, so a 409 can be shown instead of thrown. */
async function putPlan(id: number, body: Record<string, unknown>) {
  const r = await fetch(on(`/api/todos/${id}/plan`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "manual", ...body }) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; todo?: Todo; planMeta?: PlanMeta | null; plan?: string; planVersion?: number } };
}
async function flushPlan(force = false): Promise<void> {
  clearTimeout(plan.timer);
  if (plan.saving) await plan.saving;
  if (!cur || !plan.dirty || (plan.conflict && !force)) return;
  const id = cur.id, content = plan.text.value;
  plan.dirty = false;
  plan.state.textContent = L("保存中…", "Saving…");
  plan.saving = (async () => {
    try {
      const r = await putPlan(id, { content, expectedVersion: plan.version, session: plan.session });
      if (cur?.id !== id) return;
      if (r.status === 409) {
        plan.dirty = true;
        plan.conflict = { plan: r.body.plan ?? "", planVersion: r.body.planVersion ?? 0 };
        plan.conflictBar.hidden = false; plan.state.textContent = L("未保存", "Unsaved");
        showPlan("edit");
        return;
      }
      if (!r.body.ok || !r.body.todo) throw new Error(r.body.error ?? `HTTP ${r.status}`);
      plan.version = r.body.todo.planVersion; cur = { ...cur, plan: r.body.todo.plan, planVersion: r.body.todo.planVersion };
      if (plan.text.value !== content) plan.dirty = true;   // typed while saving: the next save carries it
      plan.state.textContent = plan.dirty ? L("未保存", "Unsaved") : L("已保存", "Saved");
      plan.versionsBtn.hidden = !plan.version;
      planMetaText(r.body.planMeta ?? null);
      if (!plan.drawer.hidden) void loadPlanVersions();
    } catch (e) {
      plan.dirty = true; plan.state.textContent = L("保存失败", "Not saved");
      toast(L(`方案保存失败：${(e as Error).message}`, `Plan not saved: ${(e as Error).message}`));
    }
  })();
  await plan.saving;
  plan.saving = null;
  if (plan.dirty && !plan.conflict && cur?.id === id) schedulePlan();
}
$("#d-plan-reload").onclick = () => {
  if (!plan.conflict) return;
  plan.text.value = plan.conflict.plan; plan.version = plan.conflict.planVersion;
  plan.conflict = null; plan.dirty = false; plan.conflictBar.hidden = true; plan.state.textContent = L("已载入最新", "Latest loaded");
  showPlan("view");
  if (cur) void api<Detail>(`/api/todos/${cur.id}`).then((r) => { if (cur?.id === r.todo.id) { planMetaText(r.planMeta); renderEvents(r.events); } }, () => {});
};
$("#d-plan-force").onclick = async () => {
  if (!plan.conflict || !confirm(L("用你的版本覆盖最新方案？被覆盖的版本仍可在「版本」里找回。", "Overwrite the latest plan with yours? The overwritten version stays under Versions."))) return;
  // Based on the version that is there now, as a new version of its own (no merging into someone else's).
  plan.version = plan.conflict.planVersion; plan.session = newSession();
  plan.conflict = null; plan.conflictBar.hidden = true;
  plan.dirty = true;
  await flushPlan(true);
};
plan.versionsBtn.onclick = async () => {
  const open = plan.drawer.hidden;
  plan.drawer.hidden = !open; plan.versionsBtn.setAttribute("aria-expanded", String(open));
  if (open) { plan.show.innerHTML = ""; await loadPlanVersions(); }
};
async function loadPlanVersions() {
  if (!cur) return;
  const id = cur.id;
  try {
    const r = await api<{ versions: PlanVersionRow[] }>(`/api/todos/${id}/plan/versions`);
    if (cur?.id !== id) return;
    plan.list.innerHTML = r.versions.map((v) => `<button type="button" class="plan-ver${v.version === plan.version ? " current" : ""}" data-version="${v.version}" aria-pressed="false">
      <b>v${v.version}</b><span>${esc(fmtAgo(v.createdAt))} · ${esc(v.source)} · ${L(`${v.chars} 字`, `${v.chars} chars`)}${v.version === plan.version ? L(" · 当前", " · current") : ""}</span><i>${esc(v.excerpt || L("（空）", "(empty)"))}</i></button>`).join("") || `<p class="sp-hint">${L("还没有版本", "No versions yet")}</p>`;
  } catch (e) { toast((e as Error).message); }
}
plan.list.onclick = async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-version]");
  if (!b || !cur) return;
  const id = cur.id, n = Number(b.dataset.version);
  plan.list.querySelectorAll(".plan-ver").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  try {
    const { version: v } = await api<{ version: PlanVersionRow & { content: string } }>(`/api/todos/${id}/plan/versions?version=${n}`);
    if (cur?.id !== id) return;
    plan.show.innerHTML = `<div class="run-head"><b>v${v.version}</b><span>${esc(new Date(v.createdAt).toLocaleString())}</span><span>${esc(v.source)}</span>${v.version === plan.version ? `<span>${L("当前版本", "Current version")}</span>` : `<button type="button" class="sp-btn sm" data-restore="${v.version}">${L("恢复此版", "Restore this one")}</button>`}</div>
      <div class="md">${v.content ? renderMd(v.content) : `<p class="sp-hint">${L("（空）", "(empty)")}</p>`}</div>`;
    const restore = plan.show.querySelector<HTMLButtonElement>("[data-restore]");
    if (restore) restore.onclick = async () => {
      // A restore is a new version with that text; nothing is removed.
      await flushPlan();
      if (plan.conflict || cur?.id !== id) { toast(L("先处理方案冲突", "Resolve the plan conflict first")); return; }
      restore.disabled = true;
      const r = await putPlan(id, { content: v.content, expectedVersion: plan.version });
      if (r.status === 409) { toast(L("方案刚被他人更新，请重新打开版本列表", "Someone just updated the plan; open the versions again")); restore.disabled = false; return; }
      if (!r.body.ok || !r.body.todo) { toast(r.body.error ?? L("恢复失败", "Restore failed")); restore.disabled = false; return; }
      if (cur?.id !== id) return;
      cur = { ...cur, plan: r.body.todo.plan, planVersion: r.body.todo.planVersion };
      fillPlan(cur, r.body.planMeta ?? null);
      plan.drawer.hidden = false; plan.versionsBtn.setAttribute("aria-expanded", "true");
      await loadPlanVersions();
      plan.show.innerHTML = "";
      toast(L(`已恢复 v${v.version}，保存为 v${r.body.todo.planVersion}`, `Restored v${v.version} as v${r.body.todo.planVersion}`));
      const detail = await api<Detail>(`/api/todos/${id}`);
      if (cur?.id === id) renderEvents(detail.events);
    };
  } catch (err) { toast((err as Error).message); }
};

let pending: Record<string, unknown> = {};
function scheduleSave(patch: Record<string, unknown>) {
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 500);
}
async function flushSave() {
  if (!cur || !Object.keys(pending).length) return;
  const body = pending; pending = {};
  try {
    const r = await api<{ todo: Todo }>(`/api/todos/${cur.id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (cur && cur.id === r.todo.id) cur = r.todo;
    // The due day moves it between 今天 and 即将, a project or tag between their counts.
    if ("due" in body || "project" in body || "tags" in body) void load().catch(() => {});
  } catch (e) { toast(L(`保存失败：${(e as Error).message}`, `Not saved: ${(e as Error).message}`)); }
}
// While an IME composes (pinyin), the field holds the raw syllables: save when the word is committed.
d.title.oninput = (e) => { if (!(e as InputEvent).isComposing) scheduleSave({ title: d.title.value }); };
d.title.addEventListener("compositionend", () => scheduleSave({ title: d.title.value }));
d.notes.oninput = (e) => { sizeNotes(); if (!(e as InputEvent).isComposing) scheduleSave({ notes: d.notes.value }); };
d.notes.addEventListener("compositionend", () => scheduleSave({ notes: d.notes.value }));
d.due.onchange = () => { d.due.dataset.dayOnly = ""; scheduleSave({ due: d.due.value ? d.due.value.slice(0, 16) : null }); };
d.priority.onchange = () => scheduleSave({ priority: Number(d.priority.value) });
d.project.onchange = () => scheduleSave({ project: d.project.value.trim() || null });
d.tags.onchange = () => scheduleSave({ tags: d.tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
d.done.onchange = async () => {
  if (!cur) return;
  if (cur.status === "review" && d.done.checked) { await verdict(cur.id, "accept"); return; }
  const open = curSubs.filter((s) => s.status === "open" || s.status === "doing" || s.status === "deferred").length;
  const status = d.done.checked ? "done" : "open";
  showStatus(cur.id, status);
  try { await api(`/api/todos/${cur.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); }
  catch (e) { toast((e as Error).message); d.done.checked = !d.done.checked; await load().catch(() => {}); return; }
  toast(d.done.checked ? (open ? L(`已完成，连同 ${open} 个子任务`, `Done, with ${open} subtask(s)`) : L("已完成", "Done")) : L("已重新打开", "Reopened"));
  closeDetail();
};

// ---- subtasks in the detail: a parent lists and adds its steps; a subtask shows whose step it is
function renderSubs(parent: Todo | null, subs: Todo[]) {
  curSubs = subs;
  const isSub = !!cur?.parentId;
  d.parent.hidden = !isSub;
  $("#d-subs-label").textContent = isSub ? L("所属任务", "Parent task") : L("子任务", "Subtasks");
  d.subsList.hidden = isSub; d.subAdd.hidden = isSub;
  const done = subs.filter((s) => s.status === "done").length;
  d.subsN.textContent = isSub ? "" : subs.length ? `${done}/${subs.length}` : "";
  if (isSub) {
    d.parent.innerHTML = `${L("属于", "Step of")} <a href="?todo=${cur!.parentId}" data-open="${cur!.parentId}">${esc(parent?.title ?? `#${cur!.parentId}`)}</a> <button type="button" class="sp-btn sm" data-op="detach">${L("移出", "Detach")}</button>`;
    $<HTMLElement>("[data-open]", d.parent).onclick = (e) => { e.preventDefault(); void openDetail(cur!.parentId!); };
    $<HTMLElement>("[data-op=detach]", d.parent).onclick = () => void patchSub(cur!.id, { parentId: null }, L("已移出，成为独立任务", "Detached: now a task of its own"));
    return;
  }
  d.subsList.innerHTML = subs.map((s) => `
    <div class="subrow ${s.status}" data-id="${s.id}">
      ${checkHtml(s.status === "done", `${L("完成", "Done:")} ${s.title}`)}
      <span class="title">${esc(s.title)}</span>
      ${s.status === "deferred" ? `<span class="sp-badge off">${L("暂不处理", "Deferred")}</span>` : ""}
      ${s.due ? `<span class="sp-chip due${isLate(s) && s.status !== "done" && s.status !== "deferred" && cur?.status !== "deferred" ? " late" : ""}">${esc(fmtDue(s.due))}</span>` : ""}
    </div>`).join("");
  d.subsList.querySelectorAll<HTMLElement>(".subrow").forEach((row) => {
    const id = Number(row.dataset.id);
    $<HTMLInputElement>("input", row).onchange = (e) => void patchSub(id, { status: (e.target as HTMLInputElement).checked ? "done" : "open" });
    $<HTMLElement>(".title", row).onclick = () => void openDetail(id);
  });
}
async function patchSub(id: number, patch: { status?: Status; parentId?: null }, note?: string) {
  if (patch.status) showStatus(id, patch.status);
  try { await api(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }); await refreshSubs(); if (note) toast(note); }
  catch (e) { toast((e as Error).message); }
  // The list behind the detail and its counts: a step done or detached changes them.
  void load().catch((e) => toast((e as Error).message));
}
async function refreshSubs() {
  if (!cur) return;
  const r = await api<Detail>(`/api/todos/${cur.id}`);
  cur = r.todo; renderSubs(r.parent, r.subtasks); renderEvents(r.events);
}
d.subAdd.onkeydown = async (e) => {
  if (e.key !== "Enter" || e.isComposing || !cur) return;
  const title = d.subAdd.value.trim();
  if (!title) return;
  d.subAdd.disabled = true;
  try {
    // A step keeps its task's project and tags, as the AI's splits do.
    await api("/api/todos", { method: "POST", body: JSON.stringify({ title, parentId: cur.id, project: cur.project, tags: cur.tags }) });
    d.subAdd.value = "";
    await refreshSubs();
    void load().catch((e) => toast((e as Error).message));
  } catch (err) { toast((err as Error).message); }
  finally { d.subAdd.disabled = false; d.subAdd.focus(); }
};
d.defer.onclick = async () => {
  if (!cur) return;
  const id = cur.id;
  const restoring = cur.status === "deferred";
  d.defer.disabled = true;
  try {
    clearTimeout(saveTimer); await flushSave(); await flushPlan();
    showStatus(id, restoring ? "open" : "deferred");
    const r = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status: restoring ? "open" : "deferred" }) });
    await load();
    if (cur?.id === id) await openDetail(id);
    toast(restoring ? (isLate(r.todo) ? L("已恢复待办，原截止日期已过，请调整日期", "Restored; its due date has passed, set a new one") : L("已恢复待办", "Restored")) : L("已暂不处理，可从左侧列表恢复", "Deferred; restore it from the list on the left"));
  } catch (e) { toast((e as Error).message); void load().catch(() => {}); }
  finally { d.defer.disabled = false; }
};
d.review.onclick = async () => {
  if (!cur) return;
  const id = cur.id;
  clearTimeout(saveTimer); await flushSave(); await flushPlan();
  showStatus(id, "review");
  try { await api(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status: "review" }) }); toast(L("已提交验收", "Submitted for review")); if (cur?.id === id) await openDetail(id); }
  catch (e) { toast((e as Error).message); }
  void load().catch((e) => toast((e as Error).message));
};
d.accept.onclick = () => { if (cur) void verdict(cur.id, "accept"); };
/** Rejecting asks why: the reason is required and becomes an operation record. */
function openReject() {
  if (!cur || cur.status !== "review") return;
  d.rejectBox.hidden = false;
  d.rejectReason.focus();
  d.rejectBox.scrollIntoView({ block: "nearest" });
}
d.reject.onclick = openReject;
$("#d-reject-cancel").onclick = () => { d.rejectBox.hidden = true; };
d.rejectSend.onclick = async () => {
  if (!cur) return;
  const reason = d.rejectReason.value.trim();
  if (!reason) { toast(L("请写明退回原因", "Say why it goes back")); d.rejectReason.focus(); return; }
  d.rejectSend.disabled = true;
  try { if (await verdict(cur.id, "reject", reason)) d.rejectReason.value = ""; }
  finally { d.rejectSend.disabled = false; }
};
// In progress counts under 今天, so the left column changes too.
d.doing.onclick = async () => {
  if (!cur) return;
  const id = cur.id;
  const status = cur.status === "doing" ? "open" : "doing";
  showStatus(id, status);
  try { const r = await api<{ todo: Todo }>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); if (cur?.id === id) { cur = r.todo; fillDetail(cur); } }
  catch (e) { toast((e as Error).message); }
  void load().catch((e) => toast((e as Error).message));
};
$("#d-delete").onclick = async () => {
  const open = curSubs.length;
  if (!cur || !confirm(L(`删除「${cur.title}」${open ? `和它的 ${open} 个子任务` : ""}？`, `Delete “${cur.title}”${open ? ` and its ${open} subtask(s)` : ""}?`))) return;
  const id = cur.id;
  try { await api(`/api/todos/${id}`, { method: "DELETE" }); }
  catch (e) { toast((e as Error).message); return; }
  showStatus(id, "deleted");
  cur = null; showDetailEl(false); toast(L("已删除", "Deleted"));
  void load().catch((e) => toast((e as Error).message));
};

// Drafts stay with their todo when the detail is closed or another task is opened.
const recordDrafts = new Map<number, string>();
const recordImages = new Map<number, { file: File; url: string }[]>();
const imageInput = $<HTMLInputElement>("#d-record-images");
const imagePreview = $("#d-record-preview");
function renderRecordImages() {
  imageInput.value = "";
  imagePreview.innerHTML = (cur ? recordImages.get(cur.id) ?? [] : []).map((image, i) =>
    `<div class="record-preview-item"><img src="${esc(image.url)}" alt="${esc(image.file.name)}"><button type="button" class="sp-btn sm" data-remove-image="${i}" aria-label="${L("移除图片", "Remove picture")} ${esc(image.file.name)}">${L("移除", "Remove")}</button></div>`).join("");
}
function addRecordImages(files: File[]) {
  if (!cur) return;
  const images = recordImages.get(cur.id) ?? [];
  if (images.length + files.length > 6) { toast(L("每条记录最多 6 张图片", "At most 6 pictures per record")); return; }
  if (files.some(file => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024)) {
    toast(L("请选择 PNG、JPEG、GIF 或 WebP 图片，每张不超过 10 MB", "Pick PNG, JPEG, GIF or WebP pictures of at most 10 MB each")); return;
  }
  recordImages.set(cur.id, [...images, ...files.map(file => ({ file, url: URL.createObjectURL(file) }))]);
  renderRecordImages();
}
imageInput.onchange = () => { addRecordImages(Array.from(imageInput.files ?? [])); imageInput.value = ""; };
imagePreview.onclick = event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-remove-image]");
  if (!button || !cur) return;
  const images = recordImages.get(cur.id) ?? [];
  const removed = images.splice(Number(button.dataset.removeImage), 1)[0];
  if (removed) URL.revokeObjectURL(removed.url);
  renderRecordImages();
};
d.recordContent.addEventListener("paste", event => {
  const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith("image/"));
  if (files.length) { event.preventDefault(); addRecordImages(files); }
});
let recordCursor: number | null = null;
/** The records on screen by id, for editing in place. */
const shownRecords = new Map<number, OperationRecord>();
const recordHtml = (r: OperationRecord) => `<article class="operation-record" data-rid="${r.id}">
    <div class="run-head"><time datetime="${esc(r.createdAt)}">${esc(new Date(r.createdAt).toLocaleString())}</time><span>${esc(r.source)}</span>${r.revision && r.editedAt ? `<button type="button" class="edited" data-revisions title="${L("查看旧版本", "Earlier versions")}">${L("已编辑", "Edited")} · ${esc(fmtAgo(r.editedAt))}</button>` : ""}<button type="button" class="sp-btn ghost sm" data-edit>${L("编辑", "Edit")}</button></div>
    <div class="md">${renderMd(r.content)}</div><div class="record-images">${(r.attachments ?? []).map(image => `<a href="${esc(on(`/blobs/${image.key}`))}" target="_blank" rel="noopener"><img src="${esc(on(`/blobs/${image.key}`))}" alt="${esc(image.name)}" loading="lazy"></a>`).join("")}</div></article>`;
// A record's pictures open in the page, not a new tab (the desktop client's webview cannot open one).
const imageView = {
  dialog: $<HTMLDialogElement>("#image-view"), img: $<HTMLImageElement>("#iv-img"), stage: $("#iv-stage"),
  name: $("#iv-name"), count: $("#iv-count"), open: $<HTMLAnchorElement>("#iv-open"),
  prev: $<HTMLButtonElement>("#iv-prev"), next: $<HTMLButtonElement>("#iv-next"),
  list: [] as { src: string; name: string }[], at: 0,
};
function showImage(at: number) {
  const v = imageView, image = v.list[at];
  if (!image) return;
  v.at = at;
  v.dialog.classList.remove("zoomed");
  v.img.src = image.src; v.img.alt = image.name;
  v.name.textContent = image.name;
  v.open.href = image.src;
  v.count.textContent = v.list.length > 1 ? `${at + 1} / ${v.list.length}` : "";
  v.prev.hidden = v.next.hidden = v.list.length < 2;
}
function stepImage(by: number) { const n = imageView.list.length; if (n > 1) showImage((imageView.at + by + n) % n); }
imageView.prev.onclick = () => stepImage(-1);
imageView.next.onclick = () => stepImage(1);
$("#iv-close").onclick = () => imageView.dialog.close();
imageView.dialog.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); stepImage(-1); } else if (e.key === "ArrowRight") { e.preventDefault(); stepImage(1); }
});
// The picture toggles fit / actual size, keeping the clicked point under the pointer; a click beside it closes.
imageView.img.onclick = (e) => {
  const { img, stage, dialog } = imageView;
  if (dialog.classList.contains("zoomed") || (img.naturalWidth <= img.clientWidth && img.naturalHeight <= img.clientHeight)) { dialog.classList.remove("zoomed"); return; }
  const box = img.getBoundingClientRect(), fx = (e.clientX - box.left) / box.width, fy = (e.clientY - box.top) / box.height;
  dialog.classList.add("zoomed");
  stage.scrollLeft = img.offsetLeft + fx * img.offsetWidth - stage.clientWidth / 2;
  stage.scrollTop = img.offsetTop + fy * img.offsetHeight - stage.clientHeight / 2;
};
imageView.stage.onclick = (e) => { if (e.target === imageView.stage) imageView.dialog.close(); };
imageView.dialog.addEventListener("close", () => { imageView.img.removeAttribute("src"); imageView.dialog.classList.remove("zoomed"); });
function openImage(link: HTMLAnchorElement) {
  const links = Array.from(link.closest(".record-images")?.querySelectorAll<HTMLAnchorElement>("a") ?? [link]);
  imageView.list = links.map(a => ({ src: a.getAttribute("href") ?? "", name: a.querySelector("img")?.alt ?? "" }));
  imageView.dialog.showModal();
  showImage(Math.max(0, links.indexOf(link)));
}
function renderRecords(page: RecordPage, append = false) {
  if (!append) shownRecords.clear();
  for (const r of page.records) shownRecords.set(r.id, r);
  const html = page.records.map(recordHtml).join("");
  if (append) d.records.insertAdjacentHTML("beforeend", html);
  else d.records.innerHTML = html || `<p class="sp-hint">${L("还没有操作记录", "No records yet")}</p>`;
  recordCursor = page.recordsNextBefore;
  d.recordMore.hidden = recordCursor === null;
}
d.recordContent.oninput = () => { if (cur) recordDrafts.set(cur.id, d.recordContent.value); };
// Editing a record in place: the text becomes a box with save and cancel; the server keeps the earlier text.
d.records.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const link = target.closest<HTMLAnchorElement>(".record-images a");
  // A plain click opens the viewer; ctrl/⌘/middle click still opens the picture in a new tab.
  if (link && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) { e.preventDefault(); openImage(link); return; }
  const article = target.closest<HTMLElement>(".operation-record");
  if (!article || !cur) return;
  const rid = Number(article.dataset.rid), record = shownRecords.get(rid);
  if (!record) return;
  const todoId = cur.id;
  if (target.closest("[data-edit]")) {
    if (article.querySelector(".record-edit")) return;
    const md = $(".md", article);
    md.hidden = true;
    const box = el(`<div class="record-edit"><textarea class="sp-textarea d-notes" maxlength="20000" spellcheck="false" aria-label="${L("编辑记录", "Edit record")}"></textarea>
      <div class="record-edit-bar"><span class="sp-hint">${L("只在更正事实时编辑；结论变了请追加新记录。旧版本会保留。", "Edit only to correct a fact; a new conclusion is a new record. Earlier versions are kept.")}</span><div class="grow"></div><button type="button" class="sp-btn sm" data-cancel>${L("取消", "Cancel")}</button><button type="button" class="sp-btn sm" data-save>${L("保存", "Save")}</button></div></div>`);
    const ta = $<HTMLTextAreaElement>("textarea", box);
    ta.value = record.content;
    md.after(box);
    ta.style.height = `${Math.max(84, ta.scrollHeight + 2)}px`;
    ta.focus();
    $<HTMLElement>("[data-cancel]", box).onclick = () => { box.remove(); md.hidden = false; };
    const save = $<HTMLButtonElement>("[data-save]", box);
    save.onclick = async () => {
      save.disabled = true;
      try {
        const r = await fetch(on(`/api/todos/${todoId}/records/${rid}`), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: ta.value, source: "manual", expectedRevision: record.revision }) });
        const b = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; record?: OperationRecord };
        if (r.status === 409 && b.record) {
          // Someone edited it meanwhile: show theirs, keep this text in the box to merge by hand.
          shownRecords.set(rid, b.record);
          $(".md", article).innerHTML = renderMd(b.record.content);
          toast(L("这条记录刚被他人修改，已更新下方原文；你的修改仍在输入框里", "Someone just edited this record; theirs is shown, yours is still in the box"));
          record.revision = b.record.revision; record.content = b.record.content;
          save.disabled = false;
          return;
        }
        if (!r.ok || !b.ok || !b.record) throw new Error(b.error ?? `HTTP ${r.status}`);
        shownRecords.set(rid, b.record);
        article.outerHTML = recordHtml(b.record);
        toast(b.record.revision === record.revision ? L("没有改动", "No change") : L("记录已更新，旧版本已保留", "Record updated; the earlier version is kept"));
        const detail = await api<Detail>(`/api/todos/${todoId}`);
        if (cur?.id === todoId) renderEvents(detail.events);
      } catch (err) { toast((err as Error).message); save.disabled = false; }
    };
    return;
  }
  if (target.closest("[data-revisions]")) {
    const open = article.querySelector(".revisions");
    if (open) { open.remove(); return; }
    try {
      const { revisions } = await api<{ revisions: RecordRevision[] }>(`/api/todos/${todoId}/records/${rid}/revisions`);
      const list = el(`<div class="revisions">${[...revisions].reverse().map((v, i) => `<div class="revision">
        <div class="run-head"><b>${v.revision === 0 ? L("原文", "Original") : L(`修订 ${v.revision}`, `Revision ${v.revision}`)}</b><span>${esc(new Date(v.createdAt).toLocaleString())}</span><span>${esc(v.source)}</span>${i === 0 ? `<span>${L("当前", "Current")}</span>` : ""}</div>
        <div class="md">${v.content ? renderMd(v.content) : `<p class="sp-hint">${L("（无文字）", "(no text)")}</p>`}</div></div>`).join("")}</div>`);
      $(".record-images", article).after(list);
    } catch (err) { toast((err as Error).message); }
  }
});
/** Append a record written by the person and show the refreshed list. */
async function postRecord(id: number, content: string, images: { file: File }[] = []) {
  const form = new FormData();
  form.set("content", content);
  form.set("source", "manual");
  for (const image of images) form.append("images", image.file);
  await api(`/api/todos/${id}/records`, { method: "POST", body: form });
}
async function refreshRecords(id: number) {
  const detail = await api<Detail>(`/api/todos/${id}`);
  if (cur?.id === id) { renderRecords(detail); renderEvents(detail.events); }
}
// A quick reply ("做") is one tap: it appends its own text as a record and leaves the draft and pictures alone.
$("#d-record-quick").onclick = async event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-quick]");
  if (!button || !cur || button.disabled) return;
  const id = cur.id, content = button.textContent!.trim();
  button.disabled = true;
  try {
    await postRecord(id, content);
    toast(L(`已追加记录：${content}`, `Record added: ${content}`));
    await refreshRecords(id);
  } catch (e) { toast((e as Error).message); }
  finally { button.disabled = false; }
};
d.recordAdd.onclick = async () => {
  if (!cur || d.recordAdd.disabled || (!d.recordContent.value.trim() && !recordImages.get(cur.id)?.length)) return;
  const id = cur.id, content = d.recordContent.value;
  const images = [...(recordImages.get(id) ?? [])];
  d.recordAdd.disabled = true;
  try {
    await postRecord(id, content, images);
    recordImages.set(id, (recordImages.get(id) ?? []).filter(image => !images.includes(image)));
    for (const image of images) URL.revokeObjectURL(image.url);
    if (cur?.id === id) renderRecordImages();
    if (recordDrafts.get(id) === content) recordDrafts.delete(id);
    if (cur?.id === id && d.recordContent.value === content) d.recordContent.value = "";
    toast(L("已追加记录", "Record added"));
    await refreshRecords(id);
  } catch (e) { toast((e as Error).message); }
  finally { d.recordAdd.disabled = false; }
};
d.recordMore.onclick = async () => {
  if (!cur || recordCursor === null || d.recordMore.disabled) return;
  const id = cur.id, before = recordCursor;
  d.recordMore.disabled = true;
  try {
    const page = await api<RecordPage>(`/api/todos/${id}/records?before=${before}`);
    if (cur?.id === id && recordCursor === before) renderRecords(page, true);
  } catch (e) { toast((e as Error).message); }
  finally { d.recordMore.disabled = false; }
};

function renderRuns(runs: Run[]) {
  d.runs.innerHTML = runs.map(runHtml).join("");
  d.runs.querySelectorAll<HTMLElement>("[data-op=done]").forEach((b) => { b.onclick = () => { d.done.checked = true; d.done.onchange!(new Event("change")); }; });
}
function runHtml(r: Run): string {
  // Running is ink (the kit's AI mark), finished green, failed red: each with its word.
  const st = r.status === "running" ? `<span class="sp-badge ai live">${L("执行中", "Running")}</span>` : r.status === "ok" ? `<span class="sp-badge ok">${L("完成", "Finished")}</span>` : `<span class="sp-badge bad">${L("失败", "Failed")}</span>`;
  return `<div class="run${r.status === "running" ? " live" : ""}" data-run="${r.id}">
    <div class="run-head">${st}<span>${esc(fmtAgo(r.startedAt))}</span>${r.model ? `<span>${esc(r.model)}</span>` : ""}${r.costUsd != null ? `<span>$${r.costUsd.toFixed(3)}</span>` : ""}${r.error ? `<span class="err-text">${esc(r.error)}</span>` : ""}${r.status === "ok" ? `<button type="button" class="sp-btn sm" data-op="done">${cur?.status === "review" ? L("验收通过", "Accept") : L("标记完成", "Mark done")}</button>` : ""}</div>
    <div class="md">${renderMd(r.output)}</div>
  </div>`;
}
function renderEvents(events: TodoEvent[]) {
  const label: Record<string, string> = EN
    ? { review: "Submitted for review", "review-rejected": "Sent back", "plan-edited": "Plan edited", "record-edited": "Record edited", "record-added": "Record added", created: "Created", edited: "Edited", done: "Done", open: "Reopened", doing: "Started", deferred: "Deferred", dropped: "Dropped", deleted: "Deleted", "subtask-added": "Subtask added", "run-started": "AI run started", "run-finished": "AI run finished", "run-failed": "AI run failed" }
    : { review: "提交验收", "review-rejected": "验收不通过", "plan-edited": "修改方案", "record-edited": "编辑操作记录", "record-added": "追加操作记录", created: "创建", edited: "修改", done: "完成", open: "重新打开", doing: "开始", deferred: "暂不处理", dropped: "放弃", deleted: "删除", "subtask-added": "添加子任务", "run-started": "AI 开始执行", "run-finished": "AI 执行完成", "run-failed": "AI 执行失败" };
  d.events.innerHTML = events.map((e) => {
    const src = e.data.source ? ` · ${esc(String(e.data.source))}` : "";
    const changed = e.data.changed && typeof e.data.changed === "object" ? Object.keys(e.data.changed as object).join(", ") : "";
    const version = e.kind === "plan-edited" && e.data.version ? ` · v${esc(String(e.data.version))}` : e.kind === "record-edited" && e.data.revision ? L(` · 记录 ${esc(String(e.data.recordId))} 修订 ${esc(String(e.data.revision))}`, ` · record ${esc(String(e.data.recordId))} revision ${esc(String(e.data.revision))}`) : "";
    const kind = e.kind === "done" && e.data.verdict === "accept" ? L("验收通过", "Accepted") : label[e.kind] ?? esc(e.kind);
    const reason = e.kind === "review-rejected" && e.data.reason ? ` · ${esc(String(e.data.reason).slice(0, 80))}` : "";
    return `<div><span class="k">${kind}</span>${esc(fmtAgo(e.at))}${src}${version}${changed ? ` · ${esc(changed)}` : ""}${e.data.caller ? ` · ${esc(String(e.data.caller))}` : ""}${e.data.error ? ` · ${esc(String(e.data.error))}` : ""}${reason}</div>`;
  }).join("") || `<div>${L("无", "None")}</div>`;
}

type RunKind = "research" | "code";
type RunPermission = "default" | "acceptEdits" | "bypassPermissions";
/** Start an execution of the kind and with the permission picked in the dialog, and draw it as it streams. */
async function runExecute(kind: RunKind, permission: RunPermission, model: string) {
  if (!cur) return;
  clearTimeout(saveTimer); await flushSave(); await flushPlan();
  followRun(`/api/todos/${cur.id}/execute`, { method: "POST", body: JSON.stringify({ extra: d.extra.value, kind, permission, ...(model ? { model } : {}), timezone: TZ, lang: EN ? "en" : "zh" }) });
}

// ---- moving the task shown to another machine's list (POST /api/transfer on this machine, which copies it there and removes it here)
const move = { dialog: $<HTMLDialogElement>("#move-ask"), to: $<HTMLSelectElement>("#mv-to"), hint: $("#mv-hint"), start: $<HTMLButtonElement>("#mv-start") };
$("#d-move").onclick = () => {
  if (!cur) return;
  const from = at();
  // An offline machine is listed but cannot be picked: the move would wait for it.
  const targets = machines.filter((x) => x.via !== from);
  move.to.innerHTML = targets.map((x) => `<option value="${esc(x.via)}"${x.online ? "" : " disabled"}>${esc(x.name)}${x.online ? "" : L("（离线）", " (offline)")}</option>`).join("");
  move.to.value = targets.find((x) => x.online)?.via ?? "";
  move.start.disabled = !targets.some((x) => x.online);
  move.hint.textContent = L(
    `现在在 ${nameOf(from)}。备注、方案、子任务、操作记录和图片一起转移；方案的旧版本、历史和 AI 执行记录留在原机器。`,
    `It is on ${nameOf(from)} now. Notes, plan, subtasks, records and pictures move with it; the plan's older versions, the history and the AI runs stay on that machine.`);
  move.dialog.showModal();
};
$("#mv-close").onclick = $("#mv-cancel").onclick = () => move.dialog.close();
move.dialog.addEventListener("click", (e) => { if (e.target === move.dialog) move.dialog.close(); });
move.start.onclick = async () => {
  if (!cur) return;
  const id = cur.id; const from = at(); const to = move.to.value;
  move.start.disabled = true;
  try {
    clearTimeout(saveTimer); await flushSave(); await flushPlan();
    // Asked of this machine whichever list the task is on: it reaches both ends.
    const r = await api<{ todo: { id: number }; warning?: string }>("/api/transfer", { method: "POST", body: JSON.stringify({ id, from, to, lang: EN ? "en" : "zh" }) }, "");
    move.dialog.close();
    closeDetail();
    toast(r.warning ?? L(`已转移到 ${nameOf(to)}（#${r.todo.id}）`, `Moved to ${nameOf(to)} (#${r.todo.id})`));
    void loadMachines(); void load();
  } catch (e) { toast((e as Error).message); }
  finally { move.start.disabled = false; }
};

// ---- the dialog before a run: what it does (research or code) and what it may do on the machine
const ask = {
  dialog: $<HTMLDialogElement>("#run-ask"), kind: $("#ra-kind"), kindHint: $("#ra-kind-hint"),
  permission: $<HTMLSelectElement>("#ra-permission"), permissionHint: $("#ra-permission-hint"),
  model: $<HTMLSelectElement>("#ra-model"), modelField: $("#ra-model-field"),
};
const TIERS: Record<string, [string, string]> = { basic: ["基础", "Basic"], junior: ["初级", "Junior"], intermediate: ["中级", "Intermediate"], advanced: ["高级", "Advanced"] };
/**
 * The models the task's machine can run it on (the run works there), with that machine's default first. The pick is
 * remembered per machine: each has its own runtimes. A machine on a version without the list keeps its default.
 */
async function loadRunModels() {
  const m = at();
  ask.modelField.hidden = true;
  ask.model.innerHTML = "";
  try {
    const r = await api<{ default: string; options: { value: string; runtime: string; tier: string; model: string }[] }>("/api/execute/models", {}, m);
    if (m !== at() || !ask.dialog.open || !r.options.length) return;
    const opt = (value: string, label: string) => `<option value="${esc(value)}">${esc(label)}</option>`;
    ask.model.innerHTML = opt("", L(`默认（${r.default}）`, `Default (${r.default})`))
      + r.options.map((o) => opt(o.value, `${o.runtime} · ${L(...(TIERS[o.tier] ?? [o.tier, o.tier]))} · ${o.model}`)).join("");
    const last = saved(`todo-run-model-${m}`) ?? "";
    ask.model.value = r.options.some((o) => o.value === last) ? last : "";
    ask.modelField.hidden = false;
  } catch { /* the machine cannot say: its default model runs */ }
}
const RUN_KINDS: RunKind[] = ["research", "code"];
const RUN_PERMISSIONS: RunPermission[] = ["default", "acceptEdits", "bypassPermissions"];
/** What each kind starts with: research reads, code needs to write and run its checks. */
const KIND_PERMISSION: Record<RunKind, RunPermission> = { research: "default", code: "bypassPermissions" };
const saved = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
let askKind: RunKind = RUN_KINDS.find((k) => k === saved("todo-run-kind")) ?? "research";
/** The permission for a kind: the one picked for it last in this browser, else the kind's own. */
const permissionFor = (k: RunKind): RunPermission => RUN_PERMISSIONS.find((p) => p === saved(`todo-run-permission-${k}`)) ?? KIND_PERMISSION[k];
function showAsk() {
  for (const b of ask.kind.querySelectorAll<HTMLElement>("[data-kind]")) b.setAttribute("aria-pressed", String(b.dataset.kind === askKind));
  ask.kindHint.textContent = askKind === "research"
    ? L("只查资料、读代码，给出结论和建议，不改任何东西。", "Looks things up and reads the code, then reports findings and a recommendation. Changes nothing.")
    : L("按任务改代码、跑检查，报告改了什么。", "Changes the code the task names, runs its checks and reports what changed.");
  const p = ask.permission.value as RunPermission;
  ask.permissionHint.textContent = p === "default"
    ? L("只能读，不能改文件或执行会改动的命令。", "Reads only: no file edits, no commands that change anything.")
    : p === "acceptEdits"
      ? L("可以改工作区里的文件；其他命令仍受限。", "May edit files in the workspace; other commands stay restricted.")
      : L("不经询问即可改文件、执行任意命令（以这台机器的服务用户身份）。", "Edits files and runs any command without asking, as this machine's service user.");
}
/** Open the dialog for the todo shown; nothing starts until 开始执行. */
function askRun() {
  if (!cur || d.execute.disabled) return;
  ask.permission.value = permissionFor(askKind);
  showAsk();
  ask.dialog.showModal();
  void loadRunModels();
}
ask.kind.addEventListener("click", (e) => {
  const k = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind as RunKind | undefined;
  if (!k || k === askKind) return;
  askKind = k;
  ask.permission.value = permissionFor(k);
  showAsk();
});
ask.permission.onchange = () => showAsk();
$("#ra-close").onclick = $("#ra-cancel").onclick = () => ask.dialog.close();
ask.dialog.addEventListener("click", (e) => { if (e.target === ask.dialog) ask.dialog.close(); });
$("#ra-start").onclick = () => {
  const permission = ask.permission.value as RunPermission;
  const model = ask.modelField.hidden ? "" : ask.model.value;
  keep("todo-run-kind", askKind); keep(`todo-run-permission-${askKind}`, permission);
  if (!ask.modelField.hidden) keep(`todo-run-model-${at()}`, model);
  ask.dialog.close();
  void runExecute(askKind, permission, model);
};
/**
 * A run on another machine, as the same events the stream gives: the bus cannot stream, so the run
 * is started detached and read every 1.5 s (`GET /api/runs/:id`) until it ends.
 */
async function* pollRun(url: string, init: RequestInit, signal: AbortSignal): AsyncIterable<{ event: string; data: string }> {
  let runId: number;
  const m = /^\/api\/runs\/(\d+)\/stream$/.exec(url);
  if (m) runId = Number(m[1]);
  else runId = (await api<{ run: Run }>(`${url}?detach=1`, { ...init, signal })).run.id;
  let shown = 0;
  let first = true;
  for (;;) {
    const s = await api<{ run: Run; text: string; done: { ok: boolean; run: Run; error?: string } | null }>(`/api/runs/${runId}`, { signal });
    if (first) { yield { event: "run", data: JSON.stringify({ run: s.run }) }; first = false; }
    if (s.text.length > shown) { yield { event: "delta", data: JSON.stringify({ text: s.text.slice(shown) }) }; shown = s.text.length; }
    if (s.done) { yield { event: s.done.ok ? "done" : "error", data: JSON.stringify(s.done) }; return; }
    await new Promise((r) => setTimeout(r, 1500));
    if (signal.aborted) return;
  }
}
function followRun(url: string, init: RequestInit) {
  liveAbort?.abort();
  const ac = new AbortController(); liveAbort = ac;
  d.execute.disabled = true;
  const todoId = cur?.id;
  const runM = at();
  void (async () => {
    let card: HTMLElement | null = null; let text = "";
    let frame = 0;
    const paint = () => { if (!frame && card) frame = requestAnimationFrame(() => { frame = 0; $(".md", card!).innerHTML = renderMd(text); }); };
    try {
      let events: AsyncIterable<{ event: string; data: string }>;
      if (at()) events = pollRun(url, init, ac.signal);
      else {
        const res = await fetch(url, { ...init, headers: { "content-type": "application/json" }, signal: ac.signal });
        if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? `HTTP ${res.status}`);
        }
        events = sse(res.body!);
      }
      for await (const { event, data } of events) {
        const p = JSON.parse(data) as { text?: string; run?: Run; error?: string };
        if (event === "run" && p.run) {
          if (cur?.id !== todoId) return;
          // The row says AI 执行中 until the run ends, also after the detail is closed (checkRuns).
          if (todoId !== undefined && !aiRuns.has(runKey(todoId, runM))) { aiRuns.set(runKey(todoId, runM), p.run.id); renderList(); }
          card = d.runs.querySelector<HTMLElement>(`[data-run="${p.run.id}"]`);
          if (!card) { d.runs.insertAdjacentHTML("afterbegin", runHtml({ ...p.run, output: "" })); card = d.runs.firstElementChild as HTMLElement; }
          else { card.classList.add("live"); $(".md", card).innerHTML = ""; }
        } else if (event === "delta") { text += p.text ?? ""; paint(); }
        else if (event === "done" || event === "error") {
          if (todoId !== undefined && aiRuns.delete(runKey(todoId, runM))) renderList();
          if (p.run && cur?.id === todoId) { const r = await api<{ runs: Run[]; events: TodoEvent[] }>(`/api/todos/${todoId}`); renderRuns(r.runs); renderEvents(r.events); }
          // A finished run moves its todo to review: the list and its counts follow.
          void load().catch(() => {});
          if (event === "error") toast(L(`执行失败：${p.error ?? "未知错误"}`, `Run failed: ${p.error ?? "unknown error"}`)); else toast(L("AI 执行完成", "AI run finished"));
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) toast(L(`执行失败：${(e as Error).message}`, `Run failed: ${(e as Error).message}`));
    } finally {
      if (liveAbort === ac) { liveAbort = null; d.execute.disabled = false; }
    }
  })();
}
async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = "message"; const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}
d.execute.onclick = () => askRun();

// ---- the AI panel
const FENCE_RE = /```todo-(drafts|actions)[ \t]*\r?\n[\s\S]*?```\s*/g;
const hasBlock = (text: string, kind: "drafts" | "actions") => new RegExp("```todo-" + kind + "[ \\t]*\\r?\\n").test(text);
/**
 * Styles for what this page puts inside the widget's shadow root. The page stylesheet does not reach there; the kit's
 * tokens do (custom properties on :root inherit through the shadow boundary), so these rules use them: a draft is a
 * well like the kit's `.sp-draft`, its add button the quiet pill (the page's one ink button is 新建待办), a checked box ink.
 */
const INNER_CSS = `
.drafts { margin: 10px 0 2px; display: flex; flex-direction: column; gap: 8px; }
.draft { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; align-items: start; border-radius: var(--r-well); padding: 10px 12px; background: var(--well); }
.draft.off { opacity: .45; }
.draft input, .draft select, .draft textarea { font: inherit; color: inherit; }
.draft input[type=checkbox] { width: 16px; height: 16px; margin: 3px 0 0; accent-color: var(--btn-ink-bg); }
.draft .title { border: 0; background: transparent; outline: none; font-size: 15px; font-weight: 500; color: var(--ink); width: 100%; min-width: 0; padding: 0; }
.draft .fields { grid-column: 2; display: flex; gap: 6px; flex-wrap: wrap; }
.draft .fields input, .draft .fields select { height: 26px; border: 1px solid var(--line); background: var(--surface); border-radius: var(--r-pill); padding: 0 10px; font-size: 12px; color: var(--body); outline: none; min-width: 0; }
.draft .fields input:focus, .draft .fields select:focus, .draft .title:focus-visible, .draft .notes:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.draft .due { width: 170px; } .draft .project { width: 100px; } .draft .tags { width: 140px; }
.draft .notes { grid-column: 2; border: 0; background: transparent; outline: none; font-size: 12px; color: var(--muted); resize: vertical; min-height: 18px; padding: 0; }
.draft .notes::placeholder, .draft .fields input::placeholder { color: var(--muted); opacity: 1; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.bar .n { font-size: 12px; color: var(--muted); }
.btn { display: inline-flex; align-items: center; height: 32px; border: 0; border-radius: var(--r-pill); padding: 0 14px; font-size: 15px; cursor: pointer; background: var(--pill); color: var(--ink); }
.btn:hover { background: var(--rule-strong); }
.btn:disabled { background: var(--pill); color: var(--faint); cursor: not-allowed; }
.btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.applied { margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.applied li { list-style: none; padding: 4px 10px; border-radius: var(--r-well); background: var(--well); color: var(--body); }
.applied li.bad { background: var(--bad-bg); color: var(--bad-tx); }
.done-note { font-size: 12px; color: var(--muted); margin-top: 8px; }
`;
const appliedNotes = new Map<number, HTMLElement>();
let added = new Set<number>();
try { added = new Set(JSON.parse(localStorage.getItem("todo-added") ?? "[]") as number[]); } catch { /* private mode */ }
const rememberAdded = (id: number) => { added.add(id); try { localStorage.setItem("todo-added", JSON.stringify([...added].slice(-200))); } catch { /* private mode */ } };

const el = (html: string): HTMLElement => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
const draftCard = (d: Draft) => el(`
  <div class="draft">
    <input type="checkbox" checked>
    <input class="title" value="${esc(d.title)}" maxlength="300">
    <div class="fields">
      <input class="due" type="datetime-local" value="${esc(d.due ? (d.due.length > 10 ? d.due : `${d.due}T09:00`) : "")}" title="${L("截止（清空即无日期）", "Due (empty for no date)")}">
      <select class="priority">${PRI.map((p, n) => `<option value="${n}"${(d.priority ?? 0) === n ? " selected" : ""}>${n ? L(`优先级 ${p}`, `Priority ${p}`) : L("无优先级", "No priority")}</option>`).join("")}</select>
      <input class="project" placeholder="${L("项目", "Project")}" value="${esc(d.project ?? "")}">
      <input class="tags" placeholder="${L("标签，逗号分隔", "Tags, comma separated")}" value="${esc((d.tags ?? []).join(", "))}">
    </div>
    <textarea class="notes" rows="1" placeholder="${L("备注", "Notes")}">${esc(d.notes ?? "")}</textarea>
  </div>`);
const readDraft = (card: HTMLElement): Draft | null => {
  if (!$<HTMLInputElement>("input[type=checkbox]", card).checked) return null;
  const title = $<HTMLInputElement>(".title", card).value.trim();
  if (!title) return null;
  const raw = $<HTMLInputElement>(".due", card).value;
  return { title, due: !raw ? null : card.dataset.dayOnly ? raw.slice(0, 10) : raw.slice(0, 16), priority: Number($<HTMLSelectElement>(".priority", card).value),
    project: $<HTMLInputElement>(".project", card).value.trim() || null, tags: $<HTMLInputElement>(".tags", card).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    notes: $<HTMLTextAreaElement>(".notes", card).value.trim() };
};

/** An answer with drafts: the text, then editable cards and an add button; the cards come from the server's cleaning. */
function renderDrafts(m: ChatMessage): Node {
  const wrap = el(`<div><style>${INNER_CSS}</style><div class="text">${renderMd(m.content.replace(FENCE_RE, "").trim())}</div><div class="drafts"></div></div>`);
  const list = $(".drafts", wrap);
  if (added.has(m.id)) { list.replaceWith(el(`<div class="done-note">${L("这些任务已经加入清单。", "These tasks are on the list already.")}</div>`)); return wrap; }
  void api<{ drafts: Draft[]; rejected: number }>("/api/ai/drafts", { method: "POST", body: JSON.stringify({ text: m.content }) }, chatVia()).then((r) => {
    if (!r.drafts.length) { list.replaceWith(el(`<div class="done-note">${L("没有可用的任务草稿。", "No usable task drafts.")}</div>`)); return; }
    for (const d of r.drafts) {
      const card = draftCard(d);
      card.dataset.dayOnly = d.due && d.due.length === 10 ? "1" : "";
      $<HTMLInputElement>(".due", card).onchange = () => { card.dataset.dayOnly = ""; };
      $<HTMLInputElement>("input[type=checkbox]", card).onchange = (e) => card.classList.toggle("off", !(e.target as HTMLInputElement).checked);
      list.appendChild(card);
    }
    const bar = el(`<div class="bar"><span class="n">${L(`${r.drafts.length} 项，可以先改再加入${r.rejected ? `（${r.rejected} 项无法识别）` : ""}`, `${r.drafts.length} draft(s); edit them before adding${r.rejected ? ` (${r.rejected} not understood)` : ""}`)}</span><button type="button" class="btn">${L("加入清单", "Add to list")}</button></div>`);
    $<HTMLButtonElement>("button", bar).onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const drafts = [...list.querySelectorAll<HTMLElement>(".draft")].map(readDraft).filter((d): d is Draft => !!d);
      if (!drafts.length) { toast(L("没有选中的任务", "No task selected")); return; }
      btn.disabled = true;
      try {
        await api("/api/todos/bulk", { method: "POST", body: JSON.stringify({ drafts, source: "ai" }) }, chatVia());
        rememberAdded(m.id);
        list.replaceWith(el(`<div class="done-note">${L(`已加入 ${drafts.length} 项。`, `Added ${drafts.length}.`)}</div>`));
        toast(L(`已加入 ${drafts.length} 项`, `Added ${drafts.length}`) + aiElsewhere());
        await load();
      } catch (err) { btn.disabled = false; toast((err as Error).message); }
    };
    list.appendChild(bar);
  }).catch((e) => { list.replaceWith(el(`<div class="done-note">${L("草稿读取失败：", "Could not read the drafts: ")}${esc((e as Error).message)}</div>`)); });
  return wrap;
}

/** An answer with operations: the text and the list of what the server did (filled in by onReply). */
function renderActions(m: ChatMessage): Node {
  const n = (m.content.match(/"op"\s*:/g) ?? []).length;
  const wrap = el(`<div><style>${INNER_CSS}</style><div class="text">${renderMd(m.content.replace(FENCE_RE, "").trim())}</div><ul class="applied"><li>${L(`清单操作 ${n} 项`, `${n} list operation(s)`)}</li></ul></div>`);
  appliedNotes.set(m.id, $("ul", wrap));
  return wrap;
}

let widgetLoaded: Promise<void> | null = null;
const loadWidget = (): Promise<void> => {
  widgetLoaded ??= (async () => {
    if (typeof SpaceChat !== "undefined") return;
    // The script's address carries its version: a browser or an edge cache that kept an older copy under the
    // plain address (seen behind Cloudflare, despite no-cache) would otherwise run it after ai-space was upgraded.
    // The version is the ETag, asked for under an address no cache has seen; without one, nothing is reused.
    let v = "";
    try {
      const head = await fetch(`/space/chat/widget.js?probe=${Date.now()}`, { method: "HEAD", cache: "no-store" });
      if (head.ok) v = (head.headers.get("etag") ?? "").replace(/^W\//, "").replace(/[^\w.-]/g, "");
    } catch { /* the script load below reports an unreachable ai-space */ }
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `/space/chat/widget.js?v=${v || Date.now()}`;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("widget not loaded"));
      document.head.appendChild(s);
    });
  })().catch((e) => { widgetLoaded = null; throw e; });
  return widgetLoaded;
};
/** For a toast: the machine the AI acted on, when the list shown is another one's. */
const aiElsewhere = () => (!allMode() && chatVia() === via ? "" : L(`（${nameOf(chatVia())}）`, ` (${nameOf(chatVia())})`));
let chatWidget: ChatWidget | null = null;
/** Bumped by every mountChat; a call overtaken while the widget script loads leaves the panel to the newer one. */
let chatMounts = 0;
/** The widget attaches a shadow root to its host, and a host takes only one for good: every mount gets a fresh element. */
function freshChatHost(): HTMLElement {
  const host = els.chat.cloneNode(false) as HTMLElement;
  host.removeAttribute("data-theme");
  els.chat.replaceWith(host);
  els.chat = host;
  return host;
}
async function mountChat() {
  const n = ++chatMounts;
  try { await loadWidget(); } catch {
    if (n !== chatMounts) return;
    chatWidget?.destroy(); chatWidget = null;
    freshChatHost().innerHTML = `<div class="sp-hint ai-off">${L("AI 组件没有加载（ai-space 不可达）。清单本身照常可用。", "The AI panel did not load (ai-space is not reachable). The list works as usual.")}</div>`;
    return;
  }
  if (n !== chatMounts) return;
  // A detail opened from ?todo= before the renderer arrived shows plain paragraphs; render it again now.
  if (cur) { if (!d.notesView.hidden) showNotes("view"); if (plan.mode === "view") showPlan("view"); }
  chatWidget?.destroy(); chatWidget = null;
  chatWidget = SpaceChat!.mount(freshChatHost(), {
    // The chat runs on this machine; its context and its actions go to the AI panel's machine (its own menu, else
    // the machine shown; 全部机器: this machine's), one conversation each.
    scope: chatVia() ? `todo-${chatVia()}` : "todo", theme: "auto", lang: EN ? "en" : "zh", attachments: true, timeoutMs: 300_000,
    context: async () => api<ChatContext & { tools?: string[]; model?: string }>(`/api/ai/context?timezone=${encodeURIComponent(TZ)}&lang=${EN ? "en" : "zh"}`, {}, chatVia()),
    placeholder: L("写下要做的事，或者「把明天的都推到周五」「今天先做什么」…", "Write what to do, or “move tomorrow's to Friday”, “what first today?”…"),
    emptyText: EN
      ? (aiPinned() ? `The AI reads and changes the list of ${nameOf(chatVia())}, whichever machine is shown on the left. ` : allMode() ? `In the all-machines view the AI reads and changes this machine's list only (${nameOf("")}); pick another machine in the menu above to manage it. ` : "")
        + "One entry, three uses: write “send the weekly report by 3 pm tomorrow, book flights Friday #travel” and it drafts tasks for you to confirm; say “split the year-end review into three steps” or “3 is done” and it changes the list; ask “what first today?” and it orders by due date and priority. You can also paste, drop or attach screenshots and photos with ＋."
      : (aiPinned() ? `AI 看和改的是 ${nameOf(chatVia())} 的清单，和左侧显示哪台机器无关。` : allMode() ? `全部机器视图下，AI 只看和改本机（${nameOf("")}）的清单；要管别的机器，在上方的菜单里选它。` : "") + "一个入口，三种用法：写「明天下午三点前发周报，周五订机票 #出差」，它拆成任务让你确认；说「把年终总结拆成三步」「3 完成了」，它直接改清单；问「今天先做什么」，它按截止和优先级排。也可以粘贴、拖入或用 ＋ 附上截图和照片。",
    presets: EN ? [
      { label: "Today's plan", prompt: "From the due dates and priorities, give me today's order, briefly.", send: true },
      { label: "Sort priorities", prompt: "Go over the list, raise or lower the priority of what is clearly urgent or important, and say why.", send: true },
      { label: "Split a task", prompt: "Split this task into steps I can do: ", send: false },
      { label: "Week review", prompt: "From what was finished lately, sum up this week in three sentences and name what is still waiting.", send: true },
    ] : [
      { label: "今日计划", prompt: "根据截止时间和优先级，给我今天的执行顺序，简短。", send: true },
      { label: "整理优先级", prompt: "看一遍清单，把明显紧急或重要的调整优先级，并说明理由。", send: true },
      { label: "拆分任务", prompt: "把这个任务拆成可执行的步骤：", send: false },
      { label: "一周回顾", prompt: "根据最近完成的任务，用三句话总结这一周，并指出还压着的事。", send: true },
    ],
    renderAssistant: (m) => (hasBlock(m.content, "drafts") ? renderDrafts(m) : hasBlock(m.content, "actions") ? renderActions(m) : undefined),
    onReply: async (m) => {
      if (!hasBlock(m.content, "actions")) return;
      try {
        const r = await api<{ results: { op: string; id?: number; ok: boolean; error?: string; todo?: Todo | null }[]; rejected: number }>("/api/ai/apply", { method: "POST", body: JSON.stringify({ text: m.content, source: "chat" }) }, chatVia());
        const ul = appliedNotes.get(m.id);
        const opName: Record<string, string> = EN
          ? { review: "Submit for review", accept: "Accept", reject: "Send back", add: "Add", update: "Edit", done: "Done", start: "Start", defer: "Defer", reopen: "Reopen", record: "Record", plan: "Plan", "edit-record": "Edit record", delete: "Delete" }
          : { review: "提交验收", accept: "验收通过", reject: "退回", add: "新增", update: "修改", done: "完成", start: "开始", defer: "暂不处理", reopen: "重开", record: "追加记录", plan: "改方案", "edit-record": "编辑记录", delete: "删除" };
        if (ul) ul.innerHTML = r.results.map((x) => `<li class="${x.ok ? "" : "bad"}">${opName[x.op] ?? x.op} ${x.todo ? esc(x.todo.title) : x.id ? `#${x.id}` : ""}${x.ok ? "" : ` · ${esc(x.error ?? L("失败", "failed"))}`}</li>`).join("") + (r.rejected ? `<li class="bad">${L(`${r.rejected} 项无法识别`, `${r.rejected} not understood`)}</li>` : "");
        const ok = r.results.filter((x) => x.ok).length;
        toast(L(`AI 改了清单：${ok}/${r.results.length} 项成功`, `The AI changed the list: ${ok}/${r.results.length} succeeded`) + aiElsewhere());
        await load();
      } catch (e) { toast(L(`清单操作失败：${(e as Error).message}`, `List change failed: ${(e as Error).message}`)); }
    },
  });
}
// ---- drawers (narrow screens)
/** The left column below 960 px and the AI column below 1200 px are drawers: classes on body (ai-space docs/ui-kit.md). */
function openDrawer(cls: "sp-open-nav" | "sp-open-aside") {
  document.body.classList.remove("sp-open-nav", "sp-open-aside");
  document.body.classList.add(cls, "sp-sheet-open");
}
function closeDrawers() { document.body.classList.remove("sp-open-nav", "sp-open-aside", "sp-sheet-open"); }
$("#ai-toggle").onclick = () => openDrawer("sp-open-aside");
$("#m-ai").onclick = () => openDrawer("sp-open-aside");
$("#side-close").onclick = closeDrawers;
for (const q of ["(min-width: 1200px)", "(min-width: 960px)"]) matchMedia(q).addEventListener("change", (e) => { if (e.matches) closeDrawers(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("sp-sheet-open") && els.detail.hidden && !document.querySelector("dialog[open]")) closeDrawers(); });
$("#ai-close").onclick = closeDrawers;
$("#menu").onclick = () => openDrawer("sp-open-nav");

// ---- machines
/**
 * This machine and the peers running ai-todo (a hub has them), shown as soon as the hub names them; each
 * one's open count fills in as it answers. An offline peer (ai-space's `health`) is not asked, and neither is
 * a machine the list being read already asks. Returns once the machines are known, not their counts.
 */
async function loadMachines() {
  type Health = { name: string; online: boolean; asOf?: string };
  const m = await fetch("/api/machines").then((r) => r.json() as Promise<{ local: string; peers: string[]; peerHealth?: Health[] }>, () => ({ local: "", peers: [] as string[], peerHealth: [] as Health[] }));
  // An older version answers no peerHealth: every peer counts as online.
  const health = new Map((m.peerHealth ?? []).map((h) => [h.name, h]));
  const chatBefore = chatVia();
  machines = ["", ...(m.peers ?? [])].map((v): Machine => {
    const h = health.get(v);
    const old = machines.find((x) => x.via === v);
    return { via: v, name: v || m.local || L("本机", "This machine"), online: h?.online !== false, ...(h?.asOf ? { asOf: h.asOf } : {}), active: answers.get(v)?.r.counts.active ?? old?.active ?? null, error: old?.error ?? null };
  });
  if (allMode() ? machines.length < 2 : !machines.some((x) => x.via === via)) { via = ""; syncUrl(); void load(); }
  // The machine shown turned out offline before its list came: say so; a late answer still replaces it.
  else if (!allMode() && offline(via) && !answers.has(via)) { unread.set(via, null); renderList(); }
  renderMachines();
  if (chatVia() !== chatBefore) void mountChat();
  const counted = (v: string) => allMode() || v === via;
  for (const x of machines) {
    if (!x.online || counted(x.via)) continue;
    api<ListAnswer>("/api/todos?status=active&fields=list&limit=1", {}, x.via).then(
      (b) => { x.active = b.counts.active; x.error = null; },
      (e) => { x.error = (e as Error).message; },
    ).finally(renderMachines);
  }
}
function renderMachines() {
  const nav = $("#machines");
  const many = machines.length > 1;
  $("#m-group").hidden = !many;
  const total = machines.reduce((s, x) => s + (x.active ?? 0), 0);
  // A machine that did not answer keeps its row, with a red dot and the reason in the title; an offline one a hollow dot.
  renderAiMachine();
  const state = (x: Machine) => (!x.online ? "off" : x.error ? "bad" : "on");
  const word = (x: Machine) => (!x.online ? L("离线", "offline") : x.error ? L("读取失败", "could not be read") : L("在线", "online"));
  nav.innerHTML = `<li><button type="button" class="sp-nitem" data-machine="${ALL}" aria-pressed="${allMode()}">${navIcon("layers")}<span class="nl">${L("全部机器", "All machines")}</span><span class="sp-nc">${numHtml("m:*", total)}</span></button></li>` + machines.map((x) => `<li><button type="button" class="sp-nitem" data-machine="${esc(x.via)}" aria-pressed="${x.via === via}" title="${esc(!x.online ? L(`离线${x.asOf ? `，最后在线 ${new Date(x.asOf).toLocaleString()}` : ""}`, `Offline${x.asOf ? `, last seen ${new Date(x.asOf).toLocaleString()}` : ""}`) : x.error ? L(`读取失败：${x.error}`, `Could not read: ${x.error}`) : "")}"><span class="mdot ${state(x)}${machineBusy(x.via) ? " busy" : ""}" role="img" aria-label="${word(x)}"><i></i></span><span class="nl mname"><span class="nm">${esc(x.name)}</span>${x.via ? "" : `<span class="mtag">${L("本机", "this one")}</span>`}</span>${!x.online ? `<span class="sp-nc off">${L("离线", "offline")}</span>` : x.error ? `<span class="sp-nc bad">${L("失败", "failed")}</span>` : `<span class="sp-nc">${numHtml(`m:${x.via}`, x.active ?? 0)}</span>`}</button></li>`).join("");
}
/** A machine is busy while the page waits for its list or one of its tasks is being run by the AI: its dot breathes. */
const machineBusy = (v: string) => waiting.has(v) || retrying.has(v) || [...aiRuns.keys()].some((k) => k.startsWith(`${v}#`));
/** The dots follow what the machines are doing without the section being redrawn (the list is drawn on every such change). */
function markBusy() {
  document.querySelectorAll<HTMLElement>("#machines [data-machine] .mdot").forEach((d) => {
    d.classList.toggle("busy", machineBusy(d.closest<HTMLElement>("[data-machine]")!.dataset.machine ?? ""));
  });
}
/** The AI panel's machine menu: follow the list, or one machine whatever the list shows. Hidden with one machine. */
function renderAiMachine() {
  const sel = $<HTMLSelectElement>("#ai-machine");
  sel.hidden = machines.length < 2;
  const followed = allMode() ? "" : via;
  sel.innerHTML = `<option value="">${esc(L(`跟随左侧（${nameOf(followed)}）`, `Follow the list (${nameOf(followed)})`))}</option>`
    + machines.map((x) => `<option value="m:${esc(x.via)}">${esc(x.name)}${x.via ? "" : L("（本机）", " (this one)")}</option>`).join("");
  sel.value = aiPinned() ? `m:${aiVia}` : "";
}
$<HTMLSelectElement>("#ai-machine").onchange = (e) => {
  const v = (e.target as HTMLSelectElement).value;
  const before = chatVia();
  aiVia = v ? v.slice(2) : null;
  try { if (v) localStorage.setItem("todo-ai-machine", v); else localStorage.removeItem("todo-ai-machine"); } catch { /* private mode */ }
  if (chatVia() !== before) void mountChat();
};
$("#machines").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-machine]");
  if (!b || b.dataset.machine === via) return;
  stillNums();
  via = b.dataset.machine ?? "";
  detailVia = "";
  try { if (via) localStorage.setItem("todo-machine", via); else localStorage.removeItem("todo-machine"); } catch { /* private mode */ }
  liveAbort?.abort();
  cur = null; showDetailEl(false);
  filterTag = null; filterProject = null; query = ""; ($("#search") as HTMLInputElement).value = "";
  syncUrl();
  renderMachines();
  closeDrawers();
  void load().catch((err) => toast((err as Error).message));
  // A panel with its own machine keeps its conversation; one that follows the list moves with it.
  if (!aiPinned()) void mountChat();
});

// ---- boot
// The machine list, the list and the AI panel start together: the list needs only the machine shown (the
// address or the last pick), and loadMachines falls back to this machine when that one is not listed. 全部机器
// needs the machines first.
(async () => {
  const listed = loadMachines();
  const shown = allMode() ? listed.then(() => (allMode() ? load() : undefined)) : load();
  void mountChat();
  const params = new URLSearchParams(location.search);
  const wanted = Number(params.get("todo"));
  const wantedAt = params.get("at") ?? "";
  await Promise.all([listed, shown]);
  if (allMode() && machines.some((x) => x.via === wantedAt)) detailVia = wantedAt;
  if (wanted) await openDetail(wanted);
})();
