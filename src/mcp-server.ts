import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryServiceClient } from "./service-client.js";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  getWorkerBaseUrl
} from "./worker-config.js";
import type { EntryKind, ObservationType } from "./types.js";

const OBSERVATION_TYPES: ObservationType[] = [
  "bugfix",
  "feature",
  "refactor",
  "discovery",
  "decision",
  "change",
  "note"
];

const ENTRY_KINDS: EntryKind[] = ["observation", "summary"];

export interface StartMcpServerOptions {
  workerUrl?: string;
  workerHost?: string;
  workerPort?: number;
}

export async function startMcpServer(
  options: StartMcpServerOptions = {}
): Promise<void> {
  const workerUrl =
    options.workerUrl ||
    getWorkerBaseUrl(
      options.workerHost || DEFAULT_WORKER_HOST,
      options.workerPort || DEFAULT_WORKER_PORT
    );

  const client = new MemoryServiceClient(workerUrl);

  const server = new Server(
    {
      name: "codex-mem",
      version: "0.2.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "mem_add_observation",
        description:
          "Save a concrete observation from the current coding session (bugfix, decision, discovery, etc).",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            sessionId: { type: "string" },
            externalKey: { type: "string" },
            observationType: {
              type: "string",
              enum: OBSERVATION_TYPES
            },
            title: { type: "string" },
            content: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            files: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["title", "content"]
        }
      },
      {
        name: "mem_add_summary",
        description:
          "Save an end-of-task summary to preserve what was learned and what should happen next.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            sessionId: { type: "string" },
            externalKey: { type: "string" },
            request: { type: "string" },
            investigated: { type: "string" },
            learned: { type: "string" },
            completed: { type: "string" },
            nextSteps: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" }
            },
            filesRead: {
              type: "array",
              items: { type: "string" }
            },
            filesEdited: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["learned"]
        }
      },
      {
        name: "mem_search",
        description:
          "Search memory with lightweight indexed results (ID, title, excerpt, score).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            kind: {
              type: "string",
              enum: ENTRY_KINDS
            },
            since: {
              type: "string",
              description: "ISO-8601 timestamp"
            },
            until: {
              type: "string",
              description: "ISO-8601 timestamp"
            },
            limit: { type: "number" }
          }
        }
      },
      {
        name: "mem_timeline",
        description:
          "Fetch chronological context around a specific memory ID (or around the best match for a query).",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            query: { type: "string" },
            project: { type: "string" },
            before: { type: "number" },
            after: { type: "number" }
          }
        }
      },
      {
        name: "mem_get_entries",
        description: "Fetch full memory entries by ID.",
        inputSchema: {
          type: "object",
          properties: {
            ids: {
              type: "array",
              items: { type: "number" }
            }
          },
          required: ["ids"]
        }
      },
      {
        name: "mem_context_pack",
        description:
          "Build a compact context block with an index and expanded top entries for prompt priming.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            project: { type: "string" },
            limit: { type: "number" },
            fullCount: { type: "number" }
          }
        }
      },
      {
        name: "mem_list_projects",
        description: "List known project names in memory.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return handleToolCall(request, client);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function handleToolCall(
  request: CallToolRequest,
  client: MemoryServiceClient
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const toolName = request.params.name;
    const args = toRecord(request.params.arguments);

    switch (toolName) {
      case "mem_add_observation": {
        const title = getString(args, "title", true);
        const content = getString(args, "content", true);
        const observationTypeRaw = getString(args, "observationType", false);
        const observationType = OBSERVATION_TYPES.includes(
          observationTypeRaw as ObservationType
        )
          ? (observationTypeRaw as ObservationType)
          : undefined;

        const saved = await client.addObservation({
          project: getString(args, "project", false) || undefined,
          sessionId: getString(args, "sessionId", false) || undefined,
          externalKey: getString(args, "externalKey", false) || undefined,
          observationType,
          title,
          content,
          tags: getStringArray(args, "tags"),
          files: getStringArray(args, "files")
        });

        return textResult(saved);
      }

      case "mem_add_summary": {
        const learned = getString(args, "learned", true);
        const saved = await client.addSummary({
          project: getString(args, "project", false) || undefined,
          sessionId: getString(args, "sessionId", false) || undefined,
          externalKey: getString(args, "externalKey", false) || undefined,
          request: getString(args, "request", false) || undefined,
          investigated: getString(args, "investigated", false) || undefined,
          learned,
          completed: getString(args, "completed", false) || undefined,
          nextSteps: getString(args, "nextSteps", false) || undefined,
          tags: getStringArray(args, "tags"),
          filesRead: getStringArray(args, "filesRead"),
          filesEdited: getStringArray(args, "filesEdited")
        });

        return textResult(saved);
      }

      case "mem_search": {
        const results = await client.search({
          query: getString(args, "query", false) || undefined,
          project: getString(args, "project", false) || undefined,
          kind: getKind(args),
          since: getString(args, "since", false) || undefined,
          until: getString(args, "until", false) || undefined,
          limit: getNumber(args, "limit")
        });

        return textResult(results);
      }

      case "mem_timeline": {
        const timeline = await client.timeline({
          id: getNumber(args, "id"),
          query: getString(args, "query", false) || undefined,
          project: getString(args, "project", false) || undefined,
          before: getNumber(args, "before"),
          after: getNumber(args, "after")
        });

        return textResult(timeline);
      }

      case "mem_get_entries": {
        const ids = getNumberArray(args, "ids", true);
        const entries = await client.getEntries(ids);
        return textResult(entries);
      }

      case "mem_context_pack": {
        const context = await client.contextPack({
          query: getString(args, "query", false) || undefined,
          project: getString(args, "project", false) || undefined,
          limit: getNumber(args, "limit"),
          fullCount: getNumber(args, "fullCount")
        });

        return {
          content: [
            {
              type: "text",
              text: context.context
            }
          ]
        };
      }

      case "mem_list_projects": {
        return textResult(await client.listProjects());
      }

      default:
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Unknown tool: ${toolName}`
            }
          ]
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `codex-mem error: ${message}`
        }
      ]
    };
  }
}

function textResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function getString(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): string {
  const value = args[key];
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized && required) {
      throw new Error(`${key} is required.`);
    }

    return normalized;
  }

  if (required) {
    throw new Error(`${key} is required.`);
  }

  return "";
}

function getKind(args: Record<string, unknown>): EntryKind | undefined {
  const raw = getString(args, "kind", false);
  if (!raw) {
    return undefined;
  }

  if (!ENTRY_KINDS.includes(raw as EntryKind)) {
    throw new Error(`kind must be one of: ${ENTRY_KINDS.join(", ")}`);
  }

  return raw as EntryKind;
}

function getStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getNumberArray(
  args: Record<string, unknown>,
  key: string,
  required: boolean
): number[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    if (required) {
      throw new Error(`${key} must be an array of numbers.`);
    }

    return [];
  }

  const numbers = value
    .map((item) => {
      if (typeof item === "number") {
        return item;
      }

      if (typeof item === "string") {
        const parsed = Number(item);
        return Number.isNaN(parsed) ? undefined : parsed;
      }

      return undefined;
    })
    .filter((item): item is number => item !== undefined);

  if (required && numbers.length === 0) {
    throw new Error(`${key} must include at least one numeric id.`);
  }

  return numbers;
}
