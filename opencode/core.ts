import type { OpencodeClient, SessionMessagesResponse } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Block = { block_type: "text" | "thinking" | "tool_use" | "tool_result"; text: string; tool_name?: string; tool_use_id?: string };
type Turn = { format: 1; session_id: string; cwd: string; turn_uuid: string; parent_uuid?: string; seq: number; ts: string; role: string; blocks: Block[]; harness: "opencode" };

// A session as either OpenCode describes it, reduced to what a turns file needs.
export type Row = { id: string; directory: string; updated: number };
// A finished message reduced to its turn: `blocks` is empty when nothing of it is kept.
export type Item = { id: string; role: string; parent?: string; created: number; blocks: Block[] };
// Where a project's sessions are read: OpenCode 1's SDK client, or OpenCode 2's HTTP API.
export type Source = {
  list(signal?: AbortSignal): Promise<Row[]>;
  read(id: string, signal?: AbortSignal): Promise<{ session: Row; messages: Item[] }>;
};

// Each finished message as one turn of funes's turns format (docs/funes-jsonl.md). `order` is the
// session's record: the turn ids already emitted, each at the index that is its seq. A turn met
// for the first time is appended to it, taking the next seq rather than its place in the list —
// OpenCode drops the messages a revert undoes, and a seq, once given, is never given again.
export function turnsOf(session: Row, messages: Item[], order: string[] = []): Turn[] {
  const seqs = new Map(order.map((id, seq) => [id, seq]));
  return messages.flatMap(message => {
    if (!message.blocks.length) return [];
    const seq = seqs.get(message.id) ?? order.push(message.id) - 1;
    return [{ format: 1, session_id: session.id, cwd: session.directory, turn_uuid: message.id,
      ...(message.parent && { parent_uuid: message.parent }),
      seq, ts: new Date(message.created).toISOString(), role: message.role, blocks: message.blocks, harness: "opencode" }];
  });
}

// An attachment's contents are kept only when they are text and small. Images and other binaries
// are a name: funes would store a placeholder for them, and a whole file would duplicate the repo.
const TEXT_LIMIT = 32 * 1024;

function textual(mime: string, name?: string) {
  const type = mime.toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/") || type === "application/pdf") return false;
  if (type.startsWith("text/") || type.endsWith("+json") || type.endsWith("+xml") || type.endsWith("+yaml")) return true;
  if (["application/json", "application/javascript", "application/xml", "application/yaml", "application/x-yaml", "application/toml", "application/x-sh", "application/sql"].includes(type)) return true;
  return !!name && /\.(?:txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|sh|bash|zsh|sql|ini|cfg|conf|log|svg)$/i.test(name);
}

// `undefined` when the bytes are empty, too big, binary, or not UTF-8: the name is the whole record then.
function smallText(bytes: Buffer) {
  if (!bytes.length || bytes.length > TEXT_LIMIT || bytes.includes(0)) return;
  const text = bytes.toString("utf8");
  return text.includes("\uFFFD") ? undefined : text;
}

// One attachment: a line naming it, then its contents when those are small text. `data` is base64,
// `url` a `data:` URL, `snippet` a selection OpenCode already extracted.
function attachmentBlocks(file: { mime?: string; name?: string; data?: string; url?: string; snippet?: string }): Block[] {
  const mime = file.mime || "application/octet-stream";
  const name = file.name || "attachment";
  let body: string | undefined;
  if (textual(mime, name)) {
    if (file.data) body = smallText(Buffer.from(file.data, "base64"));
    else if (file.url?.startsWith("data:")) {
      const marker = ";base64,";
      const at = file.url.indexOf(marker);
      if (at !== -1) body = smallText(Buffer.from(file.url.slice(at + marker.length), "base64"));
    }
    if (body === undefined && file.snippet && Buffer.byteLength(file.snippet) <= TEXT_LIMIT && !file.snippet.includes("\0")) body = file.snippet;
  }
  return [{ block_type: "text", text: `[attachment] ${name} (${mime})` }, ...(body ? [{ block_type: "text" as const, text: body }] : [])];
}

