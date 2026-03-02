#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_STORAGE_FILE="${CODEX_MEM_VSCODE_STORAGE_FILE:-$HOME/.config/Code/User/globalStorage/storage.json}"

list_profiles() {
  if [[ -n "${CODEX_MEM_VSCODE_PROFILE:-}" ]]; then
    printf '%s\n' "$CODEX_MEM_VSCODE_PROFILE"
    return
  fi

  if [[ ! -f "$VSCODE_STORAGE_FILE" ]]; then
    return
  fi

  node - "$VSCODE_STORAGE_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const parsed = JSON.parse(raw);
const profiles = Array.isArray(parsed?.userDataProfiles)
  ? parsed.userDataProfiles
      .map((item) => item && typeof item.name === 'string' ? item.name.trim() : '')
      .filter(Boolean)
  : [];
for (const profile of [...new Set(profiles)]) {
  process.stdout.write(`${profile}\n`);
}
NODE
}

echo "[retentia] Installing root dependencies"
npm install --prefix "$ROOT_DIR"

echo "[retentia] Installing VS Code extension dependencies"
npm install --prefix "$ROOT_DIR/vscode-extension"

echo "[retentia] Building retentia"
npm run build --prefix "$ROOT_DIR"

echo "[retentia] Installing VS Code extension"
npm run install:local --prefix "$ROOT_DIR/vscode-extension"

EXT_NAME="$(node -p "require('$ROOT_DIR/vscode-extension/package.json').name")"
EXT_VERSION="$(node -p "require('$ROOT_DIR/vscode-extension/package.json').version")"
VSIX_FILE="$ROOT_DIR/vscode-extension/${EXT_NAME}-${EXT_VERSION}.vsix"
while IFS= read -r profile; do
  if [[ -n "$profile" ]]; then
    echo "[retentia] Installing extension in profile: $profile"
    code --install-extension "$VSIX_FILE" --force --profile "$profile"
  fi
done < <(list_profiles)

echo "[retentia] Enabling MCP and starting worker"
node "$ROOT_DIR/dist/cli.js" setup

echo "[retentia] Install complete"
echo "[retentia] If commands do not appear immediately, run 'Developer: Reload Window' in VS Code."
