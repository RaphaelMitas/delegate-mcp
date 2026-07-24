import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDaemonServer } from "../src/daemon/httpServer.js";
import { JobManager } from "../src/daemon/jobManager.js";
import type { RunnerCallbacks } from "../src/daemon/runner.js";
import { parseStreamLine } from "../src/daemon/streamParser.js";
import { CONFIG_DEFAULTS } from "../src/shared/config.js";
import type { JobSummary } from "../src/shared/types.js";

const TOKEN = "test-token";

let dataDir: string;
let workdir: string;
let server: http.Server;
let baseUrl: string;
let callbacksList: RunnerCallbacks[];

function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
  });
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-http-"));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-http-work-"));
  vi.stubEnv("DELEGATE_DATA_DIR", dataDir);
  callbacksList = [];

  const manager = new JobManager(
    { ...CONFIG_DEFAULTS, model: "test-model" },
    {
      resolveModel: () => Promise.resolve("test-model"),
      startProcess: (_job, _config, callbacks) => {
        callbacksList.push(callbacks);
        return { pid: 42, kill: () => undefined };
      },
    },
  );
  server = createDaemonServer({
    config: { ...CONFIG_DEFAULTS, model: "test-model" },
    manager,
    token: TOKEN,
    version: "0.0.0-test",
    startedAt: new Date().toISOString(),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("daemon HTTP API", () => {
  it("rejects requests without the token", async () => {
    const response = await fetch(`${baseUrl}/jobs`);
    expect(response.status).toBe(401);
  });

  it("starts a job and exposes status, logs, and result", async () => {
    const created = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({ prompt: "do a thing", workdir }),
    });
    expect(created.status).toBe(201);
    const { job } = (await created.json()) as { job: JobSummary };
    expect(job.state).toBe("running");

    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Grep", input: { pattern: "x" } }],
      },
    });
    callbacksList[0]?.onLine(line, parseStreamLine(line));

    const status = await api(`/jobs/${job.id}`);
    const statusBody = (await status.json()) as {
      job: { currentTool?: { name: string } };
    };
    expect(statusBody.job.currentTool?.name).toBe("Grep");

    const logs = await api(`/jobs/${job.id}/logs?tail=10`);
    expect(await logs.text()).toContain('"Grep"');

    const resultLine = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 10,
      result: "finished",
    });
    callbacksList[0]?.onLine(resultLine, parseStreamLine(resultLine));
    callbacksList[0]?.onExit({ code: 0, signal: null, stderrTail: "" });

    const finished = await api(`/jobs/${job.id}`);
    const finishedBody = (await finished.json()) as {
      job: { state: string; result?: { text: string } };
    };
    expect(finishedBody.job.state).toBe("succeeded");
    expect(finishedBody.job.result?.text).toBe("finished");
  });

  it("validates the start payload", async () => {
    const response = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({ workdir }),
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for unknown jobs", async () => {
    const response = await api("/jobs/nope");
    expect(response.status).toBe(404);
  });

  it("streams job events over SSE", async () => {
    const buffer = await new Promise<string>((resolve, reject) => {
      const request = http.get(`${baseUrl}/events?token=${TOKEN}`, (res) => {
        expect(res.statusCode).toBe(200);
        let collected = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          collected += chunk;
          if (collected.includes("job-updated")) {
            request.destroy();
            resolve(collected);
          }
        });
        void api("/jobs", {
          method: "POST",
          body: JSON.stringify({ prompt: "sse job", workdir }),
        }).catch(reject);
      });
      request.on("error", () => {
        // destroy() after resolve triggers a socket error; ignore it.
      });
    });
    expect(buffer).toContain("event: job-updated");
    expect(buffer).toContain("sse job");
  });
});
