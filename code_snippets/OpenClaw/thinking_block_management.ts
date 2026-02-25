/**
 * Thinking Block Management
 *
 * Pattern: Strip extended thinking blocks from message history before re-sending.
 * From: OpenClaw src/agents/pi-embedded-runner/thinking.ts, src/auto-reply/thinking.ts
 *
 * Key ideas:
 *   - Thinking blocks are useful for one inference pass but waste context on re-send
 *   - If ALL blocks in an assistant message are thinking, preserve with empty text
 *     (don't break alternating user/assistant message ordering)
 *   - Multi-level reasoning config resolved per-model capability
 *   - Immutable operation — returns new array only if changes were made
 */

// ─── Types ─────────────────────────────────────────────────────────────────

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string | ContentBlock[];
}

// ─── Thinking Block Stripping ──────────────────────────────────────────────

/**
 * Remove thinking blocks from assistant messages in history.
 *
 * This is applied before re-sending history to the LLM. Thinking tokens
 * from previous turns waste context and can confuse the model.
 *
 * Edge case: if ALL content blocks in an assistant message are thinking-only,
 * we preserve the message with an empty text block. Dropping the entire
 * assistant turn would break alternating user/assistant ordering, which
 * many LLM APIs require.
 *
 * Returns the original array (same reference) if no changes were needed.
 */
export function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    // Only process assistant messages with array content
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.role !== "assistant" ||
      !Array.isArray(msg.content)
    ) {
      out.push(msg);
      continue;
    }

    const nextContent: ContentBlock[] = [];
    let changed = false;

    for (const block of msg.content) {
      if (block && typeof block === "object" && block.type === "thinking") {
        // Strip this thinking block
        touched = true;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }

    if (!changed) {
      // No thinking blocks in this message — pass through unchanged
      out.push(msg);
      continue;
    }

    // Preserve assistant turn even if all blocks were thinking-only.
    // An empty text block maintains message alternation.
    const content: ContentBlock[] =
      nextContent.length > 0
        ? nextContent
        : [{ type: "text" as const, text: "" }];

    out.push({ ...msg, content });
  }

  // Return original array if nothing changed (avoid unnecessary allocations)
  return touched ? out : messages;
}

// ─── Think Level Resolution ────────────────────────────────────────────────

/**
 * Resolve thinking level based on model capabilities.
 *
 * Some models only support binary on/off (no granular levels).
 * Some models support xhigh (very large thinking budgets).
 * This function maps the requested level to what the model actually supports.
 */

interface ModelCapability {
  supportsThinking: boolean;
  supportsBinaryOnly: boolean;   // Only "off" | "on", no granular levels
  supportsXHigh: boolean;        // Extended high thinking budget
}

const GRANULAR_LEVELS: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function resolveThinkLevel(
  requested: ThinkLevel,
  capability: ModelCapability,
): ThinkLevel {
  // Model doesn't support thinking at all
  if (!capability.supportsThinking) {
    return "off";
  }

  // Binary-only model: map any non-off level to "medium" (reasonable default)
  if (capability.supportsBinaryOnly) {
    return requested === "off" ? "off" : "medium";
  }

  // xhigh only supported by specific models
  if (requested === "xhigh" && !capability.supportsXHigh) {
    return "high"; // Downgrade to highest supported
  }

  return requested;
}

/**
 * Get available think levels for a given model (for UI display).
 */
export function getAvailableThinkLevels(capability: ModelCapability): ThinkLevel[] {
  if (!capability.supportsThinking) {
    return ["off"];
  }
  if (capability.supportsBinaryOnly) {
    return ["off", "medium"]; // Simplified binary choice
  }
  if (!capability.supportsXHigh) {
    return GRANULAR_LEVELS.filter((l) => l !== "xhigh");
  }
  return [...GRANULAR_LEVELS];
}

// ─── Think Level to Budget Tokens ──────────────────────────────────────────

/**
 * Map think level to a token budget for the thinking block.
 * These are approximate — actual budgets depend on the provider.
 */
export function thinkLevelToBudgetTokens(level: ThinkLevel): number {
  switch (level) {
    case "off": return 0;
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 10_000;
    case "high": return 32_000;
    case "xhigh": return 100_000;
  }
}

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// Before re-sending history to LLM:
const history: AgentMessage[] = [
  { role: "user", content: "Explain this code" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me analyze the code structure..." },
      { type: "text", text: "This code implements a binary search..." },
    ],
  },
  { role: "user", content: "Can you optimize it?" },
];

const cleaned = dropThinkingBlocks(history);
// Result: thinking block removed, text block preserved
// [
//   { role: "user", content: "Explain this code" },
//   { role: "assistant", content: [{ type: "text", text: "This code implements..." }] },
//   { role: "user", content: "Can you optimize it?" },
// ]

// Edge case: assistant message with ONLY thinking blocks
const edgeCase: AgentMessage[] = [
  { role: "user", content: "Think about this" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Deep analysis..." },
    ],
  },
  { role: "user", content: "What did you think?" },
];

const edgeCleaned = dropThinkingBlocks(edgeCase);
// Result: thinking stripped, empty text block preserves message alternation
// [
//   { role: "user", content: "Think about this" },
//   { role: "assistant", content: [{ type: "text", text: "" }] },  // ← preserved
//   { role: "user", content: "What did you think?" },
// ]

// Resolve think level for a binary-only model:
const level = resolveThinkLevel("high", {
  supportsThinking: true,
  supportsBinaryOnly: true,  // e.g., Z.AI model
  supportsXHigh: false,
});
// level === "medium" (downgraded from "high" to binary-compatible)
*/
