import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobManager } from "../src/daemon/jobManager.js";
import { buildJobEnv } from "../src/daemon/runner.js";
import { CONFIG_DEFAULTS, type DelegateConfig } from "../src/shared/config.js";

const fakeClaude = fileURLToPath(
  new URL("./fixtures/fake-claude.mjs", import.meta.url),
);

let dataDir: string;
let workdir: string;

const config: DelegateConfig = {
  ...CONFIG_DEFAULTS,
  model: "test-model",
  claudePath: process.execPath,
};

// The runner spawns `claudePath` with claude-style args; the fake script
// ignores them, so point claudePath at node and prepend the script via a
// wrapper shim.
function makeShim(): string {
  const shim = path.join(dataDir, "claude-shim.sh");
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-int-"));
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-int-work-"));
  vi.stubEnv("DELEGATE_DATA_DIR", dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("runner integration (real child process)", () => {
  it("runs a job to success against the fake claude CLI", async () => {
    const manager = new JobManager(
      { ...config, claudePath: makeShim() },
      { resolveModel: () => Promise.resolve("test-model") },
    );
    const job = await manager.startJob({ prompt: "succeed please", workdir });

    await vi.waitFor(
      () => {
        expect(manager.getJob(job.id).state).toBe("succeeded");
      },
      { timeout: 5000 },
    );
    const record = manager.getJob(job.id);
    expect(record.result?.text).toBe("did: succeed please");
    expect(record.turns).toBe(1);
    const events = fs.readFileSync(
      path.join(dataDir, "jobs", job.id, "events.ndjson"),
      "utf8",
    );
    expect(events).toContain('"tool_use"');
  });

  it("stall-kills a hanging process", async () => {
    const manager = new JobManager(
      { ...config, claudePath: makeShim(), stallSeconds: 1 },
      { resolveModel: () => Promise.resolve("test-model") },
    );
    const job = await manager.startJob({ prompt: "hang forever", workdir });

    await vi.waitFor(
      () => {
        expect(manager.getJob(job.id).state).toBe("stalled");
      },
      { timeout: 10000 },
    );
  }, 15000);

  it("propagates an error result", async () => {
    const manager = new JobManager(
      { ...config, claudePath: makeShim() },
      { resolveModel: () => Promise.resolve("test-model") },
    );
    const job = await manager.startJob({ prompt: "fail badly", workdir });

    await vi.waitFor(
      () => {
        expect(manager.getJob(job.id).state).toBe("failed");
      },
      { timeout: 5000 },
    );
    expect(manager.getJob(job.id).result?.isError).toBe(true);
  });

  it("fails cleanly when the claude binary does not exist", async () => {
    const manager = new JobManager(
      { ...config, claudePath: "/no/such/claude" },
      { resolveModel: () => Promise.resolve("test-model") },
    );
    const job = await manager.startJob({ prompt: "whatever", workdir });

    await vi.waitFor(() => {
      expect(manager.getJob(job.id).state).toBe("failed");
    });
    expect(manager.getJob(job.id).error).toContain("failed to spawn");
  });
});

describe("buildJobEnv", () => {
  it("scrubs Anthropic/Claude vars and points at the backend", () => {
    const env = buildJobEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "secret",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDECODE: "1",
        HOME: "/home/u",
      },
      { ...CONFIG_DEFAULTS, baseUrl: "http://127.0.0.1:9999" },
      "m1",
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999");
    expect(env.ANTHROPIC_MODEL).toBe("m1");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("m1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
});
