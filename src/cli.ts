#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildContextPack } from "./context-pack.js";
import { buildExecutionReport } from "./execution-report.js";
import { startMcpServer } from "./mcp-server.js";
import { MemoryStore } from "./store.js";
import { syncTaskExecutions, type LlmProvider } from "./task-sync.js";
import { startWorkerService } from "./worker-service.js";
import { WorkerManager } from "./worker-manager.js";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  getWorkerBaseUrl
} from "./worker-config.js";

interface ParsedArgs {
  positional: string[];
  options: Record<string, string | boolean>;
}

interface CodexRunner {
  command: string;
  prefixArgs: string[];
  label: string;
}

interface CodexMcpServerConfig {
  name: string;
  transport?: {
    type?: string;
    command?: string;
    args?: string[];
  };
}

const APP_NAME = "retentia";
const LEGACY_APP_NAME = "codex-mem";
const DEFAULT_MCP_SERVER_NAME = "retentia";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command = "mcp"] = parsed.positional;
  const dataFile = getOptionalString(parsed.options["data-file"]);
  const host = getOptionalString(parsed.options.host) || DEFAULT_WORKER_HOST;
  const port = getOptionalNumber(parsed.options.port) || DEFAULT_WORKER_PORT;
  const scriptPath = resolve(process.argv[1] || "");

  const manager = new WorkerManager({
    host,
    port,
    dataFile,
    scriptPath
  });

  switch (command) {
    case "setup": {
      await handleSetupCommand(parsed, scriptPath, host, port, dataFile, manager);
      return;
    }

    case "enable": {
      const result = await ensureEnabled(parsed, scriptPath, host, port, dataFile);
      printJson(result);
      return;
    }

    case "mcp": {
      await manager.start();
      await startMcpServer({
        workerHost: host,
        workerPort: port
      });
      return;
    }

    case "worker": {
      await handleWorkerCommand(parsed, manager, { host, port, dataFile });
      return;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      await handleStoreCommand(parsed, command, dataFile, manager);
      return;
  }
}

async function handleSetupCommand(
  parsed: ParsedArgs,
  scriptPath: string,
  host: string,
  port: number,
  dataFile: string | undefined,
  manager: WorkerManager
): Promise<void> {
  const enableResult = await ensureEnabled(parsed, scriptPath, host, port, dataFile);
  const workerStatus = await manager.start();
  printJson({
    ok: true,
    setup: true,
    enable: enableResult,
    worker: workerStatus,
    message: "Setup complete. You can now run `codex` directly."
  });
}

async function ensureEnabled(
  parsed: ParsedArgs,
  scriptPath: string,
  host: string,
  port: number,
  dataFile: string | undefined
): Promise<Record<string, unknown>> {
  const name = getOptionalString(parsed.options.name) || DEFAULT_MCP_SERVER_NAME;
  const runner = resolveCodexRunner();
  const addArgs = [
    "mcp",
    "add",
    name,
    "--",
    "node",
    scriptPath,
    "mcp",
    "--host",
    host,
    "--port",
    String(port),
    ...(dataFile ? ["--data-file", dataFile] : [])
  ];

  const listResult = runCodexCommand(runner, ["mcp", "list", "--json"]);
  const configured = parseCodexMcpList(listResult.stdout).find((item) => item.name === name);
  const targetArgs = [
    scriptPath,
    "mcp",
    "--host",
    host,
    "--port",
    String(port),
    ...(dataFile ? ["--data-file", dataFile] : [])
  ];
  const alreadyConfigured =
    configured?.transport?.type === "stdio" &&
    configured.transport.command === "node" &&
    JSON.stringify(configured.transport.args || []) === JSON.stringify(targetArgs);

  if (alreadyConfigured) {
    return {
      ok: true,
      enabled: true,
      changed: false,
      name,
      using: runner.label,
      message: `${APP_NAME} MCP server already configured`
    };
  }

  if (configured) {
    runCodexCommand(runner, ["mcp", "remove", name]);
  }

  runCodexCommand(runner, addArgs);
  return {
    ok: true,
    enabled: true,
    changed: true,
    name,
    using: runner.label,
    command: [runner.command, ...runner.prefixArgs, ...addArgs].join(" ")
  };
}

async function handleWorkerCommand(
  parsed: ParsedArgs,
  manager: WorkerManager,
  options: { host: string; port: number; dataFile?: string }
): Promise<void> {
  const action = parsed.positional[1] || "status";

  switch (action) {
    case "start":
      printJson(await manager.start());
      return;

    case "stop":
      await manager.stop();
      printJson({ ok: true, message: "worker stopped" });
      return;

    case "restart":
      printJson(await manager.restart());
      return;

    case "status":
      printJson(await manager.status());
      return;

    case "run": {
      const instance = await startWorkerService(options);
      printJson({
        ok: true,
        mode: "foreground",
        host: instance.host,
        port: instance.port,
        baseUrl: getWorkerBaseUrl(instance.host, instance.port)
      });
      await new Promise<void>(() => {
        // keep process alive until externally terminated
      });
      return;
    }

    default:
      throw new Error(`Unknown worker action: ${action}`);
  }
}

