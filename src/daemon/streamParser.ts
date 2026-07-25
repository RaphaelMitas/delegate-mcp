import { z } from "zod";

import type { Harness, JobResult } from "../shared/types.js";

const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.unknown(),
});

const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const contentBlock = z.union([
  toolUseBlock,
  textBlock,
  z.object({ type: z.string() }).passthrough(),
]);

const systemEvent = z.object({
  type: z.literal("system"),
  subtype: z.string().optional(),
  model: z.string().optional(),
});

const assistantEvent = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(contentBlock) }),
});

const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  is_error: z.boolean().optional(),
});

const userEvent = z.object({
  type: z.literal("user"),
  message: z.object({
    content: z.union([z.string(), z.array(z.unknown())]),
  }),
});

const resultEvent = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number(),
  duration_ms: z.number(),
  result: z.string().optional(),
});

export type StreamUpdate =
  | { kind: "system"; summary: string }
  | { kind: "text"; summary: string; text: string }
  | { kind: "tool_use"; summary: string; toolName: string; toolInput: string }
  | { kind: "tool_result"; summary: string; isError: boolean }
  | { kind: "result"; summary: string; result: JobResult };

function compactInput(input: unknown): string {
  let serialized: string;
  try {
    serialized = input === undefined ? "" : JSON.stringify(input);
  } catch {
    serialized = "[unserializable input]";
  }
  return serialized.length > 200 ? `${serialized.slice(0, 200)}…` : serialized;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Parse one line of `claude --output-format stream-json` output into zero or
 * more structured updates. Unknown or non-JSON lines yield an empty array.
 */
export function parseStreamLine(line: string): StreamUpdate[] {
  const trimmed = line.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const system = systemEvent.safeParse(parsed);
  if (system.success) {
    const { subtype, model } = system.data;
    return [
      {
        kind: "system",
        summary: `session ${subtype ?? "event"}${model ? ` (model ${model})` : ""}`,
      },
    ];
  }

  const assistant = assistantEvent.safeParse(parsed);
  if (assistant.success) {
    const updates: StreamUpdate[] = [];
    for (const block of assistant.data.message.content) {
      const tool = toolUseBlock.safeParse(block);
      if (tool.success) {
        const toolInput = compactInput(tool.data.input);
        updates.push({
          kind: "tool_use",
          summary: `${tool.data.name} ${toolInput}`,
          toolName: tool.data.name,
          toolInput,
        });
        continue;
      }
      const text = textBlock.safeParse(block);
      if (text.success && text.data.text.trim() !== "") {
        updates.push({
          kind: "text",
          summary: truncate(text.data.text),
          text: text.data.text,
        });
      }
    }
    return updates;
  }

  const user = userEvent.safeParse(parsed);
  if (user.success) {
    const content = user.data.message.content;
    if (Array.isArray(content)) {
      const updates: StreamUpdate[] = [];
      for (const block of content) {
        const toolResult = toolResultBlock.safeParse(block);
        if (toolResult.success) {
          const isError = toolResult.data.is_error ?? false;
          updates.push({
            kind: "tool_result",
            summary: isError ? "tool result (error)" : "tool result",
            isError,
          });
        }
      }
      return updates;
    }
    return [];
  }

  const result = resultEvent.safeParse(parsed);
  if (result.success) {
    const jobResult: JobResult = {
      text: result.data.result ?? "",
      isError: result.data.is_error,
      subtype: result.data.subtype,
      numTurns: result.data.num_turns,
      durationMs: result.data.duration_ms,
    };
    return [
      {
        kind: "result",
        summary: `finished: ${result.data.subtype} after ${result.data.num_turns} turns`,
        result: jobResult,
      },
    ];
  }

  return [];
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

// --- Codex (`codex exec --json`) -------------------------------------------

const codexItem = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    message: z.string().optional(),
    command: z.string().optional(),
    server: z.string().optional(),
    tool: z.string().optional(),
    status: z.string().optional(),
    exit_code: z.number().nullable().optional(),
  })
  .passthrough();

const codexEvent = z
  .object({
    type: z.string(),
    thread_id: z.string().optional(),
    item: codexItem.optional(),
    error: z.object({ message: z.string() }).optional(),
    message: z.string().optional(),
  })
  .passthrough();

const CODEX_TOOL_ITEMS = new Set([
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
]);

function codexToolName(item: z.infer<typeof codexItem>): string {
  if (item.type === "mcp_tool_call") {
    return (
      [item.server, item.tool].filter(Boolean).join(".") || "mcp_tool_call"
    );
  }
  if (item.type === "command_execution") return "shell";
  return item.type;
}

/**
 * Parser for `codex exec --json` JSONL. Codex has no single result event, so
 * the parser tracks the last agent message and emits a result update on
 * turn.completed / turn.failed.
 */
