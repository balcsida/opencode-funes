# opencode-funes

A [funes](https://github.com/huggingface/funes) integration for OpenCode: it gives OpenCode
funes's read tools, and keeps your memory current by converting each session into funes's
[turns format](https://github.com/huggingface/funes/blob/main/docs/funes-jsonl.md) as you work.

It follows funes's
[integration contract](https://github.com/huggingface/funes/blob/main/docs/add.md#the-integration-contract),
so it needs funes **1.4.0** or newer. It is developed against OpenCode **1.18.31**.

## Install

Clone this repository and hand funes the bundle in it:

```sh
funes add opencode --from /absolute/path/opencode-funes/opencode
funes add opencode <user|org>/funes-memory --from /absolute/path/opencode-funes/opencode
```

funes asks you to confirm before it runs files it did not publish — once, until they change.
The second form binds a memory: recall reads it, and `funes add` does the first push there.

What the install puts on the machine:

| Where | What |
| --- | --- |
| `~/.funes/agents/opencode/` | The bundle, with the records and state it keeps beside it. |
| `~/.config/opencode/plugins/funes.ts` | One file that loads the plugin from the bundle; under `$XDG_CONFIG_HOME` when that is set. A file of that name funes did not write is left alone, and the install stops. |
| `~/.funes/spool/opencode/` | Where the plugin writes turns files, and funes drains them. |

Nothing in your `opencode.json` is edited. The plugin registers the MCP server when OpenCode
loads its configuration, and only when `mcp.funes` is absent:

```json
{
  "mcp": {
    "funes": { "type": "local", "command": ["/path/to/funes", "mcp"], "enabled": true }
  }
}
```

A bound memory follows `mcp` in that command. Existing MCP entries, including a disabled or
custom funes server, are preserved. The agent discovers the tools from funes itself; the
plugin does not restate them.

Re-run `funes add opencode [memory]` to change the memory, and name `--from` again to install
a newer checkout. Either also makes the plugin convert each project's history anew, which is
how a memory is rebuilt. `funes remove opencode` takes the plugin file, the spool and the
bundle away, and leaves your memory and OpenCode's own sessions untouched.

## What is indexed, and when

When OpenCode starts in a project, the plugin lists that project's sessions, child sessions
included, and converts those changed since its last sweep there — all of them the first
time, which is how existing history gets in. After that it converts a session each time it
goes idle. Every conversion writes the session whole, as
`~/.funes/spool/opencode/<session id>.funes.jsonl`, then runs `funes index --harness opencode`
once for everything written. funes stores the turns it does not hold and drops the rest.

One message is one turn. Reasoning, text, and tool inputs, outputs and errors are kept;
unsupported parts are omitted, and a message left with nothing is not a turn. Unfinished
assistant messages and messages with pending or running tools wait for a later idle or
sweep. Each turn keeps the session's directory as `cwd`, from which funes derives the repo.

funes is append-only, and OpenCode's history is not. A turn's `seq` is given once, in the
order turns are first converted, and the plugin remembers it beside the bundle: a message
that replaces a reverted one takes the next number, never the reverted one's. Later edits,
reverts and deletions in OpenCode do not replace or remove what funes already holds. A
snapshot is not a transaction across concurrent OpenCode edits.

One conversion or index runs at a time. Repeated idle events coalesce, and those arriving
during a run remain queued. Errors are logged and retried after 1, 2, 4, ... seconds, capped
at 60 seconds. The queue is in memory; a restart sweeps again. Disposal cancels active
requests, processes and timers.

Publishing is not automated: with a memory bound, run `funes push <memory>` when you want
to publish. Recall on a bound memory also reads what this machine has indexed and not
pushed yet.

## Converting by hand

To convert a project's sessions from a running OpenCode server without the plugin — an
archive, another machine — write them to a directory of your own and index that:

```sh
bun install
bun src/cli.ts backfill \
  --url http://127.0.0.1:4096 \
  --directory /absolute/path/to/project \
  --out /absolute/path/to/turns
funes index /absolute/path/to/turns
```

`--url`, an absolute `--directory` and `--out` are required. Standard
`OPENCODE_SERVER_PASSWORD` and optional `OPENCODE_SERVER_USERNAME` (default `opencode`)
provide Basic auth. It exits nonzero on failure; re-run to retry safely. The turns carry
the ids the plugin gives them, so a session converted this way and one captured live are one
session in the memory. Turns are numbered as the session stands, without the plugin's
record. Neither path writes OpenCode storage or requests model inference.

Both paths use the pinned v1 SDK. Session lists grow from 100 to 102400 until a response
is shorter than the requested limit, avoiding timestamp cursor gaps and the default
100-session cap. A saturated ceiling fails explicitly. This relies on OpenCode 1.18.31's
runtime `limit` support, which its v1 TypeScript query declaration omits. Message fetches
have no limit, so OpenCode returns the complete oldest-first list. The plugin preserves
the supplied client's transport and authentication, including in-process servers.

## Develop

```sh
bun install
bun test
bun run typecheck
FUNES_BIN=/path/to/funes bun test    # also has funes check the converter's output
```

Tests run the bundle as funes installs it — copied into a temporary home, its `setup` run
with the contract's environment — against the real pinned SDK, a local HTTP fixture for
OpenCode, and an executable standing in for funes at the subprocess boundary. No inference
models or running funes are required. To try a working copy in OpenCode itself:

```sh
funes add opencode local --from ./opencode
funes remove opencode
```
