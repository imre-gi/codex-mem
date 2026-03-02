import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_WORKER_HOST,
  DEFAULT_WORKER_PORT,
  WORKER_LOG_DIR,
  WORKER_PID_FILE,
  getWorkerBaseUrl
} from "./worker-config.js";

interface PidFile {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  dataFile?: string;
}

export interface WorkerStatus {
  running: boolean;
  pid?: number;
  host: string;
  port: number;
  baseUrl: string;
  dataFile?: string;
  uptimeSeconds?: number;
}

export interface WorkerManagerOptions {
  host?: string;
  port?: number;
  dataFile?: string;
  scriptPath: string;
}

export class WorkerManager {
  private readonly host: string;
  private readonly port: number;
  private readonly dataFile?: string;
  private readonly scriptPath: string;

  constructor(options: WorkerManagerOptions) {
    this.host = options.host || DEFAULT_WORKER_HOST;
    this.port = options.port || DEFAULT_WORKER_PORT;
    this.dataFile = options.dataFile;
    this.scriptPath = options.scriptPath;
  }

  getBaseUrl(): string {
    return getWorkerBaseUrl(this.host, this.port);
  }

  async start(): Promise<WorkerStatus> {
    const existing = this.readPidFile();
    if (await this.healthCheck()) {
      return this.status();
    }

    if (existing && this.isProcessAlive(existing.pid)) {
      this.killProcess(existing.pid);
    }

    mkdirSync(dirname(WORKER_PID_FILE), { recursive: true });
    mkdirSync(WORKER_LOG_DIR, { recursive: true });

    const logPath = this.getLogPath();
    const logFd = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      [
        this.scriptPath,
        "worker",
        "run",
        "--host",
        this.host,
        "--port",
        String(this.port),
        ...(this.dataFile ? ["--data-file", this.dataFile] : [])
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
        cwd: process.cwd()
      }
    );

    closeSync(logFd);
    child.unref();

    if (!child.pid) {
      throw new Error("Failed to start worker process.");
    }

    const pidInfo: PidFile = {
      pid: child.pid,
      host: this.host,
      port: this.port,
      startedAt: new Date().toISOString(),
      dataFile: this.dataFile
    };
    this.writePidFile(pidInfo);

    const healthy = await this.waitForHealth(10000);
    if (!healthy) {
      throw new Error(`Worker failed health check. See logs: ${logPath}`);
    }

    return this.status();
  }

  async stop(): Promise<void> {
    const pidInfo = this.readPidFile();

    try {
      await fetch(`${this.getBaseUrl()}/api/admin/shutdown`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      await this.waitForDown(5000);
    } catch {
      // ignore and fallback to pid kill
    }

    if (pidInfo && this.isProcessAlive(pidInfo.pid)) {
      this.killProcess(pidInfo.pid);
    }

    this.removePidFile();
  }

  async restart(): Promise<WorkerStatus> {
    await this.stop();
    return this.start();
  }

  async status(): Promise<WorkerStatus> {
    const pidInfo = this.readPidFile();
    const healthy = await this.healthCheck();

    const startedAtMs = pidInfo?.startedAt ? Date.parse(pidInfo.startedAt) : NaN;
    const uptimeSeconds = Number.isNaN(startedAtMs)
      ? undefined
      : Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));

    return {
      running: healthy,
      pid: pidInfo?.pid,
      host: this.host,
      port: this.port,
      baseUrl: this.getBaseUrl(),
      dataFile: pidInfo?.dataFile || this.dataFile,
      uptimeSeconds
    };
  }

  private async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getBaseUrl()}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForHealth(timeoutMs: number): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await this.healthCheck()) {
        return true;
      }
      await delay(150);
    }
    return false;
  }

  private async waitForDown(timeoutMs: number): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!(await this.healthCheck())) {
        return;
      }
      await delay(120);
    }
  }

  private killProcess(pid: number): void {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore"
      });
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private readPidFile(): PidFile | null {
    if (!existsSync(WORKER_PID_FILE)) {
      return null;
    }

    try {
      const raw = readFileSync(WORKER_PID_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<PidFile>;
      if (
        !parsed ||
        typeof parsed.pid !== "number" ||
        typeof parsed.port !== "number" ||
        typeof parsed.host !== "string"
      ) {
        return null;
      }

      return {
        pid: parsed.pid,
        host: parsed.host,
        port: parsed.port,
        startedAt: parsed.startedAt || "",
        dataFile: parsed.dataFile
      };
    } catch {
      return null;
    }
  }

  private writePidFile(info: PidFile): void {
    writeFileSync(WORKER_PID_FILE, JSON.stringify(info, null, 2), "utf8");
  }

  private removePidFile(): void {
    rmSync(WORKER_PID_FILE, { force: true });
  }

  private getLogPath(): string {
    const day = new Date().toISOString().slice(0, 10);
    return join(WORKER_LOG_DIR, `worker-${day}.log`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
