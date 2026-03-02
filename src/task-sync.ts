import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { MemoryStore } from "./store.js";

export type LlmProvider = "codex" | "claude" | "qwen" | "gwen";

export interface SyncTaskOptions {
  providers?: LlmProvider[];
  codexPath?: string;
  claudePath?: string;
  qwenPath?: string;
  gwenPath?: string;
  lookbackDays?: number;
  maxFilesPerProvider?: number;
  maxImport?: number;
  fallbackProject?: string;
}

interface ProviderCounters {
  detected: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface SyncTaskResult {
  ok: true;
  providers: LlmProvider[];
  detectedTasks: number;
  importedTasks: number;
  skippedTasks: number;
  failedTasks: number;
  newestTaskAt?: string;
  byProvider: Array<{
    provider: LlmProvider;
    detected: number;
    imported: number;
    skipped: number;
    failed: number;
  }>;
}

interface TaskEvent {
  provider: LlmProvider;
  externalId: string;
  timestamp: string;
  title: string;
  summary: string;
  project?: string;
  model?: string;
  agent?: string;
  role?: string;
  pipeline?: string;
  status?: "completed" | "failed" | "running" | "unknown";
  taskId?: string;
  sessionId?: string;
  sourceFile?: string;
}

interface ClaudeTaskPending {
  sessionId?: string;
  cwd?: string;
  model?: string;
  timestamp?: string;
  description?: string;
  subagentType?: string;
  prompt?: string;
  toolUseId: string;
}

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_FILES_PER_PROVIDER = 24;
const DEFAULT_MAX_IMPORT = 50;
const DEFAULT_CODEX_PATH = join(homedir(), ".codex", "sessions");
const DEFAULT_CLAUDE_PATH = join(homedir(), ".claude", "projects");
const DEFAULT_QWEN_PATH = join(homedir(), ".qwen", "sessions");
const DEFAULT_GWEN_PATH = join(homedir(), ".gwen", "sessions");

export function syncTaskExecutions(
  store: MemoryStore,
  options: SyncTaskOptions = {}
): SyncTaskResult {
  const providers = normalizeProviders(options.providers);
  const lookbackDays = clampNumber(options.lookbackDays, DEFAULT_LOOKBACK_DAYS, 1, 30);
  const maxFilesPerProvider = clampNumber(
    options.maxFilesPerProvider,
    DEFAULT_MAX_FILES_PER_PROVIDER,
    1,
    200
  );
  const maxImport = clampNumber(options.maxImport, DEFAULT_MAX_IMPORT, 1, 1000);
  const fallbackProject = options.fallbackProject?.trim() || undefined;

  const counters = new Map<LlmProvider, ProviderCounters>();
  for (const provider of providers) {
    counters.set(provider, {
      detected: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    });
  }

  const detectedByExternalId = new Map<string, TaskEvent>();

  for (const provider of providers) {
    const events = collectProviderEvents(provider, {
      codexPath: options.codexPath,
      claudePath: options.claudePath,
      qwenPath: options.qwenPath,
      gwenPath: options.gwenPath,
      lookbackDays,
      maxFilesPerProvider
    });
    const providerCounter = counters.get(provider);
    if (providerCounter) {
      providerCounter.detected = events.length;
    }

    for (const event of events) {
      const existing = detectedByExternalId.get(event.externalId);
      if (!existing || event.timestamp > existing.timestamp) {
        detectedByExternalId.set(event.externalId, event);
      }
    }
  }

  const ordered = [...detectedByExternalId.values()].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp)
  );
  const importQueue = interleaveByProvider(ordered, providers);

  let importedTasks = 0;
  let skippedTasks = 0;
  let failedTasks = 0;

  for (const event of importQueue) {
    const providerCounter = counters.get(event.provider);
    if (!providerCounter) {
      continue;
    }

    if (importedTasks >= maxImport) {
      skippedTasks += 1;
      providerCounter.skipped += 1;
      continue;
    }

    if (store.hasExternalKey(event.externalId)) {
      skippedTasks += 1;
      providerCounter.skipped += 1;
      continue;
    }

    try {
      store.addObservation({
        project: event.project || fallbackProject,
        sessionId: event.sessionId,
        externalKey: event.externalId,
        observationType: "note",
        title: buildObservationTitle(event),
        content: buildObservationContent(event),
        tags: buildObservationTags(event)
      });
      importedTasks += 1;
      providerCounter.imported += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("UNIQUE constraint failed")) {
        skippedTasks += 1;
        providerCounter.skipped += 1;
        continue;
      }

      failedTasks += 1;
      providerCounter.failed += 1;
    }
  }

  const byProvider = providers.map((provider) => {
    const counter = counters.get(provider) || {
      detected: 0,
      imported: 0,
      skipped: 0,
      failed: 0
    };
    return {
      provider,
      detected: counter.detected,
      imported: counter.imported,
      skipped: counter.skipped,
      failed: counter.failed
    };
  });

  return {
    ok: true,
    providers,
    detectedTasks: ordered.length,
    importedTasks,
    skippedTasks,
    failedTasks,
    newestTaskAt: ordered[0]?.timestamp,
    byProvider
  };
}

