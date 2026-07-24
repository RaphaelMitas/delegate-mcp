import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelJob,
  fetchConfig,
  fetchHealth,
  fetchJob,
  fetchJobs,
  fetchLogs,
  getRuntime,
  setTrayStatus,
  spawnDaemon,
  subscribeEvents,
  type HealthResponse,
  type JobRecord,
  type JobSummary,
  type RuntimeInfo,
} from "./api.ts";

import Settings from "./Settings.tsx";

const STATE_LABEL: Record<JobSummary["state"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  stalled: "Stalled",
  timeout: "Timeout",
  canceled: "Canceled",
};

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobRecord | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [view, setView] = useState<"jobs" | "settings">("jobs");
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const refreshRuntime = useCallback(async () => {
    try {
      let info = await getRuntime();
      if (info === null) {
        await spawnDaemon();
        for (let i = 0; i < 20 && info === null; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          info = await getRuntime();
        }
      }
      setRuntime(info);
      setDaemonError(info === null ? "Daemon is not running" : null);
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refreshRuntime();
  }, [refreshRuntime]);

  useEffect(() => {
    if (!runtime) return;
    let stale = false;

    const poll = async () => {
      try {
        const [nextHealth, nextJobs] = await Promise.all([
          fetchHealth(runtime),
          fetchJobs(runtime),
        ]);
        if (stale) return;
        setHealth(nextHealth);
        setJobs(nextJobs);
        setDaemonError(null);
      } catch {
        if (!stale) {
          setHealth(null);
          setDaemonError("Lost connection to daemon");
          void refreshRuntime();
        }
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 5000);

    const unsubscribe = subscribeEvents(
      runtime,
      (job) => {
        setJobs((prev) => {
          const rest = prev.filter((j) => j.id !== job.id);
          return [job, ...rest].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          );
        });
        if (selectedRef.current === job.id) {
          void fetchJob(runtime, job.id).then(setDetail);
        }
      },
      (jobId) => {
        if (selectedRef.current === jobId) {
          void fetchJob(runtime, jobId).then(setDetail);
        }
      },
    );
    return () => {
      stale = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [runtime, refreshRuntime]);

  useEffect(() => {
    if (!runtime || selectedId === null) {
      setDetail(null);
      setLogs(null);
      return;
    }
    void fetchJob(runtime, selectedId).then(setDetail);
    setLogs(null);
  }, [runtime, selectedId]);

  const trayStatus = useMemo(() => {
    if (!health?.backend.reachable) return "backend-down";
    const active = jobs.find((j) => j.state === "running");
    const stalled = jobs.some(
      (j) => j.state === "stalled" && j.endedAt !== undefined,
    );
    if (active) return "running";
    if (stalled) return "stalled";
    return "idle";
  }, [health, jobs]);

  useEffect(() => {
    void setTrayStatus(trayStatus);
  }, [trayStatus]);

  const backendOk = health?.backend.reachable ?? false;

  return (
    <div className="app">
      <header className="header">
        <span className="title">Delegate</span>
        <span className={`dot ${backendOk ? "ok" : "bad"}`} />
        <span className="backend">
          {backendOk
            ? (health?.backend.models.find((m) => !m.includes("embed")) ??
              "backend up")
            : "LM Studio unreachable"}
        </span>
        <button
          className="icon-btn"
          aria-label="Settings"
          onClick={() =>
            setView((prev) => (prev === "jobs" ? "settings" : "jobs"))
          }
        >
          ⚙
        </button>
      </header>

      {daemonError !== null && (
        <div className="banner">
          {daemonError}
          <button onClick={() => void refreshRuntime()}>Retry</button>
        </div>
      )}

      {view === "settings" && runtime !== null ? (
        <Settings runtime={runtime} onClose={() => setView("jobs")} />
      ) : selectedId !== null && detail !== null ? (
        <JobDetail
          job={detail}
          logs={logs}
          onBack={() => setSelectedId(null)}
          onCancel={() => {
            if (runtime) void cancelJob(runtime, detail.id);
          }}
          onToggleLogs={() => {
            if (logs !== null) {
              setLogs(null);
            } else if (runtime) {
              void fetchLogs(runtime, detail.id).then(setLogs);
            }
          }}
        />
      ) : (
        <JobList jobs={jobs} onSelect={setSelectedId} />
      )}
    </div>
  );
}

function JobList({
  jobs,
  onSelect,
}: {
  jobs: JobSummary[];
  onSelect: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return (
      <div className="empty">
        No delegated jobs yet.
        <span className="hint">
          Jobs started via the delegate_start MCP tool appear here live.
        </span>
      </div>
    );
  }
  return (
    <ul className="job-list">
      {jobs.map((job) => (
        <li key={job.id} onClick={() => onSelect(job.id)}>
          <div className="row">
            <span className={`chip ${job.state}`}>
              {STATE_LABEL[job.state]}
              {job.queuePosition !== undefined ? ` #${job.queuePosition}` : ""}
            </span>
            <span className="when">{relativeTime(job.createdAt)}</span>
          </div>
          <div className="prompt">{job.promptPreview}</div>
          <div className="meta">
            <span>{shortPath(job.workdir)}</span>
            {job.state === "running" && job.currentTool ? (
              <span className="tool">▸ {job.currentTool.name}</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function JobDetail({
  job,
  logs,
  onBack,
  onCancel,
  onToggleLogs,
}: {
  job: JobRecord;
  logs: string | null;
  onBack: () => void;
  onCancel: () => void;
  onToggleLogs: () => void;
}) {
  const active = job.state === "queued" || job.state === "running";
  return (
    <div className="detail">
      <div className="detail-bar">
        <button onClick={onBack}>← Back</button>
        <span className={`chip ${job.state}`}>{STATE_LABEL[job.state]}</span>
        {active ? (
          <button className="danger" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button onClick={onToggleLogs}>
            {logs !== null ? "Activity" : "Raw log"}
          </button>
        )}
      </div>
      <div className="detail-meta">
        <div>
          <b>{shortPath(job.workdir)}</b> · {job.model} · {job.turns} tool calls
        </div>
        {job.secondsSinceLastEvent !== undefined && active ? (
          <div>last event {job.secondsSinceLastEvent}s ago</div>
        ) : null}
        {job.error !== undefined ? (
          <div className="error">{job.error}</div>
        ) : null}
      </div>
      <div className="prompt-full">{job.prompt}</div>
      {logs !== null ? (
        <pre className="logs">{logs}</pre>
      ) : (
        <ul className="activity">
          {job.recentActivity.map((item, index) => (
            <li key={index} className={item.kind}>
              <span className="kind">{item.kind}</span>
              <span>{item.summary}</span>
            </li>
          ))}
          {job.result ? (
            <li className={job.result.isError ? "result error" : "result"}>
              <span className="kind">result</span>
              <span>{job.result.text}</span>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
