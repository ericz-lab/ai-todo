/**
 * The page: sidebar (views, projects, tags), the AI panel, the grouped list and the detail
 * modal (fields, AI execution runs, history). The AI panel is ai-space's chat widget fed with
 * the whole list: an answer may carry a `todo-drafts` block (rendered as editable drafts the
 * person adds) or a `todo-actions` block (applied by the server, the results listed under the
 * answer).
 */

type Status = "open" | "doing" | "done" | "dropped";
type Todo = { id: number; title: string; notes: string; status: Status; priority: 0 | 1 | 2 | 3; due: string | null; tags: string[]; project: string | null; source: string; createdAt: string; updatedAt: string; doneAt: string | null };
type Draft = { title: string; notes?: string; due?: string | null; priority?: number; tags?: string[]; project?: string | null };
type Run = { id: number; todoId: number; status: "running" | "ok" | "error"; output: string; error: string | null; model: string | null; costUsd: number | null; startedAt: string; finishedAt: string | null };
type TodoEvent = { id: number; kind: string; data: Record<string, unknown>; at: string };
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
const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
/** Markdown through the space's renderer; plain paragraphs when the widget (and so ai-space) is not there. */
const renderMd = (src: string): string => (typeof SpaceChat !== "undefined" ? SpaceChat.renderMd(src) : String(src ?? "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join(""));
const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  const body = (await r.json()) as T & { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
const PRI = ["", "低", "中", "高"];
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toast = (text: string) => {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = text;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2400);
};

// ---- dates (local wall clock, like the server's strings)
const pad = (n: number) => String(n).padStart(2, "0");
const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); };
const dayOf = (due: string) => due.slice(0, 10);
const isLate = (t: Todo) => !!t.due && (t.due.length > 10 ? t.due < `${todayStr()}T${pad(new Date().getHours())}:${pad(new Date().getMinutes())}` : dayOf(t.due) < todayStr());
const fmtDue = (due: string) => {
  const day = dayOf(due), today = todayStr();
  const time = due.length > 10 ? ` ${due.slice(11)}` : "";
  if (day === today) return `今天${time}`;
  if (day === addDays(1)) return `明天${time}`;
  if (day === addDays(-1)) return `昨天${time}`;
  const d = new Date(`${day}T00:00`);
  const wd = "日一二三四五六"[d.getDay()];
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return `${sameYear ? "" : `${day.slice(0, 4)}/`}${d.getMonth() + 1}/${d.getDate()} 周${wd}${time}`;
};
const fmtAgo = (iso: string) => {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---- theme
const applyTheme = (t: string) => {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("todo-theme", t); } catch { /* private mode */ }
  $("#theme").textContent = t === "dark" ? "☀️" : "🌙";
};
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem("todo-theme"); } catch { /* private mode */ }
applyTheme(savedTheme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("#theme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");

// ---- state
type View = "today" | "upcoming" | "all" | "done";
let view: View = "all";
let filterTag: string | null = null;
let filterProject: string | null = null;
let todos: Todo[] = [];
let active: Todo[] = [];
let tags: { tag: string; n: number }[] = [];
let projects: { project: string; n: number }[] = [];
const els = { list: $("#list"), side: $("#side"), rail: $("#rail"), scrim: $("#scrim"), chat: $("#chat"), detail: $("#detail") };

async function load() {
  const status = view === "done" ? "done" : "active";
  const q = new URLSearchParams({ status });
  if (filterTag) q.set("tag", filterTag);
  if (filterProject) q.set("project", filterProject);
  const r = await api<{ todos: Todo[]; tags: typeof tags; projects: typeof projects }>(`/api/todos?${q}`);
  todos = r.todos; tags = r.tags; projects = r.projects;
  if (status === "active") active = todos;
  else { const a = await api<{ todos: Todo[] }>(`/api/todos?status=active`); active = a.todos; }
  renderSide();
  renderList();
}

// ---- sidebar
function renderSide() {
  const today = todayStr();
  const isToday = (t: Todo) => t.status === "doing" || (!!t.due && dayOf(t.due) <= today);
  const counts = { today: active.filter(isToday).length, upcoming: active.filter((t) => t.due && dayOf(t.due) > today).length, all: active.length };
  $("#n-today").textContent = counts.today ? String(counts.today) : "";
  $("#n-upcoming").textContent = counts.upcoming ? String(counts.upcoming) : "";
  $("#n-all").textContent = counts.all ? String(counts.all) : "";
  $("#n-done").textContent = view === "done" ? String(todos.length) : "";
  document.querySelectorAll<HTMLElement>(".view").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  const chips = (list: { key: string; n: number }[], on: string | null, pick: (k: string | null) => void) => {
    if (!list.length) return `<span class="none">无</span>`;
    return list.map((x) => `<button class="chip${on === x.key ? " on" : ""}" data-key="${esc(x.key)}">${esc(x.key)}<b>${x.n}</b></button>`).join("");
  };
  $("#projects").innerHTML = chips(projects.map((p) => ({ key: p.project, n: p.n })), filterProject, () => {});
  $("#tags").innerHTML = chips(tags.map((t) => ({ key: t.tag, n: t.n })), filterTag, () => {});
  $("#project-list").innerHTML = projects.map((p) => `<option value="${esc(p.project)}">`).join("");
  const late = active.filter(isLate).length;
  $("#stats").innerHTML = `${active.length} 项待办${late ? `，<span style="color:var(--danger)">${late} 项已过期</span>` : ""}<br><span style="color:var(--faint)">${TZ}</span>`;
  $("#projects").querySelectorAll<HTMLElement>(".chip").forEach((c) => { c.onclick = () => { filterProject = filterProject === c.dataset.key ? null : c.dataset.key!; void load(); }; });
  $("#tags").querySelectorAll<HTMLElement>(".chip").forEach((c) => { c.onclick = () => { filterTag = filterTag === c.dataset.key ? null : c.dataset.key!; void load(); }; });
}
document.querySelectorAll<HTMLElement>(".view").forEach((b) => { b.onclick = () => { view = b.dataset.view as View; closeDrawers(); void load(); }; });

// ---- the list
type Group = { key: string; title: string; late?: boolean; items: Todo[] };
function groups(): Group[] {
  const today = todayStr(), tomorrow = addDays(1), week = addDays(7);
  if (view === "done") return [{ key: "done", title: "已完成", items: todos }];
  const g: Record<string, Group> = {
    doing: { key: "doing", title: "进行中", items: [] }, late: { key: "late", title: "已过期", late: true, items: [] }, today: { key: "today", title: "今天", items: [] },
    tomorrow: { key: "tomorrow", title: "明天", items: [] }, week: { key: "week", title: "本周", items: [] }, later: { key: "later", title: "以后", items: [] }, none: { key: "none", title: "未定日期", items: [] },
  };
  for (const t of todos) {
    const day = t.due ? dayOf(t.due) : null;
    const key = t.status === "doing" ? "doing" : !day ? "none" : day < today ? "late" : day === today ? "today" : day === tomorrow ? "tomorrow" : day <= week ? "week" : "later";
    g[key]!.items.push(t);
  }
  const order = view === "today" ? ["doing", "late", "today"] : view === "upcoming" ? ["tomorrow", "week", "later"] : ["doing", "late", "today", "tomorrow", "week", "later", "none"];
  return order.map((k) => g[k]!).filter((x) => x.items.length);
}
function renderList() {
  const gs = groups();
  if (!gs.length) {
    const hint = view === "today" ? "今天没有安排。看看「即将」，或在右边写下要做的事。" : view === "upcoming" ? "接下来几天没有安排。" : view === "done" ? "还没有完成的任务。" : "清单是空的。在右边写点什么，让 AI 拆成任务。";
    els.list.innerHTML = `<div class="empty glass"><b>${view === "done" ? "空" : "轻松"}</b>${hint}</div>`;
    return;
  }
  els.list.innerHTML = gs.map((g) => `
    <section class="group glass">
      <div class="group-head${g.late ? " late" : ""}"><h3>${g.title}</h3><b>${g.items.length}</b></div>
      ${g.items.map(rowHtml).join("")}
    </section>`).join("");
  els.list.querySelectorAll<HTMLElement>(".todo").forEach((row) => {
    const id = Number(row.dataset.id);
    row.onclick = (e) => { if ((e.target as HTMLElement).closest("button, label, input")) return; void openDetail(id); };
    $<HTMLInputElement>("input[type=checkbox]", row).onchange = (e) => void setStatus(id, (e.target as HTMLInputElement).checked ? "done" : "open");
    row.querySelector<HTMLElement>("[data-op=run]")!.onclick = () => void openDetail(id, true);
    row.querySelector<HTMLElement>("[data-op=edit]")!.onclick = () => void openDetail(id);
  });
}
function rowHtml(t: Todo): string {
  const meta: string[] = [];
  if (t.due) meta.push(`<span class="badge due${isLate(t) && t.status !== "done" ? " late" : dayOf(t.due) === todayStr() ? " today" : ""}">${esc(fmtDue(t.due))}</span>`);
  if (t.project) meta.push(`<span class="badge proj">${esc(t.project)}</span>`);
  for (const tag of t.tags) meta.push(`<span class="badge">#${esc(tag)}</span>`);
  if (t.notes) meta.push(`<span title="${esc(t.notes.slice(0, 500))}">≡</span>`);
  if (t.status === "done" && t.doneAt) meta.push(`<span>完成于 ${esc(fmtAgo(t.doneAt))}</span>`);
  return `<div class="todo ${t.status}" data-id="${t.id}" tabindex="0">
    <label class="check"><input type="checkbox"${t.status === "done" ? " checked" : ""}><span></span></label>
    <div class="t">${t.priority ? `<i class="pri p${t.priority}" title="优先级 ${PRI[t.priority]}"></i>` : ""}<span class="title">${esc(t.title)}</span></div>
    <div class="ops"><button class="btn" data-op="run" title="交给 AI 执行"><span class="spark">✦</span> 执行</button><button class="btn" data-op="edit">详情</button></div>
    <div class="meta">${meta.join("")}</div>
  </div>`;
}
async function setStatus(id: number, status: Status) {
  try { await api(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }); await load(); }
  catch (e) { toast((e as Error).message); }
}

