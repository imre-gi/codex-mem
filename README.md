# codex-mem

Persistent memory for OpenAI Codex with a lightweight local worker service and SQLite backend.

`codex-mem` is inspired by `claude-mem` architecture and now includes the same core shape:

- MCP tools for Codex
- a lightweight background worker service (HTTP)
- persistent local DB storage (SQLite)
- local CLI for direct usage and debugging
- optional VS Code extension integration

## Table of Contents

- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Requirements](#requirements)
- [Install](#install)
- [Quick Start](#quick-start)
- [Codex MCP Setup](#codex-mcp-setup)
- [Worker Service](#worker-service)
- [CLI Reference](#cli-reference)
- [MCP Tools Reference](#mcp-tools-reference)
- [Storage](#storage)
- [VS Code Extension](#vs-code-extension)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Architecture

`codex-mem` uses 3 runtime pieces:

1. Worker service (`src/worker-service.ts`)
- Local HTTP service (default `127.0.0.1:37777`)
- Handles memory operations
- Reads/writes SQLite DB

2. MCP server (`src/mcp-server.ts`)
- Exposes `mem_*` tools to Codex
- Calls the running worker service

3. CLI (`src/cli.ts`)
- Worker lifecycle (`worker start|stop|restart|status|run`)
- Direct local operations (`add-observation`, `search`, etc.)
- `mcp` command auto-starts worker and runs MCP server

## Repository Layout

```text
codex-mem/
  src/
    cli.ts
    mcp-server.ts
    worker-service.ts
    worker-manager.ts
    worker-config.ts
    service-client.ts
    store.ts            # SQLite-backed memory store
    context-pack.ts
    types.ts
  tests/
    store.test.ts
  vscode-extension/
    package.json
    src/extension.ts
```

## Requirements

- Node.js `>=20`
- npm
- Optional: OpenAI Codex CLI (`@openai/codex`)
- Optional: VS Code

## Install

In commands below, `<repo-root>` means the directory where you cloned `codex-mem`.

```bash
cd <repo-root>
npm run install:vscode
```

`npm run install:vscode` does:

1. install root dependencies
2. install `vscode-extension` dependencies
3. build `codex-mem`
4. package/install local VS Code extension
5. one-time MCP registration + worker startup (`node dist/cli.js setup`)
6. installs extension into detected VS Code user profiles

For a fully clean reinstall:

```bash
cd <repo-root>
npm run reinstall:vscode
```

This removes prior local codex-mem extension + MCP config entries, then performs the full install again.

Profile override (optional):

```bash
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

## Getting Started (New Machine)

If this is a fresh install and you want the fastest path to working MCP memory:

1. Install Node.js 20+
2. Clone this repo
3. Run:

```bash
cd <repo-root>
npm run install:vscode
```

4. Verify:

```bash
codex mcp get codex-mem
node dist/cli.js worker status
node dist/cli.js kpis
```

5. Run Codex normally:

```bash
codex
```

Notes:

- If `codex` is not installed globally, `setup` automatically tries `npx --yes @openai/codex`.
- If `npx` path is used, the first run can be slower because it resolves the package first.

## Quick Start

### 0. One-time setup (recommended)

```bash
node dist/cli.js setup
```

This registers `codex-mem` in Codex MCP settings and starts the worker.  
After that, just run `codex` normally.

### 0b. Enable only

```bash
node dist/cli.js enable
```

### 1. Start worker

```bash
node dist/cli.js worker start
```

### 2. Verify health

```bash
node dist/cli.js worker status
```

### 3. Save memory

```bash
node dist/cli.js add-observation \
  --title "Fix auth callback" \
  --content "Normalized callback parsing and added guard" \
  --type bugfix \
  --tags auth,oauth
```

### 4. Query memory

```bash
node dist/cli.js search --query auth
node dist/cli.js context --query auth --full-count 3
node dist/cli.js kpis
```

### 5. Stop worker

```bash
node dist/cli.js worker stop
```

## Codex MCP Setup

Register `codex-mem` MCP server with Codex:

```bash
codex mcp add codex-mem -- node "$(pwd)/dist/cli.js" mcp
```

The `mcp` command auto-starts the worker backend if needed.

Equivalent single-command setup from this repo:

```bash
node dist/cli.js setup
```

Verify:

```bash
codex mcp list
codex mcp get codex-mem
```

### If `codex: command not found`

Install globally:

```bash
npm install -g @openai/codex
```

Or use `npx`:

```bash
npx @openai/codex mcp add codex-mem -- node "$(pwd)/dist/cli.js" mcp
```

## Worker Service

Default runtime:

- Host: `127.0.0.1`
- Port: `37777`

Custom host/port:

```bash
node dist/cli.js worker start --host 127.0.0.1 --port 37888
node dist/cli.js worker status --host 127.0.0.1 --port 37888
node dist/cli.js worker stop --host 127.0.0.1 --port 37888
```

Foreground mode (for debugging):

```bash
node dist/cli.js worker run
```

Worker logs:

```text
~/.codex-mem/logs/worker-YYYY-MM-DD.log
```

Worker PID file:

```text
~/.codex-mem/worker.pid
```

### Worker HTTP API (internal)

- `GET /api/health`
- `POST /api/admin/shutdown`
- `POST /api/memory/add-observation`
- `POST /api/memory/add-summary`
- `POST /api/memory/search`
- `POST /api/memory/timeline`
- `POST /api/memory/get-entries`
- `POST /api/memory/context-pack`
- `GET /api/memory/projects`

## CLI Reference

### Global options

- `--data-file <path>`: SQLite DB file path override
- `--host <host>`: worker host override
- `--port <port>`: worker port override

### Commands

- `setup`
- `enable`
- `mcp`
- `worker start|stop|restart|status|run`
- `init`
- `kpis`
- `add-observation`
- `add-summary`
- `search`
- `timeline`
- `get`
- `context`
- `list-projects`
- `help`

### `setup`

Onboarding command that enables MCP and starts worker:

```bash
node dist/cli.js setup
```

Optional:

- `--name <mcp-name>` (default: `codex-mem`)
- `--host <host>`
- `--port <port>`
- `--data-file <path>`

### `init`

```bash
node dist/cli.js init
```

Returns DB path and current worker status.

### `kpis`

```bash
node dist/cli.js kpis
```

Returns:

- worker status (`running`, `pid`, `uptimeSeconds`, endpoint)
- aggregate memory totals (`entriesTotal`, `observationsTotal`, `summariesTotal`, `projectsTotal`)
- oldest/latest entry timestamps

### `enable`

Registers this repository as an MCP server in Codex config.

```bash
node dist/cli.js enable
```

Optional:

- `--name <mcp-name>` (default: `codex-mem`)
- `--host <host>`
- `--port <port>`
- `--data-file <path>`

Behavior:

- Uses local `codex` binary if available
- Falls back to `npx --yes @openai/codex`
- Idempotent: if same server config already exists, no change is made
- If a server with same name exists but different command/args, it is replaced

### `add-observation`

Required:

- `--title <text>`
- `--content <text>`

Optional:

- `--project <name>`
- `--session-id <id>`
- `--type <bugfix|feature|refactor|discovery|decision|change|note>`
- `--tags <comma,separated>`
- `--files <comma,separated>`

### `add-summary`

Required:

- `--learned <text>`

Optional:

- `--project <name>`
- `--session-id <id>`
- `--request <text>`
- `--investigated <text>`
- `--completed <text>`
- `--next-steps <text>`
- `--tags <comma,separated>`
- `--files-read <comma,separated>`
- `--files-edited <comma,separated>`

### `search`

Optional:

- `--query <text>`
- `--project <name>`
- `--kind <observation|summary>`
- `--since <ISO-8601>`
- `--until <ISO-8601>`
- `--limit <number>`

### `timeline`

Use either:

- `--id <number>`
- or `--query <text>` (best search match becomes anchor)

Optional:

- `--project <name>`
- `--before <n>`
- `--after <n>`

### `get`

```bash
node dist/cli.js get --ids 1,2,3
```

### `context`

```bash
node dist/cli.js context --query "oauth" --full-count 3
```

## MCP Tools Reference

- `mem_add_observation`
- `mem_add_summary`
- `mem_search`
- `mem_timeline`
- `mem_get_entries`
- `mem_context_pack`
- `mem_list_projects`

### Tool inputs

`mem_add_observation`

- required: `title`, `content`
- optional: `project`, `sessionId`, `observationType`, `tags[]`, `files[]`

`mem_add_summary`

- required: `learned`
- optional: `project`, `sessionId`, `request`, `investigated`, `completed`, `nextSteps`, `tags[]`, `filesRead[]`, `filesEdited[]`

`mem_search`

- optional: `query`, `project`, `kind`, `since`, `until`, `limit`

`mem_timeline`

- optional: `id`, `query`, `project`, `before`, `after`

`mem_get_entries`

- required: `ids[]`

`mem_context_pack`

- optional: `query`, `project`, `limit`, `fullCount`

`mem_list_projects`

- no input

## Storage

DB backend: SQLite via `better-sqlite3`.

Default DB file:

```text
~/.codex-mem/codex-mem.db
```

Override path:

```bash
export CODEX_MEM_DB_FILE=/absolute/path/codex-mem.db
```

Backward compatibility alias also works:

```bash
export CODEX_MEM_DATA_FILE=/absolute/path/codex-mem.db
```

### Data model

Single table `entries` with `kind` discriminator:

- shared columns: id, project, session_id, created_at, tags
- observation columns: observation_type, title, content, files
- summary columns: request, investigated, learned, completed, next_steps, files_read, files_edited

## VS Code Extension

Local extension package: `vscode-extension/`.

### Fast local install (recommended)

From repo root:

```bash
cd <repo-root>
npm run install:vscode
```

Then restart VS Code and run:

- `Codex Mem: Status Dashboard` (visual dashboard webview with refresh/actions)
- `Codex Mem: Open Settings`
- `Codex Mem: Setup (Enable + Start Worker)`

### Option A: Development Host

Build:

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Run extension dev host:

1. Open `vscode-extension` in VS Code
2. Press `F5`
3. In the Extension Development Host window use commands:
   - `Codex Mem: Setup (Enable + Start Worker)`
   - `Codex Mem: Enable MCP`
   - `Codex Mem: Start Worker`
   - `Codex Mem: Stop Worker`
   - `Codex Mem: Worker Status`
   - `Codex Mem: Sync Codex Tasks`
   - `Codex Mem: Status Dashboard`
   - `Codex Mem: Open Settings`
   - `Codex Mem: Initialize Store`
   - `Codex Mem: Add Observation`
   - `Codex Mem: Add Summary`
   - `Codex Mem: Search Memory`
   - `Codex Mem: Generate Context Pack`
   - `Codex Mem: Open Memory File`

### Option B: Install As `.vsix`

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
npx @vscode/vsce package
code --install-extension codex-mem-vscode-0.1.1.vsix
```

After installing, run command palette action:

- `Codex Mem: Setup (Enable + Start Worker)`
- `Codex Mem: Status Dashboard`

Search tip:

- use `Ctrl+Shift+P` and type `Codex Mem` (with a space, not `codex-mem`)

Dashboard includes:

- worker health/status
- MCP config status
- KPI cards (entries, observations, summaries, projects)
- recent memory task executions
- Codex task ingestion metrics (detected/imported/skipped/errors)
- action buttons (`Refresh`, `Setup`, `Sync Codex Tasks`, `Start Worker`, `Stop Worker`)

Extension settings:

- `codexMem.cliPath`
- `codexMem.defaultProject`
- `codexMem.autoSyncCodexTasks`
- `codexMem.autoSyncLookbackDays`
- `codexMem.autoSyncMaxImport`
- `codexMem.codexSessionsPath`

CLI auto-detection checks these paths in order (before falling back to `codex-mem` on PATH):

- `<workspace>/dist/cli.js`
- `<workspace>/../dist/cli.js`
- `<workspace>/codex-mem/dist/cli.js`
- `<workspace>/../codex-mem/dist/cli.js`
- `<workspace>/../../codex-mem/dist/cli.js`

## Troubleshooting

### `codex: command not found`

Install Codex CLI:

```bash
npm install -g @openai/codex
```

or run with `npx @openai/codex`.

### Worker won’t start

Check:

```bash
node dist/cli.js worker status
cat ~/.codex-mem/logs/worker-$(date +%F).log
```

### Port conflict

Use a different port:

```bash
node dist/cli.js worker start --port 37888
node dist/cli.js mcp --port 37888
```

### VS Code extension can’t locate CLI

Set `codexMem.cliPath` to:

- `<repo-root>/dist/cli.js` (script path), or
- `codex-mem` (if linked/global)

### `Codex Mem` commands do not appear in Command Palette

Run a clean reinstall:

```bash
cd <repo-root>
npm run reinstall:vscode
```

Then in VS Code:

1. run `Developer: Reload Window`
2. open `Ctrl+Shift+P`
3. search `Codex Mem`

If you use multiple VS Code profiles, force a profile-specific install:

```bash
cd <repo-root>
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

### VS Code extension commands run, but Codex still has no memory tools

Check MCP registration and restart Codex:

```bash
codex mcp get codex-mem
codex mcp list
```

If needed, rerun:

```bash
node dist/cli.js setup
```

### Dashboard shows zero tasks even when Codex tasks run

What this means:

- Codex tasks completed, but no `mem_add_*` writes were made yet.

How this is handled now:

- The VS Code extension can auto-import recent Codex `task_complete` session events into codex-mem observations.
- You can trigger this immediately with `Codex Mem: Sync Codex Tasks`.
- Dashboard runtime panel shows ingestion counters so you can verify import activity.

### Node version errors

`codex-mem` requires Node `>=20`.

## Development

Root scripts:

```bash
npm run build
npm test
npm run dev
npm run start
```

Manual worker + MCP sequence:

```bash
node dist/cli.js worker start
node dist/cli.js mcp
```

## License

MIT. See [LICENSE](./LICENSE).
