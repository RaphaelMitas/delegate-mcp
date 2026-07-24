export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "stalled"
  | "timeout"
  | "canceled";

export const ACTIVE_STATES: readonly JobState[] = ["queued", "running"];

export interface ActivityItem {
  at: string;
  kind: "system" | "text" | "tool_use" | "tool_result" | "result";
  summary: string;
}

export interface JobResult {
  text: string;
  isError: boolean;
  subtype: string;
  numTurns: number;
  durationMs: number;
}

export interface JobRecord {
  id: string;
  state: JobState;
  prompt: string;
  workdir: string;
  model: string;
  permissionMode: PermissionMode;
  timeoutSeconds: number;
  stallSeconds: number;
  maxTurns: number;
  appendSystemPrompt?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  turns: number;
  lastEventAt?: string;
  currentTool?: { name: string; input: string; startedAt: string };
  lastText?: string;
  recentActivity: ActivityItem[];
  result?: JobResult;
  error?: string;
}

export interface JobSummary {
  id: string;
  state: JobState;
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

export type PermissionMode =
  "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface StartJobRequest {
  prompt: string;
  workdir: string;
  model?: string;
  timeoutSeconds?: number;
  stallSeconds?: number;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  appendSystemPrompt?: string;
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
  pid: number;
  startedAt: string;
  backend: BackendHealth;
  activeJobId?: string;
  queueDepth: number;
  concurrency: number;
}

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  version: string;
  startedAt: string;
}

export type ServerEvent =
  | { type: "job-updated"; job: JobSummary }
  | { type: "activity"; jobId: string; item: ActivityItem };
