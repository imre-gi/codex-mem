import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { buildContextPack } from "../src/context-pack.js";
import { MemoryStore } from "../src/store.js";

function withStore(run: (store: MemoryStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "retentia-test-"));
  const file = join(dir, "memory.db");
  const store = new MemoryStore(file, "/tmp/demo-project");
  try {
    run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("MemoryStore", () => {
  test("adds entries and searches by keyword", () => {
    withStore((store) => {
      store.addObservation({
        title: "Fix auth redirect loop",
        content: "Updated middleware to prevent redirect loop on expired token",
        observationType: "bugfix",
        tags: ["auth", "redirect"]
      });

      store.addSummary({
        request: "stabilize login",
        learned: "token refresh was missing a null guard",
        completed: "added guard and regression tests",
        nextSteps: "monitor staging logs"
      });

      const search = store.search({ query: "redirect loop", limit: 5 });
      expect(search).toHaveLength(1);
      expect(search[0]?.kind).toBe("observation");
      expect(search[0]?.title).toContain("auth redirect loop");
    });
  });

  test("returns timeline around anchor", () => {
    withStore((store) => {
      const first = store.addObservation({
        title: "Initial note",
        content: "First event"
      });
      const second = store.addObservation({
        title: "Second note",
        content: "Second event"
      });
      const third = store.addObservation({
        title: "Third note",
        content: "Third event"
      });

      const timeline = store.timeline({ id: second.id, before: 1, after: 1 });
      expect(timeline.anchorId).toBe(second.id);
      expect(timeline.entries.map((entry) => entry.id)).toEqual([
        first.id,
        second.id,
        third.id
      ]);
    });
  });

  test("builds context pack with index and expanded entries", () => {
    withStore((store) => {
      store.addObservation({
        title: "Optimize build",
        content: "Reduced compile time by switching to incremental tsbuild",
        tags: ["build"]
      });

      store.addSummary({
        request: "performance follow-up",
        learned: "incremental cache key should include tsconfig hash",
        completed: "implemented cache invalidation",
        nextSteps: "measure CI runtime"
      });

      const pack = buildContextPack(store, { query: "build", fullCount: 1 });
      expect(pack).toContain("<retentia-context>");
      expect(pack).toContain("# Memory Index");
      expect(pack).toContain("# Expanded Entries");
      expect(pack).toContain("Optimize build");
    });
  });

  test("returns aggregate kpis", () => {
    withStore((store) => {
      store.addObservation({
        title: "Fix flaky e2e login",
        content: "Retried auth callback flow and captured debug details"
      });
      store.addSummary({
        request: "weekly recap",
        learned: "worker uptime dropped during terminal restart",
        completed: "added health check smoke step"
      });

      const kpis = store.getKpis();
      expect(kpis.entriesTotal).toBe(2);
      expect(kpis.observationsTotal).toBe(1);
      expect(kpis.summariesTotal).toBe(1);
      expect(kpis.projectsTotal).toBe(1);
      expect(kpis.latestEntryAt).toBeTruthy();
      expect(kpis.oldestEntryAt).toBeTruthy();
    });
  });

  test("supports external key dedupe checks and listEntries", () => {
    withStore((store) => {
      const saved = store.addObservation({
        title: "Codex pipeline task finished",
        content: "Imported from codex sessions",
        project: "fred-client",
        externalKey: "codex:turn-123",
        tags: ["provider:codex", "agent:backend"]
      });

      expect(saved.externalKey).toBe("codex:turn-123");
      expect(store.hasExternalKey("codex:turn-123")).toBe(true);
      expect(store.hasExternalKey("codex:missing")).toBe(false);

      store.addSummary({
        project: "fred-client",
        learned: "pipeline reviewed successfully"
      });

      const listed = store.listEntries({
        project: "fred-client",
        limit: 5
      });
      expect(listed).toHaveLength(2);
      expect(listed[0]?.createdAt >= listed[1]?.createdAt).toBe(true);
    });
  });
});
