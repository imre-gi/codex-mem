#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, "..");

const codeCli = resolveCodeCli();
if (!codeCli) {
  log("VS Code CLI not found. Nothing to uninstall.");
  process.exit(0);
}

const extensionIds = csv(process.env.CODEX_MEM_VSCODE_EXTENSION_IDS).length
  ? csv(process.env.CODEX_MEM_VSCODE_EXTENSION_IDS)
  : ["local.retentia-vscode", "local.codex-mem-vscode"];

for (const extensionId of extensionIds) {
  run(codeCli, ["--uninstall-extension", extensionId], EXT_DIR, true);
  for (const profile of listProfiles()) {
    run(
      codeCli,
      ["--uninstall-extension", extensionId, "--profile", profile],
      EXT_DIR,
      true
    );
  }
}

log("Local extension uninstall complete.");

function resolveCodeCli() {
  const candidates = [];
  const envCli = (process.env.CODEX_MEM_VSCODE_CLI || "").trim();
  if (envCli) {
    candidates.push(envCli);
  }

  candidates.push("code");
  if (process.platform === "win32") {
    candidates.push("code.cmd");
  }
  candidates.push(...platformCodeCandidates());

  for (const candidate of unique(candidates)) {
    const result = run(candidate, ["--version"], EXT_DIR, true);
    if (result.status === 0) {
      return candidate;
    }
  }

  return undefined;
}

function platformCodeCandidates() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      join(
        homedir(),
        "Applications",
        "Visual Studio Code.app",
        "Contents",
        "Resources",
        "app",
        "bin",
        "code"
      )
    ];
  }

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    return [
      join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      join(programFiles, "Microsoft VS Code", "bin", "code.cmd"),
      join(programFilesX86, "Microsoft VS Code", "bin", "code.cmd")
    ];
  }

  return [
    "/usr/bin/code",
    "/usr/local/bin/code",
    "/snap/bin/code",
    ...wslRemoteCodeCandidates()
  ];
}

function wslRemoteCodeCandidates() {
  const candidates = [];
  const serverDirs = [
    join(homedir(), ".vscode-server", "bin"),
    join(homedir(), ".vscode-server-insiders", "bin")
  ];

  for (const serverDir of serverDirs) {
    if (!existsSync(serverDir)) {
      continue;
    }

    try {
      const entries = readdirSync(serverDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        candidates.push(join(serverDir, entry.name, "bin", "remote-cli", "code"));
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

function listProfiles() {
  const explicit = (process.env.CODEX_MEM_VSCODE_PROFILE || "").trim();
  if (explicit) {
    return [explicit];
  }

  const storageFile =
    process.env.CODEX_MEM_VSCODE_STORAGE_FILE || defaultVsCodeStorageFile();
  if (!existsSync(storageFile)) {
    return [];
  }

  try {
    const raw = readFileSync(storageFile, "utf8");
    const parsed = JSON.parse(raw);
    const profiles = Array.isArray(parsed?.userDataProfiles)
      ? parsed.userDataProfiles
          .map((item) =>
            item && typeof item.name === "string" ? item.name.trim() : ""
          )
          .filter(Boolean)
      : [];
    return [...new Set(profiles)];
  } catch {
    return [];
  }
}

function defaultVsCodeStorageFile() {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "storage.json"
    );
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "storage.json");
  }

  return join(homedir(), ".config", "Code", "User", "globalStorage", "storage.json");
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "pipe",
    encoding: "utf8"
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        (result.stderr || "").trim(),
        (result.stdout || "").trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function csv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function log(message) {
  process.stdout.write(`[retentia:vscode] ${message}\n`);
}
