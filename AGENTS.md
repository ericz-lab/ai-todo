# ai-todo - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads.

## Rules

1. **Be honest.** The executor's prompt makes the model mark what it could not verify and list what only the person can do; keep that. `/api/widget` returns `{ ok: false, error }` on failure.
2. **Traceable.** Every todo carries `source` (manual, ai, chat, cli) and every change is a row in `todo_events`; every AI execution is a row in `runs` with the ledger call id. Never lose history: a plan and an operation record may be edited, but each edit first keeps the earlier text as a version (`todo_plan_versions`, `todo_record_revisions`) and writes an event (`plan-edited`, `record-edited`); `todo_events` and `runs` stay append-only. The page marks an edited record `已编辑` and shows its earlier revisions.
3. **The page never holds a token.** Every AI feature goes through the server (`/api/ai/*`, `/api/todos/:id/execute`) or the `/space/chat/*` proxy; `SPACE_APP_TOKEN` stays in the process.
4. **Configuration is environment.** Real values live in `.env` (ignored) or in the `space.env` ai-space generates; the repository holds only `.env.example`.
5. **Loopback only.** The service binds `127.0.0.1:${PORT}`; exposure is the space's job.
6. **Portable.** Prompts and the agent name no host, ssh alias or home directory.

## Stack and runtime model

