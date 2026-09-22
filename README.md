# Todo · AI 待办

A todo list with an AI entry. Write what you have to do in one breath and the AI turns it into tasks with dates, priorities and tags; hand a task to the AI and it does what a model with the web can honestly do (research, draft, plan) and lists what is left for you; the chat rail reads the whole list and edits it on request.

## Use

- **AI 解析**: type anything into the box at the top (`⌘/Ctrl + Enter`), check the drafts, fix a date if you must, and add them. **直接添加** adds each line as it is.
- **执行**: on a task, `✦ 执行` (or the button in its detail) sends it to the model with `WebSearch` and `WebFetch`; the answer streams in, is kept as a run under the task, and survives closing the page.
- **AI 对话**: the rail on the right is ai-space's chat widget with the list in context. "把明天的都推到周五" or "把年终总结拆成三步" changes the list; the page shows what changed.
- Views: 今天 (doing, overdue, due today), 即将, 全部, 已完成; filter by project or tag on the left. Click a task for its detail: fields autosave, runs and history are under it.

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
bun src/cli.ts done 3 | start 3 | reopen 3 | rm 3 | show 3
bun src/cli.ts parse "明天下午三点前发周报"      # drafts, not added
bun src/cli.ts execute 3 --extra "只要一页"
```

## Deploy

A bare repository with `deploy/post-receive` on the host (`git push seoul main`), or `DEPLOY_HOST=<ssh host> ./deploy.sh`. See [AGENTS.md](AGENTS.md) for the host details once it is live.

This is an [ai-space](https://github.com/ericz-lab/ai-space) app; the contract is its `docs/app-spec.md`.
