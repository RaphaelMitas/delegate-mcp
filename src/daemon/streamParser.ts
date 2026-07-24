import { z } from "zod";

import type { JobResult } from "../shared/types.js";

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