function createCodexParser(): (line: string) => StreamUpdate[] {
  let lastAgentMessage = "";
  let lastError = "";
  let toolCount = 0;
  const startedAt = Date.now();

  return (line) => {
    const event = codexEvent.safeParse(parseJsonLine(line));
    if (!event.success) return [];
    const { type, item } = event.data;

    if (type === "thread.started") {
      return [{ kind: "system", summary: "session started" }];
    }

    if (type === "item.started" && item && CODEX_TOOL_ITEMS.has(item.type)) {
      const toolInput = truncate(item.command ?? "", 200);
      const toolName = codexToolName(item);
      toolCount += 1;
      return [
        {
          kind: "tool_use",
          summary: `${toolName} ${toolInput}`.trim(),
          toolName,
          toolInput,
        },
      ];
    }

    if (type === "item.completed" && item) {
      if (CODEX_TOOL_ITEMS.has(item.type)) {
        const isError =
          item.status === "failed" ||
          (item.exit_code !== null &&
            item.exit_code !== undefined &&
            item.exit_code !== 0);
        return [
          {
            kind: "tool_result",
            summary: isError ? "tool result (error)" : "tool result",
            isError,
          },
        ];
      }
      if (item.type === "agent_message" && item.text !== undefined) {
        lastAgentMessage = item.text;
        return [
          { kind: "text", summary: truncate(item.text), text: item.text },
        ];
      }
      if (item.type === "error" && item.message !== undefined) {
        lastError = item.message;
        return [
          { kind: "system", summary: `error: ${truncate(item.message)}` },
        ];
      }
      return [];
    }

    if (type === "error" && event.data.message !== undefined) {
      lastError = event.data.message;
      return [
        { kind: "system", summary: `error: ${truncate(event.data.message)}` },
      ];
    }

    if (type === "turn.completed" || type === "turn.failed") {
      const isError = type === "turn.failed";
      const text = isError
        ? (event.data.error?.message ?? (lastError || "turn failed"))
        : lastAgentMessage;
      const result: JobResult = {
        text,
        isError,
        subtype: isError ? "error" : "success",
        numTurns: toolCount,
        durationMs: Date.now() - startedAt,
      };
      return [
        {
          kind: "result",
          summary: `finished: ${result.subtype} after ${result.numTurns} tool calls`,
          result,
        },
      ];
    }

    return [];
  };
}

// --- OpenCode (`opencode run --format json`) --------------------------------

const opencodePart = z
  .object({
    type: z.string().optional(),
    text: z.string().optional(),
    tool: z.string().optional(),
    reason: z.string().optional(),
    state: z
      .object({
        status: z.string().optional(),
        input: z.unknown().optional(),
        error: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const opencodeEvent = z
  .object({
    type: z.string(),
    part: opencodePart.optional(),
    error: z.unknown().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/**
 * Parser for `opencode run --format json` events. Like codex there is no
 * dedicated result event; the final assistant text becomes the result when a
 * step finishes with reason "stop".
 */
function createOpencodeParser(): (line: string) => StreamUpdate[] {
  let lastText = "";
  let toolCount = 0;
  const startedAt = Date.now();

  return (line) => {
    const event = opencodeEvent.safeParse(parseJsonLine(line));
    if (!event.success) return [];
    const { type, part } = event.data;

    if (type === "step_start") {
      return [{ kind: "system", summary: "step started" }];
    }

    if (
      type === "text" &&
      part?.text !== undefined &&
      part.text.trim() !== ""
    ) {
      lastText = part.text;
      return [{ kind: "text", summary: truncate(part.text), text: part.text }];
    }

    if (type === "tool_use" && part) {
      const toolName = part.tool ?? "tool";
      const toolInput = compactInput(part.state?.input);
      const isError = part.state?.status === "error";
      toolCount += 1;
      // OpenCode emits one event per tool call, already completed, so surface
      // it as a use + result pair to match the shared activity model.
      return [
        {
          kind: "tool_use",
          summary: `${toolName} ${toolInput}`.trim(),
          toolName,
          toolInput,
        },
        {
          kind: "tool_result",
          summary: isError ? "tool result (error)" : "tool result",
          isError,
        },
      ];
    }

    if (type === "step_finish" && part?.reason === "stop") {
      const result: JobResult = {
        text: lastText,
        isError: false,
        subtype: "success",
        numTurns: toolCount,
        durationMs: Date.now() - startedAt,
      };
      return [
        {
          kind: "result",
          summary: `finished: success after ${toolCount} tool calls`,
          result,
        },
      ];
    }

    if (type.includes("error")) {
      const message =
        event.data.message ??
        (typeof event.data.error === "string"
          ? event.data.error
          : JSON.stringify(event.data.error ?? {}));
      return [{ kind: "system", summary: `error: ${truncate(message)}` }];
    }

    return [];
  };
}

/**
 * Create a per-job stream parser for the given harness. Codex and OpenCode
 * parsers are stateful (they synthesize the final result from the last
 * assistant message), so create a fresh one per process.
 */
export function createStreamParser(
  harness: Harness,
): (line: string) => StreamUpdate[] {
  switch (harness) {
    case "claude":
      return parseStreamLine;
    case "codex":
      return createCodexParser();
    case "opencode":
      return createOpencodeParser();
  }
}
