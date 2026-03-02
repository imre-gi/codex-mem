import type { MemoryEntry, SearchResult } from "./types.js";
import type { MemoryStore } from "./store.js";

export interface ContextPackOptions {
  query?: string;
  project?: string;
  limit?: number;
  fullCount?: number;
}

export function buildContextPack(
  store: MemoryStore,
  options: ContextPackOptions
): string {
  const limit = clamp(options.limit ?? 12, 1, 30);
  const fullCount = clamp(options.fullCount ?? 3, 0, 10);
  const results = store.search({
    query: options.query,
    project: options.project,
    limit
  });

  if (results.length === 0) {
    return [
      "<retentia-context>",
      "# Memory Index",
      "No matching entries found.",
      "</retentia-context>"
    ].join("\n");
  }

  const fullIds = results.slice(0, fullCount).map((result) => result.id);
  const fullMap = new Map<number, MemoryEntry>(
    store.getEntries(fullIds).map((entry) => [entry.id, entry])
  );

  const lines: string[] = [
    "<retentia-context>",
    "# Memory Index",
    "",
    ...results.map(formatIndexRow),
    ""
  ];

  if (fullIds.length > 0) {
    lines.push("# Expanded Entries");
    lines.push("");

    for (const id of fullIds) {
      const entry = fullMap.get(id);
      if (!entry) {
        continue;
      }

      lines.push(...formatEntry(entry));
      lines.push("");
    }
  }

  lines.push("</retentia-context>");

  return lines.join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatIndexRow(result: SearchResult): string {
  const kind = result.kind === "summary" ? "summary" : "observation";
  return `- #${result.id} | ${kind} | ${result.createdAt} | ${result.title}`;
}

function formatEntry(entry: MemoryEntry): string[] {
  if (entry.kind === "observation") {
    return [
      `## #${entry.id} Observation`,
      `- Project: ${entry.project}`,
      `- Type: ${entry.observationType}`,
      `- Title: ${entry.title}`,
      `- Tags: ${entry.tags.join(", ") || "(none)"}`,
      `- Files: ${entry.files.join(", ") || "(none)"}`,
      "- Content:",
      entry.content
    ];
  }

  return [
    `## #${entry.id} Summary`,
    `- Project: ${entry.project}`,
    `- Request: ${entry.request || "(none)"}`,
    `- Learned: ${entry.learned || "(none)"}`,
    `- Completed: ${entry.completed || "(none)"}`,
    `- Next Steps: ${entry.nextSteps || "(none)"}`,
    `- Tags: ${entry.tags.join(", ") || "(none)"}`,
    `- Files Read: ${entry.filesRead.join(", ") || "(none)"}`,
    `- Files Edited: ${entry.filesEdited.join(", ") || "(none)"}`
  ];
}
