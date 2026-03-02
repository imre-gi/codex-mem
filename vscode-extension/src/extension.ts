import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import * as vscode from "vscode";

interface JsonResult {
  [key: string]: unknown;
}

interface CliResolution {
  command: string;
  baseArgs: string[];
}

interface DashboardTask {
  id?: number;
  kind: string;
  title: string;
  excerpt: string;
  createdAt: string;
}

interface DashboardData {
  generatedAt: string;
  dataFile: string;
  worker: {
    running: boolean;
    pid?: number;
    uptimeSeconds?: number;
    baseUrl: string;
    host: string;
    port?: number;
  };
  mcp: {
    configured: boolean;
    command: string;
    args: string[];
    configPath: string;
  };
  kpis: {
    entriesTotal: number;
    observationsTotal: number;
    summariesTotal: number;
    projectsTotal: number;
    latestEntryAt?: string;
    oldestEntryAt?: string;
  };
  recentTasks: DashboardTask[];
  error?: string;
}

const OUTPUT = vscode.window.createOutputChannel("Codex Mem");
const DASHBOARD_VIEW_TYPE = "codexMem.statusDashboard.view";
const DASHBOARD_TITLE = "Codex Mem Dashboard";
const MCP_SERVER_SECTION = "mcp_servers.codex-mem";
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(OUTPUT);
  OUTPUT.appendLine("Codex Mem extension activated.");
  let dashboardPanel: vscode.WebviewPanel | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.setup", async () => {
      await runAndShowJson(
        ["setup"],
        "Codex Mem setup complete. MCP enabled and worker started."
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.enableMcp", async () => {
      await runAndShowJson(["enable"], "Codex Mem MCP registration completed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.initStore", async () => {
      await runAndShowJson(["init"], "codex-mem store initialized");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.startWorker", async () => {
      await runAndShowJson(["worker", "start"], "Codex Mem worker started.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.stopWorker", async () => {
      await runAndShowJson(["worker", "stop"], "Codex Mem worker stopped.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.workerStatus", async () => {
      const status = await runCliJson(["worker", "status"]);
      await openJsonDocument(status, "codex-mem-worker-status.json");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.statusDashboard", async () => {
      if (!dashboardPanel) {
        dashboardPanel = vscode.window.createWebviewPanel(
          DASHBOARD_VIEW_TYPE,
          DASHBOARD_TITLE,
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            retainContextWhenHidden: true
          }
        );

        dashboardPanel.onDidDispose(() => {
          dashboardPanel = undefined;
        });

        dashboardPanel.webview.onDidReceiveMessage(async (message: unknown) => {
          if (!dashboardPanel) {
            return;
          }

          const cmd = toText(toRecord(message).command);
          if (!cmd) {
            return;
          }

          if (cmd === "refresh") {
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "setup") {
            await runAndShowJson(
              ["setup"],
              "Codex Mem setup complete. MCP enabled and worker started."
            );
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "start-worker") {
            await runAndShowJson(["worker", "start"], "Codex Mem worker started.");
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "stop-worker") {
            await runAndShowJson(["worker", "stop"], "Codex Mem worker stopped.");
            await renderDashboardPanel(dashboardPanel);
            return;
          }
        }, undefined, context.subscriptions);
      }

      dashboardPanel.reveal(vscode.ViewColumn.Active);
      await renderDashboardPanel(dashboardPanel);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        `@ext:${context.extension.id} codexMem`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.addObservation", async () => {
      const title = await vscode.window.showInputBox({
        title: "Codex Mem: Observation Title",
        prompt: "Short title",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Title is required")
      });
      if (!title) {
        return;
      }

      const content = await vscode.window.showInputBox({
        title: "Codex Mem: Observation Content",
        prompt: "Detailed observation",
        ignoreFocusOut: true,
        validateInput: (value) =>
          value.trim() ? undefined : "Content is required"
      });
      if (!content) {
        return;
      }

      const type = await vscode.window.showQuickPick(
        ["note", "bugfix", "feature", "refactor", "discovery", "decision", "change"],
        {
          title: "Codex Mem: Observation Type",
          canPickMany: false,
          ignoreFocusOut: true
        }
      );
      if (!type) {
        return;
      }

      const tags = await vscode.window.showInputBox({
        title: "Codex Mem: Tags (optional)",
        prompt: "Comma-separated tags",
        ignoreFocusOut: true
      });

      const files = await vscode.window.showInputBox({
        title: "Codex Mem: Files (optional)",
        prompt: "Comma-separated file paths",
        ignoreFocusOut: true
      });

      const args = [
        "add-observation",
        "--title",
        title,
        "--content",
        content,
        "--type",
        type
      ];

      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }

      if (tags?.trim()) {
        args.push("--tags", tags.trim());
      }

      if (files?.trim()) {
        args.push("--files", files.trim());
      }

      const result = await runCliJson(args);
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved observation ${id}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.addSummary", async () => {
      const learned = await vscode.window.showInputBox({
        title: "Codex Mem: Learned",
        prompt: "What was learned",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Learned is required")
      });
      if (!learned) {
        return;
      }

      const request = await vscode.window.showInputBox({
        title: "Codex Mem: Request (optional)",
        prompt: "Original request summary",
        ignoreFocusOut: true
      });

      const completed = await vscode.window.showInputBox({
        title: "Codex Mem: Completed (optional)",
        prompt: "What was completed",
        ignoreFocusOut: true
      });

      const nextSteps = await vscode.window.showInputBox({
        title: "Codex Mem: Next Steps (optional)",
        prompt: "What should happen next",
        ignoreFocusOut: true
      });

      const args = ["add-summary", "--learned", learned];
      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }
      if (request?.trim()) {
        args.push("--request", request.trim());
      }
      if (completed?.trim()) {
        args.push("--completed", completed.trim());
      }
      if (nextSteps?.trim()) {
        args.push("--next-steps", nextSteps.trim());
      }

      const result = await runCliJson(args);
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved summary ${id}.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.search", async () => {
      const query = await vscode.window.showInputBox({
        title: "Codex Mem: Search",
        prompt: "Search query",
        ignoreFocusOut: true
      });
      if (query === undefined) {
        return;
      }

      const args = ["search", "--limit", "30"];
      if (query.trim()) {
        args.push("--query", query.trim());
      }

      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }

      const result = await runCliJson(args);
      const results = Array.isArray(result.results)
        ? (result.results as JsonResult[])
        : [];

      if (results.length === 0) {
        vscode.window.showInformationMessage("No matching memory entries.");
        return;
      }

      const picks = results.map((item) => {
        const id = typeof item.id === "number" ? item.id : "?";
        const title = String(item.title ?? "(no title)");
        const detail = String(item.excerpt ?? "");
        return {
          label: `#${id} ${title}`,
          description: String(item.kind ?? ""),
          detail,
          id: Number(item.id)
        };
      });

      const picked = await vscode.window.showQuickPick(picks, {
        title: "Codex Mem: Search Results",
        placeHolder: "Select an entry to open details",
        ignoreFocusOut: true
      });

      if (!picked || Number.isNaN(picked.id)) {
        return;
      }

      const entryResult = await runCliJson(["get", "--ids", String(picked.id)]);
      await openJsonDocument(entryResult, `codex-mem-entry-${picked.id}.json`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.contextPack", async () => {
      const query = await vscode.window.showInputBox({
        title: "Codex Mem: Context Pack Query",
        prompt: "Optional query",
        ignoreFocusOut: true
      });
      if (query === undefined) {
        return;
      }

      const args = ["context", "--full-count", "3"];
      if (query.trim()) {
        args.push("--query", query.trim());
      }

      const project = getDefaultProject();
      if (project) {
        args.push("--project", project);
      }

      const output = await runCliRaw(args);
      await openTextDocument(output, "markdown", "codex-mem-context.md");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.openMemoryFile", async () => {
      const init = await runCliJson(["init"]);
      const dataFile = String(init.dataFile ?? "");
      if (!dataFile) {
        vscode.window.showErrorMessage("Could not resolve memory file path.");
        return;
      }

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dataFile));
      await vscode.window.showTextDocument(doc, { preview: false });
    })
  );
}

