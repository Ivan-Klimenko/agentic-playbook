/**
 * 3-Tier Context Window Overflow Recovery
 *
 * Pattern: Escalating recovery strategies when the LLM context window fills up.
 * From: OpenClaw src/agents/pi-embedded-runner/run.ts, compact.ts
 *
 * Key ideas:
 * - Tier 1: In-attempt auto-compaction (SDK-level)
 * - Tier 2: Explicit overflow compaction (summarize older messages)
 * - Tier 3: Tool result truncation (shrink oversized results)
 * - Track compaction attempts to avoid infinite loops
 * - Measure per-message character counts to find biggest contributors
 */

// --- Types ---

interface AgentMessage {
  role: "user" | "assistant" | "tool_result";
  content: string;
  toolName?: string;
}

interface CompactionMetrics {
  totalMessages: number;
  historyTextChars: number;
  toolResultChars: number;
  estimatedTokens: number;
  topContributors: Array<{ role: string; chars: number; tool?: string }>;
}

interface CompactionResult {
  compacted: boolean;
  messagesBefore: number;
  messagesAfter: number;
}

interface TruncationResult {
  truncated: boolean;
  truncatedCount: number;
}

// --- Constants ---

const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
const CHARS_PER_TOKEN_ESTIMATE = 4;

// --- Overflow detection ---

function isLikelyContextOverflowError(errorText: string): boolean {
  const patterns = [
    /context.?length/i,
    /token.?limit/i,
    /maximum.?context/i,
    /too.?many.?tokens/i,
    /context.?window/i,
    /request.?too.?large/i,
  ];
  return patterns.some((pattern) => pattern.test(errorText));
}

function isCompactionFailureError(errorText: string): boolean {
  return /compaction.?fail/i.test(errorText);
}

// --- Metrics collection ---

function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];

  for (const msg of messages) {
    const chars = msg.content.length;
    historyTextChars += chars;

    if (msg.role === "tool_result") {
      toolResultChars += chars;
    }

    contributors.push({ role: msg.role, chars, tool: msg.toolName });
  }

  // Sort by size descending, take top 3
  const topContributors = contributors
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 3);

  return {
    totalMessages: messages.length,
    historyTextChars,
    toolResultChars,
    estimatedTokens: Math.ceil(historyTextChars / CHARS_PER_TOKEN_ESTIMATE),
    topContributors,
  };
}

// --- Tier 1: Detect if SDK auto-compacted ---

function detectAutoCompaction(
  attemptCompactionCount: number,
): { hadAutoCompaction: boolean } {
  return { hadAutoCompaction: attemptCompactionCount > 0 };
}

// --- Tier 2: Explicit compaction (summarize older messages) ---

async function compactSession(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  summarize: (messages: AgentMessage[]) => Promise<string>;
}): Promise<CompactionResult> {
  const { messages, contextWindowTokens, summarize } = params;
  const metrics = summarizeCompactionMessages(messages);

  // Only compact if we're significantly over the limit
  if (metrics.estimatedTokens < contextWindowTokens * 0.8) {
    return { compacted: false, messagesBefore: messages.length, messagesAfter: messages.length };
  }

  // Keep recent messages (last 20%), summarize older ones
  const keepCount = Math.max(4, Math.floor(messages.length * 0.2));
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(messages.length - keepCount);

  const summary = await summarize(toSummarize);
  const summaryMessage: AgentMessage = {
    role: "assistant",
    content: `[Compacted history summary]\n${summary}`,
  };

  // Replace messages in-place (in real impl, update session file)
  const newMessages = [summaryMessage, ...toKeep];

  return {
    compacted: true,
    messagesBefore: messages.length,
    messagesAfter: newMessages.length,
  };
}

// --- Tier 3: Truncate oversized tool results ---

function sessionHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): boolean {
  const maxToolResultTokens = Math.floor(params.contextWindowTokens * 0.3);
  const maxToolResultChars = maxToolResultTokens * CHARS_PER_TOKEN_ESTIMATE;

  return params.messages.some(
    (msg) => msg.role === "tool_result" && msg.content.length > maxToolResultChars,
  );
}

function truncateOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
}): TruncationResult {
  const maxToolResultTokens = Math.floor(params.contextWindowTokens * 0.3);
  const maxToolResultChars = maxToolResultTokens * CHARS_PER_TOKEN_ESTIMATE;
  let truncatedCount = 0;

  for (const msg of params.messages) {
    if (msg.role === "tool_result" && msg.content.length > maxToolResultChars) {
      const truncatedContent = msg.content.slice(0, maxToolResultChars);
      msg.content =
        truncatedContent +
        `\n\n[Truncated: original ${msg.content.length} chars → ${maxToolResultChars} chars]`;
      truncatedCount += 1;
    }
  }

  return { truncated: truncatedCount > 0, truncatedCount };
}

// --- Main recovery loop ---

async function handleContextOverflow(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  errorText: string;
  attemptCompactionCount: number;
  overflowCompactionAttempts: number;
  summarize: (messages: AgentMessage[]) => Promise<string>;
}): Promise<{
  action: "retry" | "fail";
  overflowCompactionAttempts: number;
  toolResultTruncated: boolean;
}> {
  let { overflowCompactionAttempts } = params;

  // Verify this is actually a context overflow
  if (!isLikelyContextOverflowError(params.errorText)) {
    return { action: "fail", overflowCompactionAttempts, toolResultTruncated: false };
  }

  // Check for compaction failure (don't retry compaction that already failed)
  if (isCompactionFailureError(params.errorText)) {
    return { action: "fail", overflowCompactionAttempts, toolResultTruncated: false };
  }

  // --- Tier 1: SDK already compacted? ---
  const { hadAutoCompaction } = detectAutoCompaction(params.attemptCompactionCount);

  if (hadAutoCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    // SDK compacted but overflow persists — retry without extra compaction
    overflowCompactionAttempts += 1;
    console.warn(
      `Context overflow persisted after auto-compaction ` +
        `(attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying`,
    );
    return { action: "retry", overflowCompactionAttempts, toolResultTruncated: false };
  }

  // --- Tier 2: Explicit compaction ---
  if (!hadAutoCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    overflowCompactionAttempts += 1;
    console.warn(
      `Context overflow detected ` +
        `(attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); compacting`,
    );

    const compactResult = await compactSession({
      messages: params.messages,
      contextWindowTokens: params.contextWindowTokens,
      summarize: params.summarize,
    });

    if (compactResult.compacted) {
      console.info(
        `Compaction succeeded: ${compactResult.messagesBefore} → ${compactResult.messagesAfter} messages`,
      );
      return { action: "retry", overflowCompactionAttempts, toolResultTruncated: false };
    }
  }

  // --- Tier 3: Truncate oversized tool results ---
  if (sessionHasOversizedToolResults(params)) {
    console.warn("Attempting tool result truncation as last resort");

    const truncResult = truncateOversizedToolResults({
      messages: params.messages,
      contextWindowTokens: params.contextWindowTokens,
    });

    if (truncResult.truncated) {
      console.info(`Truncated ${truncResult.truncatedCount} tool result(s); retrying`);
      return {
        action: "retry",
        overflowCompactionAttempts,
        toolResultTruncated: true,
      };
    }
  }

  // All tiers exhausted
  return { action: "fail", overflowCompactionAttempts, toolResultTruncated: false };
}

// --- Usage example ---

/*
// Inside the agent retry loop:
try {
  result = await runAttempt(messages);
} catch (error) {
  const errorText = error instanceof Error ? error.message : String(error);
  const recovery = await handleContextOverflow({
    messages,
    contextWindowTokens: 200_000,
    errorText,
    attemptCompactionCount: attempt.compactionCount,
    overflowCompactionAttempts,
    summarize: async (msgs) => {
      // Use a smaller/cheaper model to summarize
      return await llm.invoke(`Summarize this conversation:\n${msgs.map(m => m.content).join("\n")}`);
    },
  });

  overflowCompactionAttempts = recovery.overflowCompactionAttempts;

  if (recovery.action === "retry") {
    continue; // Retry the agent loop
  }
  throw error; // All recovery tiers exhausted
}
*/
