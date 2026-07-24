import { invoke } from "@tauri-apps/api/core";

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export interface DaemonFileConfig {
  baseUrl?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  stallSeconds?: number;
  timeoutSeconds?: number;
  maxTurns?: number;
}

export interface DaemonConfigResponse {
  file: DaemonFileConfig;
  effective: DaemonFileConfig &
    Required<
      Pick<
        DaemonFileConfig,
        | "baseUrl"
        | "model"
        | "permissionMode"
        | "stallSeconds"
        | "timeoutSeconds"
        | "maxTurns"
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

export function getRuntime(): Promise<RuntimeInfo | null> {
  return invoke<RuntimeInfo | null>("get_daemon_runtime");
}

export function spawnDaemon(): Promise<string> {
  return invoke<string>("spawn_daemon");
}

export function setTrayStatus(status: string): Promise<void> {
  return invoke("set_tray_status", { status });
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