export function deactivate(): void {}

function getDefaultProject(): string | undefined {
  const explicit = vscode.workspace
    .getConfiguration("codexMem")
    .get<string>("defaultProject", "")
    .trim();

  if (explicit) {
    return explicit;
  }

  return vscode.workspace.workspaceFolders?.[0]?.name;
}

async function runAndShowJson(args: string[], successMessage: string): Promise<void> {
  const json = await runCliJson(args);
  OUTPUT.appendLine(JSON.stringify(json, null, 2));
  vscode.window.showInformationMessage(successMessage);
}

async function runCliJson(args: string[]): Promise<JsonResult> {
  const raw = await runCliRaw(args);
  try {
    return JSON.parse(raw) as JsonResult;
  } catch (error) {
    throw new Error(
      `Expected JSON from codex-mem, got: ${raw.slice(0, 280)}${
        raw.length > 280 ? "..." : ""
      }`
    );
  }
}

async function runCliRaw(args: string[]): Promise<string> {
  const cwd =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const resolution = resolveCli(cwd);
  const finalArgs = [...resolution.baseArgs, ...args];

  OUTPUT.appendLine(`$ ${resolution.command} ${finalArgs.join(" ")}`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolution.command, finalArgs, {
      cwd,
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const message = [
        `Failed to start codex-mem CLI: ${error.message}`,
        `Set 'codexMem.cliPath' in VS Code settings, or ensure one of these exists:`,
        ...getAutoDetectCandidates(cwd).map((candidate) => `- ${candidate}`),
        `Or make sure 'codex-mem' is on PATH.`
      ].join("\n");
      OUTPUT.appendLine(message);
      reject(new Error(message));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      const message =
        `codex-mem command failed (exit ${code}).\n${stderr || stdout}`;
      OUTPUT.appendLine(message);
      reject(new Error(message));
    });
  });
}