function interleaveByProvider(
  events: TaskEvent[],
  providers: LlmProvider[]
): TaskEvent[] {
  const buckets = new Map<LlmProvider, TaskEvent[]>();
  for (const provider of providers) {
    buckets.set(provider, []);
  }

  for (const event of events) {
    const bucket = buckets.get(event.provider);
    if (bucket) {
      bucket.push(event);
    }
  }

  const merged: TaskEvent[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const provider of providers) {
      const bucket = buckets.get(provider);
      if (!bucket || bucket.length === 0) {
        continue;
      }
      const next = bucket.shift();
      if (!next) {
        continue;
      }
      merged.push(next);
      progressed = true;
    }
  }

  return merged;
}

function collectProviderEvents(
  provider: LlmProvider,
  options: {
    codexPath?: string;
    claudePath?: string;
    qwenPath?: string;
    gwenPath?: string;
    lookbackDays: number;
    maxFilesPerProvider: number;
  }
): TaskEvent[] {
  const rootPath = resolveProviderPath(provider, options);
  if (!rootPath || !existsSync(rootPath)) {
    return [];
  }

  const files = listRecentSessionFiles(
    rootPath,
    options.maxFilesPerProvider,
    options.lookbackDays
  );
  const events: TaskEvent[] = [];

  for (const filePath of files) {
    if (provider === "codex") {
      events.push(...parseCodexEvents(filePath));
      continue;
    }

    if (provider === "claude") {
      events.push(...parseClaudeEvents(filePath));
      continue;
    }

    events.push(...parseGenericEvents(filePath, provider));
  }

  return events;
}

function resolveProviderPath(
  provider: LlmProvider,
  options: {
    codexPath?: string;
    claudePath?: string;
    qwenPath?: string;
    gwenPath?: string;
  }
): string {
  if (provider === "codex") {
    return options.codexPath?.trim() || DEFAULT_CODEX_PATH;
  }
  if (provider === "claude") {
    return options.claudePath?.trim() || DEFAULT_CLAUDE_PATH;
  }
  if (provider === "qwen") {
    return options.qwenPath?.trim() || DEFAULT_QWEN_PATH;
  }
  return options.gwenPath?.trim() || DEFAULT_GWEN_PATH;
}

function parseCodexEvents(filePath: string): TaskEvent[] {
  const events: TaskEvent[] = [];
  for (const root of readJsonLines(filePath)) {
    if (asText(root.type) !== "event_msg") {
      continue;
    }

    const payload = asRecord(root.payload);
    if (asText(payload.type) !== "task_complete") {
      continue;
    }

    const turnId = asText(payload.turn_id);
    const timestamp = asText(root.timestamp);
    if (!turnId || !timestamp) {
      continue;
    }

    const message = asText(payload.last_agent_message) || "";
    events.push({
      provider: "codex",
      externalId: `codex:${turnId}`,
      timestamp,
      title: buildTitleFromText(message, `Codex task ${turnId.slice(0, 8)}`),
      summary: message,
      status: "completed",
      taskId: turnId,
      sessionId: inferSessionIdFromPath(filePath),
      sourceFile: filePath
    });
  }
  return events;
}

