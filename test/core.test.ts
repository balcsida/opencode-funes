import { expect, test } from "bun:test";
import { mapSession } from "../src/core";
import { messages, session } from "./fixtures";

test("maps native IDs, timestamps, thinking and paired terminal tool blocks", () => {
  expect(mapSession(session, messages)).toEqual({ version: 1, harness: "opencode", session_id: "ses_one", cwd: "/work/project", turns: [
    { turn_uuid: "msg_001", parent_uuid: null, seq: 0, ts: "1970-01-01T00:00:01.000Z", role: "user", blocks: [{ block_type: "text", text: "Explain this project" }] },
    { turn_uuid: "msg_002", parent_uuid: "msg_001", seq: 1, ts: "1970-01-01T00:00:02.000Z", role: "assistant", blocks: [
      { block_type: "thinking", text: "Inspect first" },
      { block_type: "tool_use", text: '{"path":"README.md"}', tool_name: "read", tool_use_id: "call_one" },
      { block_type: "tool_result", text: "A memory tool", tool_name: "read", tool_use_id: "call_one" },
      { block_type: "tool_use", text: '{"command":"false"}', tool_name: "bash", tool_use_id: "call_two" },
      { block_type: "tool_result", text: "exit 1", tool_name: "bash", tool_use_id: "call_two" },
      { block_type: "text", text: "It stores memories." },
    ] },
  ] });
});

test("omits unstable and empty turns without renumbering remaining IDs", () => {
  const input = structuredClone(messages);
  const incomplete = structuredClone(input[1]);
  incomplete.info.id = "msg_000";
  if (incomplete.info.role === "assistant") delete incomplete.info.time.completed;
  const empty = structuredClone(input[0]);
  empty.info.id = "msg_empty";
  empty.parts = [];
  input.splice(1, 0, incomplete, empty);
  expect(mapSession(session, input).turns.map(t => [t.turn_uuid, t.seq])).toEqual([["msg_001", 0], ["msg_002", 3]]);
  const part = input[3].parts[1];
  if (part.type === "tool") part.state = { status: "running", input: {}, time: { start: 1 } };
  expect(mapSession(session, input).turns).toHaveLength(1);
  if (part.type === "tool") part.state = { status: "pending", input: {}, raw: "" };
  expect(mapSession(session, input).turns).toHaveLength(1);
});

test("terminal assistant errors retain their final text", () => {
  const input = structuredClone(messages);
  if (input[1].info.role === "assistant") {
    delete input[1].info.time.completed;
    input[1].info.error = { name: "MessageAbortedError", data: { message: "cancelled" } };
  }
  expect(mapSession(session, input).turns).toHaveLength(2);
});

test("empty text, empty thinking and unsupported parts produce no turn", () => {
  const input = structuredClone(messages);
  input[1].parts = [
    { id: "prt_empty", sessionID: "ses_one", messageID: "msg_002", type: "text", text: "" },
    { id: "prt_thinking", sessionID: "ses_one", messageID: "msg_002", type: "reasoning", text: "", time: { start: 1, end: 2 } },
    { id: "prt_step", sessionID: "ses_one", messageID: "msg_002", type: "step-start" },
  ];
  expect(mapSession(session, input).turns).toHaveLength(1);
});
