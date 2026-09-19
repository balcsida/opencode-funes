import type { OpencodeClient, Session, SessionMessagesResponse } from "@opencode-ai/sdk";

type Block = { block_type: "text" | "thinking" | "tool_use" | "tool_result"; text: string; tool_name?: string; tool_use_id?: string };

export function mapSession(session: Session, messages: SessionMessagesResponse) {
  return {
    version: 1, harness: "opencode", session_id: session.id, cwd: session.directory,
    turns: messages.flatMap(({ info, parts }, seq) => {
      if (info.role === "assistant" && info.time.completed === undefined && !info.error) return [];
      if (parts.some(p => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"))) return [];
      const blocks: Block[] = [];
      for (const part of parts) {
        if ((part.type === "text" || part.type === "reasoning") && part.text) {
          blocks.push({ block_type: part.type === "text" ? "text" : "thinking", text: part.text });
        } else if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
          const tool = { tool_name: part.tool, tool_use_id: part.callID };
          blocks.push({ block_type: "tool_use", text: JSON.stringify(part.state.input), ...tool },
            { block_type: "tool_result", text: part.state.status === "completed" ? part.state.output : part.state.error, ...tool });
        }
      }
      return blocks.length ? [{ turn_uuid: info.id, parent_uuid: info.role === "assistant" ? info.parentID : null,
        seq, ts: new Date(info.time.created).toISOString(), role: info.role, blocks }] : [];
    }),
  };
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

export async function ingest(record: ReturnType<typeof mapSession>, directory: string, funes = "funes", signal?: AbortSignal) {
  const body = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error("Session exceeds Funes' 64 MiB input limit");
  if (!record.turns.length) return;
  const child = Bun.spawn([funes, "ingest", "-"], {
    cwd: directory, stdin: new Blob([body]), stdout: "ignore", stderr: "pipe", signal,
  });
  const stderr = new Response(child.stderr).text();
  const [code, error] = await Promise.all([child.exited, stderr]);
  if (code !== 0) throw new Error(`funes ingest exited ${code}: ${error.trim()}`);
}

export async function indexSession(client: OpencodeClient, directory: string, id: string, funes = "funes", signal?: AbortSignal) {
  const query = { directory };
  const session = await client.session.get({ path: { id }, query, signal, throwOnError: true });
  const messages = await client.session.messages({ path: { id }, query, signal, throwOnError: true });
  if (!session.data || !messages.data) throw new Error(`OpenCode session ${id} returned no data`);
  await ingest(mapSession(session.data, messages.data), directory, funes, signal);
}

export async function backfill(client: OpencodeClient, directory: string, funes = "funes") {
  const sessions = await listSessions(client, directory);
  for (const session of sessions) await indexSession(client, directory, session.id, funes);
  return sessions.length;
}
