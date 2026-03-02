# codex-mem VS Code Extension

This extension adds Codex Mem commands to VS Code and runs the `codex-mem` CLI behind the scenes.

## Install

### One-command install (from repo root, recommended)

```bash
cd /home/imre/Development/codex-mem
npm run install:vscode
```

For a clean reinstall from scratch:

```bash
cd /home/imre/Development/codex-mem
npm run reinstall:vscode
```

### Development Host

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npm install
npm run build
```

Open this folder in VS Code and press `F5`.

### VSIX (normal installation)

```bash
cd /home/imre/Development/codex-mem/vscode-extension
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
- `Codex Mem: Status Dashboard`
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
2. Run `Codex Mem: Status Dashboard`
3. Run `Codex Mem: Open Settings` (optional, to set `codexMem.cliPath`)
4. Confirm `Codex Mem: Worker Status` returns `running: true`
5. In terminal, verify MCP registration:

```bash
codex mcp get codex-mem
```

If CLI lookup fails, set `codexMem.cliPath` to:

- `/home/imre/Development/codex-mem/dist/cli.js`, or
- a globally available `codex-mem` binary.

If commands are missing in `Ctrl+Shift+P`, run:

1. `Developer: Reload Window`
2. search for `Codex Mem` (with space)

## Development

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npm install
npm run build
```

Press `F5` in VS Code to start an Extension Development Host.
