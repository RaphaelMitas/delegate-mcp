import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { configFilePath } from "./paths.js";
import type { Harness, PermissionMode } from "./types.js";

const permissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

export const harnessSchema = z.enum(["claude", "codex", "opencode"]);

const fileConfigSchema = z
  .object({
    baseUrl: z.string().url(),
    authToken: z.string(),
    model: z.string(),
    smallFastModel: z.string(),
    harness: harnessSchema,
    claudePath: z.string(),
    codexPath: z.string(),
    opencodePath: z.string(),
    port: z.number().int().min(0).max(65535),
    timeoutSeconds: z.number().int().positive(),
    stallSeconds: z.number().int().positive(),
    permissionMode: permissionModeSchema,
    maxTurns: z.number().int().positive(),
    concurrency: z.number().int().min(1).max(4),
  })
  .partial();

export type FileConfig = z.infer<typeof fileConfigSchema>;

export { fileConfigSchema };

export interface DelegateConfig {
  baseUrl: string;
  authToken: string;
  /** Empty string means "resolve from the backend's model list at job start". */
  model: string;
  smallFastModel: string;
  /** Which coding-agent CLI runs delegated jobs. */
  harness: Harness;
  claudePath: string;
  codexPath: string;
  opencodePath: string;
  /** 0 means "pick a free port". */
  port: number;
  timeoutSeconds: number;
  stallSeconds: number;
  permissionMode: PermissionMode;
  maxTurns: number;
  concurrency: number;
}

export const CONFIG_DEFAULTS: DelegateConfig = {
  baseUrl: "http://127.0.0.1:1234",
  authToken: "lmstudio",
  model: "",
  smallFastModel: "",
  harness: "claude",
  claudePath: "claude",
  codexPath: "codex",
  opencodePath: "opencode",
  port: 0,
  timeoutSeconds: 1800,
  stallSeconds: 120,
  permissionMode: "acceptEdits",
  maxTurns: 200,
  concurrency: 1,
};

function readFileConfig(filePath: string): FileConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in config file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = fileConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Invalid config file ${filePath}: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value !== "" ? value : undefined;
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Environment variable ${key} must be an integer, got "${value}"`,
    );
  }
  return parsed;
}

function envHarness(env: NodeJS.ProcessEnv, key: string): Harness | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const result = harnessSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Environment variable ${key} must be one of ${harnessSchema.options.join(", ")}, got "${value}"`,
    );
  }
  return result.data;
}

function envPermissionMode(
  env: NodeJS.ProcessEnv,
  key: string,
): PermissionMode | undefined {
  const value = envString(env, key);
  if (value === undefined) return undefined;
  const result = permissionModeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Environment variable ${key} must be one of ${permissionModeSchema.options.join(", ")}, got "${value}"`,
    );
  }
  return result.data;
}

export function readConfigFile(
  filePath: string = configFilePath(),
): FileConfig {
  return readFileConfig(filePath);
}

export function saveConfigFile(
  patch: FileConfig,
  filePath: string = configFilePath(),
): FileConfig {
  const existing = readFileConfig(filePath);
  const merged: Record<string, unknown> = { ...existing, ...patch };
  // Drop keys that are explicitly set to undefined
  for (const key in merged) {
    if (merged[key] === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete merged[key];
    }
  }
  const result = fileConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(
      `Invalid config: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(result.data, null, 2), "utf8");

  return result.data;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  filePath: string = configFilePath(),
): DelegateConfig {
  const file = readFileConfig(filePath);
  return {
    baseUrl:
      envString(env, "DELEGATE_BASE_URL") ??
      file.baseUrl ??
      CONFIG_DEFAULTS.baseUrl,
    authToken:
      envString(env, "DELEGATE_AUTH_TOKEN") ??
      file.authToken ??
      CONFIG_DEFAULTS.authToken,
    model:
      envString(env, "DELEGATE_MODEL") ?? file.model ?? CONFIG_DEFAULTS.model,
    smallFastModel:
      envString(env, "DELEGATE_SMALL_FAST_MODEL") ??
      file.smallFastModel ??
      CONFIG_DEFAULTS.smallFastModel,
    harness:
      envHarness(env, "DELEGATE_HARNESS") ??
      file.harness ??
      CONFIG_DEFAULTS.harness,
    claudePath:
      envString(env, "DELEGATE_CLAUDE_PATH") ??
      file.claudePath ??
      CONFIG_DEFAULTS.claudePath,
    codexPath:
      envString(env, "DELEGATE_CODEX_PATH") ??
      file.codexPath ??
      CONFIG_DEFAULTS.codexPath,
    opencodePath:
      envString(env, "DELEGATE_OPENCODE_PATH") ??
      file.opencodePath ??
      CONFIG_DEFAULTS.opencodePath,
    port: envInt(env, "DELEGATE_PORT") ?? file.port ?? CONFIG_DEFAULTS.port,
    timeoutSeconds:
      envInt(env, "DELEGATE_TIMEOUT_SECONDS") ??
      file.timeoutSeconds ??
      CONFIG_DEFAULTS.timeoutSeconds,
    stallSeconds:
      envInt(env, "DELEGATE_STALL_SECONDS") ??
      file.stallSeconds ??
      CONFIG_DEFAULTS.stallSeconds,
    permissionMode:
      envPermissionMode(env, "DELEGATE_PERMISSION_MODE") ??
      file.permissionMode ??
      CONFIG_DEFAULTS.permissionMode,
    maxTurns:
      envInt(env, "DELEGATE_MAX_TURNS") ??
      file.maxTurns ??
      CONFIG_DEFAULTS.maxTurns,
    concurrency:
      envInt(env, "DELEGATE_CONCURRENCY") ??
      file.concurrency ??
      CONFIG_DEFAULTS.concurrency,
  };
}