function parseClaudeEvents(filePath: string): TaskEvent[] {
  const events: TaskEvent[] = [];
  const pendingByToolUseId = new Map<string, ClaudeTaskPending>();

  for (const root of readJsonLines(filePath)) {
    const recordType = asText(root.type)?.toLowerCase();
    const timestamp = asText(root.timestamp);
    const sessionId = asText(root.sessionId);
    const cwd = asText(root.cwd);
    const message = asRecord(root.message);
    const model = asText(message.model);
    const content = asArray(message.content);

    if (recordType === "assistant") {
      for (const item of content) {
        const toolUse = asRecord(item);
        if (
          asText(toolUse.type) === "tool_use" &&
          asText(toolUse.name) === "Task"
        ) {
          const input = asRecord(toolUse.input);
          const toolUseId = asText(toolUse.id);
          if (!toolUseId) {
            continue;
          }

          pendingByToolUseId.set(toolUseId, {
            sessionId,
            cwd,
            model,
            timestamp,
            description: asText(input.description),
            subagentType: asText(input.subagent_type),
            prompt: asText(input.prompt),
            toolUseId
          });
        }
      }
      continue;
    }

    if (recordType !== "user") {
      continue;
    }

    for (const item of content) {
      const toolResult = asRecord(item);
      if (asText(toolResult.type) !== "tool_result") {
        continue;
      }

      const toolUseId = asText(toolResult.tool_use_id);
      if (!toolUseId) {
        continue;
      }

      const pending = pendingByToolUseId.get(toolUseId);
      const resultText =
        extractTextFromValue(toolResult.content) ||
        extractTextFromValue(root.toolUseResult) ||
        "";
      const taskTimestamp = timestamp || pending?.timestamp;
      if (!taskTimestamp) {
        continue;
      }

      const status = toBoolean(toolResult.is_error) ? "failed" : "completed";
      const fallbackSession = pending?.sessionId || sessionId || inferSessionIdFromPath(filePath);
      const projectPath = pending?.cwd || cwd;

      events.push({
        provider: "claude",
        externalId: `claude:${fallbackSession || "session"}:${toolUseId}`,
        timestamp: taskTimestamp,
        title: buildTitleFromText(
          pending?.description || pending?.prompt || resultText,
          `Claude task ${toolUseId.slice(0, 8)}`
        ),
        summary: resultText || pending?.description || "",
        project: projectPath ? basename(projectPath) : undefined,
        model: pending?.model || model,
        agent: normalizeAgentLabel(pending?.subagentType) || "primary",
        role: normalizeAgentLabel(pending?.subagentType) || "primary",
        pipeline: fallbackSession,
        status,
        taskId: toolUseId,
        sessionId: fallbackSession,
        sourceFile: filePath
      });
    }
  }

  return events;
}

function parseGenericEvents(filePath: string, provider: LlmProvider): TaskEvent[] {
  const events: TaskEvent[] = [];

  for (const root of readJsonLines(filePath)) {
    const marker = [
      asText(root.type),
      asText(root.event),
      asText(root.status),
      asText(root.name),
      asText(asRecord(root.payload).type),
      asText(asRecord(root.payload).event)
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const looksComplete =
      /task[ _-]?(complete|completed|finished)/.test(marker) ||
      /run[ _-]?complete/.test(marker) ||
      /session[ _-]?complete/.test(marker) ||
      /status[ _-]?done/.test(marker);

    if (!looksComplete) {
      continue;
    }

    const payload = asRecord(root.payload);
    const summary =
      asText(payload.last_agent_message) ||
      extractTextFromValue(root.message) ||
      extractTextFromValue(payload.message) ||
      asText(root.output) ||
      "";
    if (!summary.trim()) {
      continue;
    }

    const taskId =
      asText(root.task_id) ||
      asText(root.taskId) ||
      asText(payload.task_id) ||
      asText(payload.taskId) ||
      asText(root.turn_id) ||
      asText(payload.turn_id) ||
      asText(root.id);
    const timestamp =
      asText(root.timestamp) ||
      asText(root.created_at) ||
      asText(payload.timestamp) ||
      asText(payload.created_at);
    if (!timestamp) {
      continue;
    }

    const externalId = taskId
      ? `${provider}:${taskId}`
      : `${provider}:${sha1(`${filePath}:${timestamp}:${summary}`)}`;

    const cwd =
      asText(root.cwd) || asText(payload.cwd) || asText(root.project_path);
    const model =
      asText(root.model) || asText(payload.model) || asText(root.model_name);
    const agent =
      asText(root.agent) ||
      asText(root.agent_id) ||
      asText(payload.agent) ||
      asText(payload.agent_id);
    const role = asText(root.role) || asText(payload.role) || agent;
    const status = normalizeStatus(asText(root.status) || asText(payload.status));

    events.push({
      provider,
      externalId,
      timestamp,
      title: buildTitleFromText(summary, `${provider} task`),
      summary,
      project: cwd ? basename(cwd) : undefined,
      model,
      agent,
      role,
      pipeline: asText(root.pipeline_id) || asText(payload.pipeline_id),
      status,
      taskId: taskId || undefined,
      sessionId: asText(root.session_id) || asText(payload.session_id),
      sourceFile: filePath
    });
  }

  return events;
}

function listRecentSessionFiles(
  sessionsRoot: string,
  maxFiles: number,
  lookbackDays: number
): string[] {
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const pending = [sessionsRoot];
  const files: Array<{ path: string; mtimeMs: number }> = [];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      break;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }

      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".jsonl") &&
          !entry.name.endsWith(".ndjson") &&
          !entry.name.endsWith(".log"))
      ) {
        continue;
      }

      try {
        const stats = statSync(absolutePath);
        if (stats.mtimeMs >= cutoffMs) {
          files.push({ path: absolutePath, mtimeMs: stats.mtimeMs });
        }
      } catch {
        continue;
      }
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((item) => item.path);
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return records;
}

