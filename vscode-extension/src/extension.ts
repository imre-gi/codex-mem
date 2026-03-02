import {
  accessSync,
  constants,
  existsSync,
  readFileSync
} from "node:fs";
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
  ingestion: {
    autoSyncEnabled: boolean;
    detectedTasks: number;
    importedTasks: number;
    skippedTasks: number;
    failedTasks: number;
    newestTaskAt?: string;
    byProvider: Array<{
      provider: string;
      detected: number;
      imported: number;
      skipped: number;
      failed: number;
    }>;
  };
  execution: {
    total: number;
    projects: Array<{
      project: string;
      total: number;
      completed: number;
      failed: number;
      providers: string[];
      agents: string[];
      models: string[];
      latestAt?: string;
    }>;
    providers: Array<{ key: string; count: number }>;
    agents: Array<{ key: string; count: number }>;
    models: Array<{ key: string; count: number }>;
    statuses: Array<{ key: string; count: number }>;
    tasks: Array<{
      id: number;
      kind: string;
      project: string;
      sessionId?: string;
      createdAt: string;
      title: string;
      excerpt: string;
      provider: string;
      model: string;
      agent: string;
      role: string;
      pipeline: string;
      status: string;
      taskId?: string;
      sourceFile?: string;
      tags: string[];
    }>;
  };
  recentTasks: DashboardTask[];
  error?: string;
}

interface TaskSyncMetrics {
  autoSyncEnabled: boolean;
  detectedTasks: number;
  importedTasks: number;
  skippedTasks: number;
  failedTasks: number;
  newestTaskAt?: string;
  byProvider: Array<{
    provider: string;
    detected: number;
    imported: number;
    skipped: number;
    failed: number;
  }>;
}

