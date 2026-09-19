import type { Session, SessionMessagesResponse } from "@opencode-ai/sdk";

export const session: Session = {
  id: "ses_one", projectID: "project", directory: "/work/project",
  title: "fixture", version: "1.18.31", time: { created: 1000, updated: 1000 },
};
export const messages: SessionMessagesResponse = [
  {
    info: { id: "msg_001", sessionID: "ses_one", role: "user", time: { created: 1000 },
      agent: "build", model: { providerID: "test", modelID: "test" } },
    parts: [{ id: "prt_001", sessionID: "ses_one", messageID: "msg_001", type: "text", text: "Explain this project" }],
  },
  {
    info: { id: "msg_002", sessionID: "ses_one", role: "assistant", parentID: "msg_001",
      time: { created: 2000, completed: 3000 }, modelID: "test", providerID: "test", mode: "build",
      path: { cwd: "/work/project", root: "/work" }, cost: 0,
      tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } } },
    parts: [
      { id: "prt_002", sessionID: "ses_one", messageID: "msg_002", type: "reasoning", text: "Inspect first", time: { start: 2000, end: 2100 } },
      { id: "prt_003", sessionID: "ses_one", messageID: "msg_002", type: "tool", tool: "read", callID: "call_one",
        state: { status: "completed", input: { path: "README.md" }, output: "A memory tool", title: "read", metadata: {}, time: { start: 2100, end: 2200 } } },
      { id: "prt_004", sessionID: "ses_one", messageID: "msg_002", type: "tool", tool: "bash", callID: "call_two",
        state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 2300, end: 2400 } } },
      { id: "prt_005", sessionID: "ses_one", messageID: "msg_002", type: "text", text: "It stores memories." },
    ],
  },
];
