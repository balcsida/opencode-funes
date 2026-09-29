# opencode-funes

Index completed OpenCode conversations into [Funes](https://github.com/huggingface/funes)
and expose Funes' read tools through OpenCode's native MCP configuration.

Requires Bun and OpenCode **1.18.31**, plus a Funes build containing `funes ingest`
(version 1 external-session JSONL). An older released Funes binary without that command
will fail and retry. Install/build that Funes version first and confirm `funes ingest --help`.

## Install from this checkout

Run `bun install` in this repository. Add this plugin to your project's `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["file:///absolute/path/opencode-funes/opencode/plugin.ts", {"funes": "/absolute/path/to/funes"}]
  ]
}
```

The `funes` option is an executable path or command name, defaulting to `funes` on PATH.
No shell evaluates it. The plugin adds this configuration only when `mcp.funes` is absent:

```json
{
  "mcp": {
    "funes": { "type": "local", "command": ["funes", "mcp"], "enabled": true }
  }
}
```

When you select a different executable, that path replaces `funes` in the command.
Existing MCP entries, including a disabled/custom Funes server, are preserved. The agent
discovers tools from Funes itself; the plugin does not duplicate tool schemas or add an LLM.
Ingestion always writes Funes' local memory. A custom MCP entry reading another memory
does not redirect ingestion there.

## Catch-up and backfill

At startup the plugin lists sessions in the OpenCode project selected by its directory,
including child sessions. Each record retains its original session directory as `cwd`.
It imports stable completed content, then indexes again on `session.idle`. It ignores
streaming update events. Reasoning, text, tool inputs, outputs and errors are preserved;
unsupported parts and empty messages are omitted. Unfinished assistant messages and
messages with pending/running tools wait for a later idle or startup sweep. Sequence
numbers retain their positions in the full oldest-first message list, including gaps.

One worker runs `funes ingest -` at a time, from the plugin's project directory. Repeated
idle events coalesce, and newer events during an import remain queued. Errors are logged
and retried after 1, 2, 4, ... seconds, capped at 60 seconds. The queue is in memory;
restarting replays the startup sweep. Disposal cancels active requests/processes and timers.

To bulk import from an **existing** OpenCode server without loading the plugin:

```sh
bun /absolute/path/opencode-funes/src/cli.ts backfill \
  --url http://127.0.0.1:4096 \
  --directory /absolute/path/to/project \
  --funes /absolute/path/to/funes
```

The package bin is also named `opencode-funes` when installed with a package manager.
`--url` and an absolute `--directory` are required. Standard `OPENCODE_SERVER_PASSWORD`
and optional `OPENCODE_SERVER_USERNAME` (default `opencode`) provide Basic auth. The CLI
uses the same conversion/import code; it exits nonzero on failure. Re-run to retry safely.
Neither path writes OpenCode storage or requests model inference.

Both paths use the pinned v1 SDK. Session lists grow from 100 to 102400 until a response
is shorter than the requested limit, avoiding timestamp cursor gaps and the default
100-session cap. A saturated ceiling fails explicitly. This relies on OpenCode 1.18.31's
runtime `limit` support, which its v1 TypeScript query declaration omits. Message fetches
have no limit, so OpenCode returns the complete oldest-first list. The plugin preserves
the supplied client's transport and authentication, including in-process servers.

Imports send one session per process, each limited to Funes' 64 MiB input ceiling. A
larger session fails explicitly. Backfill may have imported earlier sessions before an
error; replay deduplicates them. Funes is append-only by native IDs: later edits, reverts
and deletions in OpenCode do not replace or remove previously indexed content. Startup
and idle snapshots are not a transaction across concurrent OpenCode edits.

## Develop

```sh
bun test
bun run typecheck
npm pack --dry-run
```

Tests use the real pinned SDK against a local HTTP fixture and an executable importer
fixture at the subprocess boundary; no inference models or running Funes are required.