// OpenCode 1: a message is its parts. Unfinished assistant messages, and messages with a tool
// still pending or running, are left for a later snapshot.
export function itemsV1(messages: SessionMessagesResponse): Item[] {
  return messages.flatMap(({ info, parts }) => {
    if (info.role === "assistant" && info.time.completed === undefined && !info.error) return [];
    if (parts.some(p => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"))) return [];
    const blocks: Block[] = [];
    for (const part of parts) {
      if ((part.type === "text" || part.type === "reasoning") && part.text) {
        blocks.push({ block_type: part.type === "text" ? "text" : "thinking", text: part.text });
      } else if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
        const tool = { tool_name: part.tool, tool_use_id: part.callID };
        // Whatever the store holds, a block without its text would have funes refuse the session.
        blocks.push({ block_type: "tool_use", text: JSON.stringify(part.state.input ?? {}), ...tool },
          { block_type: "tool_result", text: (part.state.status === "completed" ? part.state.output : part.state.error) ?? "", ...tool });
      } else if (part.type === "file") {
        const path = part.source && "path" in part.source ? part.source.path : undefined;
        blocks.push(...attachmentBlocks({ mime: part.mime, name: part.filename || path, url: part.url, snippet: part.source?.text?.value }));
      }
    }
    return [{ id: info.id, role: info.role, created: info.time.created, blocks,
      ...(info.role === "assistant" && { parent: info.parentID }) }];
  });
}

// OpenCode 2's wire shapes (packages/schema/src/session*.ts), reduced to what is read here.
export type SessionV2 = { id: string; location: { directory: string }; time: { created: number; updated: number } };
type ContentV2 = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string };
type ToolV2 = { type: "tool"; id: string; name: string; state:
  | { status: "streaming" | "running" }
  | { status: "completed"; input: unknown; content: ContentV2[] }
  | { status: "error"; input: unknown; error: { message: string }; content?: ContentV2[] } };
// A file on a user message: inline bytes are base64 `data`; a media ref keeps `uri` and no bytes.
type FileV2 = { mime?: string; name?: string; description?: string; data?: string; uri?: string; source?: { type: string; uri?: string } };
type ShellV2 = { type: "shell"; id: string; shellID: string; command: string; status: "running" | "exited" | "timeout" | "killed"; exit?: number; output?: { output: string; truncated?: boolean }; time: { created: number; completed?: number } };
type CompactionV2 = { type: "compaction"; id: string; status: "running" | "completed" | "failed"; reason?: "auto" | "manual"; summary?: string; time: { created: number } };
export type MessageV2 =
  | { type: "user"; id: string; text?: string; files?: FileV2[]; time: { created: number } }
  | { type: "synthetic"; id: string; text?: string; time: { created: number } }
  | { type: "assistant"; id: string; content: Array<{ type: "text" | "reasoning"; text: string } | ToolV2>; error?: unknown; time: { created: number; completed?: number } }
  | ShellV2
  | CompactionV2
  | { type: "agent-switched" | "model-switched" | "location-switched" | "system" | "skill" | "idle"; id: string; time: { created: number } };

// A finished `!` command: the command and the output OpenCode stored on the message, as a tool
// call named `shell`. A page that was cut short says so. Still running waits — emitting it now
// would keep the empty output, and funes does not replace a turn it holds.
function shellBlocks(message: ShellV2): Block[] {
  const tool = { tool_name: "shell", tool_use_id: message.shellID };
  const lines: string[] = [];
  if (message.output?.output) lines.push(message.output.output);
  if (message.output?.truncated) lines.push("[output truncated]");
  if (message.status !== "exited" || (message.exit !== undefined && message.exit !== 0)) lines.push(`(exit ${message.exit ?? message.status})`);
  return [
    { block_type: "tool_use", text: JSON.stringify({ command: message.command }), ...tool },
    { block_type: "tool_result", text: lines.join("\n"), ...tool },
  ];
}

