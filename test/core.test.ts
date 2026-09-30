import { expect, test } from "bun:test";
import { itemsV1, itemsV2, turnsOf, type MessageV2 } from "../opencode/core";
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

test("a tool call recorded without its input or output still makes two blocks funes can read", () => {
  const input = structuredClone(messages);
  const part = input[1].parts[1];
  if (part.type === "tool") part.state = { status: "completed", title: "read", metadata: {}, time: { start: 1, end: 2 } } as unknown as typeof part.state;
  expect(turnsOf(row, itemsV1(input))[1].blocks.slice(1, 3)).toEqual([
    { block_type: "tool_use", text: "{}", tool_name: "read", tool_use_id: "call_one" },
    { block_type: "tool_result", text: "", tool_name: "read", tool_use_id: "call_one" },
  ]);
});
