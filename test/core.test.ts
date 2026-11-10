import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemsV1, itemsV2, sourceSqlite, turnsOf, type MessageV2 } from "../opencode/core";
import { messages, messagesV2, row } from "./fixtures";

const seqs = (turns: ReturnType<typeof turnsOf>) => turns.map(t => [t.turn_uuid, t.seq]);

test("a finished message becomes one turn of the funes turns format", () => {
  expect(turnsOf(row, itemsV1(messages))).toEqual([
    { format: 1, session_id: "ses_one", cwd: "/work/project", turn_uuid: "msg_001", seq: 0, ts: "1970-01-01T00:00:01.000Z", role: "user",
      blocks: [{ block_type: "text", text: "Explain this project" }], harness: "opencode" },
    { format: 1, session_id: "ses_one", cwd: "/work/project", turn_uuid: "msg_002", parent_uuid: "msg_001", seq: 1, ts: "1970-01-01T00:00:02.000Z", role: "assistant",
      blocks: [
        { block_type: "thinking", text: "Inspect first" },
        { block_type: "tool_use", text: '{"path":"README.md"}', tool_name: "read", tool_use_id: "call_one" },
        { block_type: "tool_result", text: "A memory tool", tool_name: "read", tool_use_id: "call_one" },
        { block_type: "tool_use", text: '{"command":"false"}', tool_name: "bash", tool_use_id: "call_two" },
        { block_type: "tool_result", text: "exit 1", tool_name: "bash", tool_use_id: "call_two" },
        { block_type: "text", text: "It stores memories." },
      ], harness: "opencode" },
  ]);
});

test("OpenCode 2 serves the exchange as one object a message, and the turns are the same", () => {
  expect(turnsOf(row, itemsV2(messagesV2))).toEqual(turnsOf(row, itemsV1(messages)));
});

test("OpenCode 2: synthetic text is the user's, unfinished answers and tools wait, the rest is skipped", () => {
  const input: MessageV2[] = [
    ...messagesV2,
    { type: "synthetic", id: "msg_003", text: "Injected", time: { created: 3500 } },
    { type: "idle", id: "msg_004", time: { created: 3600 } },
    { type: "assistant", id: "msg_005", time: { created: 4000 }, content: [{ type: "text", text: "still streaming" }] },
    { type: "assistant", id: "msg_006", time: { created: 5000, completed: 5100 }, content: [{ type: "tool", id: "call_three", name: "read", state: { status: "running" } }] },
    { type: "assistant", id: "msg_007", time: { created: 6000 }, error: { type: "aborted", message: "cancelled" }, content: [{ type: "text", text: "partial" }] },
  ];
  const turns = turnsOf(row, itemsV2(input));
  expect(turns.map(t => [t.turn_uuid, t.role, t.seq, t.parent_uuid])).toEqual([
    ["msg_001", "user", 0, undefined], ["msg_002", "assistant", 1, "msg_001"], ["msg_003", "user", 2, undefined], ["msg_007", "assistant", 3, "msg_001"],
  ]);
  expect(turns[2].blocks).toEqual([{ block_type: "text", text: "Injected" }]);
});

test("unfinished and empty messages take no seq, so the counter stays dense", () => {
  const input = structuredClone(messages);
  const incomplete = structuredClone(input[1]);
  incomplete.info.id = "msg_000";
  if (incomplete.info.role === "assistant") delete incomplete.info.time.completed;
  const empty = structuredClone(input[0]);
  empty.info.id = "msg_empty";
  empty.parts = [];
  input.splice(1, 0, incomplete, empty);
  expect(seqs(turnsOf(row, itemsV1(input)))).toEqual([["msg_001", 0], ["msg_002", 1]]);
  const part = input[3].parts[1];
  if (part.type === "tool") part.state = { status: "running", input: {}, time: { start: 1 } };
  expect(turnsOf(row, itemsV1(input))).toHaveLength(1);
  if (part.type === "tool") part.state = { status: "pending", input: {}, raw: "" };
  expect(turnsOf(row, itemsV1(input))).toHaveLength(1);
});

