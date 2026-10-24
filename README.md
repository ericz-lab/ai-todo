# Todo · AI 待办

A todo list with an AI entry. Write what you have to do in one breath and the AI turns it into tasks with dates, priorities and tags; hand a task to the AI and it does what a model with the web can honestly do (research, draft, plan) and lists what is left for you; the chat rail reads the whole list and edits it on request.

## Use

One AI box at the top, three uses:

- **Add**: write what you have to do in one breath ("明天下午三点前发周报，周五订机票 #出差"). The AI answers with drafts, dates resolved; check them, fix one if you must, `加入清单`.
- **Change**: "把明天的都推到周五", "3 完成了", "把年终总结拆成三步". The AI edits the list and the answer shows what changed; a split becomes subtasks of the task.
- **Ask**: "今天先做什么", "这周压着什么". Presets above the box: 今日计划, 整理优先级, 拆分任务, 一周回顾.

On a task, `✦ 执行` (or the button in its detail) hands it to the model with `WebSearch` and `WebFetch`; the answer streams in, is kept as a run under the task, and survives closing the page.

Views: 今天 (doing, overdue, due today), 即将, 全部, 暂不处理, 已完成; filter by project or tag on the left. Click a task for its detail: fields autosave; subtasks, operation records, runs and history are under it.

Subtasks: a task can have steps, one level deep. They sit indented under their task in the list, which shows `☑ done/total`; each is a full todo (due, execute, history). Add them in the detail (they keep the task's project and tags), from the chat ("拆成三步"), or with `--parent`. Finishing a task finishes its open steps; deleting it deletes them. `︿` folds the AI box.

The `todo` skill ships with the app: ai-space links it into the workspace, so any agent session there ("记一下明天要交报告", "今天要做什么") reaches the same list through the CLI.

## Operation records

Use the detail's **操作记录** section for progress, actions taken, verification evidence and remaining work. Each append stores its own timestamp and source (`manual`, `cli`, `chat`, or `ai`); it never replaces the editable notes or earlier records. Correct a record by appending a new entry. Records support Markdown, up to 20,000 characters each; empty entries without images and oversized entries are rejected. Choose or paste up to six PNG, JPEG, GIF or WebP images (10 MB each), preview/remove them before submission, and click saved thumbnails to open originals. Image-only records are supported. Completed tasks also accept records.

The newest 50 entries appear first; **查看更早记录** loads older entries. Unsaved record drafts survive closing or switching tasks during the current page session. Audit history separately records each append. Upgrading creates the records table automatically and keeps existing notes and history unchanged; no text is automatically moved out of old notes. Records remain stored for audit when their todo is deleted, like events and AI runs, but deleted todos are not exposed by the records API.

```bash
bun src/cli.ts record 3 "Read-only verification passed; writes remain unverified"
bun src/cli.ts records 3                 # newest 50; recordsNextBefore is the next cursor
bun src/cli.ts records 3 --before 120
bun src/cli.ts show 3                    # includes recent records
```

- `POST /api/todos/:id/records` with `{ "content": "...", "source": "cli" }` appends one entry and returns `{ ok, record }`.
- `POST /api/todos/:id/records` also accepts multipart fields `content`, `source`, and repeated `images` files. The returned record includes `attachments` (`key`, `name`, `mime`, `size`); images are served through `GET /blobs/<key>`. Failed appends clean up staged images.
- `GET /api/todos/:id/records?before=<record-id>` returns `{ ok, records, recordsNextBefore }`, newest first, at most 50 entries.
- `GET /api/todos/:id` includes the first page as `records` and `recordsNextBefore`.
- Chat can append with `{ "op": "record", "id": 3, "content": "..." }`. Chat context includes excerpts of the latest three records per displayed todo; execution includes up to five recent records. Use the detail or CLI for the full history.

Another app reads the list through ai-space's bus (`POST /api/call/ai-todo/<capability>`): `list` answers tasks with their newest records (`{ status?, q?, tag?, project?, limit?, records? }`) and `task` one task in full (`{ id }`), both without changing anything. product-desk's board shows the specs this way.

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
bun src/cli.ts list [--all|--done|--deferred] [--q text] [--tag t] [--project p]
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

## Deferred tasks

Use **暂不处理** beside **开始做** in task details to keep a task without putting it on the daily agenda. The sidebar's **暂不处理** view sits between **全部** and **已完成**, with project and tag filters. Details offer **恢复待办** to reopen the task. The former **暂停** action is now **返回待办** and still returns a doing task to the active list.

Deferred tasks retain dates, notes, records and execution history, but leave Today, Upcoming, the active list/counts, overdue totals and the Space widget. Restoration keeps the original due date and warns in the page when it is overdue. There is no automatic resumption; append an operation record for an optional reason.

Deferring a parent hides its active children from daily lists and AI plans without changing their stored statuses. Reopening the parent reveals those children again; independently deferred children stay deferred. A child can be deferred on its own. Completing a parent completes all unfinished children, including deferred ones, with individual history events.

CLI: `bun src/cli.ts defer <id>`, `list --deferred`, and `reopen <id>`. API: `PATCH /api/todos/:id` with `{ "status": "deferred" }` or `{ "status": "open" }`; `GET /api/todos?status=deferred` lists explicitly deferred tasks. Chat supports `op: defer` and `op: reopen`; deferred tasks and children hidden by their parent are supplied separately from active tasks and excluded from daily plans by default. Existing databases accept the new text status without a schema migration.

Image storage follows ai-notes and trade-journal: `BLOB_URL=s3://bucket/prefix/` uses Bun’s S3 client with `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` and optional `S3_REGION`; `file:///absolute/path` uses a local directory. Without `BLOB_URL`, files go under `<SPACE_APP_DATA_DIR or data>/blobs`. The manifest requests `storage.blobs: s3` from Space. Only metadata is stored in SQLite; buckets stay private and the app streams images. Records and images are retained for audit after task deletion, but their URLs become unavailable. AI context currently includes record text only, not image contents.
