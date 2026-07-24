import path from "node:path";

import { startDaemon } from "../daemon/index.js";
import { runMcpServer } from "../mcp/server.js";
import { DaemonClient } from "../shared/daemonClient.js";
import { VERSION } from "../shared/version.js";

const HELP = `delegate-mcp ${VERSION} — delegate agentic coding tasks to a local model

Usage:
  delegate-mcp mcp                 Run the MCP stdio server (for Claude Code)
  delegate-mcp daemon              Run the job daemon in the foreground
  delegate-mcp start <workdir> <prompt>
                                   Start a job from the shell (returns job id)
  delegate-mcp status [jobId]      Show recent jobs or one job's status
  delegate-mcp logs <jobId> [n]    Tail a job's raw stream-json events
  delegate-mcp cancel <jobId>      Cancel a queued or running job
  delegate-mcp health              Daemon + backend health
  delegate-mcp version             Print version

Register with Claude Code:
  claude mcp add --scope user delegate -- delegate-mcp mcp
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const client = new DaemonClient();

  switch (command) {
    case "mcp":
      await runMcpServer();
      return;
    case "daemon":
      await startDaemon();
      return;
    case "start": {
      const [workdir, prompt] = rest;
      if (workdir === undefined || prompt === undefined) {
        throw new Error('usage: delegate-mcp start <workdir> "prompt"');
      }
      const job = await client.startJob({
        prompt,
        workdir: path.resolve(workdir),
      });
      console.log(JSON.stringify(job, null, 2));
      return;
    }
    case "status": {
      const jobId = rest[0];
      if (jobId === undefined) {
        console.log(JSON.stringify(await client.listJobs(), null, 2));
      } else {
        console.log(JSON.stringify(await client.getJob(jobId), null, 2));
      }
      return;
    }
    case "logs": {
      const jobId = rest[0];
      if (jobId === undefined)
        throw new Error("usage: delegate-mcp logs <jobId> [tailLines]");
      const tail = rest[1] !== undefined ? Number.parseInt(rest[1], 10) : 100;
      console.log(await client.logs(jobId, tail));
      return;
    }
    case "cancel": {
      const jobId = rest[0];
      if (jobId === undefined)
        throw new Error("usage: delegate-mcp cancel <jobId>");
      console.log(JSON.stringify(await client.cancel(jobId), null, 2));
      return;
    }
    case "health":
      console.log(JSON.stringify(await client.health(), null, 2));
      return;
    case "version":
      console.log(VERSION);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
