import type { OpencodeClient, SessionMessagesResponse } from "@opencode-ai/sdk";
import { spawn } from "node:child_process";
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
export type MessageV2 =
  | { type: "user" | "synthetic"; id: string; text?: string; time: { created: number } }
  | { type: "assistant"; id: string; content: Array<{ type: "text" | "reasoning"; text: string } | ToolV2>; error?: unknown; time: { created: number; completed?: number } }
  | { type: "agent-switched" | "model-switched" | "location-switched" | "system" | "skill" | "shell" | "compaction" | "idle"; id: string; time: { created: number } };

// OpenCode 2: a message is one object with its content. What was said to the model is kept:
// user and synthetic text, and assistant text, reasoning and tools. An assistant message whose
// answer or tool has not finished waits for a later snapshot. An assistant turn's parent is the
// user message before it, which is what OpenCode 1 recorded.
export function itemsV2(messages: MessageV2[]): Item[] {
  let parent: string | undefined;
  return messages.flatMap((message): Item[] => {
    const item = { id: message.id, created: message.time.created };
    if (message.type === "user" || message.type === "synthetic") {
      if (message.type === "user") parent = message.id;
      return [{ ...item, role: "user", blocks: message.text ? [{ block_type: "text" as const, text: message.text }] : [] }];
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
// funes drains what is written; without it a session is numbered as it stands. Says whether
// there was anything to write.
export async function emit(source: Source, id: string, out: string, records?: string, signal?: AbortSignal) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`OpenCode session id ${JSON.stringify(id)} cannot name a file`);
  const { session, messages } = await source.read(id, signal);
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

// One budgeted step of funes over the spool; what it leaves, the next step takes.
export function index(funes: string, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(funes, ["index", "--harness", "opencode"], { stdio: ["ignore", "ignore", "pipe"], signal });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.on("error", reject);
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(`funes index exited ${code}: ${error.trim()}`))));
  });
}

// Every session of a project into a directory of the caller's own, for `funes index <out>`; the
// number written.
export async function backfill(source: Source, out: string) {
  let written = 0;
  for (const row of await source.list()) if (await emit(source, row.id, out)) written++;
  return written;
}