test("a message that finishes late takes the next seq, and the turns already emitted keep theirs", () => {
  const [user, answer] = structuredClone(messages);
  const late = structuredClone(answer);
  late.info.id = "msg_000";
  if (late.info.role === "assistant") delete late.info.time.completed;
  const order: string[] = [];
  expect(seqs(turnsOf(row, itemsV1([user, late, answer]), order))).toEqual([["msg_001", 0], ["msg_002", 1]]);
  if (late.info.role === "assistant") late.info.time.completed = 5000;
  expect(seqs(turnsOf(row, itemsV1([user, late, answer]), order))).toEqual([["msg_001", 0], ["msg_000", 2], ["msg_002", 1]]);
});

test("a message that replaces a reverted one never reuses its seq", () => {
  const [user, answer] = structuredClone(messages);
  const order: string[] = [];
  turnsOf(row, itemsV1([user, answer]), order);
  const retried = structuredClone(answer);
  retried.info.id = "msg_003";
  expect(seqs(turnsOf(row, itemsV1([user, retried]), order))).toEqual([["msg_001", 0], ["msg_003", 2]]);
  expect(order).toEqual(["msg_001", "msg_002", "msg_003"]);
});

test("terminal assistant errors retain their final text", () => {
  const input = structuredClone(messages);
  if (input[1].info.role === "assistant") {
    delete input[1].info.time.completed;
    input[1].info.error = { name: "MessageAbortedError", data: { message: "cancelled" } };
  }
  expect(turnsOf(row, itemsV1(input))).toHaveLength(2);
});

test("empty text, empty thinking and unsupported parts produce no turn", () => {
  const input = structuredClone(messages);
  input[1].parts = [
    { id: "prt_empty", sessionID: "ses_one", messageID: "msg_002", type: "text", text: "" },
    { id: "prt_thinking", sessionID: "ses_one", messageID: "msg_002", type: "reasoning", text: "", time: { start: 1, end: 2 } },
    { id: "prt_step", sessionID: "ses_one", messageID: "msg_002", type: "step-start" },
  ];
  expect(turnsOf(row, itemsV1(input))).toHaveLength(1);
});

test("a shell command is a tool call named shell, and one still running waits", () => {
  const input: MessageV2[] = [
    { type: "user", id: "msg_001", text: "look", time: { created: 1000 } },
    { type: "shell", id: "msg_sh", shellID: "sh_1", command: "printf hello", status: "running", time: { created: 1500 } },
    { type: "shell", id: "msg_sh", shellID: "sh_1", command: "printf hello", status: "exited", exit: 0, output: { output: "hello", truncated: false }, time: { created: 1500, completed: 1600 } },
    { type: "shell", id: "msg_bad", shellID: "sh_2", command: "false", status: "exited", exit: 1, output: { output: "no", truncated: true }, time: { created: 1700, completed: 1800 } },
    { type: "assistant", id: "msg_002", time: { created: 2000, completed: 2100 }, content: [{ type: "text", text: "done" }] },
  ];
  const turns = turnsOf(row, itemsV2(input));
  expect(turns.map(t => [t.turn_uuid, t.role, t.parent_uuid])).toEqual([
    ["msg_001", "user", undefined], ["msg_sh", "user", undefined], ["msg_bad", "user", undefined], ["msg_002", "assistant", "msg_bad"],
  ]);
  expect(turns[1].blocks).toEqual([
    { block_type: "tool_use", text: '{"command":"printf hello"}', tool_name: "shell", tool_use_id: "sh_1" },
    { block_type: "tool_result", text: "hello", tool_name: "shell", tool_use_id: "sh_1" },
  ]);
  expect(turns[2].blocks[1].text).toBe("no\n[output truncated]\n(exit 1)");
});

test("a finished compaction summary is the user's turn and tagged, and one unfinished is not a turn", () => {
  const input: MessageV2[] = [
    { type: "compaction", id: "msg_run", status: "running", reason: "auto", summary: "partial", time: { created: 1000 } },
    { type: "compaction", id: "msg_fail", status: "failed", reason: "auto", time: { created: 1100 } },
    { type: "compaction", id: "msg_sum", status: "completed", reason: "manual", summary: "Kept the plan.", time: { created: 1200 } },
    { type: "assistant", id: "msg_002", time: { created: 2000, completed: 2100 }, content: [{ type: "text", text: "next" }] },
  ];
  const turns = turnsOf(row, itemsV2(input));
  expect(turns.map(t => [t.turn_uuid, t.role, t.parent_uuid])).toEqual([
    ["msg_sum", "user", undefined], ["msg_002", "assistant", "msg_sum"],
  ]);
  expect(turns[0].blocks).toEqual([{ block_type: "text", text: "[compaction manual]\nKept the plan." }]);
});

