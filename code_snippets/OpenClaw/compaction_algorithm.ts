/**
 * Staged Compaction Summarization Algorithm
 *
 * Pattern: Multi-stage summarization with adaptive chunking, identifier
 * preservation, and progressive fallback for oversized messages.
 * From: OpenClaw src/agents/compaction.ts
 *
 * Key ideas:
 * - computeAdaptiveChunkRatio: shrink chunks when avg message is large relative
 *   to context window (prevents single-message chunks from exceeding model limits)
 * - summarizeInStages: split history into N parts by token share, summarize each
 *   independently, then merge partial summaries into a final cohesive summary
 * - pruneHistoryForContextShare: iteratively drop oldest chunks until history
 *   fits within a token budget, repairing orphaned tool_result entries after each drop
 * - Identifier preservation: strict/custom/off policy — UUIDs, hashes, URLs,
 *   file names must survive summarization verbatim
 * - Safety margin (1.2x) compensates for token estimation inaccuracy
 * - Oversized message fallback: if a single message exceeds 50% of context,
 *   it's excluded from summarization and noted in the summary
 * - toolResult.details stripped before summarization (security: untrusted payloads)
 */

// --- Types ---

type AgentMessage = { role: string; content: string; timestamp?: number };

type IdentifierPolicy = "strict" | "custom" | "off";

type CompactionSummarizationInstructions = {
  identifierPolicy?: IdentifierPolicy;
  identifierInstructions?: string;
};

// --- Constants ---

const BASE_CHUNK_RATIO = 0.4;   // Default: each chunk = 40% of context window
const MIN_CHUNK_RATIO = 0.15;   // Floor when messages are very large
const SAFETY_MARGIN = 1.2;      // 20% buffer for estimation inaccuracy
const SUMMARIZATION_OVERHEAD_TOKENS = 4096; // Reserved for prompt/instructions
const DEFAULT_PARTS = 2;

const IDENTIFIER_PRESERVATION_INSTRUCTIONS =
  "Preserve all opaque identifiers exactly as written (no shortening or reconstruction), " +
  "including UUIDs, hashes, IDs, tokens, API keys, hostnames, IPs, ports, URLs, and file names.";

const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "",
  "MUST PRESERVE:",
  "- Active tasks and their current status (in-progress, blocked, pending)",
  "- Batch operation progress (e.g., '5/17 items completed')",
  "- The last thing the user requested and what was being done about it",
  "- Decisions made and their rationale",
  "- TODOs, open questions, and constraints",
  "- Any commitments or follow-ups promised",
  "",
  "PRIORITIZE recent context over older history. The agent needs to know",
  "what it was doing, not just what was discussed.",
].join("\n");

// --- Token estimation ---

