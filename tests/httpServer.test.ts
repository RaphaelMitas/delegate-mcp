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
let configDir: string;
let workdir: string;
let server: http.Server;
let baseUrl: string;
let callbacksList: RunnerCallbacks[];
let shutdownSpy: ReturnType<typeof vi.fn>;

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
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-config-"));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-http-work-"));
  vi.stubEnv("DELEGATE_DATA_DIR", dataDir);
  vi.stubEnv("DELEGATE_CONFIG_FILE", path.join(configDir, "config.json"));
  callbacksList = [];

  // One shared config object for manager and server, as in production, so
  // config updates through the API reach the running manager.
  const sharedConfig = { ...CONFIG_DEFAULTS, model: "test-model" };
  const manager = new JobManager(sharedConfig, {
    resolveModel: () => Promise.resolve("test-model"),
    startProcess: (_job, _config, callbacks) => {
      callbacksList.push(callbacks);
      return { pid: 42, kill: () => undefined };
    },
  });
  shutdownSpy = vi.fn();
  server = createDaemonServer({
    config: sharedConfig,
    manager,
    token: TOKEN,
    version: "0.0.0-test",
    startedAt: new Date().toISOString(),
    onShutdown: shutdownSpy,
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
  fs.rmSync(configDir, { recursive: true, force: true });
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

  describe("config endpoints", () => {
    it("GET /config returns defaults in effective when no file exists", async () => {
      const response = await api("/config");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        file: Record<string, unknown>;
        effective: Record<string, unknown>;
      };
      expect(body.file).toEqual({});
      expect(body.effective).toMatchObject(CONFIG_DEFAULTS);
    });

    it("PUT /config persists values and returns them in both file and effective", async () => {
      const putResponse = await api("/config", {
        method: "PUT",
        body: JSON.stringify({
          permissionMode: "bypassPermissions",
          baseUrl: "http://127.0.0.1:9999",
        }),
      });
      expect(putResponse.status).toBe(200);
      const putBody = (await putResponse.json()) as {
        file: Record<string, unknown>;
        effective: Record<string, unknown>;
      };
      expect(putBody.file.permissionMode).toBe("bypassPermissions");
      expect(putBody.file.baseUrl).toBe("http://127.0.0.1:9999");
      expect(putBody.effective.permissionMode).toBe("bypassPermissions");
      expect(putBody.effective.baseUrl).toBe("http://127.0.0.1:9999");

      // Verify persistence with another GET
      const getResponse = await api("/config");
      expect(getResponse.status).toBe(200);
      const getBody = (await getResponse.json()) as {
        file: Record<string, unknown>;
        effective: Record<string, unknown>;
      };
      expect(getBody.file.permissionMode).toBe("bypassPermissions");
      expect(getBody.file.baseUrl).toBe("http://127.0.0.1:9999");
      expect(getBody.effective.permissionMode).toBe("bypassPermissions");
      expect(getBody.effective.baseUrl).toBe("http://127.0.0.1:9999");
    });

    it("PUT /config with invalid body returns 400", async () => {
      const response = await api("/config", {
        method: "PUT",
        body: JSON.stringify({ permissionMode: "yolo" }),
      });
      expect(response.status).toBe(400);
    });
  });
});

describe("concurrency", () => {
  it("keeps the second job queued at concurrency 1 and starts it when raised", async () => {
    for (const prompt of ["job one", "job two"]) {
      const created = await api("/jobs", {
        method: "POST",
        body: JSON.stringify({ prompt, workdir }),
      });
      expect(created.status).toBe(201);
    }
    expect(callbacksList).toHaveLength(1);

    const put = await api("/config", {
      method: "PUT",
      body: JSON.stringify({ concurrency: 2 }),
    });
    expect(put.status).toBe(200);
    await vi.waitFor(() => {
      expect(callbacksList).toHaveLength(2);
    });
  });
});

describe("POST /shutdown", () => {
  it("accepts when idle and invokes the shutdown callback", async () => {
    const response = await api("/shutdown", { method: "POST" });
    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(shutdownSpy).toHaveBeenCalledOnce();
    });
  });

  it("refuses with 409 while a job is running", async () => {
    const start = await api("/jobs", {
      method: "POST",
      body: JSON.stringify({ prompt: "run forever", workdir }),
    });
    expect(start.status).toBe(201);
    const response = await api("/shutdown", { method: "POST" });
    expect(response.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(shutdownSpy).not.toHaveBeenCalled();
  });
});

describe("isVersionOlder", () => {
  it("compares release versions numerically", async () => {
    const { isVersionOlder } = await import("../src/shared/version.js");
    expect(isVersionOlder("0.1.1", "0.2.1")).toBe(true);
    expect(isVersionOlder("0.2.1", "0.2.1")).toBe(false);
    expect(isVersionOlder("0.10.0", "0.9.0")).toBe(false);
    expect(isVersionOlder("0.2", "0.2.1")).toBe(true);
    expect(isVersionOlder("garbage", "0.2.1")).toBe(true);
  });
});
