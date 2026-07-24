import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JobManager } from "../src/daemon/jobManager.js";
import type { RunnerCallbacks } from "../src/daemon/runner.js";
import { parseStreamLine } from "../src/daemon/streamParser.js";
import { CONFIG_DEFAULTS, type DelegateConfig } from "../src/shared/config.js";

interface FakeProcess {
  callbacks: RunnerCallbacks;
  killed: boolean;
  exit: (code?: number) => void;
}

function makeManager(overrides: Partial<DelegateConfig> = {}): {
  manager: JobManager;
  processes: FakeProcess[];
} {
  const processes: FakeProcess[] = [];
  const config: DelegateConfig = {
    ...CONFIG_DEFAULTS,
    model: "test-model",
    ...overrides,
  };
  const manager = new JobManager(config, {
    resolveModel: (requested) => Promise.resolve(requested ?? config.model),
    startProcess: (_job, _config, callbacks) => {
      const fake: FakeProcess = {
        callbacks,
        killed: false,
        exit: (code = 0) => {
          callbacks.onExit({ code, signal: null, stderrTail: "" });
        },
      };
      processes.push(fake);
      return {
        pid: 1000 + processes.length,
        kill: () => {
          fake.killed = true;
          // Simulate the process dying shortly after SIGTERM.
          setTimeout(() => {
            callbacks.onExit({ code: null, signal: "SIGTERM", stderrTail: "" });
          }, 10);
        },
      };
    },
  });
  return { manager, processes };
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-work-"));
let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-data-"));
  vi.stubEnv("DELEGATE_DATA_DIR", dataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function emit(processes: FakeProcess[], index: number, event: object): void {
  const fake = processes[index];
  if (!fake) throw new Error(`no process at index ${index}`);
  const line = JSON.stringify(event);
  fake.callbacks.onLine(line, parseStreamLine(line));
}

describe("JobManager", () => {
  it("runs jobs serially with concurrency 1 and reports queue position", async () => {
    const { manager, processes } = makeManager();
    const first = await manager.startJob({ prompt: "task one", workdir });
    const second = await manager.startJob({ prompt: "task two", workdir });

    expect(manager.getJob(first.id).state).toBe("running");
    expect(manager.getJob(second.id).state).toBe("queued");
    expect(manager.toSummary(manager.getJob(second.id)).queuePosition).toBe(1);
    expect(processes).toHaveLength(1);

    emit(processes, 0, {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 2,
      duration_ms: 500,
      result: "done one",
    });
    processes[0]?.exit(0);

    expect(manager.getJob(first.id).state).toBe("succeeded");
    expect(manager.getJob(second.id).state).toBe("running");
    expect(processes).toHaveLength(2);
  });

  it("tracks tool activity and produces a successful result", async () => {
    const { manager, processes } = makeManager();
    const job = await manager.startJob({ prompt: "do it", workdir });

    emit(processes, 0, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/a" } },
        ],
      },
    });
    const running = manager.getJob(job.id);
    expect(running.currentTool?.name).toBe("Read");
    expect(running.turns).toBe(1);

    emit(processes, 0, {
      type: "user",
      message: { content: [{ type: "tool_result", content: "ok" }] },
    });
    expect(manager.getJob(job.id).currentTool).toBeUndefined();

    emit(processes, 0, {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 100,
      result: "all done",
    });
    processes[0]?.exit(0);

    const finished = manager.getJob(job.id);
    expect(finished.state).toBe("succeeded");
    expect(finished.result?.text).toBe("all done");
    expect(
      fs.existsSync(path.join(dataDir, "jobs", job.id, "result.json")),
    ).toBe(true);
  });

  it("marks a silent job as stalled and kills it", async () => {
    const { manager, processes } = makeManager({ stallSeconds: 1 });
    const job = await manager.startJob({ prompt: "quiet", workdir });

    await vi.waitFor(
      () => {
        expect(manager.getJob(job.id).state).toBe("stalled");
      },
      { timeout: 3000 },
    );
    expect(processes[0]?.killed).toBe(true);
    expect(manager.getJob(job.id).error).toContain("no stream events for 1s");
  });

  it("cancels a queued job without starting it", async () => {
    const { manager, processes } = makeManager();
    await manager.startJob({ prompt: "first", workdir });
    const queued = await manager.startJob({ prompt: "second", workdir });

    manager.cancel(queued.id);
    expect(manager.getJob(queued.id).state).toBe("canceled");
    expect(processes).toHaveLength(1);
  });

  it("cancels a running job by killing its process", async () => {
    const { manager, processes } = makeManager();
    const job = await manager.startJob({ prompt: "kill me", workdir });

    manager.cancel(job.id);
    await vi.waitFor(() => {
      expect(manager.getJob(job.id).state).toBe("canceled");
    });
    expect(processes[0]?.killed).toBe(true);
  });

  it("fails a job whose process exits without a result event", async () => {
    const { manager, processes } = makeManager();
    const job = await manager.startJob({ prompt: "crash", workdir });
    processes[0]?.callbacks.onExit({
      code: 1,
      signal: null,
      stderrTail: "boom",
    });
    const failed = manager.getJob(job.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("boom");
  });

  it("rejects jobs with a missing workdir", async () => {
    const { manager } = makeManager();
    await expect(
      manager.startJob({ prompt: "x", workdir: "/definitely/not/here" }),
    ).rejects.toThrow(/workdir does not exist/);
  });

  it("marks persisted active jobs as failed after a restart", async () => {
    const { manager, processes } = makeManager();
    const job = await manager.startJob({ prompt: "interrupted", workdir });
    expect(processes).toHaveLength(1);

    const { manager: reloaded } = makeManager();
    reloaded.loadPersistedJobs();
    const record = reloaded.getJob(job.id);
    expect(record.state).toBe("failed");
    expect(record.error).toContain("daemon restarted");
  });
});