/** Rough estimation: ~4 chars per token. Applied with SAFETY_MARGIN. */
function estimateTokens(message: AgentMessage): number {
  return Math.ceil(message.content.length / 4);
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

// --- Adaptive Chunk Ratio ---

/**
 * Compute adaptive chunk ratio based on average message size.
 *
 * Why adaptive? When messages are large (e.g., tool results with full file
 * contents), the default 40% ratio can produce chunks that individually
 * exceed the model's context window during summarization. By reducing the
 * ratio, we create more, smaller chunks.
 *
 * Triggers when avg message > 10% of context window.
 */
function computeAdaptiveChunkRatio(messages: AgentMessage[], contextWindow: number): number {
  if (messages.length === 0) return BASE_CHUNK_RATIO;

  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  if (avgRatio > 0.1) {
    // Large messages: reduce ratio proportionally, floor at MIN_CHUNK_RATIO
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }

  return BASE_CHUNK_RATIO;
}

// --- Chunk by Token Share ---

/**
 * Split messages into N chunks of roughly equal token count.
 * Used for parallel summarization stages.
 */
function splitMessagesByTokenShare(messages: AgentMessage[], parts = DEFAULT_PARTS): AgentMessage[][] {
  if (messages.length === 0) return [];
  const normalizedParts = Math.min(Math.max(1, Math.floor(parts)), messages.length);
  if (normalizedParts <= 1) return [messages];

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg);
    if (chunks.length < normalizedParts - 1 && current.length > 0 && currentTokens + msgTokens > targetTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * Chunk messages with a hard max-tokens-per-chunk limit.
 * Applies safety margin to compensate for underestimation.
 * Oversized single messages get their own chunk to avoid unbounded growth.
 */
function chunkMessagesByMaxTokens(messages: AgentMessage[], maxTokens: number): AgentMessage[][] {
  if (messages.length === 0) return [];
  const effectiveMax = Math.max(1, Math.floor(maxTokens / SAFETY_MARGIN));
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const msgTokens = estimateTokens(msg);
    if (current.length > 0 && currentTokens + msgTokens > effectiveMax) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(msg);
    currentTokens += msgTokens;
    // Oversized single message: flush immediately
    if (msgTokens > effectiveMax) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

// --- Identifier Preservation ---

function resolveIdentifierInstructions(instructions?: CompactionSummarizationInstructions): string | undefined {
  const policy = instructions?.identifierPolicy ?? "strict";
  if (policy === "off") return undefined;
  if (policy === "custom") {
    return instructions?.identifierInstructions?.trim() || IDENTIFIER_PRESERVATION_INSTRUCTIONS;
  }
  return IDENTIFIER_PRESERVATION_INSTRUCTIONS;
}

function buildSummarizationInstructions(
  customInstructions?: string,
  instructions?: CompactionSummarizationInstructions,
): string | undefined {
  const idPreservation = resolveIdentifierInstructions(instructions);
  const custom = customInstructions?.trim();
  if (!idPreservation && !custom) return undefined;
  if (!custom) return idPreservation;
  if (!idPreservation) return `Additional focus:\n${custom}`;
  return `${idPreservation}\n\nAdditional focus:\n${custom}`;
}

// --- Oversized Message Detection ---

/** Single message > 50% of context can't be summarized safely. */
function isOversizedForSummary(msg: AgentMessage, contextWindow: number): boolean {
  return estimateTokens(msg) * SAFETY_MARGIN > contextWindow * 0.5;
}

// --- Staged Summarization ---

/**
 * Summarize with progressive fallback for oversized messages.
 *
 * 1. Try full summarization of all messages
 * 2. If that fails, exclude oversized messages and summarize the rest
 * 3. If everything is oversized, return a descriptive fallback
 */
async function summarizeWithFallback(params: {
  messages: AgentMessage[];
  contextWindow: number;
  maxChunkTokens: number;
  summarize: (messages: AgentMessage[], instructions?: string) => Promise<string>;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
}): Promise<string> {
  if (params.messages.length === 0) return "No prior history.";

  const instructions = buildSummarizationInstructions(
    params.customInstructions, params.summarizationInstructions,
  );

  // Try full summarization
  try {
    const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
    let summary: string | undefined;
    for (const chunk of chunks) {
      summary = await params.summarize(chunk, instructions);
    }
    return summary ?? "No prior history.";
  } catch { /* fall through */ }

  // Fallback: exclude oversized messages
  const small: AgentMessage[] = [];
  const oversizedNotes: string[] = [];
  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      oversizedNotes.push(`[Large ${msg.role} (~${Math.round(estimateTokens(msg) / 1000)}K tokens) omitted]`);
    } else {
      small.push(msg);
    }
  }

  if (small.length > 0) {
    try {
      const partial = await params.summarize(small, instructions);
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partial + notes;
    } catch { /* fall through */ }
  }

  return `Context contained ${params.messages.length} messages (${oversizedNotes.length} oversized). Summary unavailable.`;
}

/**
 * Multi-stage summarization: split -> summarize each part -> merge summaries.
 *
 * Why stages? Long histories may exceed the summarization model's own context
 * window. By splitting into parts and summarizing independently, each call
 * stays within limits. The final merge creates a cohesive summary.
 */
async function summarizeInStages(params: {
  messages: AgentMessage[];
  contextWindow: number;
  maxChunkTokens: number;
  summarize: (messages: AgentMessage[], instructions?: string) => Promise<string>;
  customInstructions?: string;
  summarizationInstructions?: CompactionSummarizationInstructions;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) return "No prior history.";

  const minForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = Math.min(Math.max(1, Math.floor(params.parts ?? DEFAULT_PARTS)), messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  // Skip splitting if messages are few or small enough
  if (parts <= 1 || messages.length < minForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  const splits = splitMessagesByTokenShare(messages, parts).filter((c) => c.length > 0);
  if (splits.length <= 1) return summarizeWithFallback(params);

  // Stage 1: Summarize each split independently
  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(await summarizeWithFallback({ ...params, messages: chunk }));
  }
  if (partialSummaries.length === 1) return partialSummaries[0];

  // Stage 2: Merge partial summaries into final cohesive summary
  const mergeMessages: AgentMessage[] = partialSummaries.map((s) => ({
    role: "user", content: s, timestamp: Date.now(),
  }));
  const mergeInstructions = params.customInstructions?.trim()
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: mergeMessages,
    customInstructions: mergeInstructions,
  });
}