// ---- detail modal
let cur: Todo | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let liveAbort: AbortController | null = null;
const d = {
  done: $<HTMLInputElement>("#d-done"), title: $<HTMLInputElement>("#d-title"), due: $<HTMLInputElement>("#d-due"), priority: $<HTMLSelectElement>("#d-priority"),
  project: $<HTMLInputElement>("#d-project"), tags: $<HTMLInputElement>("#d-tags"), notes: $<HTMLTextAreaElement>("#d-notes"), notesView: $("#d-notes-view"), extra: $<HTMLInputElement>("#d-extra"),
  runs: $("#d-runs"), events: $("#d-events"), execute: $<HTMLButtonElement>("#d-execute"), doing: $<HTMLButtonElement>("#d-doing"),
};
async function openDetail(id: number, execute = false) {
  const r = await api<{ todo: Todo; events: TodoEvent[]; runs: Run[] }>(`/api/todos/${id}`).catch((e) => { toast((e as Error).message); return null; });
  if (!r) return;
  cur = r.todo;
  fillDetail(r.todo);
  renderRuns(r.runs);
  renderEvents(r.events);
  els.detail.hidden = false; els.scrim.hidden = false;
  history.replaceState(null, "", `?todo=${id}`);
  const running = r.runs.find((x) => x.status === "running");
  if (running) followRun(`/api/runs/${running.id}/stream`, {});
  else if (execute) void runExecute();
  else d.title.focus();
}
function fillDetail(t: Todo) {
  d.done.checked = t.status === "done"; d.title.value = t.title; d.due.value = t.due ? (t.due.length > 10 ? t.due : `${t.due}T09:00`) : "";
  d.due.dataset.dayOnly = t.due && t.due.length === 10 ? "1" : "";
  d.priority.value = String(t.priority); d.project.value = t.project ?? ""; d.tags.value = t.tags.join(", "); d.notes.value = t.notes;
  d.doing.textContent = t.status === "doing" ? "暂停" : "开始做";
  showNotes(t.notes ? "view" : "edit");
}
/** Notes are Markdown: rendered until clicked, a textarea while editing, rendered again on blur. */
function showNotes(mode: "view" | "edit") {
  if (mode === "view" && d.notes.value.trim()) { d.notesView.innerHTML = renderMd(d.notes.value); d.notesView.hidden = false; d.notes.hidden = true; }
  else { d.notesView.hidden = true; d.notes.hidden = false; sizeNotes(); }
}
/** The textarea grows with its content, so a long note is read and edited whole; the modal scrolls. */
function sizeNotes() { d.notes.style.height = "auto"; d.notes.style.height = `${Math.max(84, d.notes.scrollHeight + 2)}px`; }
d.notesView.onclick = (e) => { if ((e.target as HTMLElement).closest("a")) return; showNotes("edit"); d.notes.focus(); };
d.notes.onblur = () => showNotes("view");
function closeDetail() {
  if (!cur) return;
  clearTimeout(saveTimer); void flushSave();
  liveAbort?.abort(); liveAbort = null;
  cur = null; els.detail.hidden = true; els.scrim.hidden = true;
  history.replaceState(null, "", location.pathname);
  void load();
}
$("#d-close").onclick = closeDetail;
els.scrim.onclick = () => { if (!els.detail.hidden) closeDetail(); else closeDrawers(); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !els.detail.hidden && document.activeElement?.tagName !== "TEXTAREA") closeDetail(); });