// OpenCode 2: a message is one object with its content. What was said to the model is kept:
// user and synthetic text, attachments, a finished shell command, a finished compaction summary,
// and assistant text, reasoning and tools. An assistant message whose answer or tool has not
// finished waits for a later snapshot, as does a shell command or compaction still running —
// the summary and the output are final once, and a turn funes holds is not replaced. An
// assistant turn's parent is the user message before it, which is what OpenCode 1 recorded;
// a shell command or compaction takes that place once it is kept.
export function itemsV2(messages: MessageV2[]): Item[] {
  let parent: string | undefined;
  return messages.flatMap((message): Item[] => {
    const item = { id: message.id, created: message.time.created };
    if (message.type === "user" || message.type === "synthetic") {
      if (message.type === "user") parent = message.id;
      const blocks: Block[] = message.text ? [{ block_type: "text", text: message.text }] : [];
      if (message.type === "user") for (const file of message.files ?? []) {
        blocks.push(...attachmentBlocks({
          mime: file.mime, data: file.data,
          name: file.name || file.description || file.uri || (file.source && "uri" in file.source ? file.source.uri : undefined),
        }));
      }
      return [{ ...item, role: "user", blocks }];
    }
    if (message.type === "shell") {
      if (message.status === "running") return [];
      parent = message.id;
      return [{ ...item, role: "user", blocks: shellBlocks(message) }];
    }
    if (message.type === "compaction") {
      if (message.status !== "completed" || !message.summary) return [];
      parent = message.id;
      const tag = message.reason ? `[compaction ${message.reason}]` : "[compaction]";
      return [{ ...item, role: "user", blocks: [{ block_type: "text", text: `${tag}\n${message.summary}` }] }];
    }
    if (message.type !== "assistant") return [];
    if (message.time.completed === undefined && !message.error) return [];
    const blocks: Block[] = [];
    for (const part of message.content) {
      if (part.type !== "tool") {
        if (part.text) blocks.push({ block_type: part.type === "text" ? "text" : "thinking", text: part.text });
        continue;
      }
      if (part.state.status !== "completed" && part.state.status !== "error") return [];
      const tool = { tool_name: part.name, tool_use_id: part.id };
      const text = part.state.status === "error" ? part.state.error?.message ?? ""
        : part.state.content.flatMap(c => (c.type === "text" ? [c.text] : [])).join("\n");
      blocks.push({ block_type: "tool_use", text: JSON.stringify(part.state.input ?? {}), ...tool }, { block_type: "tool_result", text, ...tool });
    }
    return [{ ...item, role: "assistant", parent, blocks }];
  });
}

// OpenCode 1, through the client it hands its plugins or one made for its URL.
export function sourceV1(client: OpencodeClient, directory: string): Source {
  const query = { directory };
  return {
    async list(signal) {
      // ponytail: bounds snapshots at 102400 sessions; raise if real projects reach it.
      for (let limit = 100; limit <= 102_400; limit *= 2) {
        // The pinned server supports limit; the published v1 query declaration omits it.
        const query = { directory, limit };
        const result = await client.session.list({ query, signal, throwOnError: true });
        if (!result.data) throw new Error("OpenCode session listing returned no data");
        if (result.data.length < limit) return result.data.map(s => ({ id: s.id, directory: s.directory, updated: s.time.updated }));
      }
      throw new Error("OpenCode session listing exceeds the 102400-session safety ceiling");
    },
    async read(id, signal) {
      const session = await client.session.get({ path: { id }, query, signal, throwOnError: true });
      const messages = await client.session.messages({ path: { id }, query, signal, throwOnError: true });
      if (!session.data || !messages.data) throw new Error(`OpenCode session ${id} returned no data`);
      return { session: { id: session.data.id, directory: session.data.directory, updated: session.data.time.updated }, messages: itemsV1(messages.data) };
    },
  };
}

