import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_WORKER_HOST = process.env.CODEX_MEM_WORKER_HOST || "127.0.0.1";
export const DEFAULT_WORKER_PORT = Number(process.env.CODEX_MEM_WORKER_PORT || "37777");

const DEFAULT_DATA_DIR = join(homedir(), ".codex-mem");
export const WORKER_PID_FILE = join(DEFAULT_DATA_DIR, "worker.pid");
export const WORKER_LOG_DIR = join(DEFAULT_DATA_DIR, "logs");

export function getWorkerBaseUrl(host = DEFAULT_WORKER_HOST, port = DEFAULT_WORKER_PORT): string {
  return `http://${host}:${port}`;
}
