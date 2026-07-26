import type {
  ActivityItem,
  DaemonConfigResponse,
  HealthResponse,
  JobRecord,
  JobSummary,
  RuntimeInfo,
} from "./api.ts";

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export const MOCK_RUNTIME: RuntimeInfo = {
  port: 9999,
  token: "mock",
  pid: 1,
  version: "0.2.4",
  startedAt: ago(120),
};

export const MOCK_HEALTH: HealthResponse = {
  ok: true,
  version: "0.2.4",
  backend: {
    baseUrl: "http://127.0.0.1:1234",
    reachable: true,
    models: ["qwen3-coder-next", "qwen3-coder-next-embedding"],
  },
  queueDepth: 0,
  concurrency: 1,
};

const activity: ActivityItem[] = [
  { at: ago(6), kind: "text", summary: "I'll start by reading the existing auth middleware to understand the current implementation." },
  { at: ago(5), kind: "tool_use", summary: "shell /bin/zsh -lc 'cat src/middleware/auth.ts'" },
  { at: ago(5), kind: "tool_result", summary: "tool result" },
  { at: ago(4), kind: "text", summary: "Now let me check the test file:" },
  { at: ago(4), kind: "tool_use", summary: "shell /bin/zsh -lc 'cat src/middleware/__tests__/auth.test.ts'" },
  { at: ago(4), kind: "tool_result", summary: "tool result" },
  { at: ago(3), kind: "tool_use", summary: "filesystem.write src/middleware/auth.ts" },
  { at: ago(3), kind: "tool_result", summary: "tool result" },
  { at: ago(2), kind: "tool_use", summary: "shell /bin/zsh -lc 'npm test -- --run src/middleware'" },
  { at: ago(2), kind: "tool_result", summary: "tool result" },
  { at: ago(1), kind: "text", summary: "All 12 tests pass. The middleware now validates JWT expiry and refreshes tokens within the 5-minute window." },
];

export const MOCK_JOBS: JobSummary[] = [
  {
    id: "job-1",
    state: "running",
    promptPreview: "Refactor the authentication middleware to support JWT token refresh. The current implementation silently drops expired tokens...",
    workdir: "/Users/dev/projects/my-api",
    model: "qwen3-coder-next",
    harness: "claude",
    createdAt: ago(8),
    startedAt: ago(7),
    turns: 6,
    secondsSinceLastEvent: 3,
    currentTool: { name: "filesystem.write", input: "src/middleware/auth.ts", startedAt: ago(0.5) },
  },
  {
    id: "job-2",
    state: "succeeded",
    promptPreview: "Add unit tests for the UserService class. Cover the create, update, and delete methods, including edge cases for duplicate emails...",
    workdir: "/Users/dev/projects/my-api",
    model: "qwen3-coder-next",
    harness: "claude",
    createdAt: ago(25),
    startedAt: ago(24),
    endedAt: ago(18),
    turns: 14,
    resultPreview: "Added 18 tests across 3 test files covering UserService CRUD operations...",
  },
  {
    id: "job-3",
    state: "succeeded",
    promptPreview: "Fix the race condition in the WebSocket connection handler. When two clients connect simultaneously, the second connection...",
    workdir: "/Users/dev/projects/my-api",
    model: "qwen3-coder-next",
    harness: "codex",
    createdAt: ago(45),
    startedAt: ago(44),
    endedAt: ago(35),
    turns: 9,
    resultPreview: "Fixed the race condition by adding a mutex around the connection registry...",
  },
  {
    id: "job-4",
    state: "succeeded",
    promptPreview: "Migrate the database schema from Prisma to Drizzle ORM. Keep all existing relations and indices. Update the seed script...",
    workdir: "/Users/dev/projects/my-api",
    model: "qwen3-coder-next",
    harness: "claude",
    createdAt: ago(90),
    startedAt: ago(89),
    endedAt: ago(60),
    turns: 22,
    resultPreview: "Migrated 8 models from Prisma to Drizzle. Updated seed script and all repository files...",
  },
  {
    id: "job-5",
    state: "failed",
    promptPreview: "Set up GitHub Actions CI pipeline with lint, typecheck, test, and build steps. Use pnpm caching for faster runs...",
    workdir: "/Users/dev/projects/my-api",
    model: "qwen3-coder-next",
    harness: "claude",
    createdAt: ago(150),
    startedAt: ago(149),
    endedAt: ago(140),
    turns: 11,
    error: "context length exceeded (65536 tokens)",
  },
];

export const MOCK_JOB_DETAIL: JobRecord = {
  id: "job-1",
  state: "running",
  prompt:
    "Refactor the authentication middleware to support JWT token refresh. The current implementation silently drops expired tokens instead of attempting a refresh. Add a 5-minute refresh window before expiry. Keep backwards compatibility with existing session cookies.",
  workdir: "/Users/dev/projects/my-api",
  model: "qwen3-coder-next",
  harness: "claude",
  createdAt: ago(8),
  startedAt: ago(7),
  turns: 6,
  secondsSinceLastEvent: 3,
  currentTool: { name: "filesystem.write", input: "src/middleware/auth.ts", startedAt: ago(0.5) },
  recentActivity: activity,
};

export const MOCK_CONFIG: DaemonConfigResponse = {
  file: {},
  effective: {
    baseUrl: "http://127.0.0.1:1234",
    model: "",
    harness: "claude",
    claudePath: "claude",
    codexPath: "codex",
    opencodePath: "opencode",
    permissionMode: "acceptEdits",
    stallSeconds: 120,
    timeoutSeconds: 1800,
    maxTurns: 200,
    concurrency: 1,
  },
};
