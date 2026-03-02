# Retentia

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node >=20](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-111827)](https://modelcontextprotocol.io/)
[![VS Code Extension](https://img.shields.io/badge/VS_Code-extension-007ACC?logo=visualstudiocode&logoColor=white)](./vscode-extension)

Retentia is an open-source MCP memory and task execution intelligence layer for OpenAI Codex, Claude Code, Qwen, and Gwen. It gives you persistent SQLite-backed memory, multi-agent task tracking, and a VS Code dashboard for project and execution visibility.

Compatibility note: the current runnable CLI surface in this repository is still `codex-mem` (or `node dist/cli.js`). The public project name is Retentia.

## Why Retentia

- Keep AI-assisted coding context persistent across sessions and projects.
- Track multi-agent pipeline execution by provider, model, agent, role, and status.
- Use MCP-native memory tools directly from Codex-compatible clients.
- Run fully local with a lightweight worker plus SQLite storage.
- Inspect execution health with a visual dashboard and project/task explorers in VS Code.

## Table of Contents

- [What Retentia Does](#what-retentia-does)
- [Use Cases](#use-cases)
- [Quick Start](#quick-start)
- [Feature Matrix](#feature-matrix)
- [Architecture](#architecture)
- [CLI Command Reference](#cli-command-reference)
- [MCP Tools Reference](#mcp-tools-reference)
- [VS Code Dashboard and Explorer Capabilities](#vs-code-dashboard-and-explorer-capabilities)
- [Configuration Reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [License](#license)

## What Retentia Does

Retentia combines four capabilities in one local stack:

- Persistent memory layer: observations and summaries in SQLite.
- MCP tool server: `mem_*` tools exposed for Codex workflows.
- Multi-LLM execution ingestion: import task execution from Codex, Claude Code, Qwen, and Gwen session logs.
- Execution analytics UI: provider/model/agent/status visualizer plus project and task explorers in VS Code.

## Use Cases

- Solo coding memory continuity: keep durable notes of fixes, decisions, and discoveries.
- Multi-agent observability: see which agent ran what task and final status.
- Cross-project retrieval: search, timeline, and context-pack across repositories.
- AI operations diagnostics: detect ingestion gaps, provider skew, and execution freshness.

## Quick Start

In commands below, `<repo-root>` means the directory where you cloned this repository.

### 1. One-command install (recommended)

```bash
cd <repo-root>
npm run install:vscode
```

This installs dependencies, builds the CLI and extension, installs the VS Code extension locally, and runs setup.

### 2. Verify runtime state

```bash
cd <repo-root>
codex mcp get codex-mem
node dist/cli.js worker status
node dist/cli.js kpis
```

### 3. First useful workflow

```bash
cd <repo-root>
node dist/cli.js sync-tasks --providers all --lookback-days 7 --max-import 50
node dist/cli.js execution-report --limit 200
```

Then in VS Code command palette (`Ctrl+Shift+P`), run:

- `Codex Mem: Status Dashboard`
- `Codex Mem: Project Explorer + Visualizer`

## Feature Matrix

| Capability | CLI | MCP | VS Code |
| --- | --- | --- | --- |
| Memory CRUD (observation/summary) | Yes | Yes | Yes |
| Search, timeline, context pack | Yes | Yes | Yes |
| Project listing | Yes | Yes | Yes |
| Multi-LLM task ingestion | Yes (`sync-tasks`) | No | Yes (dashboard sync / command) |
| Execution report analytics | Yes (`execution-report`) | No | Yes |
| Dashboard visualizer | No | No | Yes |
| Project explorer | No | No | Yes |
| Task explorer filters | No | No | Yes |

## Architecture

Retentia runtime has 3 core services plus the VS Code UI layer:

1. Worker service (`src/worker-service.ts`)
- Local HTTP service (default `127.0.0.1:37777`)
- Executes memory operations
- Reads/writes SQLite storage

2. MCP server (`src/mcp-server.ts`)
- Exposes `mem_*` tools
- Relays calls to the worker service

3. CLI (`src/cli.ts`)
- Setup/enabling, worker lifecycle, memory commands
- Task ingestion (`sync-tasks`)
- Analytics export (`execution-report`)

4. VS Code extension (`vscode-extension/src/extension.ts`)
- Commands and settings UI
- Dashboard with sync status, KPI cards, visualizer, and explorers

### Ingestion and reporting flow

```text
Provider session logs
  -> sync-tasks
  -> stored observations (with execution metadata)
  -> execution-report
  -> VS Code dashboard (KPIs, visualizer, project/task explorer)
```

## CLI Command Reference

All commands below are shown as runnable local commands:

```bash
node dist/cli.js <command>
```

If you have a global binary, equivalent forms are available via `codex-mem <command>`.

### Global options

- `--data-file <path>`: override SQLite DB path.
- `--host <host>`: override worker host.
- `--port <port>`: override worker port.
- `--name <mcp-name>`: override MCP server name for setup/enable.

### `setup`

Purpose:
- One-command onboarding: register MCP server and start worker.

Syntax:
- `node dist/cli.js setup [--name <mcp-name>] [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--name`, `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js setup
```

Output and behavior:
- Returns setup status, MCP enable result, and worker status.
- Idempotent for already configured setups.

### `enable`

Purpose:
- Register or refresh MCP server entry in Codex config.

Syntax:
- `node dist/cli.js enable [--name <mcp-name>] [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--name`, `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js enable
```

Output and behavior:
- Registers `codex-mem` MCP entry by default.
- Replaces conflicting same-name server entries.
- Falls back to `npx --yes @openai/codex` if local `codex` binary is unavailable.

### `mcp`

Purpose:
- Run MCP server over stdio for Codex to consume.

Syntax:
- `node dist/cli.js mcp [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js mcp
```

Output and behavior:
- Auto-starts worker if needed, then serves MCP tools.

### `worker start`

Purpose:
- Start background worker service.

Syntax:
- `node dist/cli.js worker start [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js worker start
```

Output and behavior:
- Starts daemonized worker and returns PID/status metadata.

### `worker stop`

Purpose:
- Stop background worker service.

Syntax:
- `node dist/cli.js worker stop [--host <host>] [--port <port>]`

Required args:
- None.

Optional args:
- `--host`, `--port`.

Example:

```bash
node dist/cli.js worker stop
```

Output and behavior:
- Sends shutdown request to running worker.

### `worker restart`

Purpose:
- Restart background worker service.

Syntax:
- `node dist/cli.js worker restart [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js worker restart
```

Output and behavior:
- Stops then starts worker and returns final status.

### `worker status`

Purpose:
- Inspect worker runtime health.

Syntax:
- `node dist/cli.js worker status [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js worker status
```

Output and behavior:
- Returns running state, PID, uptime, host/port, and base URL.

### `worker run`

Purpose:
- Run worker in foreground mode for debugging.

Syntax:
- `node dist/cli.js worker run [--host <host>] [--port <port>] [--data-file <path>]`

Required args:
- None.

Optional args:
- `--host`, `--port`, `--data-file`.

Example:

```bash
node dist/cli.js worker run
```

Output and behavior:
- Keeps process attached to current shell until interrupted.

### `init`

Purpose:
- Initialize storage and return readiness metadata.

Syntax:
- `node dist/cli.js init [--data-file <path>]`

Required args:
- None.

Optional args:
- `--data-file`.

Example:

```bash
node dist/cli.js init
```

Output and behavior:
- Returns DB path and readiness status.

### `kpis`

Purpose:
- Return high-level memory and runtime metrics.

Syntax:
- `node dist/cli.js kpis [--data-file <path>] [--host <host>] [--port <port>]`

Required args:
- None.

Optional args:
- `--data-file`, `--host`, `--port`.

Example:

```bash
node dist/cli.js kpis
```

Output and behavior:
- Includes entries, observations, summaries, project count, and oldest/latest timestamps.

### `add-observation`

Purpose:
- Store a concrete session observation (bugfix, discovery, decision, etc).

Syntax:
- `node dist/cli.js add-observation --title <text> --content <text> [options]`

Required args:
- `--title`
- `--content`

Optional args:
- `--project <name>`
- `--session-id <id>`
- `--external-key <key>`
- `--type <bugfix|feature|refactor|discovery|decision|change|note>`
- `--tags <comma,separated>`
- `--files <comma,separated>`

Example:

```bash
node dist/cli.js add-observation \
  --project Fred-Client \
  --title "Fix worker status timeout" \
  --content "Added retry and better error handling for stale pid files." \
  --type bugfix \
  --tags worker,reliability
```

Output and behavior:
- Returns the created observation entry payload.

### `add-summary`

Purpose:
- Store end-of-task summary context.

Syntax:
- `node dist/cli.js add-summary --learned <text> [options]`

Required args:
- `--learned`

Optional args:
- `--project <name>`
- `--session-id <id>`
- `--external-key <key>`
- `--request <text>`
- `--investigated <text>`
- `--completed <text>`
- `--next-steps <text>`
- `--tags <comma,separated>`
- `--files-read <comma,separated>`
- `--files-edited <comma,separated>`

Example:

```bash
node dist/cli.js add-summary \
  --project codex-mem \
  --request "Improve dashboard observability" \
  --learned "Execution report needed provider and agent rollups." \
  --completed "Added task explorer filters and sync metrics." \
  --next-steps "Add trend charts for weekly changes." \
  --tags dashboard,analytics
```

Output and behavior:
- Returns the created summary entry payload.

### `search`

Purpose:
- Query memory entries with optional filters.

Syntax:
- `node dist/cli.js search [--query <text>] [--project <name>] [--kind <observation|summary>] [--since <ISO-8601>] [--until <ISO-8601>] [--limit <n>]`

Required args:
- None.

Optional args:
- `--query`, `--project`, `--kind`, `--since`, `--until`, `--limit`.

Example:

```bash
node dist/cli.js search --query "oauth" --project Fred-Client --limit 20
```

Output and behavior:
- Returns lightweight indexed results (id, title, excerpt, score).

### `timeline`

Purpose:
- Fetch chronological context around an anchor memory entry.

Syntax:
- `node dist/cli.js timeline [--id <number> | --query <text>] [--project <name>] [--before <n>] [--after <n>]`

Required args:
- One of: `--id` or `--query`.

Optional args:
- `--project`, `--before`, `--after`.

Example:

```bash
node dist/cli.js timeline --query "report export" --before 4 --after 6
```

Output and behavior:
- Resolves anchor entry then returns ordered nearby entries.

### `get`

Purpose:
- Fetch full entries by explicit IDs.

Syntax:
- `node dist/cli.js get --ids <id1,id2,id3>`

Required args:
- `--ids`

Optional args:
- None.

Example:

```bash
node dist/cli.js get --ids 21,22,23
```

Output and behavior:
- Returns full stored entry payloads in requested ID order when possible.

### `context`

Purpose:
- Build compact prompt-ready context from memory.

Syntax:
- `node dist/cli.js context [--query <text>] [--project <name>] [--limit <n>] [--full-count <n>]`

Required args:
- None.

Optional args:
- `--query`, `--project`, `--limit`, `--full-count`.

Example:

```bash
node dist/cli.js context --query "task sync" --full-count 5
```

Output and behavior:
- Prints compact context block suitable for priming AI sessions.

### `list-projects`

Purpose:
- List project names known to memory store.

Syntax:
- `node dist/cli.js list-projects`

Required args:
- None.

Optional args:
- None.

Example:

```bash
node dist/cli.js list-projects
```

Output and behavior:
- Returns deduplicated project list.

### `list-entries`

Purpose:
- List full entries with pagination and filtering.

Syntax:
- `node dist/cli.js list-entries [--project <name>] [--kind <observation|summary>] [--since <ISO-8601>] [--until <ISO-8601>] [--limit <n>] [--offset <n>]`

Required args:
- None.

Optional args:
- `--project`, `--kind`, `--since`, `--until`, `--limit`, `--offset`.

Example:

```bash
node dist/cli.js list-entries --project Fred-Client --kind observation --limit 100 --offset 0
```

Output and behavior:
- Returns full entries sorted by newest first.

### `execution-report`

Purpose:
- Build analytics payload for visualizers and explorer views.

Syntax:
- `node dist/cli.js execution-report [--project <name>] [--kind <observation|summary>] [--since <ISO-8601>] [--until <ISO-8601>] [--limit <n>] [--offset <n>]`

Required args:
- None.

Optional args:
- Same filters as `list-entries`.

Example:

```bash
node dist/cli.js execution-report --limit 600
```

Output and behavior:
- Returns project summaries plus provider/agent/model/status counts and normalized task rows.

### `sync-tasks`

Purpose:
- Import provider task execution events into memory entries.

Syntax:
- `node dist/cli.js sync-tasks [--providers <codex,claude,qwen,gwen|all>] [--codex-path <path>] [--claude-path <path>] [--qwen-path <path>] [--gwen-path <path>] [--lookback-days <n>] [--max-files <n>] [--max-import <n>] [--project <fallback-name>]`

Required args:
- None.

Optional args:
- `--providers`, provider path overrides, `--lookback-days`, `--max-files`, `--max-import`, `--project`.

Example:

```bash
node dist/cli.js sync-tasks --providers codex,claude --lookback-days 7 --max-files 24 --max-import 100
```

Output and behavior:
- Returns detected/imported/skipped/failed totals and provider-level breakdown.
- Uses `externalKey` dedupe to avoid duplicate imports.

### `help`

Purpose:
- Print CLI help and usage summary.

Syntax:
- `node dist/cli.js help`
- `node dist/cli.js --help`
- `node dist/cli.js -h`

Required args:
- None.

Optional args:
- None.

Example:

```bash
node dist/cli.js --help
```

Output and behavior:
- Prints command list and global option descriptions.

## MCP Tools Reference

The MCP server exposes the following tools.

### `mem_add_observation`

Purpose:
- Persist concrete observations from active work.

Required input:
- `title`, `content`

Optional input:
- `project`, `sessionId`, `externalKey`, `observationType`, `tags[]`, `files[]`

Typical usage moment:
- After finishing a fix, discovery, or decision that should be reusable later.

### `mem_add_summary`

Purpose:
- Persist end-of-task learned/completed context.

Required input:
- `learned`

Optional input:
- `project`, `sessionId`, `externalKey`, `request`, `investigated`, `completed`, `nextSteps`, `tags[]`, `filesRead[]`, `filesEdited[]`

Typical usage moment:
- End of a coding task, handoff, or checkpoint.

### `mem_search`

Purpose:
- Retrieve indexed memory matches.

Required input:
- None.

Optional input:
- `query`, `project`, `kind`, `since`, `until`, `limit`

Typical usage moment:
- Before implementing related work to recover prior context quickly.

### `mem_timeline`

Purpose:
- Retrieve chronological context around an anchor memory item.

Required input:
- None (but should provide `id` or `query`).

Optional input:
- `id`, `query`, `project`, `before`, `after`

Typical usage moment:
- Reconstructing sequence of events for debugging or incident analysis.

### `mem_get_entries`

Purpose:
- Fetch full entry payloads by ID.

Required input:
- `ids[]`

Optional input:
- None.

Typical usage moment:
- Expanding lightweight search results into full details.

### `mem_context_pack`

Purpose:
- Build compact context block for prompt priming.

Required input:
- None.

Optional input:
- `query`, `project`, `limit`, `fullCount`

Typical usage moment:
- Starting a new AI session with compressed but high-signal historical context.

### `mem_list_projects`

Purpose:
- Enumerate known projects in memory.

Required input:
- None.

Optional input:
- None.

Typical usage moment:
- Discovering project namespaces before filtering searches or timeline requests.

## VS Code Dashboard and Explorer Capabilities

The extension dashboard provides:

- KPI cards: entries, observations, summaries, projects, providers, agents.
- Runtime and MCP status: worker state, uptime, endpoint, MCP command args, DB file.
- Provider sync matrix: detected/imported/skipped/failed by provider.
- Execution visualizer: distribution bars by provider, status, agent, model.
- Project explorer: project-level totals, done/failed counts, latest activity.
- Task explorer: interactive filters by project/provider/agent/model/status.

## Configuration Reference

### Environment variables

- `CODEX_MEM_DB_FILE`: primary DB file override.
- `CODEX_MEM_DATA_FILE`: backward compatible alias for DB file override.

Default database path:

```text
~/.codex-mem/codex-mem.db
```

Worker logs:

```text
~/.codex-mem/logs/worker-YYYY-MM-DD.log
```

Worker PID file:

```text
~/.codex-mem/worker.pid
```

### VS Code settings (`codexMem.*`)

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexMem.cliPath` | `""` | Explicit path to CLI binary or `dist/cli.js`. |
| `codexMem.defaultProject` | `""` | Default project when creating entries. |
| `codexMem.autoSyncCodexTasks` | `true` | Auto-sync task execution on dashboard refresh. |
| `codexMem.enabledProviders` | `["codex","claude","qwen","gwen"]` | Providers included in sync. |
| `codexMem.autoSyncLookbackDays` | `7` | Lookback window for provider session logs. |
| `codexMem.autoSyncMaxImport` | `25` | Max new tasks imported per sync run. |
| `codexMem.autoSyncMaxFiles` | `24` | Max recent session files scanned per provider. |
| `codexMem.codexSessionsPath` | `""` | Optional Codex sessions path override. |
| `codexMem.claudeSessionsPath` | `""` | Optional Claude sessions path override. |
| `codexMem.qwenSessionsPath` | `""` | Optional Qwen sessions path override. |
| `codexMem.gwenSessionsPath` | `""` | Optional Gwen sessions path override. |
| `codexMem.executionReportLimit` | `600` | Max entries loaded for visualizer/explorers. |

## Troubleshooting

### Command palette commands are missing

1. Run from repo root:

```bash
npm run reinstall:vscode
```

2. In VS Code, run `Developer: Reload Window`.
3. Open command palette and search `Codex Mem`.

For profile-specific install:

```bash
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

### Worker startup issues

Check status and log output:

```bash
node dist/cli.js worker status
cat ~/.codex-mem/logs/worker-$(date +%F).log
```

If needed, restart:

```bash
node dist/cli.js worker restart
```

### MCP registration not visible

Verify:

```bash
codex mcp list
codex mcp get codex-mem
```

Re-register:

```bash
node dist/cli.js setup
```

### Dashboard shows empty tasks

What it means:
- No memory writes were recorded yet, or sync has not imported task execution events.

Actions:

```bash
node dist/cli.js sync-tasks --providers all --lookback-days 7 --max-import 50
node dist/cli.js kpis
```

Then refresh dashboard in VS Code.

### CLI discovery path issues in VS Code

Set `codexMem.cliPath` to one of:

- `<repo-root>/dist/cli.js`
- `codex-mem` (if globally installed)

### Port conflicts

Use a different port:

```bash
node dist/cli.js worker start --port 37888
node dist/cli.js mcp --port 37888
```

## Contributing

PR flow expectations:

1. Open an issue describing the problem or proposal.
2. Keep changes focused and reviewable.
3. Include tests for behavior changes when applicable.
4. Update README/docs when command or behavior changes.
5. Run before opening PR:

```bash
npm run build
npm test
npm --prefix vscode-extension run build
```

Issue quality expectations:

- Include environment details (OS, Node version, provider).
- Include reproducible steps and expected vs actual behavior.
- Include relevant CLI output snippets when reporting bugs.

## Security

If you discover a security issue, do not post sensitive exploit details in a public issue.

Use GitHub Security Advisories for private disclosure if available for this repository, or contact the maintainer directly through repository contact channels.

## FAQ

### Is Retentia Codex-only?

No. Ingestion supports Codex, Claude Code, Qwen, and Gwen logs. MCP tooling remains Codex-compatible by default.

### Do I need VS Code to use Retentia?

No. CLI and MCP server are fully usable without VS Code.

### Can I run everything locally?

Yes. Worker, storage, and ingestion run locally on your machine.

### Why are command examples using `codex-mem` while project name is Retentia?

Retentia is the public product name. Current runnable command identifiers remain `codex-mem` in this repository.

## Roadmap

- Add trend views for execution over time (daily/weekly).
- Expand provider parsers for richer model/agent metadata extraction.
- Add import dry-run mode and diff preview.
- Improve setup diagnostics for multi-profile VS Code environments.
- Publish packaged extension workflow for public marketplace distribution.

## License

MIT. See [LICENSE](./LICENSE).
