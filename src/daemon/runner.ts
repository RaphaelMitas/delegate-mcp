import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

import type { DelegateConfig } from "../shared/config.js";
import type { JobRecord } from "../shared/types.js";
import { parseStreamLine, type StreamUpdate } from "./streamParser.js";

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
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_")) continue;
    if (key === "CLAUDECODE") continue;
    env[key] = value;
  }
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

export function startClaudeProcess(
  job: JobRecord,
  config: DelegateConfig,
  callbacks: RunnerCallbacks,
): RunningProcess {
  const child: ChildProcess = spawn(config.claudePath, buildJobArgs(job), {
    cwd: job.workdir,
    env: buildJobEnv(process.env, config, job.model),
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
    child.stdin.write(job.prompt);
    child.stdin.end();
  }

  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      callbacks.onLine(line, parseStreamLine(line));
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
