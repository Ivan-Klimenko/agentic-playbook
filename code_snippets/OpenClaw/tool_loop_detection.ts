/**
 * Tool Loop Detection (Pattern-Based, Not Hard Caps)
 *
 * Pattern: Detect specific tool call loop patterns and inject corrective
 * messages rather than terminating the agent run.
 * From: OpenClaw src/agents/tool-loop-detection.ts, src/agents/pi-tools.before-tool-call.ts
 *
 * Key ideas:
 *   - 4 specialized detectors: generic_repeat, known_poll_no_progress, global_circuit_breaker, ping_pong
 *   - Sliding window of last N tool calls (fingerprinted by name + args hash)
 *   - Result hashing detects "no progress" (same output from same tool)
 *   - Critical detection → block tool call (error delivered as tool_result to LLM)
 *   - Warning detection → log only (tool still executes)
 *   - Bucket-based rate limiting prevents warning spam
 */

import { createHash } from "crypto";

// ─── Types ─────────────────────────────────────────────────────────────────

type LoopDetectorKind =
  | "generic_repeat"
  | "known_poll_no_progress"
  | "global_circuit_breaker"
  | "ping_pong";

type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: "warning" | "critical";
      detector: LoopDetectorKind;
      count: number;
      message: string;
      warningKey?: string;
    };

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  toolCallId?: string;
  timestamp: number;
}

interface LoopDetectionState {
  toolCallHistory: ToolCallRecord[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const TOOL_CALL_HISTORY_SIZE = 30; // Sliding window
const WARNING_THRESHOLD = 10;
const CRITICAL_THRESHOLD = 20;
const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

// ─── Hashing ───────────────────────────────────────────────────────────────

/**
 * Stable hash of tool call arguments.
 * Key-sorted JSON prevents ordering differences from creating distinct hashes.
 */
function digestStable(value: unknown): string {
  const sorted = JSON.stringify(value, Object.keys(value as object).sort());
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

// ─── Streak Detection ──────────────────────────────────────────────────────

/**
 * Count consecutive tail entries with the same tool+args+result hash.
 * "No progress" = same tool, same args, same result, repeated.
 */
function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): number {
  let streak = 0;
  let expectedResultHash: string | undefined;

  // Walk backward from most recent
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]!;
    if (rec.toolName !== toolName || rec.argsHash !== argsHash) break;
    if (!rec.resultHash) break;

    if (expectedResultHash === undefined) {
      expectedResultHash = rec.resultHash;
    } else if (rec.resultHash !== expectedResultHash) {
      break; // Different result = progress was made
    }

    streak++;
  }

  return streak;
}

/**
 * Detect alternating A-B-A-B patterns in tool call history.
 * Returns the count of alternations and whether both sides show no progress.
 */
function getPingPongStreak(
  history: ToolCallRecord[],
): { count: number; noProgressEvidence: boolean } {
  if (history.length < 4) return { count: 0, noProgressEvidence: false };

  const last = history[history.length - 1]!;
  const lastKey = `${last.toolName}:${last.argsHash}`;

  // Find the most recent DIFFERENT tool call
  let otherKey: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    const key = `${history[i]!.toolName}:${history[i]!.argsHash}`;
    if (key !== lastKey) {
      otherKey = key;
      break;
    }
  }
  if (!otherKey) return { count: 0, noProgressEvidence: false };

  // Count alternations from the tail
  let count = 0;
  let expectKey = lastKey;
  const resultsByKey = new Map<string, Set<string>>();

  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]!;
    const key = `${rec.toolName}:${rec.argsHash}`;
    if (key !== expectKey) break;

    count++;
    if (rec.resultHash) {
      if (!resultsByKey.has(key)) resultsByKey.set(key, new Set());
      resultsByKey.get(key)!.add(rec.resultHash);
    }

    // Alternate expectation
    expectKey = expectKey === lastKey ? otherKey : lastKey;
  }

  // No progress = both sides produce only 1 unique result each
  const noProgressEvidence =
    (resultsByKey.get(lastKey)?.size ?? 0) <= 1 &&
    (resultsByKey.get(otherKey)?.size ?? 0) <= 1 &&
    count >= 4;

  return { count, noProgressEvidence };
}

// ─── Main Detector ─────────────────────────────────────────────────────────

/**
 * Evaluate all loop detectors against the current tool call history.
 * Detectors are checked in priority order (most severe first).
 */
export function detectToolCallLoop(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
): LoopDetectionResult {
  const history = state.toolCallHistory;
  if (history.length === 0) return { stuck: false };

  const argsHash = digestStable(params);
  const noProgressStreak = getNoProgressStreak(history, toolName, argsHash);

  // 1. Global circuit breaker (highest priority)
  if (noProgressStreak >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "global_circuit_breaker",
      count: noProgressStreak,
      message: `CRITICAL: ${toolName} has repeated identical no-progress outcomes ${noProgressStreak} times. Session execution blocked by global circuit breaker. Try a completely different approach.`,
    };
  }

  // 2. Known poll no progress (critical)
  if (noProgressStreak >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: "critical",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `CRITICAL: Called ${toolName} with identical arguments and no progress ${noProgressStreak} times. This appears to be a stuck polling loop. Stop polling and try a different approach.`,
    };
  }

  // 3. Known poll no progress (warning)
  if (noProgressStreak >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "known_poll_no_progress",
      count: noProgressStreak,
      message: `WARNING: ${toolName} has been called ${noProgressStreak} times with no progress. Consider whether continued polling will produce different results.`,
      warningKey: `poll:${toolName}:${argsHash}`,
    };
  }

  // 4. Ping-pong detection
  const pingPong = getPingPongStreak(history);
  if (pingPong.count >= CRITICAL_THRESHOLD && pingPong.noProgressEvidence) {
    return {
      stuck: true,
      level: "critical",
      detector: "ping_pong",
      count: pingPong.count,
      message: `CRITICAL: Detected alternating tool call loop (${pingPong.count} iterations) with no progress. Both tools are producing identical results. Break the cycle.`,
    };
  }
  if (pingPong.count >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "ping_pong",
      count: pingPong.count,
      message: `WARNING: Alternating tool call pattern detected (${pingPong.count} iterations). Verify you're making progress.`,
      warningKey: `pingpong:${pingPong.count}`,
    };
  }

  // 5. Generic repeat (warning only, for non-poll tools)
  const recentCount = history.filter(
    (r) => r.toolName === toolName && r.argsHash === argsHash,
  ).length;
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: "warning",
      detector: "generic_repeat",
      count: recentCount,
      message: `WARNING: ${toolName} has been called ${recentCount} times with identical arguments in the recent window. The result is unlikely to change.`,
      warningKey: `repeat:${toolName}:${argsHash}`,
    };
  }

  return { stuck: false };
}

