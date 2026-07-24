import http from "node:http";
import { z } from "zod";

import type { DelegateConfig } from "../shared/config.js";
import type {
  HealthResponse,
  ServerEvent,
  StartJobRequest,
} from "../shared/types.js";
import { checkBackend } from "./backend.js";
import type { JobManager } from "./jobManager.js";

const startJobSchema = z.object({
  prompt: z.string().min(1),
  workdir: z.string().min(1),
  model: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  stallSeconds: z.number().int().positive().optional(),
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "bypassPermissions"])
    .optional(),
  maxTurns: z.number().int().positive().optional(),
  appendSystemPrompt: z.string().optional(),
});

export interface DaemonHttpServerOptions {
  config: DelegateConfig;
  manager: JobManager;
  token: string;
  version: string;
  startedAt: string;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return {};
  return JSON.parse(raw);
}

export function createDaemonServer(
  options: DaemonHttpServerOptions,
): http.Server {
  const { config, manager, token, version, startedAt } = options;
  const sseClients = new Set<http.ServerResponse>();

  manager.on("event", (event: ServerEvent) => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) client.write(frame);
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("unknown job")
        ? 404
        : message.includes("is not active") ||
            message.startsWith("workdir does not exist")
          ? 400
          : 500;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    // The daemon binds to loopback and every route requires the token; CORS
    // is open so the menu-bar app's webview (custom origin) can call it.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader(
      "access-control-allow-headers",
      "authorization, content-type",
    );
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const authHeader = req.headers.authorization;
    const provided =
      authHeader?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
    if (provided !== token) {
      sendJson(res, 401, { error: "invalid or missing token" });
      return;
    }

    if (method === "GET" && url.pathname === "/health") {
      const backend = await checkBackend(config);
      const health: HealthResponse = {
        ok: true,
        version,
        pid: process.pid,
        startedAt,
        backend,
        queueDepth: manager.queueDepth(),
        concurrency: config.concurrency,
      };
      const active = manager.activeJobId();
      if (active !== undefined) health.activeJobId = active;
      sendJson(res, 200, health);
      return;
    }

    if (method === "POST" && url.pathname === "/jobs") {
      const parsed = startJobSchema.safeParse(await readBody(req));
      if (!parsed.success) {
        sendJson(res, 400, {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
        return;
      }
      const request: StartJobRequest = parsed.data;
      const job = await manager.startJob(request);
      sendJson(res, 201, { job: manager.toSummary(job) });
      return;
    }

    if (method === "GET" && url.pathname === "/jobs") {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
      sendJson(res, 200, {
        jobs: manager.listJobs(Number.isNaN(limit) ? 20 : limit),
      });
      return;
    }

    const jobMatch = /^\/jobs\/([^/]+)(\/logs|\/cancel)?$/.exec(url.pathname);
    if (jobMatch) {
      const jobId = jobMatch[1] ?? "";
      const sub = jobMatch[2];
      if (method === "GET" && sub === undefined) {
        sendJson(res, 200, { job: manager.getJob(jobId) });
        return;
      }
      if (method === "GET" && sub === "/logs") {
        const tail = Number.parseInt(url.searchParams.get("tail") ?? "100", 10);
        const logs = manager.logsTail(jobId, Number.isNaN(tail) ? 100 : tail);
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(logs);
        return;
      }
      if (method === "POST" && sub === "/cancel") {
        const job = manager.cancel(jobId);
        sendJson(res, 200, { job: manager.toSummary(job) });
        return;
      }
    }

    if (method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${url.pathname}` });
  }

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const client of sseClients) client.end();
    sseClients.clear();
  });

  return server;
}
