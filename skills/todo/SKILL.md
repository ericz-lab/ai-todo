---
name: todo
description: The person's todo list (the ai-todo app). Use when they want to add, list, finish, reschedule or plan tasks, or hand one to the AI. 当用户说"加个待办""记一下要做 XX""帮我记着""今天要做什么""待办清单""把 XX 标完成""明天要干嘛""todo"时触发。
argument-hint: "[add <text> | list | done <id> | plan]"
allowed-tools: Bash(bun *), Bash(curl *), Read
user-invocable: true
---

# todo

The list lives in the ai-todo app of this space. Everything goes through its HTTP API on loopback, or the app's CLI, which wraps the same API. Never open the database file.

## Where it is

- App directory: `${SPACE_HOME:-~/.ai-space}/apps/ai-todo` (the workspace `AGENTS.md`, "This machine", names the workspace path when it differs).
- Service: `http://127.0.0.1:8970` unless the app's `.env` or `space.yaml` says another port. The CLI reads `TODO_URL` (default that address).
- Public page: the app's `url` in `GET http://127.0.0.1:8700/api/apps/ai-todo`; give it when the person wants to look.

Set once per session:

```bash
TODO_DIR=${SPACE_HOME:-$HOME/.ai-space}/apps/ai-todo
alias todo='bun '"$TODO_DIR"'/src/cli.ts'
```

## What to do

| The person says | Do |
| --- | --- |
| "记一下 / 加个待办 / 帮我记着 …" | `todo parse "<their words>"` shows what the model makes of it (dates resolved, tags, priority); then `todo add "<title>" [--due …] [--priority …] [--tags …] [--project …]` for each draft. Read the drafts back to the person with the dates you used. Without the model (parse fails), add the plain titles and say the dates were not set. |
| "今天要做什么 / 明天要干嘛 / 安排一下" | `todo list`, then order by due, priority and what is `doing`; answer with ids, short. |
| "XX 完成了 / 做完了 3" | `todo done <id>`; find the id with `todo list --q <text>` when they name the task. |
| "开始做 / 推迟到周五 / 改成高优先级" | `todo start <id>` or `curl -sS -X PATCH http://127.0.0.1:8970/api/todos/<id> -H 'content-type: application/json' -d '{"due":"YYYY-MM-DD"}'` (fields: title, notes, status, priority, due, tags, project; source `cli`). |
| "让 AI 去做 / 帮我查一下这条" | `todo execute <id> [--extra "…"]`; it streams the model's result and stores it under the task. Minutes and a model call; say so before running unless they asked for it. |
| "删掉 …" | `todo rm <id>`, after confirming which one. |

Dates are the person's local wall clock, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; resolve "明天" and "周五" against today's date on this machine and say the date you used. `todo show <id>` gives notes, AI runs and history.

## API, for anything the CLI lacks

```
GET    /api/todos?status=active|done|all&q=&tag=&project=    { todos, tags, projects }
POST   /api/todos            { title, notes?, due?, priority?, tags?, project?, source: "cli" }
POST   /api/todos/bulk       { drafts: [...], source: "cli" }
GET    /api/todos/:id        { todo, events, runs }
PATCH  /api/todos/:id        any of the fields above
DELETE /api/todos/:id
POST   /api/ai/parse         { text } -> { drafts }
POST   /api/todos/:id/execute  { extra? } -> text/event-stream
```

Answers are `{ ok: true, ... }` or `{ ok: false, error }`.