// ─── History Management ────────────────────────────────────────────────────

/**
 * Record a tool call before execution (no result hash yet).
 * Enforces sliding window size.
 */
export function recordToolCall(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
): void {
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }

  state.toolCallHistory.push({
    toolName,
    argsHash: digestStable(params),
    toolCallId,
    timestamp: Date.now(),
  });

  // Enforce sliding window
  if (state.toolCallHistory.length > TOOL_CALL_HISTORY_SIZE) {
    state.toolCallHistory = state.toolCallHistory.slice(-TOOL_CALL_HISTORY_SIZE);
  }
}

/**
 * Patch in the result hash after tool execution.
 * Matches by toolCallId first, then by toolName+argsHash.
 */
export function recordToolCallOutcome(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
  resultHash: string,
  toolCallId?: string,
): void {
  const history = state.toolCallHistory;
  if (!history?.length) return;

  const argsHash = digestStable(params);

  // Find matching record (prefer toolCallId match)
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]!;
    if (toolCallId && rec.toolCallId === toolCallId) {
      rec.resultHash = resultHash;
      return;
    }
    if (rec.toolName === toolName && rec.argsHash === argsHash && !rec.resultHash) {
      rec.resultHash = resultHash;
      return;
    }
  }
}

// ─── Before-Tool-Call Hook Integration ─────────────────────────────────────

/**
 * Bucket-based rate limiting for warnings.
 * Only emit one warning per bucket of 10 calls to prevent spam.
 */
const LOOP_WARNING_BUCKET_SIZE = 10;

function shouldEmitLoopWarning(
  emittedBuckets: Map<string, number>,
  warningKey: string,
  count: number,
): boolean {
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = emittedBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) return false;
  emittedBuckets.set(warningKey, bucket);
  return true;
}

interface HookOutcome {
  blocked: boolean;
  reason?: string;
}

/**
 * Before-tool-call hook that runs loop detection.
 *
 * Critical detections → block the tool call (error delivered as tool_result to LLM).
 * Warning detections → log only (tool executes normally).
 *
 * The blocked tool call's error message appears in the LLM's context as a
 * tool_result with is_error: true, prompting the LLM to change strategy.
 */
export function runBeforeToolCallHook(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  warningBuckets?: Map<string, number>,
): HookOutcome {
  const result = detectToolCallLoop(state, toolName, params);

  if (result.stuck) {
    if (result.level === "critical") {
      // Block the tool call — error message becomes a tool_result
      return { blocked: true, reason: result.message };
    }

    // Warning: log but don't block
    const buckets = warningBuckets ?? new Map();
    if (result.warningKey && shouldEmitLoopWarning(buckets, result.warningKey, result.count)) {
      console.warn(`[loop-detection] ${result.message}`);
    }
  }

  // Record the call (before execution)
  recordToolCall(state, toolName, params, toolCallId);

  return { blocked: false };
}

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// In your tool execution wrapper:
const state: LoopDetectionState = { toolCallHistory: [] };
const warningBuckets = new Map<string, number>();

async function executeToolWithLoopDetection(
  toolName: string,
  params: unknown,
  toolCallId: string,
  executeFn: () => Promise<string>,
): Promise<{ result: string; isError: boolean }> {
  // Check for loops BEFORE execution
  const hookResult = runBeforeToolCallHook(
    state, toolName, params, toolCallId, warningBuckets,
  );

  if (hookResult.blocked) {
    // Return error as tool result — LLM sees this and adjusts
    return { result: hookResult.reason!, isError: true };
  }

  // Execute the actual tool
  const result = await executeFn();

  // Record the outcome for future loop detection
  const resultHash = createHash("sha256").update(result).digest("hex").slice(0, 16);
  recordToolCallOutcome(state, toolName, params, resultHash, toolCallId);

  return { result, isError: false };
}

// Example: agent stuck polling a process
// Call 1-9: process(action=poll) → { status: "running" } — no detection
// Call 10:  process(action=poll) → WARNING logged, tool still runs
// Call 20:  process(action=poll) → CRITICAL: tool BLOCKED, error message
//           sent to LLM as tool_result → LLM tries different approach

// Example: ping-pong between two tools
// read_file → edit_file → read_file → edit_file → ... (10x)
// → WARNING: "Alternating tool call pattern detected"
// read_file → edit_file → read_file → edit_file → ... (20x, no progress)
// → CRITICAL: tool BLOCKED, cycle broken
*/
