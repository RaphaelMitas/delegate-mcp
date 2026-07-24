import { useCallback, useEffect, useState } from "react";
import {
  fetchConfig,
  saveConfig,
  type DaemonFileConfig,
  type RuntimeInfo,
} from "./api";

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
    permissionMode: "acceptEdits",
    stallSeconds: 120,
    timeoutSeconds: 1800,
    maxTurns: 200,
  });
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<boolean>(false);

  useEffect(() => {
    void (async () => {
      try {
        const result = await fetchConfig(runtime);
        setConfig(result.effective);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
      if (config.model !== "") patch.model = config.model;
      if (config.permissionMode) patch.permissionMode = config.permissionMode;
      if (config.stallSeconds !== undefined)
        patch.stallSeconds = config.stallSeconds;
      if (config.timeoutSeconds !== undefined)
        patch.timeoutSeconds = config.timeoutSeconds;
      if (config.maxTurns !== undefined) patch.maxTurns = config.maxTurns;

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
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
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
          <input
            type="text"
            placeholder="auto (first loaded model)"
            value={config.model || ""}
            onChange={(e) => handleChange("model", e.target.value)}
          />
        </div>

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

        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Back
          </button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