const OUTPUT = vscode.window.createOutputChannel("Retentia");
const DASHBOARD_VIEW_TYPE = "codexMem.statusDashboard.view";
const QUICK_INPUT_VIEW_TYPE = "codexMem.quickInput";
const DASHBOARD_TITLE = "Retentia Dashboard";
const MCP_SERVER_SECTIONS = ["mcp_servers.retentia", "mcp_servers.codex-mem"];
const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const DEFAULT_AUTO_SYNC_LOOKBACK_DAYS = 7;
const DEFAULT_AUTO_SYNC_MAX_IMPORT = 25;
const DEFAULT_AUTO_SYNC_MAX_FILES = 24;
const DEFAULT_EXECUTION_REPORT_LIMIT = 600;
const OBSERVATION_TYPES = new Set([
  "note",
  "bugfix",
  "feature",
  "refactor",
  "discovery",
  "decision",
  "change"
]);

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(OUTPUT);
  OUTPUT.appendLine("Retentia extension activated.");
  let dashboardPanel: vscode.WebviewPanel | undefined;
  const sidebarProvider = new QuickInputSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QUICK_INPUT_VIEW_TYPE, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.setup", async () => {
      await runAndShowJson(
        ["setup"],
        "Retentia setup complete. MCP enabled and worker started."
      );
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.enableMcp", async () => {
      await runAndShowJson(["enable"], "Retentia MCP registration completed.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.initStore", async () => {
      await runAndShowJson(["init"], "retentia store initialized");
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.startWorker", async () => {
      await runAndShowJson(["worker", "start"], "Retentia worker started.");
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.stopWorker", async () => {
      await runAndShowJson(["worker", "stop"], "Retentia worker stopped.");
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.workerStatus", async () => {
      const status = await runCliJson(["worker", "status"]);
      await openJsonDocument(status, "retentia-worker-status.json");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.syncCodexTasks", async () => {
      const metrics = await syncTaskExecutions({ force: true });
      OUTPUT.appendLine(`Task sync metrics: ${JSON.stringify(metrics)}`);
      vscode.window.showInformationMessage(
        `LLM task sync complete. Imported ${metrics.importedTasks} of ${metrics.detectedTasks} detected tasks.`
      );
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.projectExplorer", async () => {
      await vscode.commands.executeCommand("codexMem.statusDashboard");
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
              "Retentia setup complete. MCP enabled and worker started."
            );
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "start-worker") {
            await runAndShowJson(["worker", "start"], "Retentia worker started.");
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "stop-worker") {
            await runAndShowJson(["worker", "stop"], "Retentia worker stopped.");
            await renderDashboardPanel(dashboardPanel);
            return;
          }

          if (cmd === "sync-tasks") {
            const metrics = await syncTaskExecutions({ force: true });
            OUTPUT.appendLine(`Dashboard sync metrics: ${JSON.stringify(metrics)}`);
            vscode.window.showInformationMessage(
              `LLM task sync complete. Imported ${metrics.importedTasks} task(s).`
            );
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
        title: "Retentia: Observation Title",
        prompt: "Short title",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Title is required")
      });
      if (!title) {
        return;
      }

      const content = await vscode.window.showInputBox({
        title: "Retentia: Observation Content",
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
          title: "Retentia: Observation Type",
          canPickMany: false,
          ignoreFocusOut: true
        }
      );
      if (!type) {
        return;
      }

      const tags = await vscode.window.showInputBox({
        title: "Retentia: Tags (optional)",
        prompt: "Comma-separated tags",
        ignoreFocusOut: true
      });

      const files = await vscode.window.showInputBox({
        title: "Retentia: Files (optional)",
        prompt: "Comma-separated file paths",
        ignoreFocusOut: true
      });

      const result = await runCliJson(
        buildObservationArgs({
          title,
          content,
          type,
          project: getDefaultProject(),
          tags,
          files
        })
      );
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved observation ${id}.`);
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.addSummary", async () => {
      const learned = await vscode.window.showInputBox({
        title: "Retentia: Learned",
        prompt: "What was learned",
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : "Learned is required")
      });
      if (!learned) {
        return;
      }

      const request = await vscode.window.showInputBox({
        title: "Retentia: Request (optional)",
        prompt: "Original request summary",
        ignoreFocusOut: true
      });

      const completed = await vscode.window.showInputBox({
        title: "Retentia: Completed (optional)",
        prompt: "What was completed",
        ignoreFocusOut: true
      });

      const nextSteps = await vscode.window.showInputBox({
        title: "Retentia: Next Steps (optional)",
        prompt: "What should happen next",
        ignoreFocusOut: true
      });

      const result = await runCliJson(
        buildSummaryArgs({
          learned,
          request,
          completed,
          nextSteps,
          project: getDefaultProject()
        })
      );
      const id = typeof result.id === "number" ? `#${result.id}` : "entry";
      vscode.window.showInformationMessage(`Saved summary ${id}.`);
      await sidebarProvider.refreshStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.search", async () => {
      const query = await vscode.window.showInputBox({
        title: "Retentia: Search",
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
        title: "Retentia: Search Results",
        placeHolder: "Select an entry to open details",
        ignoreFocusOut: true
      });

      if (!picked || Number.isNaN(picked.id)) {
        return;
      }

      const entryResult = await runCliJson(["get", "--ids", String(picked.id)]);
      await openJsonDocument(entryResult, `retentia-entry-${picked.id}.json`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexMem.contextPack", async () => {
      const query = await vscode.window.showInputBox({
        title: "Retentia: Context Pack Query",
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
      await openTextDocument(output, "markdown", "retentia-context.md");
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

class QuickInputSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = getQuickInputSidebarHtml();

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      await this.handleMessage(message);
    });

    await this.refreshStatus();
  }

  async refreshStatus(): Promise<void> {
    if (!this.view) {
      return;
    }

    try {
      const payload = toRecord(await runCliJson(["kpis"]));
      const worker = toRecord(payload.worker);
      const kpis = toRecord(payload.kpis);
      this.view.webview.postMessage({
        command: "status",
        payload: {
          workerRunning: toBoolean(worker.running),
          entriesTotal: toNumber(kpis.entriesTotal) ?? 0,
          projectsTotal: toNumber(kpis.projectsTotal) ?? 0,
          dataFile: toText(payload.dataFile) || toText(worker.dataFile) || "n/a",
          workerBaseUrl: toText(worker.baseUrl) || "n/a",
          updatedAt: new Date().toISOString()
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.view.webview.postMessage({
        command: "error",
        payload: {
          message
        }
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    const root = toRecord(message);
    const command = toText(root.command);
    if (!command) {
      return;
    }

    const payload = toRecord(root.payload);

    try {
      if (command === "refresh-status") {
        await this.refreshStatus();
        return;
      }

      if (command === "open-dashboard") {
        await vscode.commands.executeCommand("codexMem.statusDashboard");
        return;
      }

      if (command === "open-settings") {
        await vscode.commands.executeCommand("codexMem.openSettings");
        return;
      }

      if (command === "setup") {
        await runAndShowJson(
          ["setup"],
          "Retentia setup complete. MCP enabled and worker started."
        );
        await this.refreshStatus();
        return;
      }

      if (command === "start-worker") {
        await runAndShowJson(["worker", "start"], "Retentia worker started.");
        await this.refreshStatus();
        return;
      }

      if (command === "stop-worker") {
        await runAndShowJson(["worker", "stop"], "Retentia worker stopped.");
        await this.refreshStatus();
        return;
      }

      if (command === "sync-tasks") {
        const metrics = await syncTaskExecutions({ force: true });
        vscode.window.showInformationMessage(
          `LLM task sync complete. Imported ${metrics.importedTasks} of ${metrics.detectedTasks} detected tasks.`
        );
        await this.refreshStatus();
        return;
      }

      if (command === "add-observation") {
        await this.addObservation(payload);
        await this.refreshStatus();
        return;
      }

      if (command === "add-summary") {
        await this.addSummary(payload);
        await this.refreshStatus();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(message);
      if (this.view) {
        this.view.webview.postMessage({
          command: "error",
          payload: { message }
        });
      }
    }
  }

  private async addObservation(payload: JsonResult): Promise<void> {
    const title = toText(payload.title)?.trim() || "";
    const content = toText(payload.content)?.trim() || "";
    if (!title || !content) {
      throw new Error("Observation title and content are required.");
    }

    const result = await runCliJson(
      buildObservationArgs({
        title,
        content,
        type: toText(payload.type),
        project: toText(payload.project),
        tags: toText(payload.tags),
        files: toText(payload.files)
      })
    );

    const id = typeof result.id === "number" ? `#${result.id}` : "entry";
    vscode.window.showInformationMessage(`Saved observation ${id}.`);
    this.view?.webview.postMessage({ command: "clear-observation" });
  }

  private async addSummary(payload: JsonResult): Promise<void> {
    const learned = toText(payload.learned)?.trim() || "";
    if (!learned) {
      throw new Error("Summary learned field is required.");
    }

    const result = await runCliJson(
      buildSummaryArgs({
        learned,
        request: toText(payload.request),
        completed: toText(payload.completed),
        nextSteps: toText(payload.nextSteps),
        tags: toText(payload.tags),
        project: toText(payload.project)
      })
    );

    const id = typeof result.id === "number" ? `#${result.id}` : "entry";
    vscode.window.showInformationMessage(`Saved summary ${id}.`);
    this.view?.webview.postMessage({ command: "clear-summary" });
  }
}

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

function buildObservationArgs(input: {
  title: string;
  content: string;
  type?: string;
  project?: string;
  tags?: string;
  files?: string;
}): string[] {
  const normalizedType = (input.type || "note").trim().toLowerCase();
  const type = OBSERVATION_TYPES.has(normalizedType) ? normalizedType : "note";

  const args = [
    "add-observation",
    "--title",
    input.title.trim(),
    "--content",
    input.content.trim(),
    "--type",
    type
  ];

  const project = input.project?.trim() || getDefaultProject();
  if (project) {
    args.push("--project", project);
  }

  if (input.tags?.trim()) {
    args.push("--tags", input.tags.trim());
  }

  if (input.files?.trim()) {
    args.push("--files", input.files.trim());
  }

  return args;
}

function buildSummaryArgs(input: {
  learned: string;
  request?: string;
  completed?: string;
  nextSteps?: string;
  tags?: string;
  project?: string;
}): string[] {
  const args = ["add-summary", "--learned", input.learned.trim()];
  const project = input.project?.trim() || getDefaultProject();

  if (project) {
    args.push("--project", project);
  }
  if (input.request?.trim()) {
    args.push("--request", input.request.trim());
  }
  if (input.completed?.trim()) {
    args.push("--completed", input.completed.trim());
  }
  if (input.nextSteps?.trim()) {
    args.push("--next-steps", input.nextSteps.trim());
  }
  if (input.tags?.trim()) {
    args.push("--tags", input.tags.trim());
  }

  return args;
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
      `Expected JSON from retentia, got: ${raw.slice(0, 280)}${
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
        `Failed to start retentia CLI: ${error.message}`,
        `Set 'codexMem.cliPath' in VS Code settings, or ensure one of these exists:`,
        ...getAutoDetectCandidates(cwd).map((candidate) => `- ${candidate}`),
        `Or make sure 'retentia' (or legacy 'codex-mem') is on PATH.`
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
        `retentia command failed (exit ${code}).\n${stderr || stdout}`;
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
      return { command: process.execPath, baseArgs: [script] };
    }

    return { command: configured, baseArgs: [] };
  }

  const localScript = join(workspaceRoot, "dist", "cli.js");
  if (fileExists(localScript)) {
    return { command: process.execPath, baseArgs: [localScript] };
  }

  for (const candidate of getAutoDetectCandidates(workspaceRoot)) {
    if (fileExists(candidate)) {
      return { command: process.execPath, baseArgs: [candidate] };
    }
  }

  return { command: "retentia", baseArgs: [] };
}

function getAutoDetectCandidates(workspaceRoot: string): string[] {
  const candidates = [
    join(workspaceRoot, "..", "dist", "cli.js"),
    join(workspaceRoot, "retentia", "dist", "cli.js"),
    join(workspaceRoot, "..", "retentia", "dist", "cli.js"),
    join(workspaceRoot, "..", "..", "retentia", "dist", "cli.js"),
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
  const ingestion = await syncTaskExecutions({ force: false });
  const [statusPayload, recentPayload, executionPayload] = await Promise.all([
    runCliJson(["kpis"]),
    runCliJson(["search", "--limit", "8"]),
    runCliJson(["execution-report", "--limit", String(getExecutionReportLimit())])
  ]);

  const statusRoot = toRecord(statusPayload);
  const worker = toRecord(statusRoot.worker);
  const kpis = toRecord(statusRoot.kpis);
  const recentRoot = toRecord(recentPayload);
  const executionRoot = toRecord(executionPayload);
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

  const execution = mapExecutionReport(executionRoot);

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
    ingestion,
    execution,
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
    ingestion: {
      autoSyncEnabled: true,
      detectedTasks: 0,
      importedTasks: 0,
      skippedTasks: 0,
      failedTasks: 0,
      byProvider: []
    },
    execution: {
      total: 0,
      projects: [],
      providers: [],
      agents: [],
      models: [],
      statuses: [],
      tasks: []
    },
    recentTasks: [],
    error
  };
}

async function syncTaskExecutions(options: { force: boolean }): Promise<TaskSyncMetrics> {
  const autoSyncEnabled = isAutoSyncEnabled();
  if (!options.force && !autoSyncEnabled) {
    return {
      autoSyncEnabled,
      detectedTasks: 0,
      importedTasks: 0,
      skippedTasks: 0,
      failedTasks: 0,
      byProvider: []
    };
  }

  const args = ["sync-tasks"];
  const providers = getEnabledProviders();
  if (providers.length > 0) {
    args.push("--providers", providers.join(","));
  }

  args.push("--lookback-days", String(getAutoSyncLookbackDays()));
  args.push("--max-import", String(getAutoSyncMaxImport()));
  args.push("--max-files", String(getAutoSyncMaxFiles()));

  const defaultProject = getDefaultProject();
  if (defaultProject) {
    args.push("--project", defaultProject);
  }

  const codexPath = getPathSetting("codexSessionsPath");
  const claudePath = getPathSetting("claudeSessionsPath");
  const qwenPath = getPathSetting("qwenSessionsPath");
  const gwenPath = getPathSetting("gwenSessionsPath");
  if (codexPath) {
    args.push("--codex-path", codexPath);
  }
  if (claudePath) {
    args.push("--claude-path", claudePath);
  }
  if (qwenPath) {
    args.push("--qwen-path", qwenPath);
  }
  if (gwenPath) {
    args.push("--gwen-path", gwenPath);
  }

  const result = toRecord(await runCliJson(args));
  return {
    autoSyncEnabled,
    detectedTasks: toNumber(result.detectedTasks) ?? 0,
    importedTasks: toNumber(result.importedTasks) ?? 0,
    skippedTasks: toNumber(result.skippedTasks) ?? 0,
    failedTasks: toNumber(result.failedTasks) ?? 0,
    newestTaskAt: toText(result.newestTaskAt),
    byProvider: mapProviderSyncList(result.byProvider)
  };
}

function isAutoSyncEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("codexMem")
    .get<boolean>("autoSyncCodexTasks", true);
}

function getAutoSyncMaxImport(): number {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<number>("autoSyncMaxImport", DEFAULT_AUTO_SYNC_MAX_IMPORT);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_MAX_IMPORT;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 1000);
}

function getAutoSyncMaxFiles(): number {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<number>("autoSyncMaxFiles", DEFAULT_AUTO_SYNC_MAX_FILES);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_MAX_FILES;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 200);
}

function getAutoSyncLookbackDays(): number {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<number>("autoSyncLookbackDays", DEFAULT_AUTO_SYNC_LOOKBACK_DAYS);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_AUTO_SYNC_LOOKBACK_DAYS;
  }
  return Math.min(Math.max(Math.floor(configured), 1), 30);
}

function getEnabledProviders(): string[] {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<string[]>("enabledProviders", ["codex", "claude", "qwen", "gwen"]);

  if (!Array.isArray(configured) || configured.length === 0) {
    return ["codex", "claude", "qwen", "gwen"];
  }

  const allowed = new Set(["codex", "claude", "qwen", "gwen", "all"]);
  const normalized = [...new Set(configured.map((item) => item.toLowerCase().trim()))].filter(
    (item) => allowed.has(item)
  );
  return normalized.length > 0 ? normalized : ["codex", "claude", "qwen", "gwen"];
}

function getPathSetting(key: string): string | undefined {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<string>(key, "")
    .trim();
  return configured || undefined;
}

function getExecutionReportLimit(): number {
  const configured = vscode.workspace
    .getConfiguration("codexMem")
    .get<number>("executionReportLimit", DEFAULT_EXECUTION_REPORT_LIMIT);
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_EXECUTION_REPORT_LIMIT;
  }
  return Math.min(Math.max(Math.floor(configured), 50), 5000);
}

function mapProviderSyncList(value: unknown): TaskSyncMetrics["byProvider"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      provider: toText(item.provider) || "unknown",
      detected: toNumber(item.detected) ?? 0,
      imported: toNumber(item.imported) ?? 0,
      skipped: toNumber(item.skipped) ?? 0,
      failed: toNumber(item.failed) ?? 0
    }));
}

function mapExecutionReport(root: JsonResult): DashboardData["execution"] {
  return {
    total: toNumber(root.total) ?? 0,
    projects: mapExecutionProjects(root.projects),
    providers: mapExecutionCounts(root.providers),
    agents: mapExecutionCounts(root.agents),
    models: mapExecutionCounts(root.models),
    statuses: mapExecutionCounts(root.statuses),
    tasks: mapExecutionTasks(root.tasks)
  };
}

function mapExecutionProjects(value: unknown): DashboardData["execution"]["projects"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      project: toText(item.project) || "unknown",
      total: toNumber(item.total) ?? 0,
      completed: toNumber(item.completed) ?? 0,
      failed: toNumber(item.failed) ?? 0,
      providers: mapStringList(item.providers),
      agents: mapStringList(item.agents),
      models: mapStringList(item.models),
      latestAt: toText(item.latestAt)
    }));
}

function mapExecutionCounts(value: unknown): Array<{ key: string; count: number }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      key: toText(item.key) || "unknown",
      count: toNumber(item.count) ?? 0
    }));
}

function mapExecutionTasks(value: unknown): DashboardData["execution"]["tasks"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => toRecord(item))
    .map((item) => ({
      id: toNumber(item.id) ?? 0,
      kind: toText(item.kind) || "observation",
      project: toText(item.project) || "unknown",
      sessionId: toText(item.sessionId),
      createdAt: toText(item.createdAt) || "",
      title: toText(item.title) || "(no title)",
      excerpt: toText(item.excerpt) || "",
      provider: toText(item.provider) || "unknown",
      model: toText(item.model) || "unknown",
      agent: toText(item.agent) || "unassigned",
      role: toText(item.role) || "unassigned",
      pipeline: toText(item.pipeline) || "none",
      status: toText(item.status) || "unknown",
      taskId: toText(item.taskId),
      sourceFile: toText(item.sourceFile),
      tags: mapStringList(item.tags)
    }));
}

function mapStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
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
        const inKnownSection = MCP_SERVER_SECTIONS.some(
          (section) => trimmed === `[${section}]`
        );
        if (inKnownSection) {
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

function getQuickInputSidebarHtml(): string {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      :root {
        color-scheme: dark;
        --bg-0: #0f141b;
        --bg-1: #17202b;
        --line: #2b3a4c;
        --fg-0: #edf3fb;
        --fg-1: #a7b8cd;
        --accent: #2ea36c;
        --danger: #c74f3f;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 10px;
        font-family: "Segoe UI", "IBM Plex Sans", sans-serif;
        background: var(--bg-0);
        color: var(--fg-0);
      }

      h2 {
        margin: 0 0 8px;
        font-size: 14px;
      }

      h3 {
        margin: 0 0 8px;
        font-size: 12px;
        color: var(--fg-1);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      section {
        border: 1px solid var(--line);
        background: linear-gradient(170deg, #17202b, #101721);
        border-radius: 10px;
        padding: 10px;
        margin-bottom: 10px;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        font-size: 12px;
        margin-bottom: 6px;
      }

      .row .k {
        color: var(--fg-1);
      }

      .pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }

      .ok {
        background: rgba(46, 163, 108, 0.2);
        color: #81e0b5;
      }

      .warn {
        background: rgba(199, 79, 63, 0.2);
        color: #ffb4a8;
      }

      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
      }

      button {
        border: 1px solid var(--line);
        background: #14202b;
        color: var(--fg-0);
        font-size: 12px;
        border-radius: 8px;
        padding: 6px 8px;
        cursor: pointer;
      }

      button:hover {
        border-color: #3a5370;
      }

      button.primary {
        background: linear-gradient(180deg, #2d8f63, #236f4e);
        border-color: #2d8f63;
      }

      input,
      select,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        background: #0f1722;
        color: var(--fg-0);
        border-radius: 7px;
        padding: 6px 7px;
        font-size: 12px;
        margin-bottom: 6px;
      }

      textarea {
        min-height: 56px;
        resize: vertical;
      }

      .note {
        color: var(--fg-1);
        font-size: 11px;
      }

      .error {
        border: 1px solid rgba(199, 79, 63, 0.5);
        background: rgba(199, 79, 63, 0.1);
        color: #ffb4a8;
        border-radius: 8px;
        padding: 7px 8px;
        font-size: 12px;
        margin-bottom: 10px;
        display: none;
      }
    </style>
  </head>
  <body>
    <div id="error" class="error"></div>

    <section>
      <h2>Retentia Quick Input</h2>
      <div class="row"><span class="k">Worker</span><span id="statusWorker" class="pill warn">Unknown</span></div>
      <div class="row"><span class="k">Entries</span><span id="statusEntries">0</span></div>
      <div class="row"><span class="k">Projects</span><span id="statusProjects">0</span></div>
      <div class="row"><span class="k">DB</span><span id="statusDb">n/a</span></div>
      <div class="row"><span class="k">Updated</span><span id="statusUpdated">n/a</span></div>
      <div class="actions">
        <button data-action="refresh-status">Refresh</button>
        <button data-action="open-dashboard">Dashboard</button>
        <button class="primary" data-action="setup">Setup</button>
        <button data-action="sync-tasks">Sync Tasks</button>
        <button data-action="start-worker">Start Worker</button>
        <button data-action="stop-worker">Stop Worker</button>
        <button data-action="open-settings">Settings</button>
      </div>
      <div class="note" style="margin-top:8px;">Use Setup after first install.</div>
    </section>

    <section>
      <h3>Add Observation</h3>
      <input id="obsProject" type="text" placeholder="Project (optional)" />
      <select id="obsType">
        <option value="note">note</option>
        <option value="bugfix">bugfix</option>
        <option value="feature">feature</option>
        <option value="refactor">refactor</option>
        <option value="discovery">discovery</option>
        <option value="decision">decision</option>
        <option value="change">change</option>
      </select>
      <input id="obsTitle" type="text" placeholder="Title (required)" />
      <textarea id="obsContent" placeholder="Content (required)"></textarea>
      <input id="obsTags" type="text" placeholder="Tags (comma-separated)" />
      <input id="obsFiles" type="text" placeholder="Files (comma-separated)" />
      <button class="primary" id="submitObservation">Save Observation</button>
    </section>

    <section>
      <h3>Add Summary</h3>
      <input id="sumProject" type="text" placeholder="Project (optional)" />
      <textarea id="sumLearned" placeholder="Learned (required)"></textarea>
      <textarea id="sumRequest" placeholder="Request (optional)"></textarea>
      <textarea id="sumCompleted" placeholder="Completed (optional)"></textarea>
      <textarea id="sumNextSteps" placeholder="Next steps (optional)"></textarea>
      <input id="sumTags" type="text" placeholder="Tags (comma-separated)" />
      <button class="primary" id="submitSummary">Save Summary</button>
      <div class="note" style="margin-top:8px;">
        Need CLI path settings? Use command palette: Retentia: Open Settings.
      </div>
    </section>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();

      const statusWorker = document.getElementById("statusWorker");
      const statusEntries = document.getElementById("statusEntries");
      const statusProjects = document.getElementById("statusProjects");
      const statusDb = document.getElementById("statusDb");
      const statusUpdated = document.getElementById("statusUpdated");
      const errorNode = document.getElementById("error");

      function post(command, payload = {}) {
        vscode.postMessage({ command, payload });
      }

      function showError(message) {
        if (!message) {
          errorNode.style.display = "none";
          errorNode.textContent = "";
          return;
        }
        errorNode.style.display = "block";
        errorNode.textContent = String(message);
      }

      function formatDate(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
      }

      for (const button of document.querySelectorAll("button[data-action]")) {
        button.addEventListener("click", () => {
          showError("");
          post(button.getAttribute("data-action") || "");
        });
      }

      document.getElementById("submitObservation").addEventListener("click", () => {
        showError("");
        post("add-observation", {
          project: document.getElementById("obsProject").value,
          type: document.getElementById("obsType").value,
          title: document.getElementById("obsTitle").value,
          content: document.getElementById("obsContent").value,
          tags: document.getElementById("obsTags").value,
          files: document.getElementById("obsFiles").value
        });
      });

      document.getElementById("submitSummary").addEventListener("click", () => {
        showError("");
        post("add-summary", {
          project: document.getElementById("sumProject").value,
          learned: document.getElementById("sumLearned").value,
          request: document.getElementById("sumRequest").value,
          completed: document.getElementById("sumCompleted").value,
          nextSteps: document.getElementById("sumNextSteps").value,
          tags: document.getElementById("sumTags").value
        });
      });

      window.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.command === "status") {
          const payload = message.payload || {};
          const running = payload.workerRunning === true;
          statusWorker.textContent = running ? "Running" : "Stopped";
          statusWorker.className = running ? "pill ok" : "pill warn";
          statusEntries.textContent = String(payload.entriesTotal ?? 0);
          statusProjects.textContent = String(payload.projectsTotal ?? 0);
          statusDb.textContent = String(payload.dataFile ?? "n/a");
          statusUpdated.textContent = formatDate(payload.updatedAt);
          showError("");
          return;
        }

        if (message.command === "clear-observation") {
          document.getElementById("obsTitle").value = "";
          document.getElementById("obsContent").value = "";
          document.getElementById("obsTags").value = "";
          document.getElementById("obsFiles").value = "";
          return;
        }

        if (message.command === "clear-summary") {
          document.getElementById("sumLearned").value = "";
          document.getElementById("sumRequest").value = "";
          document.getElementById("sumCompleted").value = "";
          document.getElementById("sumNextSteps").value = "";
          document.getElementById("sumTags").value = "";
          return;
        }

        if (message.command === "error") {
          showError((message.payload && message.payload.message) || "Unknown error");
        }
      });

      post("refresh-status");
    </script>
  </body>
</html>`;
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
  const providerSyncRows =
    data.ingestion.byProvider.length > 0
      ? data.ingestion.byProvider
          .map(
            (item) => `
              <tr>
                <td>${escapeHtml(item.provider)}</td>
                <td>${item.detected}</td>
                <td>${item.imported}</td>
                <td>${item.skipped}</td>
                <td>${item.failed}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="5" class="muted">No provider data yet.</td></tr>`;
  const projectRows =
    data.execution.projects.length > 0
      ? data.execution.projects
          .map(
            (project) => `
              <tr data-project="${escapeHtml(project.project)}">
                <td>${escapeHtml(project.project)}</td>
                <td>${project.total}</td>
                <td>${project.completed}</td>
                <td>${project.failed}</td>
                <td>${escapeHtml(project.providers.slice(0, 3).join(", ") || "n/a")}</td>
                <td>${escapeHtml(formatIso(project.latestAt))}</td>
              </tr>
            `
          )
          .join("")
      : `<tr><td colspan="6" class="muted">No project execution data yet.</td></tr>`;
  const providerBars = renderBars(data.execution.providers, "provider");
  const agentBars = renderBars(data.execution.agents, "agent");
  const modelBars = renderBars(data.execution.models, "model");
  const statusBars = renderBars(data.execution.statuses, "status");
  const taskDataJson = toScriptJson(data.execution.tasks);

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
    <title>Retentia Dashboard</title>
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
        grid-template-columns: repeat(6, minmax(140px, 1fr));
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
        grid-template-columns: 1.1fr 1fr;
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

      .subgrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(140px, 1fr));
        gap: 6px 8px;
        font-size: 12px;
      }

      .bars {
        display: grid;
        gap: 8px;
      }

      .bar {
        display: grid;
        grid-template-columns: 120px 1fr 46px;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }

      .bar-key {
        color: var(--fg-1);
      }

      .bar-track {
        height: 9px;
        border-radius: 999px;
        background: rgba(188, 204, 221, 0.15);
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #2b8a3e, #59d089);
      }

      .bar-val {
        text-align: right;
      }

      .table-wrap {
        overflow: auto;
        border: 1px solid var(--line);
        border-radius: 10px;
        margin-top: 6px;
      }

      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }

      th,
      td {
        padding: 8px 9px;
        border-bottom: 1px solid rgba(188, 204, 221, 0.1);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--fg-1);
        position: sticky;
        top: 0;
        background: #121a24;
        z-index: 1;
      }

      tr[data-project] {
        cursor: pointer;
      }

      tr[data-project]:hover {
        background: rgba(255, 255, 255, 0.04);
      }

      .muted {
        color: var(--fg-1);
      }

      .filter-row {
        display: grid;
        grid-template-columns: repeat(5, minmax(120px, 1fr));
        gap: 8px;
        margin-top: 6px;
      }

      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #121a24;
        color: var(--fg-0);
        padding: 6px 8px;
        font-size: 12px;
      }

      .task-counter {
        margin-top: 8px;
        color: var(--fg-1);
        font-size: 12px;
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
        .filter-row {
          grid-template-columns: repeat(2, minmax(120px, 1fr));
        }
        .bar {
          grid-template-columns: 90px 1fr 40px;
        }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="topbar">
        <div>
          <div class="title">Retentia Dashboard</div>
          <div class="subtitle">Updated ${escapeHtml(formatIso(data.generatedAt))}</div>
        </div>
        <div class="actions">
          <button data-cmd="refresh">Refresh</button>
          <button data-cmd="setup">Setup</button>
          <button data-cmd="sync-tasks">Sync LLM Tasks</button>
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
        <article class="card">
          <div class="label">Synced (Refresh)</div>
          <div class="value">${data.ingestion.importedTasks}</div>
        </article>
        <article class="card">
          <div class="label">Detected (Recent)</div>
          <div class="value">${data.ingestion.detectedTasks}</div>
        </article>
        <article class="card">
          <div class="label">Providers</div>
          <div class="value">${data.execution.providers.length}</div>
        </article>
        <article class="card">
          <div class="label">Agents</div>
          <div class="value">${data.execution.agents.length}</div>
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
            <div class="k">Auto Sync</div><div>${data.ingestion.autoSyncEnabled ? "Enabled" : "Disabled"}</div>
            <div class="k">Sync Imported</div><div>${data.ingestion.importedTasks}</div>
            <div class="k">Sync Skipped</div><div>${data.ingestion.skippedTasks}</div>
            <div class="k">Sync Errors</div><div>${data.ingestion.failedTasks}</div>
            <div class="k">Newest Task</div><div>${escapeHtml(formatIso(data.ingestion.newestTaskAt))}</div>
          </div>
          <h3 style="margin-top:14px;">Provider Sync</h3>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Provider</th><th>Detected</th><th>Imported</th><th>Skipped</th><th>Failed</th></tr>
              </thead>
              <tbody>${providerSyncRows}</tbody>
            </table>
          </div>
        </article>
        <article class="panel">
          <h3>Recent Tasks Executed</h3>
          <ul class="tasks">${recentItems}</ul>
        </article>
      </section>

      <section class="panels" style="margin-top:12px;">
        <article class="panel">
          <h3>Execution Visualizer</h3>
          <div class="subgrid">
            <div>
              <div class="label">By Provider</div>
              <div class="bars">${providerBars}</div>
            </div>
            <div>
              <div class="label">By Status</div>
              <div class="bars">${statusBars}</div>
            </div>
            <div>
              <div class="label">By Agent</div>
              <div class="bars">${agentBars}</div>
            </div>
            <div>
              <div class="label">By Model</div>
              <div class="bars">${modelBars}</div>
            </div>
          </div>
        </article>
        <article class="panel">
          <h3>Project Explorer</h3>
          <div class="table-wrap">
            <table id="projectTable">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Total</th>
                  <th>Done</th>
                  <th>Failed</th>
                  <th>Providers</th>
                  <th>Latest</th>
                </tr>
              </thead>
              <tbody>${projectRows}</tbody>
            </table>
          </div>
        </article>
      </section>

      <section class="panel" style="margin-top:12px;">
        <h3>Task Explorer</h3>
        <div class="filter-row">
          <select id="filter-project"></select>
          <select id="filter-provider"></select>
          <select id="filter-agent"></select>
          <select id="filter-model"></select>
          <select id="filter-status"></select>
        </div>
        <div class="task-counter" id="taskCounter"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Project</th>
                <th>Provider</th>
                <th>Model</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Task</th>
              </tr>
            </thead>
            <tbody id="taskRows">
              <tr><td colspan="7" class="muted">No task execution data available yet.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const ALL_TASKS = ${taskDataJson};

      for (const button of document.querySelectorAll("button[data-cmd]")) {
        button.addEventListener("click", () => {
          vscode.postMessage({ command: button.getAttribute("data-cmd") });
        });
      }

      const filters = {
        project: document.getElementById("filter-project"),
        provider: document.getElementById("filter-provider"),
        agent: document.getElementById("filter-agent"),
        model: document.getElementById("filter-model"),
        status: document.getElementById("filter-status")
      };
      const taskRows = document.getElementById("taskRows");
      const taskCounter = document.getElementById("taskCounter");

      function uniqueSorted(values) {
        return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
      }

      function initFilter(select, values, label) {
        const options = ['<option value="">' + escape(label) + ': all</option>'];
        for (const value of values) {
          options.push(
            '<option value="' + escape(value) + '">' + escape(value) + '</option>'
          );
        }
        select.innerHTML = options.join("");
      }

      function escape(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function formatWhen(value) {
        if (!value) return "n/a";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function renderTasks() {
        const filtered = ALL_TASKS.filter((task) => {
          if (filters.project.value && task.project !== filters.project.value) return false;
          if (filters.provider.value && task.provider !== filters.provider.value) return false;
          if (filters.agent.value && task.agent !== filters.agent.value) return false;
          if (filters.model.value && task.model !== filters.model.value) return false;
          if (filters.status.value && task.status !== filters.status.value) return false;
          return true;
        });

        taskCounter.textContent =
          "Showing " + filtered.length + " of " + ALL_TASKS.length + " tasks";

        if (filtered.length === 0) {
          taskRows.innerHTML =
            '<tr><td colspan="7" class="muted">No tasks match current filters.</td></tr>';
          return;
        }

        const rows = filtered
          .slice(0, 300)
          .map(
            (task) =>
              "<tr>" +
              "<td>" + escape(formatWhen(task.createdAt)) + "</td>" +
              "<td>" + escape(task.project) + "</td>" +
              "<td>" + escape(task.provider) + "</td>" +
              "<td>" + escape(task.model) + "</td>" +
              "<td>" + escape(task.agent) + "</td>" +
              "<td>" + escape(task.status) + "</td>" +
              '<td title="' + escape(task.excerpt || "") + '">' + escape(task.title) + "</td>" +
              "</tr>"
          )
          .join("");

        taskRows.innerHTML = rows;
      }

      initFilter(filters.project, uniqueSorted(ALL_TASKS.map((item) => item.project)), "Project");
      initFilter(filters.provider, uniqueSorted(ALL_TASKS.map((item) => item.provider)), "Provider");
      initFilter(filters.agent, uniqueSorted(ALL_TASKS.map((item) => item.agent)), "Agent");
      initFilter(filters.model, uniqueSorted(ALL_TASKS.map((item) => item.model)), "Model");
      initFilter(filters.status, uniqueSorted(ALL_TASKS.map((item) => item.status)), "Status");

      for (const filter of Object.values(filters)) {
        filter.addEventListener("change", renderTasks);
      }

      for (const row of document.querySelectorAll("#projectTable tr[data-project]")) {
        row.addEventListener("click", () => {
          const project = row.getAttribute("data-project") || "";
          filters.project.value = project;
          renderTasks();
        });
      }

      renderTasks();
    </script>
  </body>
</html>`;
}

function renderBars(
  items: Array<{ key: string; count: number }>,
  label: string
): string {
  if (items.length === 0) {
    return `<div class="muted">No ${escapeHtml(label)} data</div>`;
  }

  const maxCount = Math.max(...items.map((item) => item.count), 1);
  return items
    .slice(0, 8)
    .map((item) => {
      const width = Math.round((item.count / maxCount) * 100);
      return `
        <div class="bar">
          <div class="bar-key">${escapeHtml(item.key)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
          <div class="bar-val">${item.count}</div>
        </div>
      `;
    })
    .join("");
}

function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
