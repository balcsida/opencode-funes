import type { OpencodeClient, Session, SessionMessagesResponse } from "@opencode-ai/sdk";
import { rename, utimes } from "node:fs/promises";
import { join } from "node:path";

type Block = { block_type: "text" | "thinking" | "tool_use" | "tool_result"; text: string; tool_name?: string; tool_use_id?: string };
type Turn = { format: 1; session_id: string; cwd: string; turn_uuid: string; parent_uuid?: string; seq: number; ts: string; role: string; blocks: Block[]; harness: "opencode" };

// Each finished message as one turn of funes's turns format (docs/funes-jsonl.md). `order` is the
// session's record: the turn ids already emitted, each at the index that is its seq. A turn met
// for the first time is appended to it, taking the next seq rather than its place in the list —
// OpenCode drops the messages a revert undoes, and a seq, once given, is never given again.
export function turnsOf(session: Session, messages: SessionMessagesResponse, order: string[] = []): Turn[] {
  const seqs = new Map(order.map((id, seq) => [id, seq]));
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
    if (!blocks.length) return [];
    const seq = seqs.get(info.id) ?? order.push(info.id) - 1;
    return [{ format: 1, session_id: session.id, cwd: session.directory, turn_uuid: info.id,
      ...(info.role === "assistant" && { parent_uuid: info.parentID }),
      seq, ts: new Date(info.time.created).toISOString(), role: info.role, blocks, harness: "opencode" }];
  });
}

export async function listSessions(client: OpencodeClient, directory: string, signal?: AbortSignal): Promise<Session[]> {
  // ponytail: bounds snapshots at 102400 sessions; raise if real projects reach it.
  for (let limit = 100; limit <= 102_400; limit *= 2) {
    // The pinned server supports limit; the published v1 query declaration omits it.
    const query = { directory, limit };
    const result = await client.session.list({ query, signal, throwOnError: true });
    if (!result.data) throw new Error("OpenCode session listing returned no data");
    if (result.data.length < limit) return result.data;
  }
  throw new Error("OpenCode session listing exceeds the 102400-session safety ceiling");
}

// Written beside and renamed into place, under a name `funes index` does not list: it may read
// the directory while this writes.
async function replace(path: string, body: string, time?: Date) {
  const tmp = `${path}.tmp${process.pid}`;
  await Bun.write(tmp, body);
  if (time) await utimes(tmp, time, time);
  await rename(tmp, path);
}

// A session's finished turns as `<out>/<session id>.funes.jsonl`, whole: funes stores what it
// does not hold and drops the rest. `records` keeps each session's seq order between runs, since
// funes drains what is written; without it a session is numbered as it stands. Says whether
// there was anything to write.
export async function emit(client: OpencodeClient, directory: string, id: string, out: string, records?: string, signal?: AbortSignal) {
  if (!/^[\w-]+$/.test(id)) throw new Error(`OpenCode session id ${JSON.stringify(id)} cannot name a file`);
  const query = { directory };
  const session = await client.session.get({ path: { id }, query, signal, throwOnError: true });
  const messages = await client.session.messages({ path: { id }, query, signal, throwOnError: true });
  if (!session.data || !messages.data) throw new Error(`OpenCode session ${id} returned no data`);
  const record = records && join(records, "seq", `${id}.json`);
  const order: string[] = record ? await Bun.file(record).json().catch(() => []) : [];
  const known = order.length;
  const turns = turnsOf(session.data, messages.data, order);
  if (!turns.length) return false;
  // The record first: a seq that reached the spool must be the one a later run gives again.
  if (record && order.length > known) await replace(record, JSON.stringify(order));
  // Stamped with the session's own time, so funes drains the newest session first.
  await replace(join(out, `${id}.funes.jsonl`), turns.map(turn => JSON.stringify(turn) + "\n").join(""), new Date(session.data.time.updated));
  return true;
}

// One budgeted step of funes over the spool; what it leaves, the next step takes.
export async function index(funes: string, signal?: AbortSignal) {
  const child = Bun.spawn([funes, "index", "--harness", "opencode"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", signal });
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`funes index exited ${code}: ${error.trim()}`);
}

// Every session of a project into a directory of the caller's own, for `funes index <out>`; the
// number written.
export async function backfill(client: OpencodeClient, directory: string, out: string) {
  let written = 0;
  for (const session of await listSessions(client, directory)) if (await emit(client, directory, session.id, out)) written++;
  return written;
}
