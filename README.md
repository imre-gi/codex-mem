# codex-mem

`codex-mem` is a Codex-compatible memory plugin inspired by `claude-mem`.

It runs as an MCP server and gives Codex persistent memory tools:

- save observations
- save summaries
- search memory
- get timeline context
- fetch full entries by ID
- build a compact context pack for prompt priming

## Why this shape

`claude-mem` uses Claude lifecycle hooks + worker services.

OpenAI Codex currently exposes MCP integration (`codex mcp add ...`), so this implementation uses an MCP server as the integration surface.

## Quick start

```bash
cd /home/imre/Development/codex-mem
npm install
npm run build
```

Add it to Codex:

```bash
codex mcp add codex-mem -- node /home/imre/Development/codex-mem/dist/cli.js mcp
```

If you get `codex: command not found`:

```bash
npm install -g @openai/codex
```

or run with `npx` (no global install):

```bash
npx @openai/codex mcp add codex-mem -- node /home/imre/Development/codex-mem/dist/cli.js mcp
```

Verify:

```bash
codex mcp list
codex mcp get codex-mem
```

## MCP tools

- `mem_add_observation`
- `mem_add_summary`
- `mem_search`
- `mem_timeline`
- `mem_get_entries`
- `mem_context_pack`
- `mem_list_projects`

## Data location

Default store file:

```text
~/.codex-mem/memory.json
```

Override with env var:

```bash
export CODEX_MEM_DATA_FILE=/path/to/memory.json
```

## Optional CLI usage

You can use `codex-mem` directly outside MCP:

```bash
node dist/cli.js init
node dist/cli.js add-observation --title "Fix OAuth callback" --content "Normalized redirect URI parsing" --type bugfix --tags auth,oauth
node dist/cli.js search --query oauth
node dist/cli.js context --query oauth --full-count 2
```

## Development

```bash
npm run build
npm test
npm run dev
```

## VS Code Extension

A local VS Code extension is included under `vscode-extension/`.

Build it:

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npm install
npm run build
```

Use it in VS Code:

1. Open `codex-mem` in VS Code.
2. Open the `vscode-extension` folder in a second VS Code window (or workspace).
3. Press `F5` to launch an Extension Development Host.
4. In the new window run commands from the Command Palette:
   - `Codex Mem: Initialize Store`
   - `Codex Mem: Add Observation`
   - `Codex Mem: Add Summary`
   - `Codex Mem: Search Memory`
   - `Codex Mem: Generate Context Pack`
   - `Codex Mem: Open Memory File`

If your CLI is not auto-detected, set `codexMem.cliPath` in VS Code settings:

- binary: `codex-mem`
- local script: `/home/imre/Development/codex-mem/dist/cli.js`

## Recommended Codex workflow

1. At the start of a task, call `mem_context_pack` with the task query.
2. During work, call `mem_add_observation` for decisions, gotchas, and bugfixes.
3. At completion, call `mem_add_summary` with learned/completed/next steps.
4. In later sessions, start with `mem_search` then `mem_get_entries` for relevant IDs.
