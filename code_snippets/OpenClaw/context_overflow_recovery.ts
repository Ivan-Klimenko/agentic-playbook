/**
 * 5-Tier Context Window Overflow Recovery
 *
 * Pattern: Escalating recovery strategies when the LLM context window fills up,
 * with smart tool result truncation using head+tail preservation.
 * From: OpenClaw src/agents/pi-embedded-runner/run.ts (lines 1051-1312),
 *       src/agents/pi-embedded-runner/tool-result-truncation.ts
 *
 * Key ideas:
 * - Tier 1: SDK auto-compaction already ran → retry without extra work
 * - Tier 2: Explicit compaction via pluggable context engine
 * - Tier 3: Tool result truncation (head+tail strategy preserves errors)
 * - Tier 4: Compaction failure → give up immediately
 * - Tier 5: All tiers exhausted → return user-facing error
 * - Head+tail truncation: keeps beginning for context + end for errors/results
 * - Single tool result capped at 30% of context window (hard max 400K chars)
 * - Track attempts across tiers to prevent infinite recovery loops
 */

// --- Types ---

interface AgentMessage {
  role: "user" | "assistant" | "tool_result";
  content: string | ContentBlock[];
  toolName?: string;
}

interface ContentBlock {
  type: "text" | "image";
  text?: string;
}

// --- Constants ---

const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;
const HARD_MAX_TOOL_RESULT_CHARS = 400_000;
const MIN_KEEP_CHARS = 2_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;

const TRUNCATION_SUFFIX =
  "\n\n[Content truncated -- original was too large for the model's context window. " +
  "If you need more, request specific sections or use offset/limit parameters.]";

const MIDDLE_OMISSION_MARKER =
  "\n\n[... middle content omitted -- showing head and tail ...]\n\n";

// --- Overflow detection ---

function isLikelyContextOverflowError(errorText: string): boolean {
  const patterns = [
    /context.?length/i, /token.?limit/i, /maximum.?context/i,
    /too.?many.?tokens/i, /context.?window/i, /request.?too.?large/i,
  ];
  return patterns.some((p) => p.test(errorText));
}

function isCompactionFailureError(errorText: string): boolean {
  return /compaction.?fail/i.test(errorText);
}

// --- Smart tool result truncation (head + tail) ---

/**
 * Detect whether text likely contains error/diagnostic content near the end.
 * Errors, JSON closing braces, and summary lines should be preserved.
 */
function hasImportantTail(text: string): boolean {
  const tail = text.slice(-2000).toLowerCase();
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    /\}\s*$/.test(tail.trim()) ||
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/**
 * Truncate text with head+tail strategy when tail contains important content.
 *
 * Why head+tail? Tool outputs often have structure at the beginning (headers,
 * file paths) and diagnostic info at the end (errors, summaries). Naive
 * head-only truncation loses the most actionable information.
 *
 * Budget split: 70% head, 30% tail (max 4K tail) when tail is important.
 * Cut points snap to newline boundaries to avoid mid-line breaks.
 */
function truncateToolResultText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const budget = Math.max(MIN_KEEP_CHARS, maxChars - TRUNCATION_SUFFIX.length);

  // Head+tail strategy when tail looks important
  if (hasImportantTail(text) && budget > MIN_KEEP_CHARS * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > MIN_KEEP_CHARS) {
      // Snap to newline boundaries
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) headCut = headNewline;

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
        tailStart = tailNewline + 1;
      }

      return text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart) + TRUNCATION_SUFFIX;
    }
  }

  // Default: keep the beginning, snap to newline
  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) cutPoint = lastNewline;
  return text.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}

// --- Size limit calculation ---

/** Max chars for a single tool result: 30% of context window, hard cap 400K. */
function calculateMaxToolResultChars(contextWindowTokens: number): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  return Math.min(maxTokens * CHARS_PER_TOKEN_ESTIMATE, HARD_MAX_TOOL_RESULT_CHARS);
}

function getToolResultTextLength(msg: AgentMessage): number {
  if (msg.role !== "tool_result") return 0;
  if (typeof msg.content === "string") return msg.content.length;
  if (!Array.isArray(msg.content)) return 0;
  return msg.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .reduce((sum, b) => sum + (b.text?.length ?? 0), 0);
}

// --- Truncate oversized tool results in message array ---

