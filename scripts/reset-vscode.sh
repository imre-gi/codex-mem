#!/usr/bin/env bash
set -euo pipefail

EXT_IDS_CSV="${CODEX_MEM_VSCODE_EXTENSION_IDS:-local.retentia-vscode,local.codex-mem-vscode}"
CODEX_CONFIG_FILE="${CODEX_MEM_CODEX_CONFIG:-$HOME/.codex/config.toml}"
VSCODE_MCP_FILE="${CODEX_MEM_VSCODE_MCP_CONFIG:-$HOME/.config/Code/User/mcp.json}"
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

echo "[retentia] Resetting VS Code + Codex MCP setup"

IFS=',' read -ra EXT_IDS <<< "$EXT_IDS_CSV"
echo "[retentia] Uninstalling VS Code extensions: ${EXT_IDS_CSV}"
if command -v code >/dev/null 2>&1; then
  for ext_id in "${EXT_IDS[@]}"; do
    trimmed_id="$(echo "$ext_id" | xargs)"
    if [[ -z "$trimmed_id" ]]; then
      continue
    fi

    code --uninstall-extension "$trimmed_id" >/dev/null 2>&1 || true
    while IFS= read -r profile; do
      if [[ -n "$profile" ]]; then
        code --uninstall-extension "$trimmed_id" --profile "$profile" >/dev/null 2>&1 || true
      fi
    done < <(list_profiles)
  done
else
  echo "[retentia] 'code' CLI not found; skipping extension uninstall"
fi

if [[ -f "$CODEX_CONFIG_FILE" ]]; then
  echo "[retentia] Removing [mcp_servers.retentia] and [mcp_servers.codex-mem] from ${CODEX_CONFIG_FILE}"
  tmp_file="$(mktemp)"
  awk '
  BEGIN { skip=0 }
  /^\[mcp_servers\.(retentia|codex-mem)\]/ { skip=1; next }
  /^\[.*\]/ {
    if (skip == 1) {
      skip=0
    }
  }
  {
    if (skip == 0) {
      print
    }
  }
  ' "$CODEX_CONFIG_FILE" > "$tmp_file"
  mv "$tmp_file" "$CODEX_CONFIG_FILE"
else
  echo "[retentia] Codex config not found at ${CODEX_CONFIG_FILE}; skipping"
fi

if [[ -f "$VSCODE_MCP_FILE" ]]; then
  echo "[retentia] Removing retentia/codex-mem entries from ${VSCODE_MCP_FILE}"
  node - "$VSCODE_MCP_FILE" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const raw = fs.readFileSync(file, 'utf8');
const parsed = JSON.parse(raw);
if (parsed && parsed.servers && typeof parsed.servers === 'object') {
  for (const key of Object.keys(parsed.servers)) {
    const normalized = key.toLowerCase();
    if (normalized.includes('retentia') || normalized.includes('codex-mem')) {
      delete parsed.servers[key];
    }
  }
}
fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n');
NODE
else
  echo "[retentia] VS Code MCP config not found at ${VSCODE_MCP_FILE}; skipping"
fi

echo "[retentia] Reset complete"
