---
name: delegate-local
description: Offload self-contained coding subtasks to a free local model via the delegate MCP tools (delegate_start, delegate_status, delegate_result). Use proactively whenever a subtask is independent, clearly specifiable, and verifiable — bulk edits, boilerplate, test scaffolding, mechanical refactors, isolated bug fixes, documentation, exploratory prototypes — instead of doing that work inline. The local model is free; cost is never a reason to avoid delegating.
---

# Delegate to the local model

This machine runs a local coding agent behind the `delegate_*` MCP tools.
Delegated work costs nothing and runs in parallel with your own. Treat it as a
standing pool of free labor: before doing a subtask yourself, ask "could
another competent engineer do this from a written brief without questions?" —
if yes, delegate it.

## Delegate proactively

- Implementation of a component from a clear, frozen spec
- Mechanical refactors, renames, and bulk edits across files
- Writing tests or test scaffolding for existing behavior
- Boilerplate, glue code, config plumbing
- Isolated bug fixes that have a reproduction
- Documentation, comments, README updates
- Exploratory prototypes where trying is cheaper than analyzing

## Keep for yourself

- Design decisions, ambiguous specs, judgment calls
- Anything needing this session's context, credentials, or MCP/browser tools
- Tiny edits that are faster to do than to brief (< ~20 lines)
- Final review and the decision to commit/land — always yours

## Workflow

1. `delegate_start` with a fully self-contained prompt: goal, relevant file
   paths, constraints, and what "done" looks like. The delegate shares no
   context with you — write the brief accordingly. `workdir` is the absolute
   project root. Independent subtasks can be started as separate parallel jobs.
2. Continue your own work; check `delegate_status` between your own steps
   rather than busy-waiting.
3. When finished, fetch `delegate_result` — then verify yourself: read the
   diff, run the tests. Worker reports are optimistic; correctness lives in
   the code. Never present delegated work as done without your own check.
4. If a job stalls (status shows no recent events), `delegate_cancel` it and
   retry with a sharper brief; use `delegate_health` when delegation seems
   broken. If a task fails twice delegated, do it yourself.
