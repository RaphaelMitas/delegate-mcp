import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DaemonClient } from "../shared/daemonClient.js";
import { installSkill, uninstallSkill } from "../shared/skill.js";
import { VERSION } from "../shared/version.js";

function jsonContent(value: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorContent(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return {
    content: [
      { type: "text", text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

export async function runMcpServer(): Promise<void> {
  const client = new DaemonClient();
  const server = new McpServer(
    { name: "delegate-mcp", version: VERSION },
    {
      instructions:
        "delegate-mcp runs a FREE local coding agent on this machine. Proactively offload self-contained subtasks to it instead of doing them inline: implementation from a clear spec, mechanical refactors, bulk edits, test writing, boilerplate, isolated bug fixes, docs. Delegated jobs run in parallel with your own work at zero cost. Keep judgment work (design, ambiguous specs, final review) yourself, write fully self-contained prompts (the delegate shares none of your context), and always verify delegated results by reading the diff and running tests before presenting them as done.",
    },
  );

  server.registerTool(
    "delegate_start",
    {
      description:
        "Delegate a self-contained coding subtask to a FREE local model (headless Claude Code, Codex CLI, or OpenCode against a local backend such as LM Studio). Use proactively for independent, well-specified, verifiable work — bulk edits, tests, boilerplate, mechanical refactors, isolated fixes — instead of doing it yourself; jobs run in parallel with your own work at zero cost. Returns immediately with a job id; poll delegate_status and verify the result yourself. The prompt must be fully self-contained: goal, relevant paths, constraints, and what 'done' looks like (the delegate shares none of your context).",
      inputSchema: {
        prompt: z
          .string()
          .describe("Self-contained task prompt for the local agent"),
        workdir: z
          .string()
          .describe("Absolute path the agent runs in (its project root)"),
        model: z
          .string()
          .optional()
          .describe("Backend model id; defaults to configured/loaded model"),
        harness: z
          .enum(["claude", "codex", "opencode"])
          .optional()
          .describe(
            "Coding-agent CLI to run this job with; defaults to the configured harness",
          ),
        timeoutSeconds: z.number().int().positive().optional(),
        stallSeconds: z.number().int().positive().optional(),
        permissionMode: z
          .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
          .optional(),
        maxTurns: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Claude harness only; codex/opencode ignore it"),
        appendSystemPrompt: z
          .string()
          .optional()
          .describe("Claude harness only; codex/opencode ignore it"),
      },
    },
    async (args) => {
      try {
        const job = await client.startJob(args);
        return jsonContent({
          jobId: job.id,
          state: job.state,
          queuePosition: job.queuePosition ?? 0,
          hint: "Poll delegate_status with this jobId; fetch the final output with delegate_result.",
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_status",
    {
      description:
        "Status of a delegated job (or the active + recent jobs when jobId is omitted): state, elapsed time, turns, seconds since last event, current tool call, recent activity. Use this to see what the local agent is doing right now and whether it is stuck.",
      inputSchema: {
        jobId: z.string().optional(),
        activityLimit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How many recent activity items to include (default 10)"),
      },
    },
    async ({ jobId, activityLimit }) => {
      try {
        if (jobId === undefined) {
          return jsonContent({ jobs: await client.listJobs() });
        }
        const job = await client.getJob(jobId);
        const limit = activityLimit ?? 10;
        return jsonContent({
          id: job.id,
          state: job.state,
          workdir: job.workdir,
          model: job.model,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          turns: job.turns,
          secondsSinceLastEvent:
            job.lastEventAt !== undefined
              ? Math.round((Date.now() - Date.parse(job.lastEventAt)) / 1000)
              : undefined,
          currentTool: job.currentTool,
          lastText: job.lastText,
          recentActivity: job.recentActivity.slice(-limit),
          error: job.error,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_result",
    {
      description:
        "Final result of a finished delegated job: the agent's closing message plus run stats. Errors if the job is still active.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        const job = await client.getJob(jobId);
        if (job.state === "queued" || job.state === "running") {
          return errorContent(
            new Error(
              `job ${jobId} is still ${job.state}; poll delegate_status until it finishes`,
            ),
          );
        }
        return jsonContent({
          id: job.id,
          state: job.state,
          result: job.result?.text,
          isError: job.result?.isError,
          numTurns: job.result?.numTurns ?? job.turns,
          durationMs: job.result?.durationMs,
          error: job.error,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_logs",
    {
      description:
        "Raw stream-json event log tail of a delegated job, for deep debugging when status is not enough.",
      inputSchema: {
        jobId: z.string(),
        tail: z.number().int().positive().optional(),
      },
    },
    async ({ jobId, tail }) => {
      try {
        const logs = await client.logs(jobId, tail ?? 50);
        return {
          content: [
            {
              type: "text",
              text: logs === "" ? "(no events logged yet)" : logs,
            },
          ],
        };
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_cancel",
    {
      description: "Cancel a queued or running delegated job.",
      inputSchema: { jobId: z.string() },
    },
    async ({ jobId }) => {
      try {
        return jsonContent({ job: await client.cancel(jobId) });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_config",
    {
      description:
        "Read or update daemon configuration (harness, baseUrl, model, permissionMode, maxTurns, stallSeconds, timeoutSeconds, concurrency, harness binary paths). Call with no arguments to read current settings. Pass fields to update them — only provided fields are changed, others are preserved. Changes are written to the config file and take effect immediately.",
      inputSchema: {
        baseUrl: z
          .string()
          .url()
          .optional()
          .describe("Backend URL (e.g. http://127.0.0.1:1234)"),
        model: z.string().optional().describe("Model id to use"),
        harness: z
          .enum(["claude", "codex", "opencode"])
          .optional()
          .describe(
            "Default coding-agent CLI for delegated jobs: claude (Claude Code), codex (Codex CLI), or opencode (OpenCode)",
          ),
        claudePath: z.string().optional().describe("Path to the claude binary"),
        codexPath: z.string().optional().describe("Path to the codex binary"),
        opencodePath: z
          .string()
          .optional()
          .describe("Path to the opencode binary"),
        permissionMode: z
          .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
          .optional()
          .describe("Permission mode for delegated agents"),
        maxTurns: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum tool-call turns per job"),
        stallSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Seconds without an event before a job is killed as stalled",
          ),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Wall-clock timeout per job in seconds"),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe("Max concurrent jobs"),
      },
    },
    async (args) => {
      try {
        const hasUpdates = Object.values(args).some((v) => v !== undefined);
        if (hasUpdates) {
          return jsonContent(await client.saveConfig(args));
        }
        return jsonContent(await client.getConfig());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_health",
    {
      description:
        "Health of the delegation daemon and its model backend: backend reachability, loaded models, active job, queue depth. Call this first when delegation seems broken.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonContent(await client.health());
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  server.registerTool(
    "delegate_install_skill",
    {
      description:
        "Install (or uninstall) the delegation skill so the coding agent proactively delegates subtasks to the free local model. Supports Claude Code, Codex CLI, and OpenCode. By default installs for all harnesses; pass specific harnesses to limit scope.",
      inputSchema: {
        harnesses: z
          .array(z.enum(["claude", "codex", "opencode"]))
          .optional()
          .describe(
            "Which harnesses to install for; defaults to all three",
          ),
        uninstall: z
          .boolean()
          .optional()
          .describe("Set to true to remove the skill instead of installing it"),
      },
    },
    ({ harnesses, uninstall }) => {
      try {
        const results = uninstall
          ? uninstallSkill(harnesses)
          : installSkill(harnesses);
        return jsonContent({
          action: uninstall ? "uninstalled" : "installed",
          skills: results,
        });
      } catch (err) {
        return errorContent(err);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
