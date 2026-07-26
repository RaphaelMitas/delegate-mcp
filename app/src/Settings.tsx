import { useCallback, useEffect, useState } from "react";
import {
  fetchConfig,
  fetchHealth,
  isMock,
  saveConfig,
  type DaemonFileConfig,
  type Harness,
  type RuntimeInfo,
} from "./api";

import { MOCK_CONFIG, MOCK_HEALTH } from "./mock";

const HARNESSES: {
  value: Harness;
  label: string;
  pathField: keyof DaemonFileConfig;
}[] = [
  { value: "claude", label: "Claude Code", pathField: "claudePath" },
  { value: "codex", label: "Codex", pathField: "codexPath" },
  { value: "opencode", label: "OpenCode", pathField: "opencodePath" },
];

export default function Settings({
  runtime,
  onClose,
}: {
  runtime: RuntimeInfo;
  onClose: () => void;
}) {
  const [config, setConfig] = useState<DaemonFileConfig>({
    baseUrl: "",
    model: "",
    harness: "claude",
    claudePath: "",
    codexPath: "",
    opencodePath: "",
    permissionMode: "acceptEdits",
    stallSeconds: 120,
    timeoutSeconds: 1800,
    maxTurns: 200,
    concurrency: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);
  const [backendModels, setBackendModels] = useState<string[]>([]);

  useEffect(() => {
    if (isMock) {
      setConfig(MOCK_CONFIG.effective);
      setBackendModels(
        MOCK_HEALTH.backend.models.filter((m) => !m.includes("embed")),
      );
      return;
    }
    void (async () => {
      try {
        const result = await fetchConfig(runtime);
        setConfig(result.effective);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    void (async () => {
      try {
        const health = await fetchHealth(runtime);
        setBackendModels(
          health.backend.models.filter((m) => !m.includes("embed")),
        );
      } catch {
        // Backend unreachable; fall back to the free-text model input.
      }
    })();
  }, [runtime]);

  const handleChange = useCallback(
    (field: keyof DaemonFileConfig, value: string | number) => {
      setConfig((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    try {
      // Build patch with only fields that have values set
      const patch: DaemonFileConfig = {};
      if (config.baseUrl !== "") patch.baseUrl = config.baseUrl;
      // Always send model: "" means "auto" and must be able to overwrite a
      // previously saved explicit model.
      patch.model = config.model ?? "";
      if (config.harness) patch.harness = config.harness;
      if (config.claudePath) patch.claudePath = config.claudePath;
      if (config.codexPath) patch.codexPath = config.codexPath;
      if (config.opencodePath) patch.opencodePath = config.opencodePath;
      if (config.permissionMode) patch.permissionMode = config.permissionMode;
      if (config.stallSeconds !== undefined)
        patch.stallSeconds = config.stallSeconds;
      if (config.timeoutSeconds !== undefined)
        patch.timeoutSeconds = config.timeoutSeconds;
      if (config.maxTurns !== undefined) patch.maxTurns = config.maxTurns;
      if (config.concurrency !== undefined)
        patch.concurrency = config.concurrency;

      await saveConfig(runtime, patch);
      setSuccess(true);
      setError(null);
      setTimeout(() => setSuccess(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSuccess(false);
    }
  }, [runtime, config]);

  const permissionModes: DaemonFileConfig["permissionMode"][] = [
    "default",
    "acceptEdits",
    "plan",
    "bypassPermissions",
  ];

  return (
    <div className="settings">
      <div className="settings-header">
        <h2>Settings</h2>
      </div>

      {error !== null && (
        <div className="warning">{success ? "Saved" : error}</div>
      )}
      {success && <div className="success">Saved</div>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        <div className="form-row">
          <label>Server URL</label>
          <input
            type="text"
            placeholder="http://127.0.0.1:1234"
            value={config.baseUrl || ""}
            onChange={(e) => handleChange("baseUrl", e.target.value)}
          />
        </div>

        <div className="form-row">
          <label>Model</label>
          {backendModels.length > 0 ? (
            <select
              value={config.model || ""}
              onChange={(e) => handleChange("model", e.target.value)}
            >
              <option value="">auto (first loaded model)</option>
              {backendModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {config.model && !backendModels.includes(config.model) ? (
                <option value={config.model}>
                  {config.model} (not loaded)
                </option>
              ) : null}
            </select>
          ) : (
            <input
              type="text"
              placeholder="auto (first loaded model)"
              value={config.model || ""}
              onChange={(e) => handleChange("model", e.target.value)}
            />
          )}
        </div>

        <div className="form-row">
          <label>Harness</label>
          <select
            value={config.harness || "claude"}
            onChange={(e) => handleChange("harness", e.target.value)}
          >
            {HARNESSES.map((h) => (
              <option key={h.value} value={h.value}>
                {h.label}
              </option>
            ))}
          </select>
        </div>

        {HARNESSES.filter((h) => h.value === (config.harness || "claude")).map(
          (h) => (
            <div className="form-row" key={h.pathField}>
              <label>{h.label} binary</label>
              <input
                type="text"
                placeholder={h.value}
                value={(config[h.pathField] as string) || ""}
                onChange={(e) => handleChange(h.pathField, e.target.value)}
              />
            </div>
          ),
        )}

        <div className="form-row">
          <label>Permission mode</label>
          <select
            value={config.permissionMode || "default"}
            onChange={(e) => handleChange("permissionMode", e.target.value)}
          >
            {permissionModes.map((mode) => (
              <option key={mode} value={mode}>
                {mode === "bypassPermissions"
                  ? "bypassPermissions — dangerously skip permissions"
                  : mode}
              </option>
            ))}
          </select>
        </div>

        {config.permissionMode === "bypassPermissions" && (
          <div className="warning">
            The local agent will run shell commands without asking
          </div>
        )}

        <div className="form-row">
          <label>Stall seconds</label>
          <input
            type="number"
            value={config.stallSeconds ?? 120}
            onChange={(e) =>
              handleChange("stallSeconds", Number(e.target.value))
            }
          />
        </div>

        <div className="form-row">
          <label>Timeout seconds</label>
          <input
            type="number"
            value={config.timeoutSeconds ?? 1800}
            onChange={(e) =>
              handleChange("timeoutSeconds", Number(e.target.value))
            }
          />
        </div>

        <div className="form-row">
          <label>Max turns</label>
          <input
            type="number"
            value={config.maxTurns ?? 200}
            onChange={(e) => handleChange("maxTurns", Number(e.target.value))}
          />
        </div>

        <div className="form-row">
          <label>Concurrent jobs</label>
          <select
            value={config.concurrency ?? 1}
            onChange={(e) =>
              handleChange("concurrency", Number(e.target.value))
            }
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n === 1 ? "1 — serial (recommended for local backends)" : n}
              </option>
            ))}
          </select>
        </div>

        {(config.concurrency ?? 1) > 1 && (
          <div className="warning">
            Local backends often serialize requests anyway; parallel jobs share
            the backend and may slow each other down
          </div>
        )}

        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Back
          </button>
          <button type="submit">Save</button>
        </div>
      </form>

      <div className="settings-version">delegate-mcp v{runtime.version}</div>
    </div>
  );
}
