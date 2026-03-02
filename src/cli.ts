#!/usr/bin/env node
import { buildContextPack } from "./context-pack.js";
import { startMcpServer } from "./mcp-server.js";
import { MemoryStore } from "./store.js";

interface ParsedArgs {
  positional: string[];
  options: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command = "mcp"] = parsed.positional;
  const dataFile = getOptionalString(parsed.options["data-file"]);
  const store = new MemoryStore(dataFile);

  switch (command) {
    case "mcp":
      await startMcpServer({ dataFile: store.getDataFilePath() });
      return;

    case "init":
      printJson({
        ok: true,
        dataFile: store.getDataFilePath(),
        message: "codex-mem store is ready"
      });
      return;

    case "add-observation": {
      const title = getRequiredString(parsed.options.title, "--title");
      const content = getRequiredString(parsed.options.content, "--content");
      const saved = store.addObservation({
        project: getOptionalString(parsed.options.project),
        sessionId: getOptionalString(parsed.options["session-id"]),
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

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      throw new Error(`Unknown command: ${command}`);
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

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printHelp(): void {
  const lines = [
    "codex-mem: persistent memory plugin for Codex via MCP",
    "",
    "Usage:",
    "  codex-mem mcp",
    "  codex-mem init [--data-file <path>]",
    "  codex-mem add-observation --title <text> --content <text> [--type <bugfix|feature|...>]",
    "  codex-mem add-summary --learned <text> [--request <text>] [--next-steps <text>]",
    "  codex-mem search [--query <text>] [--project <name>] [--kind <observation|summary>]",
    "  codex-mem timeline [--id <number> | --query <text>] [--before <n>] [--after <n>]",
    "  codex-mem get --ids 1,2,3",
    "  codex-mem context [--query <text>] [--full-count <n>]",
    "  codex-mem list-projects",
    "",
    "Global options:",
    "  --data-file <path>   Override storage file (default: ~/.codex-mem/memory.json)"
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`codex-mem error: ${message}\n`);
  process.exit(1);
});
