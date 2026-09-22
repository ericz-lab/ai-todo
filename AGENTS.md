# ai-todo - agent guide

Read this before touching code. Users read [README.md](README.md). This repository is an ai-space app; the contract is ai-space `docs/app-spec.md` (spec 1) and `space.yaml` is the only file ai-space reads.

## Rules

1. **Be honest.** The executor's prompt makes the model mark what it could not verify and list what only the person can do; keep that. `/api/widget` returns `{ ok: false, error }` on failure.
2. **Traceable.** Every todo carries `source` (manual, ai, chat, cli) and every change is a row in `todo_events`; every AI execution is a row in `runs` with the ledger call id. Never rewrite history.
3. **The page never holds a token.** Every AI feature goes through the server (`/api/ai/*`, `/api/todos/:id/execute`) or the `/space/chat/*` proxy; `SPACE_APP_TOKEN` stays in the process.
4. **Configuration is environment.** Real values live in `.env` (ignored) or in the `space.env` ai-space generates; the repository holds only `.env.example`.
5. **Loopback only.** The service binds `127.0.0.1:${PORT}`; exposure is the space's job.
6. **Portable.** Prompts and the agent name no host, ssh alias or home directory.

## Stack and runtime model

- Bun + TypeScript, no framework, no runtime dependency. `src/index.ts` is the service (`Bun.serve` with the HTML import of `web/index.html`), `bun:sqlite` for storage.
- Two AI paths, both through ai-space's model service (`POST ${SPACE_API_URL}/api/model/run`, `docs/model.md`) or chat service (`docs/chat.md`):
  - **the AI panel** (`web/app.ts`, `mountChat`): ai-space's chat widget, scope `todo`, with `context()` from `GET /api/ai/context` (system prompt `CHAT_SYSTEM`, the whole list with ids as `text`). The prompt makes every answer one of three: a `todo-drafts` block (the message was things to do; the page fetches the cleaned drafts from `POST /api/ai/drafts`, renders editable cards inside the widget's shadow root with their own `<style>`, and adds them with `POST /api/todos/bulk`), a `todo-actions` block (a change; the widget's `onReply` posts the answer to `POST /api/ai/apply`, which validates with `cleanAction` and applies each operation, and the page lists the results under the answer), or plain text (a plan or an answer).
  - **execute** (`POST /api/todos/:id/execute`): one streamed call, tag `execute`, tools `WebSearch, WebFetch` (`TODO_WEB=0` removes them), system prompt `EXECUTE_SYSTEM`. The run row is created first, the model call is detached from the request (a closed page does not stop it), and `Live` fans the stream out to whoever is watching; `GET /api/runs/:id/stream` reattaches for a minute after the end. One run in flight per todo; runs left `running` by a crash are closed on boot.
  - `POST /api/ai/parse` (tag `parse`, `PARSE_SYSTEM`, `thinking: 0`) is the same drafting as one non-streamed call, for the CLI and the skill; the page no longer uses it.
- Dates are local wall-clock strings (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`) with no zone; the page sends its zone with every AI request and the prompts carry a `Clock:` line so relative dates resolve.

## Directory map

```
space.yaml           * the manifest: identity, service, agent, widget, storage
src/index.ts         * the service: routes, execution fan-out, chat proxy, boot
src/ai.ts            * model-service client, the three prompts, answer readers (JSON array, todo-actions)
src/db.ts            * schema, cleaning of drafts/patches, todos, events, runs
src/types.ts           data model
src/config.ts          environment
src/cli.ts             the CLI the planner agent uses
web/index.html         the page shell; app.ts the logic; styles.css the glass; md.ts Markdown
agents/planner.md      system prompt of the `planner` agent; planner.svg its avatar
skills/todo/SKILL.md   the skill ai-space links into the workspace: the list from any agent session
deploy/app.service     user-level systemd unit template (@DIR@ substituted)
deploy/post-receive    bare-repository hook: checkout, install, unit, restart, sync
deploy.sh              rsync alternative to the hook
```

## Conventions

- Page routes trust loopback (the edge holds the login); there is no write token.
- Widget contract: `GET /api/widget` -> `{ ok: true, items: [{ text, url, time }] }`, active todos due first, at most twenty.
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

Fill in once live: host, workspace path, unit name, port, deploy command, public URL, access rule.

## Known pitfalls

- The widget script must be loaded with a script element created at runtime; a static `<script src="/space/chat/widget.js">` is resolved at build time by Bun's HTML import and fails.
- A todo row is a CSS grid; the ops column has an explicit `grid-column`, otherwise its fixed `grid-row` makes the auto-placer put it first.
- `renderAssistant` runs before `onReply` finishes: the applied-actions list is created empty in the render and filled from the apply result by message id.
- Nodes returned from `renderAssistant` land inside the widget's shadow root: the page stylesheet does not apply there, only inherited custom properties do, so the draft cards carry their own `<style>` (`INNER_CSS`).
- Drafts already added are remembered per browser (`localStorage` `todo-added`, message ids) so a reloaded thread does not offer them again; another browser will.
