# codex-mem

Persistent project memory for OpenAI Codex, inspired by the practical workflow of `claude-mem`.

`codex-mem` provides:

- an MCP server (`mcp` mode) that Codex can call as tools
- a local CLI for direct usage and debugging
- a local JSON-backed memory store
- a VS Code extension (`vscode-extension/`) for IDE-native workflows

## Table of Contents

- [What It Solves](#what-it-solves)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Requirements](#requirements)
- [Install and Build](#install-and-build)
- [Codex MCP Integration](#codex-mcp-integration)
- [CLI Reference](#cli-reference)
- [MCP Tools Reference](#mcp-tools-reference)
- [Data Storage and Model](#data-storage-and-model)
- [Search, Timeline, and Context Behavior](#search-timeline-and-context-behavior)
- [VS Code Extension](#vs-code-extension)
- [Recommended Workflows](#recommended-workflows)
- [Troubleshooting](#troubleshooting)
- [Security and Privacy](#security-and-privacy)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## What It Solves

LLM coding sessions often lose important context between runs. `codex-mem` stores important working memory in a structured local format so later sessions can retrieve it quickly.

The memory model has two record types:

- `observation`: a concrete event, decision, gotcha, bugfix, or change
- `summary`: end-of-task compressed context (learned, completed, next steps)

## Architecture

`codex-mem` has three runtime surfaces:

1. CLI (`src/cli.ts`)
- Runs commands directly (`add-observation`, `search`, `context`, etc.)
- Runs MCP server mode via `mcp` command

2. MCP server (`src/mcp-server.ts`)
- Exposes tool endpoints for Codex (`mem_search`, `mem_timeline`, etc.)
- Uses stdio transport for `codex mcp add ... -- <command>` usage

3. Store (`src/store.ts`)
- JSON persistence with atomic write pattern (`.tmp` + rename)
- Search, timeline windowing, and project listing

The VS Code extension (`vscode-extension/`) is a separate package that shells out to the CLI.

## Repository Layout

```text
codex-mem/
  src/
    cli.ts            # local CLI + mcp entry command
    mcp-server.ts     # MCP tool server
    store.ts          # JSON-backed memory store
    context-pack.ts   # compact prompt context formatter
    types.ts          # shared types
    index.ts          # exports
  tests/
    store.test.ts     # unit tests
  vscode-extension/
    src/extension.ts  # VS Code commands
    package.json      # extension manifest
```

## Requirements

- Node.js `>=20`
- npm
- Optional: OpenAI Codex CLI (`@openai/codex`) if you want MCP integration from Codex CLI
- Optional: VS Code if you want extension workflows

## Install and Build

From source:

```bash
cd /home/imre/Development/codex-mem
npm install
npm run build
```

Run tests:

```bash
npm test
```

Dev MCP server without build output:

```bash
npm run dev
```

## Codex MCP Integration

After build, register the MCP server with Codex:

```bash
codex mcp add codex-mem -- node /home/imre/Development/codex-mem/dist/cli.js mcp
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

Or use `npx` (no global install):

```bash
npx @openai/codex mcp add codex-mem -- node /home/imre/Development/codex-mem/dist/cli.js mcp
```

## CLI Reference

CLI entry:

- built: `node dist/cli.js ...`
- dev: `tsx src/cli.ts ...`
- optional linked binary: `npm link` then `codex-mem ...`

### Global Option

- `--data-file <path>`: override memory file path for any command

Default path if omitted:

```text
~/.codex-mem/memory.json
```

### Commands

#### `mcp`

Start MCP stdio server.

```bash
node dist/cli.js mcp
```

#### `init`

Ensure store exists and print data file path.

```bash
node dist/cli.js init
```

#### `add-observation`

Required:

- `--title <text>`
- `--content <text>`

Optional:

- `--project <name>`
- `--session-id <id>`
- `--type <bugfix|feature|refactor|discovery|decision|change|note>`
- `--tags <comma,separated>`
- `--files <comma,separated>`

Example:

```bash
node dist/cli.js add-observation \
  --title "Fix OAuth callback state check" \
  --content "Normalized callback params and added nonce guard" \
  --type bugfix \
  --tags auth,oauth \
  --files src/auth/callback.ts,tests/auth.test.ts
```

#### `add-summary`

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

Example:

```bash
node dist/cli.js add-summary \
  --request "stabilize oauth callback" \
  --learned "URL param normalization prevented state mismatch edge cases" \
  --completed "fixed callback parser and added tests" \
  --next-steps "monitor auth error logs for 48h" \
  --files-edited src/auth/callback.ts,tests/auth.test.ts
```

#### `search`

Optional:

- `--query <text>`
- `--project <name>`
- `--kind <observation|summary>`
- `--since <ISO-8601>`
- `--until <ISO-8601>`
- `--limit <number>`

Example:

```bash
node dist/cli.js search --query oauth --kind observation --limit 20
```

#### `timeline`

Anchor by either:

- `--id <number>`
- or `--query <text>` (best first search hit becomes anchor)

Optional:

- `--project <name>`
- `--before <n>`
- `--after <n>`

Example:

```bash
node dist/cli.js timeline --query oauth --before 3 --after 3
```

#### `get`

Required:

- `--ids <comma,separated numeric ids>`

Example:

```bash
node dist/cli.js get --ids 12,14,22
```

#### `context`

Build `<codex-mem-context>` markdown block.

Optional:

- `--query <text>`
- `--project <name>`
- `--limit <number>`
- `--full-count <number>`

Example:

```bash
node dist/cli.js context --query oauth --full-count 3
```

#### `list-projects`

List all known project names.

```bash
node dist/cli.js list-projects
```

#### `help`

```bash
node dist/cli.js help
```

## MCP Tools Reference

Tools exposed by `src/mcp-server.ts`:

### `mem_add_observation`

Required fields:

- `title: string`
- `content: string`

Optional fields:

- `project: string`
- `sessionId: string`
- `observationType: "bugfix" | "feature" | "refactor" | "discovery" | "decision" | "change" | "note"`
- `tags: string[]`
- `files: string[]`

### `mem_add_summary`

Required fields:

- `learned: string`

Optional fields:

- `project: string`
- `sessionId: string`
- `request: string`
- `investigated: string`
- `completed: string`
- `nextSteps: string`
- `tags: string[]`
- `filesRead: string[]`
- `filesEdited: string[]`

### `mem_search`

Optional fields:

- `query: string`
- `project: string`
- `kind: "observation" | "summary"`
- `since: string` (ISO-8601)
- `until: string` (ISO-8601)
- `limit: number`

Returns compact index rows (`id`, `kind`, `title`, `excerpt`, `createdAt`, `score`).

### `mem_timeline`

Optional fields:

- `id: number`
- `query: string`
- `project: string`
- `before: number`
- `after: number`

Returns chronological neighbors around the anchor entry.

### `mem_get_entries`

Required fields:

- `ids: number[]`

Returns full entry objects.

### `mem_context_pack`

Optional fields:

- `query: string`
- `project: string`
- `limit: number`
- `fullCount: number`

Returns markdown context block wrapped in `<codex-mem-context>...</codex-mem-context>`.

### `mem_list_projects`

No args. Returns all stored projects.

## Data Storage and Model

Default file path:

```text
~/.codex-mem/memory.json
```

Override with environment variable:

```bash
export CODEX_MEM_DATA_FILE=/absolute/path/memory.json
```

### File Shape

```json
{
  "version": 1,
  "lastId": 2,
  "entries": [
    {
      "id": 1,
      "kind": "observation",
      "project": "codex-mem",
      "sessionId": "optional-session",
      "createdAt": "2026-03-02T08:00:00.000Z",
      "tags": ["auth"],
      "observationType": "bugfix",
      "title": "Fix callback guard",
      "content": "Added null check before decoding state",
      "files": ["src/auth/callback.ts"]
    },
    {
      "id": 2,
      "kind": "summary",
      "project": "codex-mem",
      "createdAt": "2026-03-02T08:10:00.000Z",
      "tags": [],
      "request": "stabilize callback",
      "investigated": "state mismatch reports",
      "learned": "URL decoding was inconsistent",
      "completed": "normalized parser + tests",
      "nextSteps": "watch logs",
      "filesRead": ["src/auth/callback.ts"],
      "filesEdited": ["src/auth/callback.ts", "tests/auth.test.ts"]
    }
  ]
}
```

### Persistence Details

- IDs are monotonic (`lastId + 1`)
- Writes use temp-file + rename for atomic replacement
- Lists are normalized (trimmed, deduplicated)
- Project defaults to current directory name if omitted
- If JSON parsing fails, store reads as empty in-memory data for that run

## Search, Timeline, and Context Behavior

### Search Ranking

For each query token:

- `+10` if token appears in title
- `+4` if token appears in searchable body text
- `+6` if token equals a tag (exact lowercase match)

Sort order:

1. higher score
2. newer timestamp (`createdAt` desc)

Limits:

- default limit: `10`
- max limit: `100`

### Timeline Behavior

- If `id` is provided, it is the anchor
- Else it resolves anchor from top `search` result for `query`
- Default window: `before=5`, `after=5`
- Max window each side: `50`

### Context Pack Behavior

From `src/context-pack.ts`:

- `limit` default `12`, clamped to `1..30`
- `fullCount` default `3`, clamped to `0..10`
- Produces:
  - `# Memory Index` with compact rows
  - `# Expanded Entries` for top `fullCount` IDs

## VS Code Extension

A VS Code extension is included in `vscode-extension/`.

### What It Adds

Command Palette commands:

- `Codex Mem: Initialize Store`
- `Codex Mem: Add Observation`
- `Codex Mem: Add Summary`
- `Codex Mem: Search Memory`
- `Codex Mem: Generate Context Pack`
- `Codex Mem: Open Memory File`

### Extension Settings

- `codexMem.cliPath`
  - optional explicit path to CLI binary or `dist/cli.js`
- `codexMem.defaultProject`
  - optional default project name used by prompts

### CLI Resolution Order in Extension

1. `codexMem.cliPath` setting
2. workspace-local `dist/cli.js` via `node`
3. `codex-mem` from PATH

### Run in Development Host

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npm install
npm run build
```

Then in VS Code:

1. Open `vscode-extension` folder
2. Press `F5`
3. In Extension Development Host window, run `Codex Mem:*` commands

### Optional VSIX Packaging

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npx @vscode/vsce package
```

## Recommended Workflows

### Workflow A: Task-Based Memory Capture

1. Start task and fetch context:

```bash
node dist/cli.js context --query "task topic" --full-count 3
```

2. Record decisions and discoveries during work:

```bash
node dist/cli.js add-observation --title "Decision" --content "Chose X because Y" --type decision
```

3. Close task with summary:

```bash
node dist/cli.js add-summary --learned "..." --completed "..." --next-steps "..."
```

### Workflow B: Retrieval-First Investigation

1. Find relevant IDs:

```bash
node dist/cli.js search --query "oauth" --limit 20
```

2. Fetch full entries:

```bash
node dist/cli.js get --ids 3,8,11
```

3. Get nearby chronology:

```bash
node dist/cli.js timeline --id 8 --before 4 --after 4
```

### Workflow C: Multi-Repo or Multi-Project

When storing across repositories, always set explicit project names:

```bash
node dist/cli.js add-observation --project fred-client --title "..." --content "..."
node dist/cli.js search --project fred-client --query "..."
```

## Troubleshooting

### `codex: command not found`

Install Codex CLI:

```bash
npm install -g @openai/codex
```

Or use `npx @openai/codex ...`.

### `codex-mem: command not found`

Use explicit node command:

```bash
node /home/imre/Development/codex-mem/dist/cli.js help
```

Optional local global link:

```bash
cd /home/imre/Development/codex-mem
npm link
```

### VS Code extension cannot find CLI

Set `codexMem.cliPath` to one of:

- `/home/imre/Development/codex-mem/dist/cli.js`
- or absolute path to `codex-mem` binary

Then retry command from Command Palette.

### Node version errors

Check version:

```bash
node -v
```

Must be `>=20`.

### Store file permission errors

Ensure writable location for:

- `~/.codex-mem/`
- or your custom `CODEX_MEM_DATA_FILE` path

### Empty results after migration or edits

Check data file path currently used:

```bash
node dist/cli.js init
```

If path is unexpected, confirm `--data-file` and `CODEX_MEM_DATA_FILE` usage.

### Corrupted JSON store

If `memory.json` is malformed, runtime reads as empty data. Restore from backup or fix JSON formatting manually.

## Security and Privacy

- Data is stored locally in plaintext JSON by default
- No remote syncing or encryption is built in
- Do not store secrets, tokens, or PII unless your local environment policy allows it
- Prefer redaction in `content`, `request`, and `learned` fields

## Limitations

Current constraints in v0.1.0:

- No database backend or full-text index engine (JSON only)
- No cross-process file locking
- No built-in encryption at rest
- Search is token/scoring based, not embeddings-based
- Corrupted JSON fallback currently treats data as empty for that run

## Development

Root scripts:

```bash
npm run build
npm test
npm run dev
npm run start
```

Extension scripts:

```bash
cd vscode-extension
npm install
npm run build
```

Core code entry points:

- `src/cli.ts`
- `src/mcp-server.ts`
- `src/store.ts`
- `src/context-pack.ts`

## License

MIT. See [LICENSE](./LICENSE).
