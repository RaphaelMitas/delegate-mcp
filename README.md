# delegate-mcp

Delegate agentic coding tasks from [Claude Code](https://claude.com/claude-code) to a **free local model** — with real observability.

`delegate-mcp` runs headless coding-agent sessions — [Claude Code](https://claude.com/claude-code), [Codex CLI](https://github.com/openai/codex), or [OpenCode](https://opencode.ai) — against a local endpoint such as [LM Studio](https://lmstudio.ai) ≥ 0.4.1. Your expensive cloud agent orchestrates; your local model explores, edits, and fixes — and you can watch every tool call it makes, live. The harness is switchable per job, in Settings, or via the `delegate_config` MCP tool.

## Why

Shelling out to a local-model CLI wrapper and watching a log file grow is fragile: when the local server queues or the model loops, all you see is silence. delegate-mcp fixes the two root causes:

- **Event-level observability.** Jobs run in the harness's streaming-JSON mode (`claude -p --output-format stream-json`, `codex exec --json`, `opencode run --format json`), so the daemon sees every tool call and message as a structured event. "What is it doing right now?" is a status query, not log archaeology.
- **One shared daemon.** All Claude Code sessions talk to a single local job daemon with one queue. It runs serially by default — matching local servers that process one request at a time — but `concurrency` can be raised to 4 for backends that handle parallel requests. No more two sessions silently deadlocking the backend.

## Architecture

```
Claude Code session A ──┐  MCP (stdio)
Claude Code session B ──┤                     Delegate.app (menu-bar UI)
                        ▼                        │  HTTP + SSE
                 delegate-mcp mcp ────►  daemon ─┘   127.0.0.1, token-protected
                 (thin client)             │
                                           ├─ job queue (concurrency 1–4, serial by default)
                                           ├─ per job: spawns a headless harness
                                           │    (claude | codex | opencode)
                                           │    against the local backend
                                           ├─ stream parser per harness → live activity
                                           ├─ stall detector (event-level) + timeout
                                           └─ jobs persisted to disk (ndjson event logs)
```

## Install

```bash
brew install raphaelmitas/tap/delegate-mcp          # CLI + daemon + MCP server
brew install --cask raphaelmitas/tap/delegate       # optional menu-bar app
```

Requires at least one harness CLI on your PATH: [Claude Code](https://claude.com/claude-code) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`), or [OpenCode](https://opencode.ai) (`opencode`). The default harness is `claude`.

### Harnesses

| Harness    | CLI        | Backend wiring                                                                     |
| ---------- | ---------- | ---------------------------------------------------------------------------------- |
| `claude`   | `claude`   | Anthropic-compatible `/v1/messages` via `ANTHROPIC_BASE_URL`                       |
| `codex`    | `codex`    | OpenAI Responses API (`/v1/responses`, needs LM Studio ≥ 0.4.x) via `-c` overrides |
| `opencode` | `opencode` | OpenAI-compatible `/v1/chat/completions` via inline `OPENCODE_CONFIG_CONTENT`      |

Switch the default in the app's Settings, with `delegate_config` (`{"harness": "codex"}`), or per job via `delegate_start`'s `harness` argument. `maxTurns` and `appendSystemPrompt` only apply to the `claude` harness.

### Set up with LM Studio

1. In LM Studio (≥ 0.4.1), load a tool-capable coding model with a **context length of 64K or more** (Claude Code's harness is context-heavy) and start the server (default `http://127.0.0.1:1234`).
2. Register the MCP server with Claude Code:

```bash
claude mcp add --scope user delegate -- delegate-mcp mcp
```

3. In any Claude Code session: ask Claude to use `delegate_health` to verify, then delegate away.

The daemon auto-starts on first use. No LM Studio? Point `DELEGATE_BASE_URL` at any Anthropic-compatible `/v1/messages` endpoint.

## MCP tools

| Tool              | What it does                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `delegate_start`  | Start a job (self-contained prompt + workdir). Returns a job id immediately.                                          |
| `delegate_status` | Live state: current tool call, turns, seconds since last event, recent activity. Without a job id: lists recent jobs. |
| `delegate_result` | Final message + stats of a finished job.                                                                              |
| `delegate_logs`   | Raw stream-json event tail for deep debugging.                                                                        |
| `delegate_cancel` | Cancel a queued or running job.                                                                                       |
| `delegate_health` | Daemon + backend health: reachability, loaded models, queue depth.                                                    |
| `delegate_config` | Read or update daemon config (harness, baseUrl, model, permissionMode, …) without touching files.                     |
| `delegate_install_skill` | Install the delegation skill for Claude Code, Codex CLI, and/or OpenCode so agents proactively delegate.  |

Job lifecycle: `queued → running → succeeded | failed | stalled | timeout | canceled`. A job is **stalled** when no stream event arrived for `stallSeconds` (default 120) — the daemon kills it and says so, instead of hanging forever.

## CLI

```
delegate-mcp mcp                 MCP stdio server (what Claude Code runs)
delegate-mcp daemon              Run the daemon in the foreground
delegate-mcp start <dir> "task"  Start a job from the shell
delegate-mcp status [jobId]      Inspect jobs
delegate-mcp logs <jobId> [n]    Raw event log tail
delegate-mcp cancel <jobId>      Cancel a job
delegate-mcp health              Daemon + backend health
delegate-mcp install-skill [harness...]
                                 Install the delegation skill (all harnesses by default)
delegate-mcp uninstall-skill [harness...]
                                 Remove the delegation skill
```

## Configuration

Precedence: per-job tool arguments > environment variables > `~/.config/delegate-mcp/config.json` > defaults.

| config.json key  | Env var                     | Default                                       |
| ---------------- | --------------------------- | --------------------------------------------- |
| `baseUrl`        | `DELEGATE_BASE_URL`         | `http://127.0.0.1:1234`                       |
| `authToken`      | `DELEGATE_AUTH_TOKEN`       | `lmstudio`                                    |
| `model`          | `DELEGATE_MODEL`            | first non-embedding model the backend reports |
| `smallFastModel` | `DELEGATE_SMALL_FAST_MODEL` | same as `model`                               |
| `harness`        | `DELEGATE_HARNESS`          | `claude` (`claude` \| `codex` \| `opencode`)  |
| `claudePath`     | `DELEGATE_CLAUDE_PATH`      | `claude`                                      |
| `codexPath`      | `DELEGATE_CODEX_PATH`       | `codex`                                       |
| `opencodePath`   | `DELEGATE_OPENCODE_PATH`    | `opencode`                                    |
| `timeoutSeconds` | `DELEGATE_TIMEOUT_SECONDS`  | `1800`                                        |
| `stallSeconds`   | `DELEGATE_STALL_SECONDS`    | `120`                                         |
| `permissionMode` | `DELEGATE_PERMISSION_MODE`  | `acceptEdits`                                 |
| `maxTurns`       | `DELEGATE_MAX_TURNS`        | `200`                                         |
| `concurrency`    | `DELEGATE_CONCURRENCY`      | `1`                                           |
| `port`           | `DELEGATE_PORT`             | `0` (random)                                  |

`permissionMode: "bypassPermissions"` lets the local agent run shell commands unprompted — useful for real delegation on repos you trust, but understand what that means before enabling it.

**Self-healing after upgrades:** the daemon is a long-lived process, so a `brew upgrade` alone leaves the old version running. Both the MCP client and the menu-bar app detect an older daemon and restart it automatically — but only when it is idle (no active or queued jobs; the daemon answers `409` to `POST /shutdown` otherwise, and the old version keeps serving until the next opportunity).

Data lives in `~/Library/Application Support/delegate-mcp/`: `daemon.json` (port + auth token, mode 600), `daemon.log`, and `jobs/<id>/` with `prompt.txt`, `events.ndjson`, `job.json`, `result.json`.

## Menu-bar app

`Delegate.app` shows the daemon from the outside: tray state (idle / ▶ running / ⚠ stalled / ○ backend down), the live job queue, a per-job activity feed streaming over SSE, cancel buttons, and raw event logs. It talks to the same daemon API — no extra state.

## Troubleshooting

- **Job stalled immediately** — the backend is probably busy or the model unloaded; check `delegate_health`, then LM Studio's server tab.
- **`failed to spawn claude`/`codex`/`opencode`** — the harness CLI isn't on the daemon's PATH; set `claudePath`/`codexPath`/`opencodePath` in config.
- **Codex jobs fail with a wire-API error** — Codex only speaks the OpenAI Responses API; make sure your LM Studio is new enough to serve `/v1/responses`.
- **Model errors / empty results** — ensure the loaded model supports tool use and the context length is ≥ 64K (LM Studio defaults are often much lower).
- **Everything looks stuck** — `delegate-mcp health`; the daemon log is at `~/Library/Application Support/delegate-mcp/daemon.log`.

## Development

```bash
pnpm install
pnpm test              # vitest: parser, stall detector, queue, HTTP API, runner
pnpm dev:daemon        # daemon in foreground with tsx
pnpm build:binary      # Bun-compiled standalone binary (dist/delegate-mcp)
cd app && pnpm tauri dev   # menu-bar app against the local daemon
```

Releases: push a `v*` tag. CI builds the binary tarball + signed/notarized app zip, creates the GitHub release, and dispatches the Homebrew tap update workflows.

## License

MIT