// --- History Pruning for Context Share ---

/**
 * Iteratively drop oldest message chunks until history fits within a token budget.
 *
 * After each chunk drop, repairs orphaned tool_result entries (whose tool_use
 * was in the dropped chunk) to prevent API errors. Dropped messages are
 * collected for optional summarization.
 */
function pruneHistoryForContextShare(params: {
  messages: AgentMessage[];
  maxContextTokens: number;
  maxHistoryShare?: number; // default 0.5 = 50% of context
  parts?: number;
}): {
  messages: AgentMessage[];
  droppedMessages: AgentMessage[];
  droppedChunks: number;
  budgetTokens: number;
} {
  const maxShare = params.maxHistoryShare ?? 0.5;
  const budgetTokens = Math.max(1, Math.floor(params.maxContextTokens * maxShare));
  let kept = params.messages;
  const allDropped: AgentMessage[] = [];
  let droppedChunks = 0;
  const parts = Math.min(Math.max(1, Math.floor(params.parts ?? DEFAULT_PARTS)), kept.length);

  while (kept.length > 0 && estimateMessagesTokens(kept) > budgetTokens) {
    const chunks = splitMessagesByTokenShare(kept, parts);
    if (chunks.length <= 1) break;

    const [dropped, ...rest] = chunks;
    const flatRest = rest.flat();

    // Repair: drop orphaned tool_results whose tool_use was in the dropped chunk.
    // In real impl: repairToolUseResultPairing(flatRest) strips these to prevent
    // "unexpected tool_use_id" errors from the Anthropic API.

    allDropped.push(...dropped);
    kept = flatRest;
    droppedChunks++;
  }

  return { messages: kept, droppedMessages: allDropped, droppedChunks, budgetTokens };
}

// --- Usage Example ---

/*
// Adaptive chunking for summarization:
const ratio = computeAdaptiveChunkRatio(messages, 200_000);
// ratio = 0.4 (normal) or 0.2 (messages are large)

// Staged summarization:
const summary = await summarizeInStages({
  messages: longHistory,
  contextWindow: 200_000,
  maxChunkTokens: 80_000,
  summarize: (msgs, instructions) => llm.summarize(msgs, instructions),
  summarizationInstructions: { identifierPolicy: "strict" },
  parts: 3,
});

// Pruning for context share (e.g., before passing history to subagent):
const pruned = pruneHistoryForContextShare({
  messages: fullHistory,
  maxContextTokens: 200_000,
  maxHistoryShare: 0.5,
});
// pruned.messages fits within 100K tokens
// pruned.droppedMessages can be summarized separately
*/