function truncateOversizedToolResults(
  messages: AgentMessage[],
  contextWindowTokens: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if (msg.role !== "tool_result") return msg;
    const textLength = getToolResultTextLength(msg);
    if (textLength <= maxChars) return msg;

    truncatedCount++;
    // Truncate each text block proportionally
    if (typeof msg.content === "string") {
      return { ...msg, content: truncateToolResultText(msg.content, maxChars) };
    }
    const totalTextChars = textLength;
    const newContent = (msg.content as ContentBlock[]).map((block) => {
      if (block.type !== "text" || !block.text) return block;
      const blockShare = block.text.length / totalTextChars;
      const blockBudget = Math.max(MIN_KEEP_CHARS, Math.floor(maxChars * blockShare));
      return { ...block, text: truncateToolResultText(block.text, blockBudget) };
    });
    return { ...msg, content: newContent };
  });

  return { messages: result, truncatedCount };
}

function sessionHasOversizedToolResults(
  messages: AgentMessage[],
  contextWindowTokens: number,
): boolean {
  const maxChars = calculateMaxToolResultChars(contextWindowTokens);
  return messages.some((msg) => msg.role === "tool_result" && getToolResultTextLength(msg) > maxChars);
}

// --- 5-Tier recovery orchestrator ---

async function handleContextOverflow(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  errorText: string;
  attemptCompactionCount: number;        // SDK auto-compactions this attempt
  overflowCompactionAttempts: number;     // total across all tiers
  toolResultTruncationAttempted: boolean; // one-shot flag
  compact: () => Promise<{ ok: boolean; compacted: boolean; reason?: string }>;
}): Promise<{
  action: "retry" | "fail";
  overflowCompactionAttempts: number;
  toolResultTruncationAttempted: boolean;
}> {
  let { overflowCompactionAttempts, toolResultTruncationAttempted } = params;

  // Verify this is actually a context overflow
  if (!isLikelyContextOverflowError(params.errorText)) {
    return { action: "fail", overflowCompactionAttempts, toolResultTruncationAttempted };
  }

  // --- Tier 4: Compaction failure → immediate give-up ---
  if (isCompactionFailureError(params.errorText)) {
    return { action: "fail", overflowCompactionAttempts, toolResultTruncationAttempted };
  }

  const hadAutoCompaction = params.attemptCompactionCount > 0;

  // --- Tier 1: SDK already compacted → retry without extra compaction ---
  if (hadAutoCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    overflowCompactionAttempts++;
    return { action: "retry", overflowCompactionAttempts, toolResultTruncationAttempted };
  }

  // --- Tier 2: Explicit compaction via context engine ---
  if (!hadAutoCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS) {
    overflowCompactionAttempts++;
    const compactResult = await params.compact();

    if (compactResult.compacted) {
      // Context engine hooks (before/after_compaction) fire here in real impl
      return { action: "retry", overflowCompactionAttempts, toolResultTruncationAttempted };
    }
  }

  // --- Tier 3: Truncate oversized tool results (one-shot) ---
  if (!toolResultTruncationAttempted) {
    const hasOversized = sessionHasOversizedToolResults(
      params.messages, params.contextWindowTokens,
    );

    if (hasOversized) {
      toolResultTruncationAttempted = true;
      const truncResult = truncateOversizedToolResults(
        params.messages, params.contextWindowTokens,
      );

      if (truncResult.truncatedCount > 0) {
        // Do NOT reset overflowCompactionAttempts — global cap must remain
        // enforced to prevent unbounded compaction cycles.
        return { action: "retry", overflowCompactionAttempts, toolResultTruncationAttempted };
      }
    }
  }

  // --- Tier 5: All tiers exhausted ---
  return { action: "fail", overflowCompactionAttempts, toolResultTruncationAttempted };
}

// --- Usage example ---

/*
// Inside the agent retry loop:
let overflowCompactionAttempts = 0;
let toolResultTruncationAttempted = false;

while (true) {
  try {
    result = await runAttempt(messages);
    break;
  } catch (error) {
    const errorText = error instanceof Error ? error.message : String(error);
    const recovery = await handleContextOverflow({
      messages,
      contextWindowTokens: 200_000,
      errorText,
      attemptCompactionCount: attempt.compactionCount,
      overflowCompactionAttempts,
      toolResultTruncationAttempted,
      compact: () => contextEngine.compact({
        sessionFile, tokenBudget: 200_000, force: true,
      }),
    });

    overflowCompactionAttempts = recovery.overflowCompactionAttempts;
    toolResultTruncationAttempted = recovery.toolResultTruncationAttempted;

    if (recovery.action === "retry") continue;
    // Return user-facing error
    return { error: "Context overflow: try /reset or use a larger-context model." };
  }
}
*/
