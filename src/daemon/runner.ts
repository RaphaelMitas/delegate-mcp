import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import type { DelegateConfig } from "../shared/config.js";
import type { JobRecord } from "../shared/types.js";
import { createStreamParser, type StreamUpdate } from "./streamParser.js";

export interface RunnerCallbacks {
  /** Called for every stdout line with its parsed updates (may be empty). */
  onLine: (rawLine: string, updates: StreamUpdate[]) => void;
  /** Called once when the process exits, however it exits. */
  onExit: (outcome: {
    code: number | null;
    signal: NodeJS.Signals | null;
    stderrTail: string;
  }) => void;
  onSpawnError: (error: Error) => void;
}

export interface RunningProcess {
  pid: number | undefined;
  kill: () => void;
}

/** Fully resolved invocation of a harness CLI for one job. */
export interface HarnessCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** When false the prompt is passed as the last CLI argument instead. */
  promptViaStdin: boolean;
}

function scrubEnv(
  base: NodeJS.ProcessEnv,
  prefixes: string[],
  exact: string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
    if (exact.includes(key)) continue;
    env[key] = value;
  }
  return env;
}

function backendV1Url(config: DelegateConfig): string {
  return `${config.baseUrl.replace(/\/$/, "")}/v1`;
}

/**
 * Environment for the spawned Claude Code process: inherit the caller's
 * environment minus anything Anthropic/Claude-related (the daemon may itself
 * have been started from inside a Claude Code session), then point the CLI at
 * the local Anthropic-compatible backend.
 */
export function buildJobEnv(
  base: NodeJS.ProcessEnv,
  config: DelegateConfig,
  model: string,
): NodeJS.ProcessEnv {
  const env = scrubEnv(base, ["ANTHROPIC_", "CLAUDE_"], ["CLAUDECODE"]);
  env.ANTHROPIC_BASE_URL = config.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = config.authToken;
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL =
    config.smallFastModel !== "" ? config.smallFastModel : model;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  return env;
}

export function buildJobArgs(job: JobRecord): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    job.permissionMode,
    "--max-turns",
    String(job.maxTurns),
  ];
  if (job.appendSystemPrompt !== undefined && job.appendSystemPrompt !== "") {
    args.push("--append-system-prompt", job.appendSystemPrompt);
  }
  return args;
}

/**
 * Codex only speaks the OpenAI "responses" wire API (chat was removed in
 * 0.145), which LM Studio serves at /v1/responses. The provider is injected
 * entirely via -c overrides so the user's ~/.codex/config.toml stays intact.
 */
export function buildCodexCommand(
  job: JobRecord,
  config: DelegateConfig,
  base: NodeJS.ProcessEnv,
): HarnessCommand {
  const env = scrubEnv(base, ["OPENAI_", "CODEX_"]);
  env.DELEGATE_API_KEY = config.authToken;

  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    "model_provider=delegate",
    "-c",
    'model_providers.delegate.name="Delegate backend"',
    "-c",
    `model_providers.delegate.base_url="${backendV1Url(config)}"`,
    "-c",
    'model_providers.delegate.env_key="DELEGATE_API_KEY"',
    "-c",
    'model_providers.delegate.wire_api="responses"',
    "-m",
    job.model,
  ];
  switch (job.permissionMode) {
    case "bypassPermissions":
      args.push("--dangerously-bypass-approvals-and-sandbox");
      break;
    case "plan":
      args.push("-s", "read-only");
      break;
    default:
      args.push("-s", "workspace-write");
  }
  args.push("-");
  return { command: config.codexPath, args, env, promptViaStdin: true };
}

/**
 * OpenCode gets its provider and permission policy through
 * OPENCODE_CONFIG_CONTENT so no config file has to be written; the model is
 * addressed as delegate/<model>.
 */
export function buildOpencodeCommand(
  job: JobRecord,
  config: DelegateConfig,
  base: NodeJS.ProcessEnv,
): HarnessCommand {
  const env = scrubEnv(base, ["OPENCODE_"]);
  const opencodeConfig: Record<string, unknown> = {
    provider: {
      delegate: {
        npm: "@ai-sdk/openai-compatible",
        name: "Delegate backend",
        options: { baseURL: backendV1Url(config), apiKey: config.authToken },
        models: { [job.model]: { name: job.model } },
      },
    },
  };
  switch (job.permissionMode) {
    case "acceptEdits":
      opencodeConfig.permission = { edit: "allow" };
      break;
    case "bypassPermissions":
      opencodeConfig.permission = {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
      };
      break;
    case "plan":
      opencodeConfig.permission = { edit: "deny", bash: "deny" };
      break;
    case "default":
      break;
  }
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opencodeConfig);
  // OpenCode resolves its project root from $PWD, not the process cwd, so an
  // inherited PWD would silently retarget the job at the daemon's directory.
  env.PWD = job.workdir;

  const args = [
    "run",
    "--format",
    "json",
    "--dir",
    job.workdir,
    "-m",
    `delegate/${job.model}`,
  ];
  if (job.permissionMode === "bypassPermissions") args.push("--auto");
  args.push(job.prompt);
  return { command: config.opencodePath, args, env, promptViaStdin: false };
}

export function buildHarnessCommand(
  job: JobRecord,
  config: DelegateConfig,
  base: NodeJS.ProcessEnv = process.env,
): HarnessCommand {
  switch (job.harness) {
    case "codex":
      return buildCodexCommand(job, config, base);
    case "opencode":
      return buildOpencodeCommand(job, config, base);
    case "claude":
      return {
        command: config.claudePath,
        args: buildJobArgs(job),
        env: buildJobEnv(base, config, job.model),
        promptViaStdin: true,
      };
  }
}

export function startHarnessProcess(
  job: JobRecord,
  config: DelegateConfig,
  callbacks: RunnerCallbacks,
): RunningProcess {
  const invocation = buildHarnessCommand(job, config);
  const parse = createStreamParser(job.harness);
  const child: ChildProcess = spawn(invocation.command, invocation.args, {
    cwd: job.workdir,
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  let exited = false;

  child.on("error", (error) => {
    if (exited) return;
    exited = true;
    callbacks.onSpawnError(error);
  });

  if (child.stdin) {
    child.stdin.on("error", () => {
      // The process can exit before the prompt is fully written; the exit
      // handler reports the real failure.
    });
    if (invocation.promptViaStdin) child.stdin.write(job.prompt);
    child.stdin.end();
  }

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      callbacks.onLine(line, parse(line));
    });
  }

  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 50) stderrChunks.shift();
    });
  }

  child.on("close", (code, signal) => {
    if (exited) return;
    exited = true;
    callbacks.onExit({
      code,
      signal,
      stderrTail: stderrChunks.join("").slice(-4000),
    });
  });

  return {
    pid: child.pid,
    kill: () => {
      if (child.pid === undefined || exited) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 5000).unref();
    },
  };
}
