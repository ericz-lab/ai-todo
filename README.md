# Todo · AI 待办

A todo list with an AI entry. Write what you have to do in one breath and the AI turns it into tasks with dates, priorities and tags; hand a task to the AI and it does what a model with the web can honestly do (research, draft, plan) and lists what is left for you; the chat rail reads the whole list and edits it on request.

## Use

One AI box at the top, three uses:

- **Add**: write what you have to do in one breath ("明天下午三点前发周报，周五订机票 #出差"). The AI answers with drafts, dates resolved; check them, fix one if you must, `加入清单`.
- **Change**: "把明天的都推到周五", "3 完成了", "把年终总结拆成三步". The AI edits the list and the answer shows what changed; a split becomes subtasks of the task.
- **Ask**: "今天先做什么", "这周压着什么". Presets above the box: 今日计划, 整理优先级, 拆分任务, 一周回顾.

On a task, `✦ 执行` (or the button in its detail) hands it to the model with `WebSearch` and `WebFetch`; the answer streams in, is kept as a run under the task, and survives closing the page.

Views: 今天 (doing, overdue, due today), 即将, 全部, 已完成; filter by project or tag on the left. Click a task for its detail: fields autosave; subtasks, operation records, runs and history are under it.

Subtasks: a task can have steps, one level deep. They sit indented under their task in the list, which shows `☑ done/total`; each is a full todo (due, execute, history). Add them in the detail (they keep the task's project and tags), from the chat ("拆成三步"), or with `--parent`. Finishing a task finishes its open steps; deleting it deletes them. `︿` folds the AI box.

The `todo` skill ships with the app: ai-space links it into the workspace, so any agent session there ("记一下明天要交报告", "今天要做什么") reaches the same list through the CLI.

## Operation records

Use the detail's **操作记录** section for progress, actions taken, verification evidence and remaining work. Each append stores its own timestamp and source (`manual`, `cli`, `chat`, or `ai`); it never replaces the editable notes or earlier records. Correct a record by appending a new entry. Records support Markdown, up to 20,000 characters each; empty and oversized entries are rejected. Completed tasks also accept records.

The newest 50 entries appear first; **查看更早记录** loads older entries. Unsaved record drafts survive closing or switching tasks during the current page session. Audit history separately records each append. Upgrading creates the records table automatically and keeps existing notes and history unchanged; no text is automatically moved out of old notes. Records remain stored for audit when their todo is deleted, like events and AI runs, but deleted todos are not exposed by the records API.

```bash
bun src/cli.ts record 3 "Read-only verification passed; writes remain unverified"
bun src/cli.ts records 3                 # newest 50; recordsNextBefore is the next cursor
bun src/cli.ts records 3 --before 120
bun src/cli.ts show 3                    # includes recent records
```

- `POST /api/todos/:id/records` with `{ "content": "...", "source": "cli" }` appends one entry and returns `{ ok, record }`.
- `GET /api/todos/:id/records?before=<record-id>` returns `{ ok, records, recordsNextBefore }`, newest first, at most 50 entries.
- `GET /api/todos/:id` includes the first page as `records` and `recordsNextBefore`.
- Chat can append with `{ "op": "record", "id": 3, "content": "..." }`. Chat context includes excerpts of the latest three records per displayed todo; execution includes up to five recent records. Use the detail or CLI for the full history.

There are no edit or delete endpoints for individual records. Each append and its audit event are committed together. A POST is one new entry; callers should check recent records before retrying after an uncertain network response.

## Run locally

```bash
bun install
cp .env.example .env      # fill in real values; never commit .env
PORT=8970 bun src/index.ts
curl -s http://127.0.0.1:8970/healthz
```

Without `SPACE_API_URL` and `SPACE_APP_TOKEN` the list works and every AI feature answers 502. Inside an ai-space workspace both come from `<workspace>/data/ai-todo/space.env`, with `DATABASE_URL`.

CLI over the running service (also what the `planner` agent uses):

```bash
bun src/cli.ts list [--all|--done] [--q text] [--tag t] [--project p]
bun src/cli.ts add "订机票" --due 2026-09-26 --priority 2 --tags 出差
bun src/cli.ts add "订酒店" --parent 3                 # a subtask of #3
bun src/cli.ts move 5 3 | move 5 none                 # make #5 a subtask of #3, or take it out
bun src/cli.ts done 3 | start 3 | reopen 3 | rm 3 | show 3
bun src/cli.ts parse "明天下午三点前发周报"      # drafts, not added
bun src/cli.ts execute 3 --extra "只要一页"
```

## Deploy

A bare repository with `deploy/post-receive` on the host (`git push seoul main`), or `DEPLOY_HOST=<ssh host> ./deploy.sh`. See [AGENTS.md](AGENTS.md) for the host details once it is live.

This is an [ai-space](https://github.com/ericz-lab/ai-space) app; the contract is its `docs/app-spec.md`.

All AI features inherit the default model selected in ai-space Settings. Legacy `TODO_MODEL` values are ignored.
