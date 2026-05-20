import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { V2MemoryEngine } from "../src/v2-engine.js";

function withEngine(run: (engine: V2MemoryEngine) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "retentia-v2-test-"));
  const engine = new V2MemoryEngine(join(dir, "memory.db"));
  try {
    run(engine);
  } finally {
    engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("V2MemoryEngine", () => {
  test("stores events, distilled memories, and graph edges", () => {
    withEngine((engine) => {
      const event = engine.addEvent({
        type: "task_started",
        source: "mcp",
        actor: "codex",
        role: "primary",
        taskId: "task-1",
        project: "retentia",
        summary: "Design low-token memory retrieval",
        tags: ["agent:codex", "task:design"],
        payload: { model: "gpt-5-codex" },
      });

      const memory = engine.addMemory({
        kind: "decision",
        project: "retentia",
        title: "Use staged retrieval by default",
        body: "Search should return compact IDs and snippets first, then hydrate full evidence only when the model asks for it.",
        tags: ["rag", "tokens"],
        sourceEventIds: [event.id],
        confidence: 0.94,
        pinned: true,
      });

      const edge = engine.addEdge({
        fromType: "agent",
        fromId: "codex",
        toType: "task",
        toId: "task-1",
        relation: "works_on",
      });

      expect(event.id).toBeGreaterThan(0);
      expect(memory.sourceEventIds).toEqual([event.id]);
      expect(memory.pinned).toBe(true);
      expect(edge.relation).toBe("works_on");
    });
  });

  test("searches memories with FTS and metadata filters", () => {
    withEngine((engine) => {
      engine.addMemory({
        kind: "procedure",
        project: "retentia",
        title: "Debug auth callbacks",
        body: "Inspect redirect middleware, expired token refresh, and session cookie propagation.",
        tags: ["auth", "debug"],
      });
      engine.addMemory({
        kind: "fact",
        project: "portfolio",
        title: "Hero image rule",
        body: "Landing pages need real visual assets above the fold.",
        tags: ["frontend"],
      });

      const results = engine.search({
        query: "expired token",
        project: "retentia",
        tags: ["auth"],
      });

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe("Debug auth callbacks");
      expect(results[0]?.snippet).toContain("token");
    });
  });

  test("builds budgeted context packs", () => {
    withEngine((engine) => {
      engine.addMemory({
        kind: "episode",
        project: "retentia",
        title: "Token economy design session",
        body: "The system should preserve raw events but retrieve compact derived memories by default to minimize repeated context cost.",
        tags: ["tokens", "architecture"],
      });
      engine.addMemory({
        kind: "decision",
        project: "retentia",
        title: "Prefer SQLite FTS first",
        body: "FTS5 and BM25 provide fast local ranking without requiring hosted vector databases for the personal version.",
        tags: ["search", "local-first"],
      });

      const context = engine.buildContext({
        query: "retrieval tokens",
        project: "retentia",
        mode: "brief",
        maxChars: 220,
      });

      expect(context.text).toContain("<retentia-v2-context");
      expect(context.usedChars).toBeLessThanOrEqual(220);
      expect(context.memoryIds.length).toBeGreaterThan(0);
    });
  });

  test("lists graph edges around an agent or task", () => {
    withEngine((engine) => {
      engine.addEdge({
        fromType: "agent",
        fromId: "primary",
        toType: "agent",
        toId: "backend-subagent",
        relation: "delegated_to",
        metadata: { task: "migration checks" },
      });

      const edges = engine.listEdgesForNode("agent", "primary");
      expect(edges).toHaveLength(1);
      expect(edges[0]?.toId).toBe("backend-subagent");
      expect(edges[0]?.metadata).toEqual({ task: "migration checks" });
    });
  });
});
