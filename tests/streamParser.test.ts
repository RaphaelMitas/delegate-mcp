import { describe, expect, it } from "vitest";

import {
  createStreamParser,
  parseStreamLine,
} from "../src/daemon/streamParser.js";

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

describe("createStreamParser (codex)", () => {
  it("parses a full codex exec run and synthesizes the result", () => {
    const parse = createStreamParser("codex");
    expect(parse('{"type":"thread.started","thread_id":"t1"}')).toMatchObject([
      { kind: "system" },
    ]);
    expect(parse('{"type":"turn.started"}')).toEqual([]);
    expect(
      parse(
        '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
      ),
    ).toMatchObject([{ kind: "tool_use", toolName: "shell" }]);
    expect(
      parse(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc ls","aggregated_output":"a.txt\\n","exit_code":0,"status":"completed"}}',
      ),
    ).toMatchObject([{ kind: "tool_result", isError: false }]);
    expect(
      parse(
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done: a.txt"}}',
      ),
    ).toMatchObject([{ kind: "text", text: "done: a.txt" }]);
    const final = parse(
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    );
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      kind: "result",
      result: { text: "done: a.txt", isError: false, numTurns: 1 },
    });
  });

  it("reports turn.failed as an error result", () => {
    const parse = createStreamParser("codex");
    parse('{"type":"error","message":"Missing environment variable"}');
    const final = parse(
      '{"type":"turn.failed","error":{"message":"Missing environment variable"}}',
    );
    expect(final[0]).toMatchObject({
      kind: "result",
      result: { isError: true, text: "Missing environment variable" },
    });
  });
});

describe("createStreamParser (opencode)", () => {
  it("parses a full opencode run and synthesizes the result", () => {
    const parse = createStreamParser("opencode");
    expect(
      parse('{"type":"step_start","part":{"type":"step-start"}}'),
    ).toMatchObject([{ kind: "system" }]);
    const tool = parse(
      '{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"1","state":{"status":"completed","input":{"command":"ls"},"output":"a.txt\\n"}}}',
    );
    expect(tool).toHaveLength(2);
    expect(tool[0]).toMatchObject({ kind: "tool_use", toolName: "bash" });
    expect(tool[1]).toMatchObject({ kind: "tool_result", isError: false });
    expect(
      parse(
        '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls"}}',
      ),
    ).toEqual([]);
    expect(
      parse('{"type":"text","part":{"type":"text","text":"files: a.txt"}}'),
    ).toMatchObject([{ kind: "text", text: "files: a.txt" }]);
    const final = parse(
      '{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}',
    );
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({
      kind: "result",
      result: { text: "files: a.txt", isError: false, numTurns: 1 },
    });
  });
});
