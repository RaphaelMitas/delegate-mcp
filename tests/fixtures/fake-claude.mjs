#!/usr/bin/env node
// Stands in for the `claude` CLI in integration tests. Reads the prompt from
// stdin and emits stream-json lines. Behavior is selected via the prompt text:
//   "succeed"  -> tool_use, tool_result, result, exit 0
//   "hang"     -> one system event, then silence (stall path)
//   "fail"     -> result with is_error, exit 1
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  emit({ type: "system", subtype: "init", model: process.env.ANTHROPIC_MODEL });

  if (prompt.includes("hang")) {
    // Keep the process alive silently; the daemon must stall-kill it.
    setInterval(() => undefined, 1000);
    return;
  }

  emit({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/a" } },
      ],
    },
  });
  emit({
    type: "user",
    message: { content: [{ type: "tool_result", content: "ok" }] },
  });

  if (prompt.includes("fail")) {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
      duration_ms: 5,
      result: "it broke",
    });
    process.exit(1);
  }

  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    duration_ms: 5,
    result: `did: ${prompt.trim()}`,
  });
  process.exit(0);
});
