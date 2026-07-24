import { z } from "zod";

import type { DelegateConfig } from "../shared/config.js";
import type { BackendHealth } from "../shared/types.js";

const modelsResponse = z.object({
  data: z.array(z.object({ id: z.string() })),
});

export async function checkBackend(
  config: DelegateConfig,
): Promise<BackendHealth> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/v1/models`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return {
        baseUrl: config.baseUrl,
        reachable: false,
        models: [],
        error: `GET ${url} returned ${response.status}`,
      };
    }
    const parsed = modelsResponse.safeParse(await response.json());
    const models = parsed.success ? parsed.data.data.map((m) => m.id) : [];
    return { baseUrl: config.baseUrl, reachable: true, models };
  } catch (err) {
    return {
      baseUrl: config.baseUrl,
      reachable: false,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pick the model for a job: explicit request > config > first non-embedding
 * model the backend reports. Throws when nothing can be resolved so the job
 * fails fast with a clear message instead of the CLI requesting a model the
 * backend does not have.
 */
export async function resolveModel(
  requested: string | undefined,
  config: DelegateConfig,
): Promise<string> {
  if (requested && requested !== "") return requested;
  if (config.model !== "") return config.model;
  const health = await checkBackend(config);
  if (!health.reachable) {
    throw new Error(
      `Backend ${config.baseUrl} is not reachable: ${health.error ?? "unknown error"}`,
    );
  }
  const candidate = health.models.find((id) => !id.includes("embed"));
  if (!candidate) {
    throw new Error(
      `Backend ${config.baseUrl} reports no loaded (non-embedding) models; load a model or set DELEGATE_MODEL`,
    );
  }
  return candidate;
}