function resolveCli(workspaceRoot: string): CliResolution {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<string>("cliPath", "")
    .trim();

  if (configured) {
    if (configured.endsWith(".js") || configured.endsWith(".mjs")) {
      const script = isAbsolute(configured)
        ? configured
        : join(workspaceRoot, configured);
      return { command: "node", baseArgs: [script] };
    }

    return { command: configured, baseArgs: [] };
  }

  const localScript = join(workspaceRoot, "dist", "cli.js");
  if (fileExists(localScript)) {
    return { command: "node", baseArgs: [localScript] };
  }

  for (const candidate of getAutoDetectCandidates(workspaceRoot)) {
    if (fileExists(candidate)) {
      return { command: "node", baseArgs: [candidate] };
    }
  }

  return { command: "codex-mem", baseArgs: [] };
}

function getAutoDetectCandidates(workspaceRoot: string): string[] {
  const candidates = [
    join(workspaceRoot, "..", "dist", "cli.js"),
    join(workspaceRoot, "codex-mem", "dist", "cli.js"),
    join(workspaceRoot, "..", "codex-mem", "dist", "cli.js"),
    join(workspaceRoot, "..", "..", "codex-mem", "dist", "cli.js")
  ];

  return [...new Set(candidates)];
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function openJsonDocument(payload: unknown, title: string): Promise<void> {
  await openTextDocument(JSON.stringify(payload, null, 2), "json", title);
}

async function openTextDocument(
  content: string,
  language: string,
  _title: string
): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    language,
    content
  });

  await vscode.window.showTextDocument(document, { preview: false });
}

