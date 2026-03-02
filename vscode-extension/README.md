# Retentia VS Code Extension

The Retentia VS Code extension adds persistent memory commands, multi-LLM task sync, and execution observability to VS Code using the existing `codexMem.*` command and settings surface.

Compatibility note: command IDs and CLI integration remain unchanged (`codexMem.*` and `codex-mem` / `node dist/cli.js`) so examples stay runnable today.

## Install

In commands below, `<repo-root>` means the directory where you cloned this repository.

### One-command install (from repo root, recommended)

```bash
cd <repo-root>
npm run install:vscode
```

### Clean reinstall

```bash
cd <repo-root>
npm run reinstall:vscode
```

Profile-specific reinstall:

```bash
cd <repo-root>
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

### Development host

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Open `vscode-extension` in VS Code and press `F5`.

### VSIX install

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
npm run package
code --install-extension codex-mem-vscode-0.1.1.vsix
```

## Commands

All commands below are contributed by the extension and appear in the command palette.

| Command title | Command ID | What it does |
| --- | --- | --- |
| `Codex Mem: Setup (Enable + Start Worker)` | `codexMem.setup` | Runs setup to enable MCP and start worker. |
| `Codex Mem: Enable MCP` | `codexMem.enableMcp` | Registers MCP server for Codex integration. |
| `Codex Mem: Initialize Store` | `codexMem.initStore` | Ensures local storage is ready. |
| `Codex Mem: Start Worker` | `codexMem.startWorker` | Starts local worker process. |
| `Codex Mem: Stop Worker` | `codexMem.stopWorker` | Stops local worker process. |
| `Codex Mem: Worker Status` | `codexMem.workerStatus` | Shows worker runtime status payload. |
| `Codex Mem: Sync LLM Tasks (Codex/Claude/Qwen/Gwen)` | `codexMem.syncCodexTasks` | Imports execution events from enabled providers. |
| `Codex Mem: Project Explorer + Visualizer` | `codexMem.projectExplorer` | Opens dashboard focused on execution exploration. |
| `Codex Mem: Status Dashboard` | `codexMem.statusDashboard` | Opens full dashboard with runtime and KPIs. |
| `Codex Mem: Open Settings` | `codexMem.openSettings` | Opens extension settings in VS Code UI. |
| `Codex Mem: Add Observation` | `codexMem.addObservation` | Interactive prompt to create an observation entry. |
| `Codex Mem: Add Summary` | `codexMem.addSummary` | Interactive prompt to create a summary entry. |
| `Codex Mem: Search Memory` | `codexMem.search` | Runs search and opens JSON results. |
| `Codex Mem: Generate Context Pack` | `codexMem.contextPack` | Creates compact memory context for prompt priming. |
| `Codex Mem: Open Memory File` | `codexMem.openMemoryFile` | Opens the active SQLite data file location. |

## Settings

| Setting | Default | Intent |
| --- | --- | --- |
| `codexMem.cliPath` | `""` | Explicit path to CLI binary or `dist/cli.js`. |
| `codexMem.defaultProject` | `""` | Default project when creating entries from VS Code. |
| `codexMem.autoSyncCodexTasks` | `true` | Auto-sync execution events during dashboard refresh. |
| `codexMem.enabledProviders` | `["codex","claude","qwen","gwen"]` | Providers included in task ingestion. |
| `codexMem.autoSyncLookbackDays` | `7` | Session log lookback window in days. |
| `codexMem.autoSyncMaxImport` | `25` | Max task imports per sync run. |
| `codexMem.autoSyncMaxFiles` | `24` | Max session files scanned per provider. |
| `codexMem.codexSessionsPath` | `""` | Optional Codex sessions path override. |
| `codexMem.claudeSessionsPath` | `""` | Optional Claude Code sessions path override. |
| `codexMem.qwenSessionsPath` | `""` | Optional Qwen sessions path override. |
| `codexMem.gwenSessionsPath` | `""` | Optional Gwen sessions path override. |
| `codexMem.executionReportLimit` | `600` | Max entries loaded for visualizer/explorer views. |

## Dashboard Walkthrough

The Status Dashboard combines operations and analytics in one view:

- Top actions: `Refresh`, `Setup`, `Sync LLM Tasks`, `Start Worker`, `Stop Worker`.
- KPI cards: worker state, MCP state, task totals, project totals, provider and agent counts.
- Runtime panel: PID, uptime, endpoint, MCP config command/args, DB file path.
- Provider Sync table: detected/imported/skipped/failed counts by provider.
- Execution Visualizer: bar charts by provider, status, agent, and model.
- Project Explorer: per-project totals with done/failed and latest activity.
- Task Explorer: filterable task list by project/provider/agent/model/status.

## About "Tasks Executed"

`Tasks Executed` reflects entries stored in Retentia memory storage.

- If your workflow does not call `mem_add_observation` or `mem_add_summary`, totals can remain low.
- To improve out-of-the-box visibility, the extension syncs execution events from enabled providers into observations.
- Trigger manual ingestion any time with `Codex Mem: Sync LLM Tasks (Codex/Claude/Qwen/Gwen)`.

## CLI Discovery

The extension resolves CLI in this order:

1. `codexMem.cliPath`
2. `<workspace>/dist/cli.js`
3. `<workspace>/../dist/cli.js`
4. `<workspace>/codex-mem/dist/cli.js`
5. `<workspace>/../codex-mem/dist/cli.js`
6. `<workspace>/../../codex-mem/dist/cli.js`
7. `codex-mem` from PATH

## Troubleshooting

### Command palette does not show commands

1. Reinstall extension:

```bash
cd <repo-root>
npm run reinstall:vscode
```

2. Run `Developer: Reload Window` in VS Code.
3. Open `Ctrl+Shift+P` and search `Codex Mem`.

### CLI path resolution issues

Set `codexMem.cliPath` explicitly to:

- `<repo-root>/dist/cli.js`, or
- `codex-mem` (global binary).

Then run `Codex Mem: Worker Status` to confirm connectivity.

### MCP visible in extension but not active in Codex

Verify in terminal:

```bash
codex mcp list
codex mcp get codex-mem
```

If missing, run:

```bash
cd <repo-root>
node dist/cli.js setup
```

## Development

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Start Extension Development Host with `F5` in VS Code.
