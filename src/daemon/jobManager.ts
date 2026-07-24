import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import type { DelegateConfig } from "../shared/config.js";
import { jobDir, jobsDir } from "../shared/paths.js";
import type {
  ActivityItem,
  JobRecord,
  JobState,
  JobSummary,
  ServerEvent,
  StartJobRequest,
} from "../shared/types.js";
import { resolveModel as defaultResolveModel } from "./backend.js";
import {
  startClaudeProcess as defaultStartProcess,
  type RunningProcess,
  type RunnerCallbacks,
} from "./runner.js";
import { StallDetector } from "./stallDetector.js";
import type { StreamUpdate } from "./streamParser.js";

const RECENT_ACTIVITY_LIMIT = 40;
const LOADED_JOBS_LIMIT = 100;

export interface JobManagerDeps {
  startProcess?: (
    job: JobRecord,
    config: DelegateConfig,
    callbacks: RunnerCallbacks,
  ) => RunningProcess;
  resolveModel?: (
    requested: string | undefined,
    config: DelegateConfig,
  ) => Promise<string>;
}

interface RunningJob {
  process: RunningProcess;
  detector: StallDetector;
  eventStream: fs.WriteStream;
  /** Set before kill() so the exit handler knows the terminal state. */
  killReason?: Extract<JobState, "stalled" | "timeout" | "canceled">;
}

export class JobManager extends EventEmitter {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly running = new Map<string, RunningJob>();
  private readonly startProcess: NonNullable<JobManagerDeps["startProcess"]>;
  private readonly resolveModel: NonNullable<JobManagerDeps["resolveModel"]>;

  constructor(
    private readonly config: DelegateConfig,
    deps: JobManagerDeps = {},
  ) {
    super();
    this.startProcess = deps.startProcess ?? defaultStartProcess;
    this.resolveModel = deps.resolveModel ?? defaultResolveModel;
  }

