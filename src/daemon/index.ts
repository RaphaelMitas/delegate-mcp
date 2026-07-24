import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import { loadConfig } from "../shared/config.js";
import { dataDir, jobsDir, runtimeFilePath } from "../shared/paths.js";
import type { RuntimeInfo } from "../shared/types.js";
import { VERSION } from "../shared/version.js";
import { JobManager } from "./jobManager.js";
import { createDaemonServer } from "./httpServer.js";

export function readRuntimeInfo(): RuntimeInfo | undefined {
  try {
    const raw = fs.readFileSync(runtimeFilePath(), "utf8");
    return JSON.parse(raw) as RuntimeInfo;
  } catch {
    return undefined;
  }
}

async function runtimeIsLive(info: RuntimeInfo): Promise<boolean> {
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

async function listen(server: net.Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to determine listen port");
  }
  return address.port;
}

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.mkdirSync(jobsDir(), { recursive: true });

  const existing = readRuntimeInfo();
  if (existing && (await runtimeIsLive(existing))) {
    console.error(
      `delegate-mcp daemon already running (pid ${existing.pid}, port ${existing.port})`,
    );
    return;
  }

  const manager = new JobManager(config);
  manager.loadPersistedJobs();

  const token = crypto.randomBytes(24).toString("hex");
  const startedAt = new Date().toISOString();
  const server = createDaemonServer({
    config,
    manager,
    token,
    version: VERSION,
    startedAt,
  });
  const port = await listen(server, config.port);

  const runtime: RuntimeInfo = {
    port,
    token,
    pid: process.pid,
    version: VERSION,
    startedAt,
  };
  fs.writeFileSync(runtimeFilePath(), JSON.stringify(runtime, null, 2), {
    mode: 0o600,
  });

  console.error(`delegate-mcp daemon listening on 127.0.0.1:${port}`);

  const shutdown = () => {
    manager.shutdown();
    server.close();
    try {
      const current = readRuntimeInfo();
      if (current?.pid === process.pid) fs.unlinkSync(runtimeFilePath());
    } catch {
      // best effort
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
