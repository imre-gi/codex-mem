import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buildContextPack } from "./context-pack.js";
import { MemoryStore } from "./store.js";
import type {
  AddObservationInput,
  AddSummaryInput,
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
      service: "codex-mem-worker",
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
    sendJson(res, 200, { ok: true, data: saved });
    return;
  }

  if (method === "POST" && url === "/api/memory/add-summary") {
    const body = await readJsonBody(req);
    const saved = store.addSummary(body as unknown as AddSummaryInput);
    sendJson(res, 200, { ok: true, data: saved });
    return;
  }

  if (method === "POST" && url === "/api/memory/search") {
    const body = await readJsonBody(req);
    const results = store.search(body as SearchOptions);
    sendJson(res, 200, { ok: true, data: { total: results.length, results } });
    return;
  }

  if (method === "POST" && url === "/api/memory/timeline") {
    const body = await readJsonBody(req);
    const timeline = store.timeline(body as TimelineOptions);
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
    sendJson(res, 200, { ok: true, data: { total: entries.length, entries } });
    return;
  }

  if (method === "POST" && url === "/api/memory/context-pack") {
    const body = await readJsonBody(req);
    const context = buildContextPack(store, body);
    sendJson(res, 200, { ok: true, data: { context } });
    return;
  }

  if (method === "GET" && url === "/api/memory/projects") {
    const projects = store.listProjects();
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