let pending: Record<string, unknown> = {};
function scheduleSave(patch: Record<string, unknown>) {
  pending = { ...pending, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), 500);
}
async function flushSave() {
  if (!cur || !Object.keys(pending).length) return;
  const body = pending; pending = {};
  try { const r = await api<{ todo: Todo }>(`/api/todos/${cur.id}`, { method: "PATCH", body: JSON.stringify(body) }); if (cur && cur.id === r.todo.id) cur = r.todo; }
  catch (e) { toast(`保存失败：${(e as Error).message}`); }
}
d.title.oninput = () => scheduleSave({ title: d.title.value });
d.notes.oninput = () => { sizeNotes(); scheduleSave({ notes: d.notes.value }); };
d.due.onchange = () => { d.due.dataset.dayOnly = ""; scheduleSave({ due: d.due.value ? d.due.value.slice(0, 16) : null }); };
d.priority.onchange = () => scheduleSave({ priority: Number(d.priority.value) });
d.project.onchange = () => scheduleSave({ project: d.project.value.trim() || null });
d.tags.onchange = () => scheduleSave({ tags: d.tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) });
d.done.onchange = async () => { if (!cur) return; await api(`/api/todos/${cur.id}`, { method: "PATCH", body: JSON.stringify({ status: d.done.checked ? "done" : "open" }) }); toast(d.done.checked ? "已完成" : "已重新打开"); closeDetail(); };
d.doing.onclick = async () => { if (!cur) return; const status = cur.status === "doing" ? "open" : "doing"; const r = await api<{ todo: Todo }>(`/api/todos/${cur.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); cur = r.todo; fillDetail(cur); };
$("#d-delete").onclick = async () => { if (!cur || !confirm(`删除「${cur.title}」？`)) return; await api(`/api/todos/${cur.id}`, { method: "DELETE" }); cur = null; els.detail.hidden = true; els.scrim.hidden = true; toast("已删除"); void load(); };

function renderRuns(runs: Run[]) {
  d.runs.innerHTML = runs.map(runHtml).join("");
  d.runs.querySelectorAll<HTMLElement>("[data-op=done]").forEach((b) => { b.onclick = () => { d.done.checked = true; d.done.onchange!(new Event("change")); }; });
}
function runHtml(r: Run): string {
  const st = r.status === "running" ? "执行中" : r.status === "ok" ? "完成" : "失败";
  return `<div class="run${r.status === "running" ? " live" : ""}" data-run="${r.id}">
    <div class="run-head"><span class="st ${r.status}">${st}</span><span>${esc(fmtAgo(r.startedAt))}</span>${r.model ? `<span>${esc(r.model)}</span>` : ""}${r.costUsd != null ? `<span>$${r.costUsd.toFixed(3)}</span>` : ""}${r.error ? `<span style="color:var(--danger)">${esc(r.error)}</span>` : ""}${r.status === "ok" ? `<button class="btn small" data-op="done">标记完成</button>` : ""}</div>
    <div class="md">${renderMd(r.output)}</div>
  </div>`;
}
function renderEvents(events: TodoEvent[]) {
  const label: Record<string, string> = { created: "创建", edited: "修改", done: "完成", open: "重新打开", doing: "开始", dropped: "放弃", deleted: "删除", "run-started": "AI 开始执行", "run-finished": "AI 执行完成", "run-failed": "AI 执行失败" };
  d.events.innerHTML = events.map((e) => {
    const src = e.data.source ? ` · ${esc(String(e.data.source))}` : "";
    const changed = e.data.changed && typeof e.data.changed === "object" ? Object.keys(e.data.changed as object).join(", ") : "";
    return `<div><span class="k">${label[e.kind] ?? esc(e.kind)}</span>${esc(fmtAgo(e.at))}${src}${changed ? ` · ${esc(changed)}` : ""}${e.data.error ? ` · ${esc(String(e.data.error))}` : ""}</div>`;
  }).join("") || `<div>无</div>`;
}

/** Start an execution, or reattach to the one in flight, and draw it as it streams. */
async function runExecute() {
  if (!cur) return;
  clearTimeout(saveTimer); await flushSave();
  followRun(`/api/todos/${cur.id}/execute`, { method: "POST", body: JSON.stringify({ extra: d.extra.value, timezone: TZ }) });
}
function followRun(url: string, init: RequestInit) {
  liveAbort?.abort();
  const ac = new AbortController(); liveAbort = ac;
  d.execute.disabled = true;
  const todoId = cur?.id;
  void (async () => {
    let card: HTMLElement | null = null; let text = "";
    let frame = 0;
    const paint = () => { if (!frame && card) frame = requestAnimationFrame(() => { frame = 0; $(".md", card!).innerHTML = renderMd(text); }); };
    try {
      const res = await fetch(url, { ...init, headers: { "content-type": "application/json" }, signal: ac.signal });
      if (!res.ok || !res.headers.get("content-type")?.includes("text/event-stream")) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? `HTTP ${res.status}`);
      }
      for await (const { event, data } of sse(res.body!)) {
        const p = JSON.parse(data) as { text?: string; run?: Run; error?: string };
        if (event === "run" && p.run) {
          if (cur?.id !== todoId) return;
          card = d.runs.querySelector<HTMLElement>(`[data-run="${p.run.id}"]`);
          if (!card) { d.runs.insertAdjacentHTML("afterbegin", runHtml({ ...p.run, output: "" })); card = d.runs.firstElementChild as HTMLElement; }
          else { card.classList.add("live"); $(".md", card).innerHTML = ""; }
        } else if (event === "delta") { text += p.text ?? ""; paint(); }
        else if (event === "done" || event === "error") {
          if (p.run && cur?.id === todoId) { const r = await api<{ runs: Run[]; events: TodoEvent[] }>(`/api/todos/${todoId}`); renderRuns(r.runs); renderEvents(r.events); }
          if (event === "error") toast(`执行失败：${p.error ?? "未知错误"}`); else toast("AI 执行完成");
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) toast(`执行失败：${(e as Error).message}`);
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
d.execute.onclick = () => void runExecute();

// ---- the AI panel
const FENCE_RE = /```todo-(drafts|actions)[ \t]*\r?\n[\s\S]*?```\s*/g;
const hasBlock = (text: string, kind: "drafts" | "actions") => new RegExp("```todo-" + kind + "[ \\t]*\\r?\\n").test(text);
/** Styles for what this page puts inside the widget's shadow root; the page stylesheet does not reach there, the tokens do. */
const INNER_CSS = `
.drafts { margin: 8px 0 2px; display: flex; flex-direction: column; gap: 6px; }
.draft { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; align-items: start; border-radius: 12px; padding: 8px 10px; background: var(--glass-strong); border: 1px solid var(--glass-border); }
.draft.off { opacity: .45; }
.draft input, .draft select, .draft textarea { font: inherit; color: inherit; }
.draft input[type=checkbox] { margin: 4px 0 0; accent-color: var(--ai); }
.draft .title { border: 0; background: transparent; outline: none; font-weight: 700; font-size: 14px; width: 100%; }
.draft .fields { grid-column: 2; display: flex; gap: 5px; flex-wrap: wrap; }
.draft .fields input, .draft .fields select { border: 1px solid var(--hairline); background: transparent; border-radius: 8px; padding: 1px 7px; font-size: 12px; color: var(--muted); outline: none; }
.draft .fields input:focus { border-color: var(--ai); }
.draft .due { width: 165px; } .draft .project { width: 100px; } .draft .tags { width: 140px; }
.draft .notes { grid-column: 2; border: 0; background: transparent; outline: none; font-size: 12.5px; color: var(--muted); resize: vertical; min-height: 18px; }
.bar { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.bar .n { font-size: 12.5px; color: var(--muted); }
.btn { border-radius: 999px; padding: 5px 14px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--glass-border); background: var(--glass); color: var(--text); }
.btn.primary { background: var(--ai); color: var(--on-ai); border-color: transparent; }
.btn:disabled { opacity: .5; cursor: default; }
.applied { margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; }
.applied li { list-style: none; padding: 3px 10px; border-radius: 8px; background: var(--ai-soft); color: var(--ai); }
.applied li.bad { background: rgba(209,52,76,.12); color: var(--danger); }
.done-note { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
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
      <input class="due" type="datetime-local" value="${esc(d.due ? (d.due.length > 10 ? d.due : `${d.due}T09:00`) : "")}" title="截止（清空即无日期）">
      <select class="priority">${PRI.map((p, n) => `<option value="${n}"${(d.priority ?? 0) === n ? " selected" : ""}>${n ? `优先级 ${p}` : "无优先级"}</option>`).join("")}</select>
      <input class="project" placeholder="项目" value="${esc(d.project ?? "")}">
      <input class="tags" placeholder="标签，逗号分隔" value="${esc((d.tags ?? []).join(", "))}">
    </div>
    <textarea class="notes" rows="1" placeholder="备注">${esc(d.notes ?? "")}</textarea>
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
  if (added.has(m.id)) { list.replaceWith(el(`<div class="done-note">这些任务已经加入清单。</div>`)); return wrap; }
  void api<{ drafts: Draft[]; rejected: number }>("/api/ai/drafts", { method: "POST", body: JSON.stringify({ text: m.content }) }).then((r) => {
    if (!r.drafts.length) { list.replaceWith(el(`<div class="done-note">没有可用的任务草稿。</div>`)); return; }
    for (const d of r.drafts) {
      const card = draftCard(d);
      card.dataset.dayOnly = d.due && d.due.length === 10 ? "1" : "";
      $<HTMLInputElement>(".due", card).onchange = () => { card.dataset.dayOnly = ""; };
      $<HTMLInputElement>("input[type=checkbox]", card).onchange = (e) => card.classList.toggle("off", !(e.target as HTMLInputElement).checked);
      list.appendChild(card);
    }
    const bar = el(`<div class="bar"><span class="n">${r.drafts.length} 项，可以先改再加入${r.rejected ? `（${r.rejected} 项无法识别）` : ""}</span><button class="btn primary">加入清单</button></div>`);
    $<HTMLButtonElement>("button", bar).onclick = async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const drafts = [...list.querySelectorAll<HTMLElement>(".draft")].map(readDraft).filter((d): d is Draft => !!d);
      if (!drafts.length) { toast("没有选中的任务"); return; }
      btn.disabled = true;
      try {
        await api("/api/todos/bulk", { method: "POST", body: JSON.stringify({ drafts, source: "ai" }) });
        rememberAdded(m.id);
        list.replaceWith(el(`<div class="done-note">已加入 ${drafts.length} 项。</div>`));
        toast(`已加入 ${drafts.length} 项`);
        await load();
      } catch (err) { btn.disabled = false; toast((err as Error).message); }
    };
    list.appendChild(bar);
  }).catch((e) => { list.replaceWith(el(`<div class="done-note">草稿读取失败：${esc((e as Error).message)}</div>`)); });
  return wrap;
}

/** An answer with operations: the text and the list of what the server did (filled in by onReply). */
function renderActions(m: ChatMessage): Node {
  const n = (m.content.match(/"op"\s*:/g) ?? []).length;
  const wrap = el(`<div><style>${INNER_CSS}</style><div class="text">${renderMd(m.content.replace(FENCE_RE, "").trim())}</div><ul class="applied"><li>清单操作 ${n} 项</li></ul></div>`);
  appliedNotes.set(m.id, $("ul", wrap));
  return wrap;
}

let widgetLoaded: Promise<void> | null = null;
const loadWidget = (): Promise<void> => {
  widgetLoaded ??= new Promise<void>((resolve, reject) => {
    if (typeof SpaceChat !== "undefined") return resolve();
    const s = document.createElement("script");
    s.src = "/space/chat/widget.js";
    s.onload = () => resolve();
    s.onerror = () => { widgetLoaded = null; reject(new Error("widget not loaded")); };
    document.head.appendChild(s);
  });
  return widgetLoaded;
};
async function mountChat() {
  try { await loadWidget(); } catch { els.chat.innerHTML = `<div class="sub ai-off">AI 组件没有加载（ai-space 不可达）。清单本身照常可用。</div>`; return; }
  SpaceChat!.mount(els.chat, {
    scope: "todo", theme: "auto", lang: "zh", attachments: false, timeoutMs: 300_000,
    context: async () => api<ChatContext & { tools?: string[]; model?: string }>(`/api/ai/context?timezone=${encodeURIComponent(TZ)}`),
    placeholder: "写下要做的事，或者「把明天的都推到周五」「今天先做什么」…",
    emptyText: "一个入口，三种用法：写「明天下午三点前发周报，周五订机票 #出差」，它拆成任务让你确认；说「把年终总结拆成三步」「3 完成了」，它直接改清单；问「今天先做什么」，它按截止和优先级排。",
    presets: [
      { label: "今日计划", prompt: "根据截止时间和优先级，给我今天的执行顺序，简短。", send: true },
      { label: "整理优先级", prompt: "看一遍清单，把明显紧急或重要的调整优先级，并说明理由。", send: true },
      { label: "拆分任务", prompt: "把这个任务拆成可执行的步骤：", send: false },
      { label: "一周回顾", prompt: "根据最近完成的任务，用三句话总结这一周，并指出还压着的事。", send: true },
    ],
    renderAssistant: (m) => (hasBlock(m.content, "drafts") ? renderDrafts(m) : hasBlock(m.content, "actions") ? renderActions(m) : undefined),
    onReply: async (m) => {
      if (!hasBlock(m.content, "actions")) return;
      try {
        const r = await api<{ results: { op: string; id?: number; ok: boolean; error?: string; todo?: Todo | null }[]; rejected: number }>("/api/ai/apply", { method: "POST", body: JSON.stringify({ text: m.content, source: "chat" }) });
        const ul = appliedNotes.get(m.id);
        const opName: Record<string, string> = { add: "新增", update: "修改", done: "完成", start: "开始", reopen: "重开", delete: "删除" };
        if (ul) ul.innerHTML = r.results.map((x) => `<li class="${x.ok ? "" : "bad"}">${opName[x.op] ?? x.op} ${x.todo ? esc(x.todo.title) : x.id ? `#${x.id}` : ""}${x.ok ? "" : ` · ${esc(x.error ?? "失败")}`}</li>`).join("") + (r.rejected ? `<li class="bad">${r.rejected} 项无法识别</li>` : "");
        const ok = r.results.filter((x) => x.ok).length;
        toast(`AI 改了清单：${ok}/${r.results.length} 项成功`);
        await load();
      } catch (e) { toast(`清单操作失败：${(e as Error).message}`); }
    },
  });
}
// ---- drawers (narrow screens)
function closeDrawers() { els.rail.classList.remove("open"); els.side.classList.remove("open"); if (els.detail.hidden) els.scrim.hidden = true; }
$("#ai-toggle").onclick = () => { els.rail.classList.add("open"); els.scrim.hidden = false; };
$("#ai-close").onclick = closeDrawers;
$("#menu").onclick = () => { els.side.classList.add("open"); els.scrim.hidden = false; };

// ---- boot
(async () => {
  await load();
  void mountChat();
  const wanted = Number(new URLSearchParams(location.search).get("todo"));
  if (wanted) await openDetail(wanted);
})();