async function handleStoreCommand(
  parsed: ParsedArgs,
  command: string,
  dataFile: string | undefined,
  manager: WorkerManager
): Promise<void> {
  const store = new MemoryStore(dataFile);

  try {
    switch (command) {
      case "init": {
        printJson({
          ok: true,
          dataFile: store.getDataFilePath(),
          worker: await manager.status(),
          message: `${APP_NAME} store is ready`
        });
        return;
      }

      case "kpis": {
        printJson({
          ok: true,
          dataFile: store.getDataFilePath(),
          worker: await manager.status(),
          kpis: store.getKpis()
        });
        return;
      }

      case "add-observation": {
        const title = getRequiredString(parsed.options.title, "--title");
        const content = getRequiredString(parsed.options.content, "--content");
        const saved = store.addObservation({
          project: getOptionalString(parsed.options.project),
          sessionId: getOptionalString(parsed.options["session-id"]),
          externalKey: getOptionalString(parsed.options["external-key"]),
          observationType: getOptionalString(parsed.options.type) as
            | "bugfix"
            | "feature"
            | "refactor"
            | "discovery"
            | "decision"
            | "change"
            | "note"
            | undefined,
          title,
          content,
          tags: getCsvList(parsed.options.tags),
          files: getCsvList(parsed.options.files)
        });
        printJson(saved);
        return;
      }

      case "add-summary": {
        const learned = getRequiredString(parsed.options.learned, "--learned");
        const saved = store.addSummary({
          project: getOptionalString(parsed.options.project),
          sessionId: getOptionalString(parsed.options["session-id"]),
          externalKey: getOptionalString(parsed.options["external-key"]),
          request: getOptionalString(parsed.options.request),
          investigated: getOptionalString(parsed.options.investigated),
          learned,
          completed: getOptionalString(parsed.options.completed),
          nextSteps: getOptionalString(parsed.options["next-steps"]),
          tags: getCsvList(parsed.options.tags),
          filesRead: getCsvList(parsed.options["files-read"]),
          filesEdited: getCsvList(parsed.options["files-edited"])
        });
        printJson(saved);
        return;
      }

      case "search": {
        const results = store.search({
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit)
        });
        printJson({ total: results.length, results });
        return;
      }

      case "timeline": {
        const timeline = store.timeline({
          id: getOptionalNumber(parsed.options.id),
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          before: getOptionalNumber(parsed.options.before),
          after: getOptionalNumber(parsed.options.after)
        });
        printJson(timeline);
        return;
      }

      case "get": {
        const ids = getCsvList(parsed.options.ids).map((value) => Number(value));
        const clean = ids.filter((value) => !Number.isNaN(value));
        if (clean.length === 0) {
          throw new Error("--ids is required (comma-separated numeric ids).");
        }

        const entries = store.getEntries(clean);
        printJson({ total: entries.length, entries });
        return;
      }

      case "context": {
        const context = buildContextPack(store, {
          query: getOptionalString(parsed.options.query),
          project: getOptionalString(parsed.options.project),
          limit: getOptionalNumber(parsed.options.limit),
          fullCount: getOptionalNumber(parsed.options["full-count"])
        });
        process.stdout.write(`${context}\n`);
        return;
      }

      case "list-projects":
        printJson({ projects: store.listProjects() });
        return;

      case "list-entries": {
        const entries = store.listEntries({
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
          offset: getOptionalNumber(parsed.options.offset)
        });
        printJson({ total: entries.length, entries });
        return;
      }

      case "execution-report": {
        const entries = store.listEntries({
          project: getOptionalString(parsed.options.project),
          kind: getOptionalString(parsed.options.kind) as
            | "observation"
            | "summary"
            | undefined,
          since: getOptionalString(parsed.options.since),
          until: getOptionalString(parsed.options.until),
          limit: getOptionalNumber(parsed.options.limit),
          offset: getOptionalNumber(parsed.options.offset)
        });
        const report = buildExecutionReport(entries);
        printJson(report);
        return;
      }

      case "sync-tasks": {
        const rawProviders = getCsvList(parsed.options.providers);
        const providers = normalizeProviders(rawProviders);
        const result = syncTaskExecutions(store, {
          providers,
          codexPath: getOptionalString(parsed.options["codex-path"]),
          claudePath: getOptionalString(parsed.options["claude-path"]),
          qwenPath: getOptionalString(parsed.options["qwen-path"]),
          gwenPath: getOptionalString(parsed.options["gwen-path"]),
          lookbackDays: getOptionalNumber(parsed.options["lookback-days"]),
          maxFilesPerProvider: getOptionalNumber(parsed.options["max-files"]),
          maxImport: getOptionalNumber(parsed.options["max-import"]),
          fallbackProject:
            getOptionalString(parsed.options.project) || basenameSafe(process.cwd())
        });
        printJson(result);
        return;
      }

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positional, options };
}

