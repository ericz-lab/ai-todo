---
name: todo
description: The person's todo list (the ai-todo app). Use when they want to add, list, finish, reschedule or plan tasks, or hand one to the AI. 当用户说"加个待办""记一下要做 XX""帮我记着""今天要做什么""待办清单""把 XX 标完成""明天要干嘛""todo"时触发。
argument-hint: "[add <text> | list | done <id> | plan]"
allowed-tools: Bash(bun *), Bash(curl *), Bash(ssh *), Read
user-invocable: true
---

# todo

The list lives in an ai-todo service, which may be on this machine or another configured space host. Everything goes through its HTTP API or the app's CLI, which wraps the same API. Reach a remote loopback service over SSH. Never open the database file.

## Where it is

- App directory: `${SPACE_HOME:-~/.ai-space}/apps/ai-todo` (the workspace `AGENTS.md`, "This machine", names the workspace path when it differs).
- Service: honor an explicit user target or `TODO_URL`; otherwise use `http://127.0.0.1:8970`, with the port from the app's `space.env`, `.env` or `space.yaml` when configured.
- Public page: the app's `url` in `GET /api/apps/ai-todo` on the selected host's Space API (`SPACE_API_URL`, otherwise loopback with `SPACE_PORT`, default 8700); give it when the person wants to look. A public page URL is not proof that its API is reachable or authenticated.

## Find the running service

1. Probe the selected endpoint with a read-only request, for example `curl -fsS --connect-timeout 3 --max-time 5 "${TODO_URL:-http://127.0.0.1:8970}/api/todos?status=active"`. Require a valid ai-todo response (`ok: true` and a `todos` array), not just HTTP 200. An empty list is a successful connection. A 401/403 is an access problem, not evidence that the app is absent.
2. If the local service is unavailable, look for other configured machines before asking the person for an address. Read the workspace `AGENTS.md` / `AGENTS.local.md`, the app's deployment notes, and the workspace `.env` peer entries (`SPACE_PEER_*`). Use SSH aliases and deployment remotes from the current session or app repository when they identify a relevant host. Inspect only the connection settings needed; never print credentials. Peer HTTP URLs and SSH aliases are different: do not invent an SSH target from a peer name.
3. Check each known candidate once with bounded, read-only probes. Query its Space app registry using the configured API credentials, or use `ssh -o BatchMode=yes -o ConnectTimeout=5 <configured-host> ...` to inspect the remote workspace and call the remote loopback API. Resolve the workspace, app path and port on that host from its guide, service configuration and app environment; do not reuse the developer machine's paths. Probe `/api/todos?status=active` there to verify a live service. An app directory or cached peer listing alone does not establish availability. Do not scan unrelated hosts, start a service, deploy code or create a local database during discovery.
4. If exactly one working instance is found and no explicit target was requested, report its machine and use it for the requested task. If multiple instances work, ask which list to use before changing anything. If the user explicitly selected an unavailable instance, report alternatives without silently switching. If no candidate works, summarize the hosts checked and ask only for the missing address or access details.

Keep the chosen host and endpoint for the rest of the task. Do not repeat a failed write on another instance: a timeout may occur after the original write succeeded. Discovery uses GET requests only.

For a selected local service, set the resolved values once per session:

```bash
TODO_DIR=${SPACE_HOME:-$HOME/.ai-space}/apps/ai-todo
export TODO_URL=${TODO_URL:-http://127.0.0.1:8970}
alias todo='bun '"$TODO_DIR"'/src/cli.ts'
```

Adjust these defaults to the discovered app path and port. For a remote service, run the CLI or API request on the selected host over SSH, using that host's `TODO_DIR`, `TODO_URL` and Bun path. The `todo` commands below mean that selected CLI, local or remote. If the CLI is absent, use the API. Quote CLI arguments and JSON safely across the SSH shell boundary, and quote URLs containing `?`. Do not let later commands fall back to the developer machine's loopback address.

## What to do

| The person says | Do |
| --- | --- |
| "记一下 / 加个待办 / 帮我记着 …" | `todo parse "<their words>"` shows what the model makes of it (dates resolved, tags, priority); then `todo add "<title>" [--due …] [--priority …] [--tags …] [--project …]` for each draft. Read the drafts back to the person with the dates you used. Without the model (parse fails), add the plain titles and say the dates were not set. |
| "今天要做什么 / 明天要干嘛 / 安排一下" | `todo list`, then order by due, priority and what is `doing`; answer with ids, short. |
| "XX 完成了 / 做完了 3" | `todo done <id>`; find the id with `todo list --q <text>` when they name the task. |
| "开始做 / 推迟到周五 / 改成高优先级" | `todo start <id>` or `curl -sS -X PATCH "$TODO_URL/api/todos/<id>" -H 'content-type: application/json' -d '{"due":"YYYY-MM-DD"}'` on the selected host (fields: title, notes, status, priority, due, tags, project; source `cli`). |
| "让 AI 去做 / 帮我查一下这条" | `todo execute <id> [--extra "…"]`; it streams the model's result and stores it under the task. Minutes and a model call; say so before running unless they asked for it. |
| "记录进展 / 回写验收结果 / 追加操作记录" | `todo record <id> "<content>"`; preserve notes and earlier entries. Include evidence, what was verified and what remains unverified. Use `todo records <id> [--before id]` to read older entries. |
| "删掉 …" | `todo rm <id>`, after confirming which one; it takes the subtasks with it, say so. |
| "拆成几步 / 放到 X 下面 / 这几个是 X 的子任务" | Subtasks, one level deep: `todo add "<step>" --parent <id>` for a new one, `todo move <id> <parent-id>` for an existing one (`none` takes it out). A task with subtasks cannot become one, a subtask cannot have its own. `todo done <parent>` also finishes its open subtasks. |

Dates are the person's local wall clock, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; resolve "明天" and "周五" using the person's timezone and current date, not a remote server's timezone, and say the date you used. `todo show <id>` gives notes, the parent or the subtasks, AI runs and history; `todo list` prints subtasks indented under their task.

## API, for anything the CLI lacks

```
GET    /api/todos?status=active|deferred|done|all&q=&tag=&project=    { todos, tags, projects }
POST   /api/todos            { title, notes?, due?, priority?, tags?, project?, parentId?, source: "cli" }
POST   /api/todos/bulk       { drafts: [...], parentId?, source: "cli" }   parentId: every draft becomes its subtask
GET    /api/todos/:id        { todo, parent, subtasks, events, runs, records, recordsNextBefore }
GET    /api/todos/:id/records?before=<id>  { records, recordsNextBefore } (50 newest first)
POST   /api/todos/:id/records { content, source: "cli" } -> { record }
PATCH  /api/todos/:id        any of the fields above; parentId null takes a subtask out
DELETE /api/todos/:id
POST   /api/ai/parse         { text } -> { drafts }
POST   /api/todos/:id/execute  { extra? } -> text/event-stream
```

Answers are `{ ok: true, ... }` or `{ ok: false, error }`.

Operation records are append-only, support Markdown, and allow 1–20,000 characters. Correct earlier claims with a new entry. After an uncertain POST response, inspect recent records before retrying to avoid duplicates.

For 暂不处理, use `todo defer <id>`; use `todo list --deferred` to find deferred tasks and `todo reopen <id>` to restore. Dates, records and history remain intact. A deferred parent hides its active children without changing their statuses; daily plans exclude these tasks unless requested.