function buildObservationTitle(event: TaskEvent): string {
  return clip(event.title.trim() || `${event.provider} task execution`, 120);
}

function buildObservationContent(event: TaskEvent): string {
  const lines = [
    "Source: multi-llm task execution sync",
    `Provider: ${event.provider}`,
    `Timestamp: ${event.timestamp}`,
    `Status: ${event.status || "unknown"}`
  ];

  if (event.model) {
    lines.push(`Model: ${event.model}`);
  }
  if (event.agent) {
    lines.push(`Agent: ${event.agent}`);
  }
  if (event.role) {
    lines.push(`Agent Role: ${event.role}`);
  }
  if (event.pipeline) {
    lines.push(`Pipeline: ${event.pipeline}`);
  }
  if (event.taskId) {
    lines.push(`Task ID: ${event.taskId}`);
  }
  if (event.sessionId) {
    lines.push(`Session ID: ${event.sessionId}`);
  }
  if (event.sourceFile) {
    lines.push(`Source File: ${event.sourceFile}`);
  }
  if (event.summary.trim()) {
    lines.push(`Task Summary: ${clip(event.summary.trim(), 2000)}`);
  }

  return lines.join("\n");
}

function buildObservationTags(event: TaskEvent): string[] {
  const tags = ["task-execution", "task-complete", `provider:${event.provider}`];

  if (event.model) {
    tags.push(`model:${toTagValue(event.model)}`);
  }
  if (event.agent) {
    tags.push(`agent:${toTagValue(event.agent)}`);
  }
  if (event.role) {
    tags.push(`role:${toTagValue(event.role)}`);
  }
  if (event.pipeline) {
    tags.push(`pipeline:${toTagValue(event.pipeline)}`);
  }
  if (event.status) {
    tags.push(`status:${toTagValue(event.status)}`);
  }
  if (event.taskId) {
    tags.push(`task:${toTagValue(event.taskId)}`);
  }
  if (event.sourceFile) {
    tags.push(`source_file:${toTagValue(basename(event.sourceFile))}`);
  }

  return [...new Set(tags)];
}

function buildTitleFromText(text: string, fallback: string): string {
  const first = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => Boolean(part));
  return clip((first || fallback).replace(/\s+/g, " "), 140);
}

function inferSessionIdFromPath(filePath: string): string | undefined {
  const fileName = basename(filePath);
  if (!fileName.endsWith(".jsonl")) {
    return undefined;
  }
  return fileName.replace(/\.jsonl$/i, "");
}

function extractTextFromValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextFromValue(item))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text.trim();
    }
    if (typeof record.content === "string") {
      return record.content.trim();
    }
    if (Array.isArray(record.content)) {
      return extractTextFromValue(record.content);
    }
    if (typeof record.message === "string") {
      return record.message.trim();
    }
  }

  return "";
}

function normalizeProviders(providers?: LlmProvider[]): LlmProvider[] {
  if (!providers || providers.length === 0) {
    return ["codex", "claude", "qwen", "gwen"];
  }

  const deduped = [...new Set(providers)];
  return deduped.length > 0 ? deduped : ["codex", "claude", "qwen", "gwen"];
}

function normalizeAgentLabel(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function normalizeStatus(value?: string): "completed" | "failed" | "running" | "unknown" {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("run") || normalized.includes("progress")) {
    return "running";
  }
  if (normalized.includes("done") || normalized.includes("complete") || normalized.includes("success")) {
    return "completed";
  }
  return "unknown";
}

function toTagValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

function clampNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