function getRequiredString(value: string | boolean | undefined, flag: string): string {
  const normalized = getOptionalString(value);
  if (!normalized) {
    throw new Error(`${flag} is required.`);
  }

  return normalized;
}

function getOptionalString(value: string | boolean | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function getOptionalNumber(value: string | boolean | undefined): number | undefined {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function getCsvList(value: string | boolean | undefined): string[] {
  const normalized = getOptionalString(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProviders(rawProviders: string[]): LlmProvider[] {
  if (rawProviders.length === 0) {
    return ["codex", "claude", "qwen", "gwen"];
  }

  const expanded = rawProviders
    .flatMap((value) => value.trim().toLowerCase())
    .flatMap((value) =>
      value === "all" ? ["codex", "claude", "qwen", "gwen"] : [value]
    );
  const allowed = new Set<LlmProvider>(["codex", "claude", "qwen", "gwen"]);
  const deduped = [...new Set(expanded)].filter((value): value is LlmProvider =>
    allowed.has(value as LlmProvider)
  );

  return deduped.length > 0 ? deduped : ["codex", "claude", "qwen", "gwen"];
}

function basenameSafe(path: string): string {
  const name = basename(path).trim();
  return name || "project";
}

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHelp(): void {
  const lines = [
    `${APP_NAME}: persistent memory plugin for Codex via MCP + worker service`,
    "",
    "Usage:",
    `  ${APP_NAME} setup [--name <mcp-name>] [--host <host>] [--port <port>] [--data-file <path>]`,
    `  ${APP_NAME} enable [--name <mcp-name>] [--host <host>] [--port <port>] [--data-file <path>]`,
    `  ${APP_NAME} mcp [--host <host>] [--port <port>] [--data-file <path>]`,
    `  ${APP_NAME} worker <start|stop|restart|status|run> [--host <host>] [--port <port>] [--data-file <path>]`,
    `  ${APP_NAME} init [--data-file <path>]`,
    `  ${APP_NAME} kpis [--data-file <path>] [--host <host>] [--port <port>]`,
    `  ${APP_NAME} add-observation --title <text> --content <text> [--type <bugfix|feature|...>]`,
    `  ${APP_NAME} add-summary --learned <text> [--request <text>] [--next-steps <text>]`,
    `  ${APP_NAME} sync-tasks [--providers codex,claude,qwen,gwen|all] [--lookback-days <n>] [--max-import <n>]`,
    `  ${APP_NAME} search [--query <text>] [--project <name>] [--kind <observation|summary>]`,
    `  ${APP_NAME} timeline [--id <number> | --query <text>] [--before <n>] [--after <n>]`,
    `  ${APP_NAME} get --ids 1,2,3`,
    `  ${APP_NAME} context [--query <text>] [--full-count <n>]`,
    `  ${APP_NAME} list-projects`,
    `  ${APP_NAME} list-entries [--project <name>] [--kind <observation|summary>] [--limit <n>] [--offset <n>]`,
    `  ${APP_NAME} execution-report [--project <name>] [--limit <n>] [--offset <n>]`,
    "",
    "Global options:",
    "  --data-file <path>   Override SQLite DB path (default: ~/.retentia/retentia.db)",
    "  --host <host>        Worker host (default: 127.0.0.1)",
    "  --port <port>        Worker port (default: 37777)",
    `  --name <mcp-name>    MCP server name used by \`enable\` (default: ${DEFAULT_MCP_SERVER_NAME})`,
    "",
    `Compatibility: legacy command alias \`${LEGACY_APP_NAME}\` is still supported.`
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveCodexRunner(): CodexRunner {
  if (commandExists("codex")) {
    return {
      command: "codex",
      prefixArgs: [],
      label: "codex"
    };
  }

  if (commandExists("npx")) {
    return {
      command: "npx",
      prefixArgs: ["--yes", "@openai/codex"],
      label: "npx @openai/codex"
    };
  }

  throw new Error(
    "Neither `codex` nor `npx` is available. Install @openai/codex or ensure npx is on PATH."
  );
}

function commandExists(command: string): boolean {
  const check = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !check.error && check.status === 0;
}

function runCodexCommand(
  runner: CodexRunner,
  args: string[]
): { stdout: string; stderr: string } {
  const result = spawnSync(runner.command, [...runner.prefixArgs, ...args], {
    encoding: "utf8"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      [
        `Codex command failed: ${runner.command} ${[...runner.prefixArgs, ...args].join(" ")}`,
        result.stderr?.trim(),
        result.stdout?.trim()
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

function parseCodexMcpList(json: string): CodexMcpServerConfig[] {
  if (!json.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as CodexMcpServerConfig[];
  } catch {
    return [];
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${APP_NAME} error: ${message}\n`);
  process.exit(1);
});