async function renderDashboardPanel(panel: vscode.WebviewPanel): Promise<void> {
  panel.webview.html = getDashboardHtml(createEmptyDashboardData(), true);

  try {
    const data = await collectDashboardData();
    panel.webview.html = getDashboardHtml(data, false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    OUTPUT.appendLine(`Dashboard render failed: ${message}`);
    panel.webview.html = getDashboardHtml(createEmptyDashboardData(message), false);
  }
}

async function collectDashboardData(): Promise<DashboardData> {
  const [statusPayload, recentPayload] = await Promise.all([
    runCliJson(["kpis"]),
    runCliJson(["search", "--limit", "8"])
  ]);

  const statusRoot = toRecord(statusPayload);
  const worker = toRecord(statusRoot.worker);
  const kpis = toRecord(statusRoot.kpis);
  const recentRoot = toRecord(recentPayload);
  const mcp = readMcpStatus();
  const recentSource = Array.isArray(recentRoot.results) ? recentRoot.results : [];

  const recentTasks = recentSource
    .map((item) => toRecord(item))
    .map((item) => ({
      id: toNumber(item.id),
      kind: toText(item.kind) || "unknown",
      title: toText(item.title) || "(no title)",
      excerpt: toText(item.excerpt) || "",
      createdAt: toText(item.createdAt) || ""
    }))
    .filter((item) => Boolean(item.createdAt || item.title));

  return {
    generatedAt: new Date().toISOString(),
    dataFile: toText(statusRoot.dataFile) || toText(worker.dataFile) || "n/a",
    worker: {
      running: toBoolean(worker.running),
      pid: toNumber(worker.pid),
      uptimeSeconds: toNumber(worker.uptimeSeconds),
      baseUrl: toText(worker.baseUrl) || "n/a",
      host: toText(worker.host) || "n/a",
      port: toNumber(worker.port)
    },
    mcp,
    kpis: {
      entriesTotal: toNumber(kpis.entriesTotal) ?? 0,
      observationsTotal: toNumber(kpis.observationsTotal) ?? 0,
      summariesTotal: toNumber(kpis.summariesTotal) ?? 0,
      projectsTotal: toNumber(kpis.projectsTotal) ?? 0,
      latestEntryAt: toText(kpis.latestEntryAt),
      oldestEntryAt: toText(kpis.oldestEntryAt)
    },
    recentTasks
  };
}

function createEmptyDashboardData(error?: string): DashboardData {
  return {
    generatedAt: new Date().toISOString(),
    dataFile: "n/a",
    worker: {
      running: false,
      baseUrl: "n/a",
      host: "n/a"
    },
    mcp: {
      configured: false,
      command: "n/a",
      args: [],
      configPath: CODEX_CONFIG_PATH
    },
    kpis: {
      entriesTotal: 0,
      observationsTotal: 0,
      summariesTotal: 0,
      projectsTotal: 0
    },
    recentTasks: [],
    error
  };
}

function readMcpStatus(): DashboardData["mcp"] {
  const fallback: DashboardData["mcp"] = {
    configured: false,
    command: "n/a",
    args: [],
    configPath: CODEX_CONFIG_PATH
  };

  try {
    if (!existsSync(CODEX_CONFIG_PATH)) {
      return fallback;
    }

    const lines = readFileSync(CODEX_CONFIG_PATH, "utf8").split(/\r?\n/);
    let inSection = false;
    let foundSection = false;
    let command = "";
    let args: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      if (trimmed.startsWith("[")) {
        if (trimmed === `[${MCP_SERVER_SECTION}]`) {
          inSection = true;
          foundSection = true;
          continue;
        }

        if (inSection) {
          break;
        }

        continue;
      }

      if (!inSection) {
        continue;
      }

      const commandMatch = trimmed.match(/^command\s*=\s*"([^"]+)"/);
      if (commandMatch && commandMatch[1]) {
        command = commandMatch[1];
        continue;
      }

      if (trimmed.startsWith("args")) {
        args = [...trimmed.matchAll(/"([^"]+)"/g)]
          .map((match) => match[1])
          .filter(Boolean);
      }
    }

    if (!foundSection) {
      return fallback;
    }

    return {
      configured: true,
      command: command || "n/a",
      args,
      configPath: CODEX_CONFIG_PATH
    };
  } catch {
    return fallback;
  }
}

