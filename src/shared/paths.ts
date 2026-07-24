import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  const override = process.env.DELEGATE_DATA_DIR;
  if (override !== undefined && override !== "") return override;
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "delegate-mcp",
    );
  }
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(
    xdg ?? path.join(os.homedir(), ".local", "share"),
    "delegate-mcp",
  );
}

export function jobsDir(): string {
  return path.join(dataDir(), "jobs");
}

export function jobDir(jobId: string): string {
  return path.join(jobsDir(), jobId);
}

export function runtimeFilePath(): string {
  return path.join(dataDir(), "daemon.json");
}

export function daemonLogPath(): string {
  return path.join(dataDir(), "daemon.log");
}

export function configFilePath(): string {
  const override = process.env.DELEGATE_CONFIG_FILE;
  if (override !== undefined && override !== "") return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(
    xdg ?? path.join(os.homedir(), ".config"),
    "delegate-mcp",
    "config.json",
  );
}
