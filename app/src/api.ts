const isTauri = "__TAURI_INTERNALS__" in window;
export const isMock = new URLSearchParams(window.location.search).has("mock");

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export type Harness = "claude" | "codex" | "opencode";

export interface DaemonFileConfig {
  baseUrl?: string;
  model?: string;
  harness?: Harness;
  claudePath?: string;
  codexPath?: string;
  opencodePath?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  stallSeconds?: number;
  timeoutSeconds?: number;
  maxTurns?: number;
  concurrency?: number;
}

export interface DaemonConfigResponse {
  file: DaemonFileConfig;
  effective: DaemonFileConfig &
    Required<
      Pick<
        DaemonFileConfig,
        | "baseUrl"
        | "model"
        | "harness"
        | "permissionMode"
        | "stallSeconds"
        | "timeoutSeconds"
        | "maxTurns"
        | "concurrency"
      >
    >;
}

export interface BackendHealth {
  baseUrl: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  backend: BackendHealth;
  activeJobId?: string;
  queueDepth: number;
  concurrency: number;
}

export interface ActivityItem {
  at: string;
  kind: "system" | "text" | "tool_use" | "tool_result" | "result";
  summary: string;
}

export interface JobSummary {
  id: string;
  state:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "stalled"
    | "timeout"
    | "canceled";
  promptPreview: string;
  workdir: string;
  model: string;
  harness?: Harness;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  turns: number;
  secondsSinceLastEvent?: number;
  queuePosition?: number;
  currentTool?: { name: string; input: string; startedAt: string };
  lastText?: string;
  error?: string;
  resultPreview?: string;
  isError?: boolean;
}

export interface JobRecord extends Omit<JobSummary, "promptPreview"> {
  prompt: string;
  recentActivity: ActivityItem[];
  result?: {
    text: string;
    isError: boolean;
    subtype: string;
    numTurns: number;
    durationMs: number;
  };
}

export async function getRuntime(): Promise<RuntimeInfo | null> {
  if (isTauri) return tauriInvoke<RuntimeInfo | null>("get_daemon_runtime");
  const params = new URLSearchParams(window.location.search);
  const port = params.get("port");
  const token = params.get("token");
  if (!port || !token) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const h = (await res.json()) as HealthResponse & { pid: number; startedAt: string };
    return { port: Number(port), token, pid: h.pid, version: h.version, startedAt: h.startedAt };
  } catch {
    return null;
  }
}

export async function spawnDaemon(): Promise<string> {
  if (isTauri) return tauriInvoke<string>("spawn_daemon");
  throw new Error("Cannot spawn daemon from browser — start it manually: delegate-mcp daemon");
}

export async function setTrayStatus(status: string): Promise<void> {
  if (isTauri) return tauriInvoke("set_tray_status", { status });
  void status;
}

function base(runtime: RuntimeInfo): string {
  return `http://127.0.0.1:${runtime.port}`;
}

async function get<T>(runtime: RuntimeInfo, path: string): Promise<T> {
  const response = await fetch(`${base(runtime)}${path}`, {
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export function fetchHealth(runtime: RuntimeInfo): Promise<HealthResponse> {
  return get<HealthResponse>(runtime, "/health");
}

export async function fetchJobs(runtime: RuntimeInfo): Promise<JobSummary[]> {
  const { jobs } = await get<{ jobs: JobSummary[] }>(runtime, "/jobs?limit=30");
  return jobs;
}

export async function fetchJob(
  runtime: RuntimeInfo,
  jobId: string,
): Promise<JobRecord> {
  const { job } = await get<{ job: JobRecord }>(
    runtime,
    `/jobs/${encodeURIComponent(jobId)}`,
  );
  return job;
}

export async function fetchLogs(
  runtime: RuntimeInfo,
  jobId: string,
): Promise<string> {
  const response = await fetch(
    `${base(runtime)}/jobs/${encodeURIComponent(jobId)}/logs?tail=200`,
    { headers: { authorization: `Bearer ${runtime.token}` } },
  );
  if (!response.ok) throw new Error(`logs: ${response.status}`);
  return response.text();
}

/** Ask the daemon to exit; it refuses with 409 while jobs are active. */
export async function shutdownDaemon(runtime: RuntimeInfo): Promise<boolean> {
  const response = await fetch(`${base(runtime)}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.token}` },
  });
  return response.ok;
}

export async function cancelJob(
  runtime: RuntimeInfo,
  jobId: string,
): Promise<void> {
  const response = await fetch(
    `${base(runtime)}/jobs/${encodeURIComponent(jobId)}/cancel`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.token}` },
    },
  );
  if (!response.ok) throw new Error(`cancel: ${response.status}`);
}

export function subscribeEvents(
  runtime: RuntimeInfo,
  onJobUpdated: (job: JobSummary) => void,
  onActivity: (jobId: string, item: ActivityItem) => void,
): () => void {
  const source = new EventSource(
    `${base(runtime)}/events?token=${encodeURIComponent(runtime.token)}`,
  );
  source.addEventListener("job-updated", (event) => {
    const parsed = JSON.parse(event.data) as { job: JobSummary };
    onJobUpdated(parsed.job);
  });
  source.addEventListener("activity", (event) => {
    const parsed = JSON.parse(event.data) as {
      jobId: string;
      item: ActivityItem;
    };
    onActivity(parsed.jobId, parsed.item);
  });
  return () => {
    source.close();
  };
}

export async function fetchConfig(
  runtime: RuntimeInfo,
): Promise<DaemonConfigResponse> {
  return get<DaemonConfigResponse>(runtime, "/config");
}

export async function saveConfig(
  runtime: RuntimeInfo,
  patch: DaemonFileConfig,
): Promise<DaemonConfigResponse> {
  const response = await fetch(`${base(runtime)}/config`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`config: ${response.status}`);
  return await response.json();
}