test("an attachment is named, and only a small text file keeps its contents", () => {
  const hello = Buffer.from("hello\n").toString("base64");
  const huge = Buffer.alloc(32 * 1024 + 1, 0x61).toString("base64");
  const binary = Buffer.from([0, 1, 2, 3]).toString("base64");
  const input: MessageV2[] = [{
    type: "user", id: "msg_001", text: "see these", time: { created: 1000 },
    files: [
      { mime: "text/plain", name: "note.txt", data: hello },
      { mime: "text/plain", name: "big.txt", data: huge },
      { mime: "image/png", name: "shot.png", data: hello },
      { mime: "text/plain", name: "blob.txt", data: binary },
      { mime: "application/pdf", name: "spec.pdf" },
    ],
  }];
  expect(turnsOf(row, itemsV2(input))[0].blocks.map(b => b.text)).toEqual([
    "see these",
    "[attachment] note.txt (text/plain)", "hello\n",
    "[attachment] big.txt (text/plain)",
    "[attachment] shot.png (image/png)",
    "[attachment] blob.txt (text/plain)",
    "[attachment] spec.pdf (application/pdf)",
  ]);
});

test("OpenCode 1 keeps a file part's name and a small text selection", () => {
  const input = structuredClone(messages);
  input[0].parts.push(
    { id: "prt_file", sessionID: "ses_one", messageID: "msg_001", type: "file", mime: "text/markdown", filename: "README.md", url: "file:///work/README.md",
      source: { type: "file", path: "README.md", text: { value: "# Title", start: 0, end: 7 } } },
    { id: "prt_img", sessionID: "ses_one", messageID: "msg_001", type: "file", mime: "image/png", filename: "shot.png", url: "file:///work/shot.png" },
  );
  expect(turnsOf(row, itemsV1(input))[0].blocks.map(b => b.text)).toEqual([
    "Explain this project", "[attachment] README.md (text/markdown)", "# Title", "[attachment] shot.png (image/png)",
  ]);
});

test("OpenCode 2's database is read as the turns its API would serve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-funes-db-"));
  try {
    const db = new Database(join(dir, "opencode.db"));
    db.run("CREATE TABLE session_v2 (id TEXT, directory TEXT, time_updated INTEGER)");
    db.run("CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT)");
    db.run("INSERT INTO session_v2 (id, directory, time_updated) VALUES (?, ?, ?)", ["ses_one", "/work/project", 1000]);
    db.run("INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
      ["msg_001", "ses_one", "user", 0, JSON.stringify({ text: "Explain this project", time: { created: 1000 }, files: [] })]);
    db.run("INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
      ["msg_sum", "ses_one", "compaction", 1, JSON.stringify({ status: "completed", reason: "auto", summary: "Kept the plan.", time: { created: 1500 } })]);
    db.close();
    const source = await sourceSqlite(join(dir, "opencode.db"));
    const { session, messages: stored } = await source.read("ses_one");
    expect(await source.list()).toEqual([session]);
    expect(turnsOf(session, stored).map(t => t.blocks[0].text)).toEqual(["Explain this project", "[compaction auto]\nKept the plan."]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a tool call recorded without its input or output still makes two blocks funes can read", () => {
  const input = structuredClone(messages);
  const part = input[1].parts[1];
  if (part.type === "tool") part.state = { status: "completed", title: "read", metadata: {}, time: { start: 1, end: 2 } } as unknown as typeof part.state;
  expect(turnsOf(row, itemsV1(input))[1].blocks.slice(1, 3)).toEqual([
    { block_type: "tool_use", text: "{}", tool_name: "read", tool_use_id: "call_one" },
    { block_type: "tool_result", text: "", tool_name: "read", tool_use_id: "call_one" },
  ]);
});
