import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type {
  AddObservationInput,
  AddSummaryInput,
  MemoryData,
  MemoryEntry,
  ObservationEntry,
  SearchOptions,
  SearchResult,
  SummaryEntry,
  TimelineOptions,
  TimelineResult
} from "./types.js";

const DEFAULT_DATA_DIR = join(homedir(), ".codex-mem");
const DEFAULT_DATA_FILE = join(DEFAULT_DATA_DIR, "memory.json");
const MAX_LIMIT = 100;

function emptyData(): MemoryData {
  return {
    version: 1,
    lastId: 0,
    entries: []
  };
}

export class MemoryStore {
  private readonly dataFile: string;
  private readonly cwd: string;

  constructor(dataFile?: string, cwd?: string) {
    this.dataFile =
      dataFile || process.env.CODEX_MEM_DATA_FILE || DEFAULT_DATA_FILE;
    this.cwd = cwd || process.cwd();
    this.ensureDataFile();
  }

  getDataFilePath(): string {
    return this.dataFile;
  }

  addObservation(input: AddObservationInput): ObservationEntry {
    const data = this.readData();
    const id = data.lastId + 1;
    const entry: ObservationEntry = {
      id,
      kind: "observation",
      project: this.resolveProject(input.project),
      sessionId: this.cleanOptional(input.sessionId),
      createdAt: new Date().toISOString(),
      tags: this.cleanList(input.tags),
      observationType: input.observationType || "note",
      title: this.requireText(input.title, "title"),
      content: this.requireText(input.content, "content"),
      files: this.cleanList(input.files)
    };

    data.lastId = id;
    data.entries.push(entry);
    this.writeData(data);
    return entry;
  }

  addSummary(input: AddSummaryInput): SummaryEntry {
    const data = this.readData();
    const id = data.lastId + 1;
    const entry: SummaryEntry = {
      id,
      kind: "summary",
      project: this.resolveProject(input.project),
      sessionId: this.cleanOptional(input.sessionId),
      createdAt: new Date().toISOString(),
      tags: this.cleanList(input.tags),
      request: this.cleanOptional(input.request) || "",
      investigated: this.cleanOptional(input.investigated) || "",
      learned: this.requireText(input.learned, "learned"),
      completed: this.cleanOptional(input.completed) || "",
      nextSteps: this.cleanOptional(input.nextSteps) || "",
      filesRead: this.cleanList(input.filesRead),
      filesEdited: this.cleanList(input.filesEdited)
    };

    data.lastId = id;
    data.entries.push(entry);
    this.writeData(data);
    return entry;
  }

  getEntries(ids: number[]): MemoryEntry[] {
    if (ids.length === 0) {
      return [];
    }

    const data = this.readData();
    const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
    return ids
      .map((id) => byId.get(id))
      .filter((entry): entry is MemoryEntry => Boolean(entry));
  }

