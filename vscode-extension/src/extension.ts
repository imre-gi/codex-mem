import { accessSync, constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import * as vscode from "vscode";

interface JsonResult {
  [key: string]: unknown;
}

interface CliResolution {
  command: string;
  baseArgs: string[];
}

const OUTPUT = vscode.window.createOutputChannel("Codex Mem");

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(OUTPUT);
  OUTPUT.appendLine("Codex Mem extension activated.");

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