- Bun + TypeScript, no framework, no runtime dependency. `src/index.ts` is the service (`Bun.serve` with the HTML import of `web/index.html`), `bun:sqlite` for storage.
- Two AI paths, both through ai-space's model service (`POST ${SPACE_API_URL}/api/model/run`, `docs/model.md`) or chat service (`docs/chat.md`):
  - **the AI panel** (`web/app.ts`, `mountChat`): ai-space's chat widget, scope `todo`, with `context()` from `GET /api/ai/context` (system prompt `CHAT_SYSTEM`, the whole list with ids as `text`). The prompt makes every answer one of three: a `todo-drafts` block (the message was things to do; the page fetches the cleaned drafts from `POST /api/ai/drafts`, renders editable cards inside the widget's shadow root with their own `<style>`, and adds them with `POST /api/todos/bulk`), a `todo-actions` block (a change; the widget's `onReply` posts the answer to `POST /api/ai/apply`, which validates with `cleanAction` and applies each operation, and the page lists the results under the answer), or plain text (a plan or an answer).
  - The plan reaches both: the chat context has a 200-character excerpt per task with its version (`plan (vN, excerpt…)`), the chat may answer `op: plan` (whole text, with `expectedVersion`), `op: edit-record`, or `update` with `plan`; the executor's prompt has the plan up to 8,000 characters (`PLAN_PROMPT_CHARS`) after the notes and the parent's first 1,000.
  - **execute** (`POST /api/todos/:id/execute`): one streamed call, tag `execute`, tools `WebSearch, WebFetch` (`TODO_WEB=0` removes them), system prompt `EXECUTE_SYSTEM`. The run row is created first, the model call is detached from the request (a closed page does not stop it), and `Live` fans the stream out to whoever is watching; `GET /api/runs/:id/stream` reattaches for a minute after the end. One run in flight per todo; runs left `running` by a crash are closed on boot.
  - `POST /api/ai/parse` (tag `parse`, `PARSE_SYSTEM`, `thinking: 0`) is the same drafting as one non-streamed call, for the CLI and the skill; the page no longer uses it.
- Subtasks: `todos.parent_id`, one level deep (checked in `db.ts`: the parent exists, is not a subtask, a todo with subtasks stays on top). Every read carries `subtasks: { total, done }`; `done` on a parent finishes its open subtasks and `delete` deletes them, each with its own event; the parent logs `subtask-added`. The page nests them under their parent, the chat context indents them (`↳`), the chat's splits and `POST /api/todos/bulk { parentId }` create them, execute sees the parent or the steps. A database from before gets the column on open.
- Plan (方案): `todos.plan` is the current Markdown plan of a todo (how it is done, the design; at most 50,000 characters), `todos.plan_version` its number; every version is a full row in `todo_plan_versions` (`setPlan` in `db.ts` writes the version, the cached copy and a `plan-edited { source, version }` event in one transaction). `expectedVersion` on a write must match or the write is a `ConflictError` (409 with the current plan). A save carrying the same `session` and source as the latest version, within a minute of it, rewrites that version (the page's typing), like `mergeEdit`; a write without a session (CLI, AI) is always a new version. Notes stay the short description beside the plan. A database from before gets the columns and tables on open; nothing is moved into plans then (`src/migrate-plans.ts` is the one-time copy of old `## AI 评估` records).
- Operation records: `todo_records` holds progress/acceptance entries separate from notes and `todo_events`; they are appended, and may be edited to correct a fact (`editRecord`: revision 0 is the text as appended, every revision a row in `todo_record_revisions`, `revision`/`edited_at` on the record, a `record-edited` event; `expectedRevision` like `expectedVersion`). An edit changes the text only; the id, time, author (`source`) and images stay. Use `POST /api/todos/:id/records`, CLI `record`, or chat `op: record`; never overwrite notes to log progress. Each append is transactional with its audit event. Reads are newest first with a stable `before` id cursor. Existing notes are not migrated. Records accept multipart image attachments; bytes live in BLOB_URL, metadata in the attachments column. Failed appends remove staged blobs; deleted todos retain audit data but cannot serve images.
- Dates are local wall-clock strings (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`) with no zone; the page sends its zone with every AI request and the prompts carry a `Clock:` line so relative dates resolve.

## Directory map

```
space.yaml           * the manifest: identity, service, agent, widget, storage
src/index.ts         * the service: routes, execution fan-out, chat proxy, boot
src/ai.ts            * model-service client, the three prompts, answer readers (JSON array, todo-actions)
src/db.ts            * schema, cleaning of drafts/patches, todos, plans and their versions, records and their revisions, events, runs
src/widget.ts          the panel card: items and state blocks
src/types.ts           data model
src/config.ts          environment
src/blobs.ts           private BLOB_URL image storage (file or S3), following trade-journal
src/cli.ts             the CLI the planner agent uses
web/index.html         the page shell; app.ts the logic; styles.css the glass
agents/planner.md      system prompt of the `planner` agent; planner.svg its avatar
skills/todo/SKILL.md   the skill ai-space links into the workspace: the list from any agent session
deploy/app.service     user-level systemd unit template (@DIR@ substituted)
deploy/post-receive    bare-repository hook: checkout, install, unit, restart, sync
deploy.sh              rsync alternative to the hook
```

## Conventions

- Page routes trust loopback (the edge holds the login); there is no write token.
- Widget contract: `GET /api/widget` -> `{ ok: true, items: [{ text, url, time }], asOf, staleAfter, blocks }` (`src/widget.ts`). `items` (active todos due first, at most twenty) stays for panels without blocks. `blocks`: a hero metric of todos due by today in the `TODO_TZ` wall clock (tone negative when any is overdue, warning when due today), the next three todos as `status` rows linking `/?todo=<id>`, a 7-day bar trend of completions counted from `done` events, then two more todos; an empty list is the hero alone (plus the trend if anything was finished).
- Capabilities for other apps (`provides` in `space.yaml`, ai-space `docs/events.md`): `parse` is `POST /api/ai/parse`, `add` is `POST /api/todos/bulk`, `record` is `POST /api/capabilities/record` (multipart `todoId`, `content`, `source`, `images`: the page's record with pictures, for another app; ai-spark attaches an idea's screenshot to the tasks it makes), `capture-image` is `POST /api/capabilities/capture-image` (a capture target, ai-space `docs/events.md#capture`: a phone screenshot kept as a new task; multipart `file`, `text?`, `via?`, `id?`; the first line of the text is the title, `截图` without one, the rest the notes, the picture the first record; a repeated `id` answers the first task), `list` is `POST /api/capabilities/list` (`{ status?, q?, tag?, project?, limit?, records?, plan? }`: the tasks another app shows, each with its newest records and `planExcerpt`, the first 300 characters of its plan, or `plan` in full with `plan: true`; product-desk's board reads specs this way) and `task` is `POST /api/capabilities/task` (`{ id }`: the same answer as `GET /api/todos/:id`, the full plan included), both reads that add no event, `plan` is `POST /api/capabilities/plan` (`{ id, content, source?, expectedVersion? }`: replace a task's plan, 409 with the current one when stale; the caller goes into the `plan-edited` event), `create` is `POST /api/capabilities/create`, the "Create todo" action of ai-space's command box and Shortcuts panel (ai-space `docs/shortcuts.md`): `{ title, dueDate?, dueTime?, notes?, timezone, idempotencyKey }` answers a receipt `{ items: [{ id, title, url, detail }] }`; a time in another zone is moved to the `TODO_TZ` wall clock (`actionDue`), and a repeated `idempotencyKey` (kept in the `created` event) answers the first todo instead of adding another. ai-space forwards a call on loopback with `x-space-caller`; the routes put that name into the todo's `created` event as `caller`, next to `source`.
- `/space/chat/*` is a dumb pass-through to ai-space (only `content-type`, `accept`, `content-length`, `if-none-match` forwarded; `timeout: false` upstream).
- Tests sit next to the code (`src/*.test.ts`), use `:memory:` databases and a stub `Bun.serve` standing in for ai-space; no network, no model.
- English in code, comments, docs and commits; the page and the model output are Chinese (`TODO_LANG=zh`).
- Commit messages follow Conventional Commits.

## Commands

```bash
bun install
PORT=8970 bun src/index.ts
bun run check            # typecheck + tests
bun src/cli.ts list
```

## Environment variables

See `.env.example`. Provided by ai-space: `PORT`, `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`, `SPACE_APP_TOKEN`, `DATABASE_URL`.

## Deployment

- Host: the `thinkbook` space (Local edition on a Linux laptop kept always on, `SPACE_NAME=thinkbook`), workspace `~/.ai-space`, code in `apps/ai-todo` (the bare repository's work tree, no `.git`). It is a peer of the seoul space, whose panel lists it and forwards calls to it. Moved from seoul on 2026-10-24.
- Deploy: `git push deploy main` (remote `deploy` = `~/ai-todo.git` on that machine; its `post-receive` hook from `deploy/post-receive` runs `space app deploy ai-todo`: checkout, the manifest's checks, sync, restart only when they pass).
- Service: supervised by ai-space (`SPACE_SUPERVISOR=space`) as the user unit `space-ai-todo.service`, `127.0.0.1:8970`, health `GET /healthz`. Logs: `space logs ai-todo -n 50`.
- Data: `data/ai-todo/main.db` (`DATABASE_URL` in `data/ai-todo/space.env`), pictures in R2 under `s3://my-bucket/ai-todo/` (`BLOB_URL`); the space's `ai-todo/backup` task snapshots it nightly to `s3://my-bucket/backups-thinkbook/`. Snapshots from before the move are under seoul's `backups/` prefix.
- Public URL: `https://ai-todo.example.com/` through the space router's wildcard rule (Caddy on loopback, Cloudflare tunnel `thinkbook`), behind Cloudflare Access (`*.example.com`). The old `ai-todo.example.com` name ended with the move.
- First deploy of a new directory needs `space app sync` once (the hook's per-app sync answers 404 for an app the space has not seen).
- Source: https://github.com/ericz-lab/ai-todo, remote `origin`.

## Known pitfalls

- The widget script must be loaded with a script element created at runtime; a static `<script src="/space/chat/widget.js">` is resolved at build time by Bun's HTML import and fails.
- A todo row is a CSS grid; the ops column has an explicit `grid-column`, otherwise its fixed `grid-row` makes the auto-placer put it first.
- `renderAssistant` runs before `onReply` finishes: the applied-actions list is created empty in the render and filled from the apply result by message id.
- Markdown (notes, AI runs) is rendered by the space's own renderer, `SpaceChat.renderMd` from the chat widget the page already loads; there is no copy of it here. Without ai-space the page falls back to escaped paragraphs.
- Nodes returned from `renderAssistant` land inside the widget's shadow root: the page stylesheet does not apply there, only inherited custom properties do, so the draft cards carry their own `<style>` (`INNER_CSS`).
- The detail autosaves title and notes half a second after typing and not while an IME composes (`compositionend` saves). A run of such saves of the same field(s) from the same source, each within a minute of the todo's latest event, extends that one `edited` event (`mergeEdit` in `db.ts`: `from` before the session, `to` the last save) instead of adding a line per pause; any other change is its own row.
- Drafts already added are remembered per browser (`localStorage` `todo-added`, message ids) so a reloaded thread does not offer them again; another browser will.

- Deferred tasks use `status: deferred`, chat `op: defer`, CLI `defer` / `list --deferred`. Active queries and AI plans exclude deferred tasks and active children of deferred parents; child statuses are preserved. Completing a parent also completes deferred children. The deferred sidebar has its own project/tag counts.
