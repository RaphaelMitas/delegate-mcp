import { describe, expect, it } from "vitest";

import { parseStreamLine } from "../src/daemon/streamParser.js";

describe("parseStreamLine", () => {
  it("parses system init events", () => {
    const updates = parseStreamLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "qwen/qwen3-coder-next",
      }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      kind: "system",
      summary: "session init (model qwen/qwen3-coder-next)",
    });
  });

  it("parses assistant tool_use and text blocks from one event", () => {
    const updates = parseStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Now I'll create the file:" },
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/x.md", content: "hello" },
            },
          ],
        },
      }),
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ kind: "text" });
    expect(updates[1]).toMatchObject({ kind: "tool_use", toolName: "Write" });
  });

  it("truncates huge tool inputs", () => {
    const updates = parseStreamLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { content: "x".repeat(5000) },
            },
          ],
        },
      }),
    );
    const update = updates[0];
    if (update?.kind !== "tool_use") throw new Error("expected tool_use");
    expect(update.toolInput.length).toBeLessThanOrEqual(201);
  });

  it("parses tool_result blocks including errors", () => {
    const updates = parseStreamLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", is_error: true, content: "boom" }],
        },
      }),
    );
    expect(updates[0]).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("parses the final result event", () => {
    const updates = parseStreamLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 6,
        duration_ms: 33430,
        result: "Done. Created summary.md",
      }),
    );
    const update = updates[0];
    if (update?.kind !== "result") throw new Error("expected result");
    expect(update.result).toEqual({
      text: "Done. Created summary.md",
      isError: false,
      subtype: "success",
      numTurns: 6,
      durationMs: 33430,
    });
  });

  it("ignores blank, non-JSON, and unknown lines", () => {
    expect(parseStreamLine("")).toEqual([]);
    expect(parseStreamLine("not json")).toEqual([]);
    expect(parseStreamLine(JSON.stringify({ type: "mystery" }))).toEqual([]);
  });
});