// OpenCode 2, through its HTTP API: cursor-paged listings under /api, read whole.
export function sourceV2(url: string | URL, directory: string, headers?: HeadersInit): Source {
  async function get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const target = new URL(path, url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    const response = await fetch(target, { headers, signal });
    if (!response.ok) throw new Error(`OpenCode answered ${response.status} to GET ${path}`);
    return await response.json() as T;
  }
  // The first page as asked, the rest by cursor: a cursor carries the filter and order it was made with.
  async function pages<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T[]> {
    const rows: T[] = [];
    // ponytail: no ceiling on pages; a 200-row page per request bounds memory, not count.
    for (let cursor: string | undefined; ;) {
      const page = await get<{ data: T[]; cursor: { next?: string } }>(path, cursor ? { limit: "200", cursor } : { limit: "200", ...params }, signal);
      rows.push(...page.data);
      // OpenCode 2.0.20 hands a next cursor with a last full page too; the page after it is empty.
      cursor = page.cursor.next;
      if (!cursor || !page.data.length) return rows;
    }
  }
  const row = (s: SessionV2): Row => ({ id: s.id, directory: s.location.directory, updated: s.time.updated });
  return {
    list: signal => pages<SessionV2>("/api/session", { directory }, signal).then(rows => rows.map(row)),
    async read(id, signal) {
      const session = await get<{ data: SessionV2 }>(`/api/session/${id}`, {}, signal);
      const messages = await pages<MessageV2>(`/api/session/${id}/message`, { order: "asc" }, signal);
      return { session: row(session.data), messages: itemsV2(messages) };
    },
  };
}

// Written beside and renamed into place, under a name `funes index` does not list: it may read
// the directory while this writes.
export async function replace(path: string, body: string, time?: Date) {
  const tmp = `${path}.tmp${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, body);
  if (time) await utimes(tmp, time, time);
  await rename(tmp, path);
}

// A session's finished turns as `<out>/<session id>.funes.jsonl`, whole: funes stores what it
// does not hold and drops the rest. `records` keeps each session's seq order between runs, since
// funes drains what is written; without it a session is numbered as it stands. With `within`, a
// session of another directory is not the caller's to write. Says whether anything was written.
export async function emit(source: Source, id: string, out: string, records?: string, signal?: AbortSignal, within?: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`OpenCode session id ${JSON.stringify(id)} cannot name a file`);
  const { session, messages } = await source.read(id, signal);
  if (within && session.directory !== within) return false;
  const record = records && join(records, "seq", `${id}.json`);
  const order: string[] = record ? await readFile(record, "utf8").then(JSON.parse).catch(() => []) : [];
  const known = order.length;
  const turns = turnsOf(session, messages, order);
  if (!turns.length) return false;
  // The record first: a seq that reached the spool must be the one a later run gives again.
  if (record && order.length > known) await replace(record, JSON.stringify(order));
  // Stamped with the session's own time, so funes drains the newest session first.
  await replace(join(out, `${id}.funes.jsonl`), turns.map(turn => JSON.stringify(turn) + "\n").join(""), new Date(session.updated));
  return true;
}

// One budgeted step of funes over the spool; what it leaves, the next step takes. `env` is added
// to the caller's own.
export function index(funes: string, signal?: AbortSignal, env?: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(funes, ["index", "--harness", "opencode"], { stdio: ["ignore", "ignore", "pipe"], signal, env: { ...process.env, ...env } });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`funes index exited ${code}: ${error.trim()}`))));
  });
}

// `funes push <memory>`, detached, its output appended to `log`: a publish at disposal outlives
// OpenCode, so nothing waits on it past its start, and only one that could not start is an error.
export function publish(funes: string, memory: string, log: string, env?: Record<string, string>) {
  return new Promise<void>((resolve, reject) => {
    const fd = openSync(log, "a");
    const child = spawn(funes, ["push", memory], { stdio: ["ignore", fd, fd], detached: true, env: { ...process.env, ...env } });
    closeSync(fd);
    child.unref();
    child.once("spawn", resolve);
    child.on("error", reject);
  });
}

// Every session of a project into a directory of the caller's own, for `funes index <out>`; the
// number written.
export async function backfill(source: Source, out: string) {
  let written = 0;
  for (const row of await source.list()) if (await emit(source, row.id, out)) written++;
  return written;
}
