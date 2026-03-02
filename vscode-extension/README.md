# codex-mem VS Code Extension

This extension adds Codex Mem commands to VS Code and runs the `codex-mem` CLI behind the scenes.

## Commands

- `Codex Mem: Initialize Store`
- `Codex Mem: Add Observation`
- `Codex Mem: Add Summary`
- `Codex Mem: Search Memory`
- `Codex Mem: Generate Context Pack`
- `Codex Mem: Open Memory File`

## Settings

- `codexMem.cliPath`: optional explicit path to `codex-mem` binary or `dist/cli.js`.
- `codexMem.defaultProject`: optional default project name.

## Development

```bash
cd /home/imre/Development/codex-mem/vscode-extension
npm install
npm run build
```

Press `F5` in VS Code to start an Extension Development Host.