  search(options: SearchOptions): SearchResult[] {
    const data = this.readData();
    const limit = this.resolveLimit(options.limit);
    const tokens = this.tokenize(options.query);
    const sinceMs = this.parseTime(options.since);
    const untilMs = this.parseTime(options.until);

    return data.entries
      .filter((entry) => this.filterEntry(entry, options, sinceMs, untilMs))
      .map((entry) => {
        const score = this.scoreEntry(entry, tokens);
        return {
          id: entry.id,
          kind: entry.kind,
          project: entry.project,
          title: this.getEntryTitle(entry),
          excerpt: this.getExcerpt(entry),
          createdAt: entry.createdAt,
          score
        } satisfies SearchResult;
      })
      .filter((result) => (tokens.length > 0 ? result.score > 0 : true))
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit);
  }

  timeline(options: TimelineOptions): TimelineResult {
    const data = this.readData();
    if (data.entries.length === 0) {
      throw new Error("No memory entries exist yet.");
    }

    const sorted = [...data.entries].sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id - b.id;
      }

      return a.createdAt.localeCompare(b.createdAt);
    });

    const anchorId = this.resolveAnchorId(sorted, options);
    const anchorIndex = sorted.findIndex((entry) => entry.id === anchorId);

    if (anchorIndex < 0) {
      throw new Error(`Entry #${anchorId} not found.`);
    }

    const before = this.resolveWindow(options.before, 5);
    const after = this.resolveWindow(options.after, 5);
    const start = Math.max(0, anchorIndex - before);
    const end = Math.min(sorted.length, anchorIndex + after + 1);

    return {
      anchorId,
      entries: sorted.slice(start, end)
    };
  }

  listProjects(): string[] {
    const data = this.readData();
    return [...new Set(data.entries.map((entry) => entry.project))].sort();
  }

  private ensureDataFile(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    if (!existsSync(this.dataFile)) {
      this.writeData(emptyData());
    }
  }

  private readData(): MemoryData {
    try {
      const raw = readFileSync(this.dataFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<MemoryData>;
      if (!parsed || typeof parsed !== "object") {
        return emptyData();
      }

      const entries = Array.isArray(parsed.entries)
        ? (parsed.entries as MemoryEntry[])
        : [];

      return {
        version: 1,
        lastId:
          typeof parsed.lastId === "number"
            ? parsed.lastId
            : entries.reduce((max, entry) => Math.max(max, entry.id), 0),
        entries
      };
    } catch {
      return emptyData();
    }
  }

  private writeData(data: MemoryData): void {
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.dataFile);
    rmSync(tmp, { force: true });
  }

  private resolveProject(project?: string): string {
    const explicit = this.cleanOptional(project);
    if (explicit) {
      return explicit;
    }

    return basename(this.cwd);
  }

  private cleanOptional(value?: string): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private cleanList(values?: string[]): string[] {
    if (!Array.isArray(values)) {
      return [];
    }

    const seen = new Set<string>();
    for (const value of values) {
      const normalized = value.trim();
      if (normalized) {
        seen.add(normalized);
      }
    }

    return [...seen];
  }

  private requireText(value: string, fieldName: string): string {
    const normalized = value?.trim();
    if (!normalized) {
      throw new Error(`${fieldName} is required.`);
    }

    return normalized;
  }

  private resolveLimit(limit?: number): number {
    if (!limit || Number.isNaN(limit)) {
      return 10;
    }

    return Math.max(1, Math.min(limit, MAX_LIMIT));
  }

  private resolveWindow(value: number | undefined, fallback: number): number {
    if (value === undefined || Number.isNaN(value)) {
      return fallback;
    }

    return Math.max(0, Math.min(value, 50));
  }

  private parseTime(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private tokenize(query?: string): string[] {
    if (!query?.trim()) {
      return [];
    }

    return query
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private filterEntry(
    entry: MemoryEntry,
    options: SearchOptions,
    sinceMs?: number,
    untilMs?: number
  ): boolean {
    if (options.project && entry.project !== options.project) {
      return false;
    }

    if (options.kind && entry.kind !== options.kind) {
      return false;
    }

    const createdAtMs = Date.parse(entry.createdAt);
    if (!Number.isNaN(createdAtMs)) {
      if (sinceMs !== undefined && createdAtMs < sinceMs) {
        return false;
      }

      if (untilMs !== undefined && createdAtMs > untilMs) {
        return false;
      }
    }

    return true;
  }

  private scoreEntry(entry: MemoryEntry, tokens: string[]): number {
    if (tokens.length === 0) {
      return 1;
    }

    const title = this.getEntryTitle(entry).toLowerCase();
    const body = this.getSearchBody(entry).toLowerCase();
    let score = 0;

    for (const token of tokens) {
      if (title.includes(token)) {
        score += 10;
      }

      if (body.includes(token)) {
        score += 4;
      }

      if (entry.tags.some((tag) => tag.toLowerCase() === token)) {
        score += 6;
      }
    }

    return score;
  }

  private getSearchBody(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return [
        entry.content,
        entry.observationType,
        ...entry.files,
        ...entry.tags
      ].join(" ");
    }

    return [
      entry.request,
      entry.investigated,
      entry.learned,
      entry.completed,
      entry.nextSteps,
      ...entry.filesRead,
      ...entry.filesEdited,
      ...entry.tags
    ].join(" ");
  }

  private getEntryTitle(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return entry.title;
    }

    return entry.request || this.clip(entry.learned, 80);
  }

  private getExcerpt(entry: MemoryEntry): string {
    if (entry.kind === "observation") {
      return this.clip(entry.content, 220);
    }

    const sections = [entry.learned, entry.completed, entry.nextSteps]
      .map((part) => part.trim())
      .filter(Boolean);

    return this.clip(sections.join(" | "), 220);
  }

  private clip(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
      return value;
    }

    return `${value.slice(0, maxChars - 1)}…`;
  }

  private resolveAnchorId(entries: MemoryEntry[], options: TimelineOptions): number {
    if (options.id !== undefined) {
      return options.id;
    }

    const [firstMatch] = this.search({
      query: options.query,
      project: options.project,
      limit: 1
    });

    if (!firstMatch) {
      throw new Error("Could not resolve timeline anchor. Provide an id or query.");
    }

    return firstMatch.id;
  }
}