  loadPersistedJobs(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(jobsDir());
    } catch {
      return;
    }
    const records: JobRecord[] = [];
    for (const entry of entries) {
      try {
        const raw = fs.readFileSync(
          path.join(jobsDir(), entry, "job.json"),
          "utf8",
        );
        records.push(JSON.parse(raw) as JobRecord);
      } catch {
        continue;
      }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const record of records.slice(0, LOADED_JOBS_LIMIT)) {
      if (record.state === "queued" || record.state === "running") {
        record.state = "failed";
        record.error = "daemon restarted while the job was active";
        record.endedAt ??= new Date().toISOString();
        this.persist(record);
      }
      this.jobs.set(record.id, record);
    }
  }

  async startJob(request: StartJobRequest): Promise<JobRecord> {
    if (!fs.existsSync(request.workdir)) {
      throw new Error(`workdir does not exist: ${request.workdir}`);
    }
    const model = await this.resolveModel(request.model, this.config);
    const now = new Date();
    const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const job: JobRecord = {
      id,
      state: "queued",
      prompt: request.prompt,
      workdir: request.workdir,
      model,
      permissionMode: request.permissionMode ?? this.config.permissionMode,
      timeoutSeconds: request.timeoutSeconds ?? this.config.timeoutSeconds,
      stallSeconds: request.stallSeconds ?? this.config.stallSeconds,
      maxTurns: request.maxTurns ?? this.config.maxTurns,
      createdAt: now.toISOString(),
      turns: 0,
      recentActivity: [],
    };
    if (request.appendSystemPrompt !== undefined) {
      job.appendSystemPrompt = request.appendSystemPrompt;
    }
    fs.mkdirSync(jobDir(id), { recursive: true });
    fs.writeFileSync(path.join(jobDir(id), "prompt.txt"), job.prompt);
    this.jobs.set(id, job);
    this.queue.push(id);
    this.persist(job);
    this.broadcastJob(job);
    this.pump();
    return job;
  }

  cancel(jobId: string): JobRecord {
    const job = this.mustGet(jobId);
    const queueIndex = this.queue.indexOf(jobId);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      this.finalize(job, "canceled", "canceled while queued");
      return job;
    }
    const running = this.running.get(jobId);
    if (running) {
      running.killReason = "canceled";
      running.process.kill();
      return job;
    }
    throw new Error(`job ${jobId} is not active (state: ${job.state})`);
  }

  getJob(jobId: string): JobRecord {
    return this.mustGet(jobId);
  }

  listJobs(limit = 20): JobSummary[] {
    const all = [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return all.slice(0, limit).map((job) => this.toSummary(job));
  }

  toSummary(job: JobRecord): JobSummary {
    const summary: JobSummary = {
      id: job.id,
      state: job.state,
      promptPreview:
        job.prompt.length > 200 ? `${job.prompt.slice(0, 200)}…` : job.prompt,
      workdir: job.workdir,
      model: job.model,
      createdAt: job.createdAt,
      turns: job.turns,
    };
    if (job.startedAt !== undefined) summary.startedAt = job.startedAt;
    if (job.endedAt !== undefined) summary.endedAt = job.endedAt;
    if (job.currentTool !== undefined) summary.currentTool = job.currentTool;
    if (job.lastText !== undefined) summary.lastText = job.lastText;
    if (job.error !== undefined) summary.error = job.error;
    if (job.lastEventAt !== undefined) {
      summary.secondsSinceLastEvent = Math.round(
        (Date.now() - Date.parse(job.lastEventAt)) / 1000,
      );
    }
    const queueIndex = this.queue.indexOf(job.id);
    if (queueIndex >= 0) summary.queuePosition = queueIndex + 1;
    if (job.result) {
      summary.resultPreview =
        job.result.text.length > 300
          ? `${job.result.text.slice(0, 300)}…`
          : job.result.text;
      summary.isError = job.result.isError;
    }
    return summary;
  }

  logsTail(jobId: string, tailLines = 100): string {
    this.mustGet(jobId);
    const file = path.join(jobDir(jobId), "events.ndjson");
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
    const lines = raw.split("\n").filter((line) => line !== "");
    return lines.slice(-tailLines).join("\n");
  }

  activeJobId(): string | undefined {
    return [...this.running.keys()][0];
  }

  queueDepth(): number {
    return this.queue.length;
  }

  shutdown(): void {
    for (const [jobId, running] of this.running) {
      running.killReason = "canceled";
      const job = this.jobs.get(jobId);
      if (job) job.error = "daemon shut down";
      running.process.kill();
    }
  }

  private pump(): void {
    while (this.running.size < this.config.concurrency) {
      const nextId = this.queue.shift();
      if (nextId === undefined) return;
      const job = this.jobs.get(nextId);
      if (!job) continue;
      this.launch(job);
    }
  }

  private launch(job: JobRecord): void {
    job.state = "running";
    job.startedAt = new Date().toISOString();
    const eventStream = fs.createWriteStream(
      path.join(jobDir(job.id), "events.ndjson"),
      { flags: "a" },
    );
    eventStream.on("error", () => {
      // Event log persistence is best-effort; job state lives in memory.
    });

    const detector = new StallDetector({
      stallMs: job.stallSeconds * 1000,
      timeoutMs: job.timeoutSeconds * 1000,
      onStall: () => {
        this.killRunning(job.id, "stalled");
      },
      onTimeout: () => {
        this.killRunning(job.id, "timeout");
      },
    });

    const processHandle = this.startProcess(job, this.config, {
      onLine: (rawLine, updates) => {
        eventStream.write(rawLine + "\n");
        if (updates.length > 0) {
          detector.recordEvent();
          this.applyUpdates(job, updates);
        }
      },
      onExit: ({ code, signal, stderrTail }) => {
        detector.stop();
        eventStream.end();
        const running = this.running.get(job.id);
        this.running.delete(job.id);
        if (running?.killReason) {
          this.finalize(
            job,
            running.killReason,
            this.killReasonMessage(running.killReason, job),
          );
        } else if (job.result && !job.result.isError) {
          this.finalize(job, "succeeded");
        } else if (job.result) {
          this.finalize(job, "failed", `result: ${job.result.subtype}`);
        } else {
          this.finalize(
            job,
            "failed",
            `claude exited with ${signal ?? `code ${code ?? "unknown"}`}${
              stderrTail !== "" ? `; stderr: ${stderrTail.slice(-1000)}` : ""
            }`,
          );
        }
        this.pump();
      },
      onSpawnError: (error) => {
        detector.stop();
        eventStream.end();
        this.running.delete(job.id);
        this.finalize(
          job,
          "failed",
          `failed to spawn claude: ${error.message}`,
        );
        this.pump();
      },
    });

    this.running.set(job.id, { process: processHandle, detector, eventStream });
    detector.start();
    this.persist(job);
    this.broadcastJob(job);
  }

  private killRunning(
    jobId: string,
    reason: Extract<JobState, "stalled" | "timeout">,
  ): void {
    const running = this.running.get(jobId);
    if (!running || running.killReason) return;
    running.killReason = reason;
    running.process.kill();
  }

  private killReasonMessage(
    reason: Extract<JobState, "stalled" | "timeout" | "canceled">,
    job: JobRecord,
  ): string {
    switch (reason) {
      case "stalled":
        return `no stream events for ${job.stallSeconds}s; process killed`;
      case "timeout":
        return `exceeded wall-clock timeout of ${job.timeoutSeconds}s`;
      case "canceled":
        return job.error ?? "canceled by request";
    }
  }

  private applyUpdates(job: JobRecord, updates: StreamUpdate[]): void {
    const at = new Date().toISOString();
    job.lastEventAt = at;
    for (const update of updates) {
      const item: ActivityItem = {
        at,
        kind: update.kind,
        summary: update.summary,
      };
      job.recentActivity.push(item);
      if (job.recentActivity.length > RECENT_ACTIVITY_LIMIT) {
        job.recentActivity.shift();
      }
      switch (update.kind) {
        case "tool_use":
          job.turns += 1;
          job.currentTool = {
            name: update.toolName,
            input: update.toolInput,
            startedAt: at,
          };
          break;
        case "tool_result":
          delete job.currentTool;
          break;
        case "text":
          job.lastText = update.summary;
          break;
        case "result":
          job.result = update.result;
          break;
        case "system":
          break;
      }
      this.emitEvent({ type: "activity", jobId: job.id, item });
    }
    this.persist(job);
    this.broadcastJob(job);
  }

  private finalize(job: JobRecord, state: JobState, error?: string): void {
    job.state = state;
    job.endedAt = new Date().toISOString();
    delete job.currentTool;
    if (error !== undefined) job.error = error;
    if (job.result) {
      fs.writeFileSync(
        path.join(jobDir(job.id), "result.json"),
        JSON.stringify(job.result, null, 2),
      );
    }
    this.persist(job);
    this.broadcastJob(job);
  }

  private persist(job: JobRecord): void {
    try {
      fs.mkdirSync(jobDir(job.id), { recursive: true });
      fs.writeFileSync(
        path.join(jobDir(job.id), "job.json"),
        JSON.stringify(job, null, 2),
      );
    } catch {
      // Persistence is best-effort; in-memory state stays authoritative.
    }
  }

  private broadcastJob(job: JobRecord): void {
    this.emitEvent({ type: "job-updated", job: this.toSummary(job) });
  }

  private emitEvent(event: ServerEvent): void {
    this.emit("event", event);
  }

  private mustGet(jobId: string): JobRecord {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return job;
  }
}
