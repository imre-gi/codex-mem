# codex-mem VS Code Extension

This extension adds Codex Mem commands to VS Code and runs the `codex-mem` CLI behind the scenes.

## Install

In commands below, `<repo-root>` means the directory where you cloned `codex-mem`.

### One-command install (from repo root, recommended)

```bash
cd <repo-root>
npm run install:vscode
```

For a clean reinstall from scratch:

```bash
cd <repo-root>
npm run reinstall:vscode
```

Profile override (optional):

```bash
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

### Development Host

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Open this folder in VS Code and press `F5`.

### VSIX (normal installation)

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
npm run package
code --install-extension codex-mem-vscode-0.1.1.vsix
```

## Commands

- `Codex Mem: Setup (Enable + Start Worker)`
- `Codex Mem: Enable MCP`
- `Codex Mem: Start Worker`
- `Codex Mem: Stop Worker`
- `Codex Mem: Worker Status`
- `Codex Mem: Sync LLM Tasks (Codex/Claude/Qwen/Gwen)`
- `Codex Mem: Status Dashboard`
- `Codex Mem: Project Explorer + Visualizer`
- `Codex Mem: Open Settings`
- `Codex Mem: Initialize Store`
- `Codex Mem: Add Observation`
- `Codex Mem: Add Summary`
- `Codex Mem: Search Memory`
- `Codex Mem: Generate Context Pack`
- `Codex Mem: Open Memory File`

## Settings

- `codexMem.cliPath`: optional explicit path to `codex-mem` binary or `dist/cli.js`.
- `codexMem.defaultProject`: optional default project name.
- `codexMem.autoSyncCodexTasks`: auto-sync task execution events when dashboard refreshes.
- `codexMem.enabledProviders`: provider list for sync (`codex`, `claude`, `qwen`, `gwen`, or `all`).
- `codexMem.autoSyncLookbackDays`: how many recent days of provider sessions are scanned.
- `codexMem.autoSyncMaxImport`: max new tasks imported per sync run.
- `codexMem.autoSyncMaxFiles`: max recent session files scanned per provider.
- `codexMem.codexSessionsPath`: optional override for Codex sessions directory (default `~/.codex/sessions`).
- `codexMem.claudeSessionsPath`: optional override for Claude sessions directory (default `~/.claude/projects`).
- `codexMem.qwenSessionsPath`: optional override for Qwen sessions directory (default `~/.qwen/sessions`).
- `codexMem.gwenSessionsPath`: optional override for Gwen sessions directory (default `~/.gwen/sessions`).
- `codexMem.executionReportLimit`: max entries loaded for explorer/visualizer.

## CLI Discovery

The extension resolves CLI in this order:

1. `codexMem.cliPath`
2. `<workspace>/dist/cli.js`
3. `<workspace>/../dist/cli.js`
4. `<workspace>/codex-mem/dist/cli.js`
5. `<workspace>/../codex-mem/dist/cli.js`
6. `<workspace>/../../codex-mem/dist/cli.js`
7. `codex-mem` from PATH

## First Run Checklist

1. Run `Codex Mem: Setup (Enable + Start Worker)`
2. Run `Codex Mem: Status Dashboard` (visual webview)
3. Run `Codex Mem: Open Settings` (optional, to set `codexMem.cliPath`)
4. Confirm `Codex Mem: Worker Status` returns `running: true`
5. In terminal, verify MCP registration:

```bash
codex mcp get codex-mem
```

If CLI lookup fails, set `codexMem.cliPath` to:

- `<repo-root>/dist/cli.js`, or
- a globally available `codex-mem` binary.

If commands are missing in `Ctrl+Shift+P`, run:

1. `Developer: Reload Window`
2. search for `Codex Mem` (with space)

If you use multiple VS Code profiles, reinstall with explicit profile:

```bash
CODEX_MEM_VSCODE_PROFILE="<profile-name>" npm run reinstall:vscode
```

Status Dashboard provides:

- worker runtime state
- MCP registration/config state
- KPI totals (entries/projects/providers/agents)
- recent memory task execution list
- provider sync matrix (detected/imported/skipped/failed)
- execution visualizer (provider, model, agent, status distributions)
- project explorer table with per-project task outcomes
- task explorer filters (project/provider/agent/model/status)
- action buttons for refresh/setup/sync/start/stop worker

## About "Tasks Executed"

The dashboard `Tasks Executed` KPI is backed by stored codex-mem entries.

- If your agent does not call `mem_add_observation`/`mem_add_summary`, the KPI will stay `0`.
- To make this work out-of-the-box, the extension syncs task-execution events from enabled providers into codex-mem observations.
- You can trigger a manual import any time with `Codex Mem: Sync LLM Tasks (Codex/Claude/Qwen/Gwen)`.

## Development

```bash
cd <repo-root>/vscode-extension
npm install
npm run build
```

Press `F5` in VS Code to start an Extension Development Host.
