#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const VSCODE_EXTENSION_DIR = join(ROOT_DIR, "vscode-extension");
const EXTENSION_PACKAGE_JSON = join(VSCODE_EXTENSION_DIR, "package.json");
let codeCliResolutionHint = "";

const mode = (process.argv[2] || "install").trim().toLowerCase();
if (mode !== "install" && mode !== "reinstall") {
  fail(`Unknown mode '${mode}'. Use 'install' or 'reinstall'.`);
}

try {
  if (mode === "reinstall") {
    log("Reinstall mode: resetting extension and MCP config");
    resetEnvironment();
  }

  installFlow();
  log("Install complete");
  log("If commands do not appear immediately, run 'Developer: Reload Window' in VS Code.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
}

function installFlow() {
  log("Installing root dependencies");
  runNpm(["install"], ROOT_DIR);

  log("Rebuilding native dependencies for current Node runtime");
  runNpm(["rebuild", "better-sqlite3"], ROOT_DIR);

  log("Installing VS Code extension dependencies");
  runNpm(["install"], VSCODE_EXTENSION_DIR);

  log("Building Retentia CLI");
  runNpm(["run", "build"], ROOT_DIR);

  log("Packaging VS Code extension");
  runNpm(["run", "package"], VSCODE_EXTENSION_DIR);

  const vsixFile = resolveVsixPath();
  if (!existsSync(vsixFile)) {
    throw new Error(`VSIX file not found: ${vsixFile}`);
  }

  const codeCli = resolveCodeCli();
  if (!codeCli) {
    throw new Error(
      [
      "VS Code CLI not found.",
      "Install VS Code command-line integration (the 'code' command) and retry.",
      "Or set CODEX_MEM_VSCODE_CLI to a working VS Code CLI path/command.",
      codeCliResolutionHint,
      `Generated VSIX: ${vsixFile}`
    ]
        .filter(Boolean)
        .join("\n")
    );
  }

  log(`Using VS Code CLI: ${codeCli}`);
  uninstallKnownExtensions(codeCli);
  installExtensionEverywhere(codeCli, vsixFile);

  log("Enabling MCP and starting worker");
  run(process.execPath, [join(ROOT_DIR, "dist", "cli.js"), "setup"], ROOT_DIR);
}

function resetEnvironment() {
  const codeCli = resolveCodeCli();
  if (codeCli) {
    log(`Removing existing extension installations with: ${codeCli}`);
    uninstallKnownExtensions(codeCli);
  } else {
    log("VS Code CLI not found during reset; skipping extension uninstall");
  }

  resetCodexConfig();
  resetVsCodeMcpConfig();
}

function resetCodexConfig() {
  const configPath =
    process.env.CODEX_MEM_CODEX_CONFIG || join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) {
    return;
  }

  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  const output = [];
  let skip = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[mcp_servers.retentia]" || trimmed === "[mcp_servers.codex-mem]") {
      skip = true;
      continue;
    }

    if (skip && /^\[.+\]$/.test(trimmed)) {
      skip = false;
    }

    if (!skip) {
      output.push(line);
    }
  }

  writeFileSync(configPath, `${output.join("\n")}\n`, "utf8");
}

