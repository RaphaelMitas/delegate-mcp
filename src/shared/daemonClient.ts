import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { readRuntimeInfo } from "../daemon/index.js";
import { dataDir, daemonLogPath } from "./paths.js";
import { isVersionOlder, VERSION } from "./version.js";
import type { FileConfig } from "./config.js";
import type {
  HealthResponse,
  JobRecord,
  JobSummary,
  RuntimeInfo,
  StartJobRequest,
} from "./types.js";

export interface ConfigResponse {
  file: FileConfig;
  effective: FileConfig &
    Required<
      Pick<
        FileConfig,
        | "baseUrl"
        | "model"
        | "permissionMode"
        | "stallSeconds"
        | "timeoutSeconds"
        | "maxTurns"
        | "concurrency"
      >
    >;
}

export class DaemonClient {
  private runtime: RuntimeInfo | undefined;

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
  ): Promise<T> {
    const runtime = await this.ensureDaemon();
    const response = await fetch(
      `http://127.0.0.1:${runtime.port}${pathname}`,
      {
        method,
        headers: {
          authorization: `Bearer ${runtime.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        const parsed = JSON.parse(text) as { error?: string };
        if (parsed.error !== undefined) message = parsed.error;
      } catch {
        // keep raw text
      }
      throw new Error(
        `daemon ${method} ${pathname} failed (${response.status}): ${message}`,
      );
    }
    if (response.headers.get("content-type")?.includes("ndjson")) {
      return text as T;
    }
    return JSON.parse(text) as T;
  }

  async ensureDaemon(): Promise<RuntimeInfo> {
    if (this.runtime && (await this.isLive(this.runtime))) {
      return (await this.healIfOutdated(this.runtime)) ?? this.runtime;
    }
    const existing = readRuntimeInfo();
    if (existing && (await this.isLive(existing))) {
      this.runtime = existing;
      return (await this.healIfOutdated(existing)) ?? existing;
    }
    await this.spawnDaemon();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await delay(250);
      const info = readRuntimeInfo();
      if (info && (await this.isLive(info))) {
        this.runtime = info;
        return info;
      }
    }
    throw new Error(
      `delegate-mcp daemon did not become healthy within 15s; check ${daemonLogPath()}`,
    );
  }

  /**
   * Self-healing: when the running daemon is an older release than this
   * client (typical after a brew upgrade), ask it to shut down and spawn a
   * fresh one. The daemon refuses (409) while jobs are active or queued, in
   * which case the old daemon keeps serving. Attempted at most once per
   * client so a refusal can't loop.
   */
  private healAttempted = false;

  private async healIfOutdated(
    info: RuntimeInfo,
  ): Promise<RuntimeInfo | undefined> {
    if (this.healAttempted) return undefined;
    if (!isVersionOlder(info.version, VERSION)) return undefined;
    this.healAttempted = true;
    try {
      const response = await fetch(`http://127.0.0.1:${info.port}/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${info.token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return undefined;
    } catch {
      return undefined;
    }
    const gone = Date.now() + 5000;
    while (Date.now() < gone && (await this.isLive(info))) {
      await delay(200);
    }
    this.runtime = undefined;
    await this.spawnDaemon();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await delay(250);
      const fresh = readRuntimeInfo();
      if (fresh && fresh.pid !== info.pid && (await this.isLive(fresh))) {
        this.runtime = fresh;
        return fresh;
      }
    }
    return undefined;
  }

  private async isLive(info: RuntimeInfo): Promise<boolean> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${info.port}/health?token=${encodeURIComponent(info.token)}`,
        { signal: AbortSignal.timeout(2000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  private async spawnDaemon(): Promise<void> {
    fs.mkdirSync(dataDir(), { recursive: true });
    const logFd = fs.openSync(daemonLogPath(), "a");
    const command = selfCommand();
    const child = spawn(
      command[0],
      [...command.slice(1), "daemon", "--foreground"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    child.unref();
    fs.closeSync(logFd);
    await delay(100);
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  async startJob(request: StartJobRequest): Promise<JobSummary> {
    const { job } = await this.request<{ job: JobSummary }>(
      "POST",
      "/jobs",
      request,
    );
    return job;
  }

  async listJobs(limit = 20): Promise<JobSummary[]> {
    const { jobs } = await this.request<{ jobs: JobSummary[] }>(
      "GET",
      `/jobs?limit=${limit}`,
    );
    return jobs;
  }

  async getJob(jobId: string): Promise<JobRecord> {
    const { job } = await this.request<{ job: JobRecord }>(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}`,
    );
    return job;
  }

  logs(jobId: string, tail = 100): Promise<string> {
    return this.request<string>(
      "GET",
      `/jobs/${encodeURIComponent(jobId)}/logs?tail=${tail}`,
    );
  }

  async cancel(jobId: string): Promise<JobSummary> {
    const { job } = await this.request<{ job: JobSummary }>(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
    );
    return job;
  }

  getConfig(): Promise<ConfigResponse> {
    return this.request<ConfigResponse>("GET", "/config");
  }

  saveConfig(patch: FileConfig): Promise<ConfigResponse> {
    return this.request<ConfigResponse>("PUT", "/config", patch);
  }
}

/**
 * Command that re-invokes this same program, whether it is running as a
 * Bun-compiled binary (execPath is the binary itself) or under
 * node/tsx (execPath is the runtime, argv[1] the entry script).
 */
export function selfCommand(): [string, ...string[]] {
  const runtime = path.basename(process.execPath).toLowerCase();
  const entry = process.argv[1];
  if (
    (runtime.startsWith("node") || runtime.startsWith("bun")) &&
    entry !== undefined
  ) {
    // execArgv carries loader flags (e.g. tsx) needed to run a .ts entry.
    return [process.execPath, ...process.execArgv, entry];
  }
  return [process.execPath];
}
