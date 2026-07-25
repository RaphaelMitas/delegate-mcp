import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobManager } from "../src/daemon/jobManager.js";
import { buildHarnessCommand, buildJobEnv } from "../src/daemon/runner.js";
import { CONFIG_DEFAULTS, type DelegateConfig } from "../src/shared/config.js";
import type { JobRecord } from "../src/shared/types.js";

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

describe("buildHarnessCommand", () => {
  const baseJob = {
    id: "j1",
    state: "queued",
    prompt: "do the thing",
    workdir: "/tmp/w",
    model: "m1",
    permissionMode: "acceptEdits",
    timeoutSeconds: 10,
    stallSeconds: 5,
    maxTurns: 10,
    createdAt: new Date().toISOString(),
    turns: 0,
    recentActivity: [],
  } satisfies Omit<JobRecord, "harness">;

  it("builds a codex invocation pointed at the backend", () => {
    const cmd = buildHarnessCommand(
      { ...baseJob, harness: "codex" },
      {
        ...CONFIG_DEFAULTS,
        baseUrl: "http://127.0.0.1:9999",
        authToken: "tok",
      },
      { PATH: "/usr/bin", OPENAI_API_KEY: "leak", CODEX_HOME: "/x" },
    );
    expect(cmd.command).toBe("codex");
    expect(cmd.promptViaStdin).toBe(true);
    expect(cmd.args).toContain("exec");
    expect(cmd.args).toContain("--json");
    expect(cmd.args).toContain(
      'model_providers.delegate.base_url="http://127.0.0.1:9999/v1"',
    );
    expect(cmd.args).toContain("workspace-write");
    expect(cmd.env.DELEGATE_API_KEY).toBe("tok");
    expect(cmd.env.OPENAI_API_KEY).toBeUndefined();
    expect(cmd.env.CODEX_HOME).toBeUndefined();
  });

  it("maps permission modes onto codex sandbox flags", () => {
    const bypass = buildHarnessCommand(
      { ...baseJob, harness: "codex", permissionMode: "bypassPermissions" },
      CONFIG_DEFAULTS,
      {},
    );
    expect(bypass.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    const plan = buildHarnessCommand(
      { ...baseJob, harness: "codex", permissionMode: "plan" },
      CONFIG_DEFAULTS,
      {},
    );
    expect(plan.args).toContain("read-only");
  });

  it("builds an opencode invocation with inline config and prompt argument", () => {
    const cmd = buildHarnessCommand(
      { ...baseJob, harness: "opencode" },
      {
        ...CONFIG_DEFAULTS,
        baseUrl: "http://127.0.0.1:9999",
        authToken: "tok",
      },
      { PATH: "/usr/bin", OPENCODE_CONFIG: "/should/be/scrubbed" },
    );
    expect(cmd.command).toBe("opencode");
    expect(cmd.promptViaStdin).toBe(false);
    expect(cmd.args.at(-1)).toBe("do the thing");
    expect(cmd.args).toContain("delegate/m1");
    expect(cmd.env.OPENCODE_CONFIG).toBeUndefined();
    const inline = JSON.parse(cmd.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider: { delegate: { options: { baseURL: string; apiKey: string } } };
      permission?: Record<string, string>;
    };
    expect(inline.provider.delegate.options.baseURL).toBe(
      "http://127.0.0.1:9999/v1",
    );
    expect(inline.provider.delegate.options.apiKey).toBe("tok");
    expect(inline.permission).toEqual({ edit: "allow" });
  });

  it("keeps the claude invocation shape", () => {
    const cmd = buildHarnessCommand(
      { ...baseJob, harness: "claude" },
      CONFIG_DEFAULTS,
      { PATH: "/usr/bin" },
    );
    expect(cmd.command).toBe("claude");
    expect(cmd.promptViaStdin).toBe(true);
    expect(cmd.args).toContain("stream-json");
    expect(cmd.env.ANTHROPIC_MODEL).toBe("m1");
  });
});
