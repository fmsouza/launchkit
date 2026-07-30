import type { AcpSessionUpdateNotification } from "../acp-client"

/** agent_message_chunk with text content + messageId. */
export const agentMessageChunkFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_1",
    content: { type: "text", text: "Hello, I'll help you with that." },
  },
}

/** agent_message_chunk with empty text (should be dropped by the mapper). */
export const emptyTextChunkFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "msg_1",
    content: { type: "text", text: "" },
  },
}

/** agent_message_chunk without a messageId (mapper synthesizes one). */
export const noMessageIdChunkFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "no id" },
  },
}

/** agent_thought_chunk (reasoning). */
export const thoughtChunkFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "agent_thought_chunk",
    messageId: "msg_thought_1",
    content: { type: "text", text: "Let me think about this..." },
  },
}

/** user_message_chunk — the agent echoing the user's own turn. */
export const userMessageChunkFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "please fix the build" },
  },
}

/** tool_call (pending) — first sighting starts the tool. */
export const toolCallPendingFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call_001",
    title: "Reading config",
    kind: "read",
    status: "pending",
  },
}

/** tool_call without explicit status (defaults to pending per ACP spec). */
export const toolCallNoStatusFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call_002",
    title: "Running tests",
    kind: "execute",
  },
}

/** tool_call_update (in_progress) — streaming output. */
export const toolCallInProgressFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_001",
    status: "in_progress",
    content: [
      { type: "content", content: { type: "text", text: "Found 3 files..." } },
    ],
  },
}

/** tool_call_update (completed) — terminal success. */
export const toolCallCompletedFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_001",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Done." } }],
    rawOutput: { result: "ok" },
  },
}

/** tool_call_update (failed) — terminal error. */
export const toolCallFailedFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call_update",
    toolCallId: "call_001",
    status: "failed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "Error: file not found" },
      },
    ],
  },
}

/** Re-emitted tool_call (same toolCallId) — should NOT double-start. */
export const toolCallReEmitFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "tool_call",
    toolCallId: "call_001",
    title: "Reading config",
    kind: "read",
    status: "pending",
  },
}

/** plan — full execution plan with entries. */
export const planFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "plan",
    entries: [
      { content: "Check syntax", priority: "high", status: "pending" },
      { content: "Fix types", priority: "medium", status: "in_progress" },
      { content: "Done step", priority: "low", status: "completed" },
    ],
  },
}

/** plan_update — a revised plan; replaces the previous one by planId. */
export const planUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "plan_update",
    entries: [
      { content: "Check syntax", priority: "high", status: "completed" },
      { content: "Fix types", priority: "medium", status: "in_progress" },
      { content: "Done step", priority: "low", status: "completed" },
    ],
  },
}

/** usage_update — context + cost. */
export const usageUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "usage_update",
    used: 53000,
    size: 200000,
    cost: { amount: 0.045, currency: "USD" },
  },
}

/** usage_update with null used/size (agent doesn't report context). */
export const usageUpdateNullFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "usage_update",
    used: null,
    size: null,
  },
}

/** current_mode_update — the agent changed its mode from its side. */
export const modeChangeFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "current_mode_update",
    currentModeId: "plan",
  },
}

/** available_commands_update — the agent's slash-command list. No Spectrum surface renders it. */
export const availableCommandsUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "compact", description: "Compact history" }],
  },
}

/** session_info_update — session metadata (title etc). No Spectrum surface renders it. */
export const sessionInfoUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "session_info_update",
    title: "Fix the build",
  },
}

/** config_option_update — the agent's session config changed (model/effort). */
export const configOptionUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "config_option_update",
    configId: "model",
  },
}

/** plan_removed — the agent dropped its plan. */
export const planRemovedFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: { sessionUpdate: "plan_removed" },
}

/** Unknown sessionUpdate kind (defensive — should map to []). */
export const unknownUpdateFixture: AcpSessionUpdateNotification = {
  sessionId: "sess_1",
  update: {
    sessionUpdate: "custom_extension" as never,
  } as never,
}