function resetVsCodeMcpConfig() {
  const mcpConfigPath =
    process.env.CODEX_MEM_VSCODE_MCP_CONFIG || defaultVsCodeMcpFile();
  if (!existsSync(mcpConfigPath)) {
    return;
  }

  try {
    const raw = readFileSync(mcpConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.servers && typeof parsed.servers === "object") {
      for (const key of Object.keys(parsed.servers)) {
        const normalized = key.toLowerCase();
        if (normalized.includes("retentia") || normalized.includes("codex-mem")) {
          delete parsed.servers[key];
        }
      }
      writeFileSync(mcpConfigPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }
  } catch {
    log(`Could not parse VS Code MCP config: ${mcpConfigPath}`);
  }
}

function uninstallKnownExtensions(codeCli) {
  const extensionIds = csv(process.env.CODEX_MEM_VSCODE_EXTENSION_IDS).length
    ? csv(process.env.CODEX_MEM_VSCODE_EXTENSION_IDS)
    : ["local.retentia-vscode", "local.codex-mem-vscode"];

  for (const extensionId of extensionIds) {
    run(codeCli, ["--uninstall-extension", extensionId], ROOT_DIR, true);
    for (const profile of listProfiles()) {
      run(
        codeCli,
        ["--uninstall-extension", extensionId, "--profile", profile],
        ROOT_DIR,
        true
      );
    }
  }
}

function installExtensionEverywhere(codeCli, vsixFile) {
  run(codeCli, ["--install-extension", vsixFile, "--force"], ROOT_DIR);

  for (const profile of listProfiles()) {
    const result = run(
      codeCli,
      ["--install-extension", vsixFile, "--force", "--profile", profile],
      ROOT_DIR,
      true
    );

    if (result.status !== 0) {
      log(`Skipping profile '${profile}' because installation failed.`);
    }
  }
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

function resolveVsixPath() {
  const extensionPackage = JSON.parse(readFileSync(EXTENSION_PACKAGE_JSON, "utf8"));
  return join(
    VSCODE_EXTENSION_DIR,
    `${extensionPackage.name}-${extensionPackage.version}.vsix`
  );
}

function resolveCodeCli() {
  codeCliResolutionHint = "";
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
    if (!canRunCodeCli(candidate)) {
      continue;
    }

    const probe = ensureCodeCliUsable(candidate);
    if (!probe.ok) {
      if (!codeCliResolutionHint && probe.hint) {
        codeCliResolutionHint = probe.hint;
      }
      continue;
    }

    return candidate;
  }

  return undefined;
}

function canRunCodeCli(candidate) {
  const result = run(candidate, ["--version"], ROOT_DIR, true);
  return result.status === 0;
}

function ensureCodeCliUsable(candidate) {
  const firstProbe = run(candidate, ["--list-extensions"], ROOT_DIR, true);
  if (firstProbe.status === 0) {
    return { ok: true };
  }

  if (!looksLikeIpcSocketFailure(firstProbe)) {
    return {
      ok: false,
      hint:
        "Detected a VS Code CLI candidate, but it could not be used. Set CODEX_MEM_VSCODE_CLI to a working 'code' command/path."
    };
  }

  const sockets = resolveVsCodeIpcSocketCandidates();
  if (!sockets.length) {
    return {
      ok: false,
      hint:
        "Detected a VS Code remote CLI, but no active VS Code IPC socket was found. Open a VS Code remote window and retry, or set CODEX_MEM_VSCODE_CLI to a local 'code' command."
    };
  }

  for (const socket of sockets) {
    if (process.env.VSCODE_IPC_HOOK_CLI !== socket) {
      process.env.VSCODE_IPC_HOOK_CLI = socket;
      log(`Using VS Code IPC socket: ${socket}`);
    }

    const retryProbe = run(candidate, ["--list-extensions"], ROOT_DIR, true);
    if (retryProbe.status === 0) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    hint:
      "Detected a VS Code remote CLI, but the IPC socket could not be reached. Open/reload the remote VS Code window and retry, or set CODEX_MEM_VSCODE_CLI."
  };
}

function looksLikeIpcSocketFailure(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`;
  return (
    output.includes("Unable to connect to VS Code server") ||
    output.includes("connect ENOENT") ||
    /vscode-ipc-[\w-]+\.sock/.test(output)
  );
}

function resolveVsCodeIpcSocketCandidates() {
  const sockets = [];
  const envSocket = (process.env.VSCODE_IPC_HOOK_CLI || "").trim();
  if (envSocket && existsSync(envSocket)) {
    sockets.push(envSocket);
  }

  const runtimeDir = resolveRuntimeDir();
  if (!runtimeDir || !existsSync(runtimeDir)) {
    return unique(sockets);
  }

  try {
    const discovered = readdirSync(runtimeDir)
      .filter((name) => /^vscode-ipc-.*\.sock$/.test(name))
      .map((name) => join(runtimeDir, name))
      .filter((candidate) => existsSync(candidate))
      .sort((left, right) => getMtimeMs(right) - getMtimeMs(left));
    for (const candidate of discovered) {
      sockets.push(candidate);
    }
  } catch {
    return unique(sockets);
  }

  return unique(sockets);
}

function getMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveRuntimeDir() {
  const explicit = (process.env.XDG_RUNTIME_DIR || "").trim();
  if (explicit) {
    return explicit;
  }

  if (typeof process.getuid === "function") {
    return `/run/user/${process.getuid()}`;
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

function defaultVsCodeMcpFile() {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Code",
      "User",
      "mcp.json"
    );
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }

  return join(homedir(), ".config", "Code", "User", "mcp.json");
}

function runNpm(args, cwd) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    run(process.execPath, [npmExecPath, ...args], cwd);
    return;
  }

  run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: allowFailure ? "pipe" : "inherit",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    if (!allowFailure) {
      throw new Error(`Command failed: ${command} ${args.join(" ")}`);
    }
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
  process.stdout.write(`[retentia] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[retentia] ${message}\n`);
  process.exit(1);
}
