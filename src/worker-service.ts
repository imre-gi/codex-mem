import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildContextPack } from "./context-pack.js";
import { MemoryStore } from "./store.js";
import type {
  AddObservationInput,
  AddSummaryInput,
  ListIoTraceOptions,
  SearchOptions,
  TimelineOptions
} from "./types.js";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT
} from "./worker-config.js";

export interface WorkerServiceOptions {
  host?: string;
  port?: number;
  dataFile?: string;
  cwd?: string;
}

export interface WorkerServiceInstance {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export async function startWorkerService(
  options: WorkerServiceOptions = {}
): Promise<WorkerServiceInstance> {
  const host = options.host || DEFAULT_WORKER_HOST;
  const port = options.port || DEFAULT_WORKER_PORT;
  const store = new MemoryStore(options.dataFile, options.cwd);

  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, store, host, port, server);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    host,
    port,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      store.close();
    }
  };
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  host: string,
  port: number,
  server: ReturnType<typeof createServer>
): Promise<void> {
  const method = req.method || "GET";
  const url = req.url || "/";

  if (method === "GET" && url === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      service: "retentia-worker",
      host,
      port,
      dataFile: store.getDataFilePath(),
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (method === "POST" && url === "/api/admin/shutdown") {
    sendJson(res, 200, { ok: true, message: "shutting down" });
    setTimeout(() => {
      server.close(() => {
        store.close();
      });
    }, 20);
    return;
  }

  if (method === "POST" && url === "/api/memory/add-observation") {
    const body = await readJsonBody(req);
    const saved = store.addObservation(body as unknown as AddObservationInput);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "w_obs",
      req: {
        p: pickString(body, "project"),
        sid: pickString(body, "sessionId"),
        ek: pickString(body, "externalKey"),
        t: pickString(body, "observationType"),
        ttl: pickString(body, "title"),
        c: pickString(body, "content"),
        tg: pickStringArray(body, "tags"),
        f: pickStringArray(body, "files")
      },
      res: {
        id: saved.id,
        k: saved.kind,
        p: saved.project,
        at: saved.createdAt
      }
    });
    sendJson(res, 200, { ok: true, data: saved });
    return;
  }

  if (method === "POST" && url === "/api/memory/add-summary") {
    const body = await readJsonBody(req);
    const saved = store.addSummary(body as unknown as AddSummaryInput);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "w_sum",
      req: {
        p: pickString(body, "project"),
        sid: pickString(body, "sessionId"),
        ek: pickString(body, "externalKey"),
        rq: pickString(body, "request"),
        i: pickString(body, "investigated"),
        l: pickString(body, "learned"),
        c: pickString(body, "completed"),
        ns: pickString(body, "nextSteps"),
        tg: pickStringArray(body, "tags"),
        fr: pickStringArray(body, "filesRead"),
        fe: pickStringArray(body, "filesEdited")
      },
      res: {
        id: saved.id,
        k: saved.kind,
        p: saved.project,
        at: saved.createdAt
      }
    });
    sendJson(res, 200, { ok: true, data: saved });
    return;
  }

  if (method === "POST" && url === "/api/memory/search") {
    const body = await readJsonBody(req);
    const results = store.search(body as SearchOptions);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "q_search",
      req: {
        q: pickString(body, "query"),
        p: pickString(body, "project"),
        k: pickString(body, "kind"),
        s: pickString(body, "since"),
        u: pickString(body, "until"),
        l: pickNumber(body, "limit")
      },
      res: {
        n: results.length,
        ids: results.map((item) => item.id).slice(0, 100)
      }
    });
    sendJson(res, 200, { ok: true, data: { total: results.length, results } });
    return;
  }

  if (method === "POST" && url === "/api/memory/timeline") {
    const body = await readJsonBody(req);
    const timeline = store.timeline(body as TimelineOptions);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "q_timeline",
      req: {
        id: pickNumber(body, "id"),
        q: pickString(body, "query"),
        p: pickString(body, "project"),
        b: pickNumber(body, "before"),
        a: pickNumber(body, "after")
      },
      res: {
        aid: timeline.anchorId,
        ids: timeline.entries.map((entry) => entry.id)
      }
    });
    sendJson(res, 200, { ok: true, data: timeline });
    return;
  }

  if (method === "POST" && url === "/api/memory/get-entries") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids)
      ? body.ids
          .map((value: unknown) => Number(value))
          .filter((value: number) => !Number.isNaN(value))
      : [];
    const entries = store.getEntries(ids);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "r_entries",
      req: { ids },
      res: {
        n: entries.length,
        ids: entries.map((entry) => entry.id)
      }
    });
    sendJson(res, 200, { ok: true, data: { total: entries.length, entries } });
    return;
  }

  if (method === "POST" && url === "/api/memory/context-pack") {
    const body = await readJsonBody(req);
    const context = buildContextPack(store, body);
    store.addIoTrace({
      source: resolveTraceSource(req, body),
      op: "r_context",
      req: {
        q: pickString(body, "query"),
        p: pickString(body, "project"),
        l: pickNumber(body, "limit"),
        fc: pickNumber(body, "fullCount")
      },
      res: {
        chars: context.length
      }
    });
    sendJson(res, 200, { ok: true, data: { context } });
    return;
  }

  if (method === "POST" && url === "/api/memory/io-trace") {
    const body = await readJsonBody(req);
    const events = store.listIoTrace(body as ListIoTraceOptions);
    sendJson(res, 200, { ok: true, data: { total: events.length, events } });
    return;
  }

  if (method === "GET" && url === "/api/memory/projects") {
    const projects = store.listProjects();
    store.addIoTrace({
      source: resolveTraceSource(req),
      op: "r_projects",
      req: {},
      res: { n: projects.length, p: projects.slice(0, 100) }
    });
    sendJson(res, 200, { ok: true, data: { projects } });
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown route ${method} ${url}` });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function resolveTraceSource(
  req: IncomingMessage,
  body?: Record<string, unknown>
): string {
  const headerValue = req.headers["x-retentia-source"];
  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }

  if (Array.isArray(headerValue) && headerValue.length > 0) {
    const first = headerValue[0]?.trim();
    if (first) {
      return first;
    }
  }

  const bodySource = body?._source;
  if (typeof bodySource === "string" && bodySource.trim()) {
    return bodySource.trim();
  }

  return "api";
}

function pickString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function pickNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return undefined;
}

function pickStringArray(
  body: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const clean = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return clean.length > 0 ? clean : undefined;
}
