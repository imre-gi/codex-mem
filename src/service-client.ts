import type {
  AddObservationInput,
  AddSummaryInput,
  ListIoTraceOptions,
  SearchOptions,
  TimelineOptions,
} from "./types.js";

interface WorkerResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export class MemoryServiceClient {
  private readonly baseUrl: string;
  private readonly source: string;

  constructor(baseUrl: string, source = "api") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.source = source.trim() || "api";
  }

  async health(): Promise<Record<string, unknown>> {
    return this.get("/api/health");
  }

  async addObservation(input: AddObservationInput): Promise<unknown> {
    return this.post("/api/memory/add-observation", input as unknown);
  }

  async addSummary(input: AddSummaryInput): Promise<unknown> {
    return this.post("/api/memory/add-summary", input as unknown);
  }

  async search(
    input: SearchOptions,
  ): Promise<{ total: number; results: unknown[] }> {
    return this.post("/api/memory/search", input as unknown);
  }

  async timeline(input: TimelineOptions): Promise<unknown> {
    return this.post("/api/memory/timeline", input as unknown);
  }

  async getEntries(
    ids: number[],
  ): Promise<{ total: number; entries: unknown[] }> {
    return this.post("/api/memory/get-entries", { ids });
  }

  async contextPack(
    input: Record<string, unknown>,
  ): Promise<{ context: string }> {
    return this.post("/api/memory/context-pack", input);
  }

  async listProjects(): Promise<{ projects: string[] }> {
    return this.get("/api/memory/projects");
  }

  async ioTrace(
    input: ListIoTraceOptions,
  ): Promise<{ total: number; events: unknown[] }> {
    return this.post("/api/memory/io-trace", input as unknown);
  }

  async shutdown(): Promise<Record<string, unknown>> {
    return this.post("/api/admin/shutdown", {});
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        "x-retentia-source": this.source,
      },
    });
    const payload = (await response.json()) as WorkerResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        payload.error || `Worker request failed (${response.status})`,
      );
    }

    return (payload.data || {}) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-retentia-source": this.source,
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as WorkerResponse<T>;
    if (!response.ok || !payload.ok) {
      throw new Error(
        payload.error || `Worker request failed (${response.status})`,
      );
    }

    return (payload.data || {}) as T;
  }
}