function getDashboardHtml(data: DashboardData, loading: boolean): string {
  const nonce = String(Date.now());
  const workerState = data.worker.running ? "Running" : "Stopped";
  const workerStateClass = data.worker.running ? "status-ok" : "status-warn";
  const mcpStateClass = data.mcp.configured ? "status-ok" : "status-warn";
  const mcpState = data.mcp.configured ? "Configured" : "Missing";
  const recentItems =
    data.recentTasks.length > 0
      ? data.recentTasks
          .map((item) => {
            const title = escapeHtml(item.title);
            const kind = escapeHtml(item.kind);
            const id = item.id !== undefined ? `#${item.id}` : "n/a";
            const createdAt = formatIso(item.createdAt);
            const excerpt = escapeHtml(item.excerpt || "No details");
            return `
              <li class="task-item">
                <div class="task-title">${title}</div>
                <div class="task-meta">${id} · ${kind} · ${escapeHtml(createdAt)}</div>
                <div class="task-excerpt">${excerpt}</div>
              </li>
            `;
          })
          .join("")
      : `<li class="task-empty">No memory tasks found yet.</li>`;

  const errorBlock = data.error
    ? `<div class="error-box">Dashboard error: ${escapeHtml(data.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codex Mem Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #0d1117;
        --bg-1: #141b24;
        --bg-2: #1d2633;
        --fg-0: #f2f6fa;
        --fg-1: #bac8d8;
        --accent: #26a269;
        --warn: #e5a50a;
        --danger: #e66100;
        --line: #293444;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Segoe UI", "IBM Plex Sans", "Noto Sans", sans-serif;
        background: radial-gradient(circle at 20% 0%, #1f2f44 0%, var(--bg-0) 55%);
        color: var(--fg-0);
      }

      .wrap {
        padding: 20px;
        max-width: 1100px;
        margin: 0 auto;
      }

      .topbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }

      .title {
        font-size: 22px;
        font-weight: 700;
        letter-spacing: 0.2px;
      }

      .subtitle {
        color: var(--fg-1);
        font-size: 12px;
      }

      .actions {
        display: flex;
        gap: 8px;
      }

      button {
        border: 1px solid var(--line);
        background: linear-gradient(180deg, #202b39, #141c27);
        color: var(--fg-0);
        padding: 8px 11px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
      }

      button:hover {
        border-color: #3c4f69;
      }

      .cards {
        display: grid;
        grid-template-columns: repeat(4, minmax(160px, 1fr));
        gap: 10px;
        margin-bottom: 12px;
      }

      .card {
        background: linear-gradient(170deg, var(--bg-1), var(--bg-2));
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }

      .label {
        color: var(--fg-1);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin-bottom: 7px;
      }

      .value {
        font-size: 22px;
        font-weight: 700;
      }

      .status-pill {
        display: inline-block;
        margin-top: 4px;
        padding: 3px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }

      .status-ok {
        background: rgba(38, 162, 105, 0.18);
        color: #7ce6b7;
      }

      .status-warn {
        background: rgba(229, 165, 10, 0.2);
        color: #ffd387;
      }

      .panels {
        display: grid;
        grid-template-columns: 1.35fr 1fr;
        gap: 12px;
      }

      .panel {
        background: linear-gradient(170deg, #152030, #0f1723);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
      }

      .panel h3 {
        margin: 0 0 10px;
        font-size: 14px;
      }

      .kv {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 6px;
        font-size: 12px;
      }

      .kv .k {
        color: var(--fg-1);
      }

      .tasks {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow: auto;
      }

      .task-item {
        border-top: 1px solid var(--line);
        padding: 10px 0;
      }

      .task-item:first-child {
        border-top: 0;
        padding-top: 0;
      }

      .task-title {
        font-weight: 600;
        font-size: 13px;
      }

      .task-meta {
        color: var(--fg-1);
        font-size: 11px;
        margin-top: 2px;
      }

      .task-excerpt {
        font-size: 12px;
        margin-top: 6px;
        color: #d3dfed;
      }

      .task-empty {
        color: var(--fg-1);
        font-size: 12px;
      }

      .loading {
        color: var(--fg-1);
        font-size: 12px;
        margin-bottom: 10px;
      }

      .error-box {
        border: 1px solid rgba(230, 97, 0, 0.5);
        background: rgba(230, 97, 0, 0.12);
        color: #ffba92;
        border-radius: 10px;
        padding: 9px 10px;
        margin-bottom: 10px;
        font-size: 12px;
      }

      @media (max-width: 900px) {
        .cards {
          grid-template-columns: repeat(2, minmax(140px, 1fr));
        }
        .panels {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div>
          <div class="title">Codex Mem Dashboard</div>
          <div class="subtitle">Updated ${escapeHtml(formatIso(data.generatedAt))}</div>
        </div>
        <div class="actions">
          <button data-cmd="refresh">Refresh</button>
          <button data-cmd="setup">Setup</button>
          <button data-cmd="start-worker">Start Worker</button>
          <button data-cmd="stop-worker">Stop Worker</button>
        </div>
      </div>

      ${loading ? `<div class="loading">Refreshing dashboard data...</div>` : ""}
      ${errorBlock}

      <section class="cards">
        <article class="card">
          <div class="label">Worker</div>
          <div class="value">${escapeHtml(workerState)}</div>
          <div class="status-pill ${workerStateClass}">${escapeHtml(workerState)}</div>
        </article>
        <article class="card">
          <div class="label">MCP</div>
          <div class="value">${escapeHtml(mcpState)}</div>
          <div class="status-pill ${mcpStateClass}">${escapeHtml(mcpState)}</div>
        </article>
        <article class="card">
          <div class="label">Tasks Executed</div>
          <div class="value">${data.kpis.entriesTotal}</div>
        </article>
        <article class="card">
          <div class="label">Projects</div>
          <div class="value">${data.kpis.projectsTotal}</div>
        </article>
      </section>

      <section class="panels">
        <article class="panel">
          <h3>Runtime + MCP Status</h3>
          <div class="kv">
            <div class="k">Worker PID</div><div>${data.worker.pid ?? "n/a"}</div>
            <div class="k">Worker Uptime</div><div>${escapeHtml(formatUptime(data.worker.uptimeSeconds))}</div>
            <div class="k">Worker Endpoint</div><div>${escapeHtml(data.worker.baseUrl)}</div>
            <div class="k">Worker Host/Port</div><div>${escapeHtml(`${data.worker.host}:${data.worker.port ?? "n/a"}`)}</div>
            <div class="k">MCP Command</div><div>${escapeHtml(data.mcp.command)}</div>
            <div class="k">MCP Args</div><div>${escapeHtml(data.mcp.args.join(" ")) || "n/a"}</div>
            <div class="k">MCP Config</div><div>${escapeHtml(data.mcp.configPath)}</div>
            <div class="k">DB File</div><div>${escapeHtml(data.dataFile)}</div>
            <div class="k">Observations</div><div>${data.kpis.observationsTotal}</div>
            <div class="k">Summaries</div><div>${data.kpis.summariesTotal}</div>
            <div class="k">Latest Entry</div><div>${escapeHtml(formatIso(data.kpis.latestEntryAt))}</div>
            <div class="k">Oldest Entry</div><div>${escapeHtml(formatIso(data.kpis.oldestEntryAt))}</div>
          </div>
        </article>
        <article class="panel">
          <h3>Recent Tasks Executed</h3>
          <ul class="tasks">${recentItems}</ul>
        </article>
      </section>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      for (const button of document.querySelectorAll("button[data-cmd]")) {
        button.addEventListener("click", () => {
          vscode.postMessage({ command: button.getAttribute("data-cmd") });
        });
      }
    </script>
  </body>
</html>`;
}

function toRecord(value: unknown): JsonResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as JsonResult;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUptime(seconds: number | undefined): string {
  if (seconds === undefined) {
    return "n/a";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

function formatIso(value: string | undefined): string {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${date.toLocaleString()} (${value})`;
}
