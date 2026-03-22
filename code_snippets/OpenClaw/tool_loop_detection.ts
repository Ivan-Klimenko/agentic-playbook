/**
 * Tool Loop Detection (Configurable, Pattern-Based)
 *
 * Pattern: Detect specific tool call loop patterns and inject corrective
 * messages rather than terminating the agent run.
 * From: OpenClaw src/agents/tool-loop-detection.ts
 *
 * Key ideas:
 *   - 4 specialized detectors: generic_repeat, known_poll_no_progress, global_circuit_breaker, ping_pong
 *   - Fully configurable thresholds and per-detector enable flags
 *   - Recursive stable JSON serialization with fallback for unhashable values
 *   - Domain-specific outcome hashing (poll actions extract status/exitCode fields)
 *   - Outcome hash covers both success results and errors (error:hash prefix)
 *   - Critical → block tool call; Warning → log only
 *   - Canonical pair key for ping-pong deduplication
 *   - recordToolCallOutcome patches result hash onto matching history entry,
 *     or appends a new entry if no pending match exists (late-arrival tolerance)
 */

import { createHash } from "crypto";

// --- Types ---

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
      pairedToolName?: string; // for ping_pong: the other tool in the pair
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

// --- Configurable thresholds ---

interface LoopDetectionConfig {
  enabled?: boolean;
  historySize?: number;
  warningThreshold?: number;
  criticalThreshold?: number;
  globalCircuitBreakerThreshold?: number;
  detectors?: {
    genericRepeat?: boolean;
    knownPollNoProgress?: boolean;
    pingPong?: boolean;
  };
}

const DEFAULTS = {
  enabled: false, // opt-in by default
  historySize: 30,
  warningThreshold: 10,
  criticalThreshold: 20,
  globalCircuitBreakerThreshold: 30,
} as const;

function resolveConfig(config?: LoopDetectionConfig) {
  let warn = Math.max(1, config?.warningThreshold ?? DEFAULTS.warningThreshold);
  let crit = Math.max(warn + 1, config?.criticalThreshold ?? DEFAULTS.criticalThreshold);
  let global = Math.max(crit + 1, config?.globalCircuitBreakerThreshold ?? DEFAULTS.globalCircuitBreakerThreshold);
  // Enforce strict ordering: warning < critical < global
  if (crit <= warn) crit = warn + 1;
  if (global <= crit) global = crit + 1;

  return {
    enabled: config?.enabled ?? DEFAULTS.enabled,
    historySize: Math.max(1, config?.historySize ?? DEFAULTS.historySize),
    warningThreshold: warn,
    criticalThreshold: crit,
    globalCircuitBreakerThreshold: global,
    detectors: {
      genericRepeat: config?.detectors?.genericRepeat ?? true,
      knownPollNoProgress: config?.detectors?.knownPollNoProgress ?? true,
      pingPong: config?.detectors?.pingPong ?? true,
    },
  };
}

// --- Stable Hashing ---

/**
 * Recursive stable JSON serialization with sorted keys.
 * Ensures identical objects always produce identical strings regardless
 * of property insertion order.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * Fallback for unhashable values: Error objects serialize to name:message,
 * bigints stringify, and anything else gets Object.prototype.toString.
 */
function stableStringifyFallback(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    if (value == null) return `${value}`;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return `${value}`;
    if (value instanceof Error) return `${value.name}:${value.message}`;
    return Object.prototype.toString.call(value);
  }
}

function digestStable(value: unknown): string {
  return createHash("sha256").update(stableStringifyFallback(value)).digest("hex");
}

function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

// --- Domain-Specific Outcome Hashing ---

/**
 * Hash a tool outcome with domain awareness.
 * - Errors: prefixed with "error:" to distinguish from success
 * - Known poll tools (process/poll, command_status): extract status fields
 *   so irrelevant output noise doesn't defeat no-progress detection
 * - Generic tools: hash the details + text content
 */
function hashToolOutcome(
  toolName: string,
  params: unknown,
  result: unknown,
  error: unknown,
): string | undefined {
  // Error outcomes get a distinct prefix
  if (error !== undefined) {
    const errorStr = error instanceof Error ? error.message : String(error);
    return `error:${digestStable(errorStr)}`;
  }
  if (result === undefined) return undefined;
  if (typeof result !== "object" || result === null) return digestStable(result);

  const details = (result as Record<string, unknown>).details ?? {};
  const text = extractTextContent(result);

  // Domain: process poll/log actions — extract only status-relevant fields
  if (isKnownPollToolCall(toolName, params) && typeof params === "object" && params !== null) {
    const action = (params as Record<string, unknown>).action;
    if (action === "poll") {
      return digestStable({
        action, status: (details as any).status,
        exitCode: (details as any).exitCode ?? null,
        exitSignal: (details as any).exitSignal ?? null,
        text,
      });
    }
  }

  return digestStable({ details, text });
}

function isKnownPollToolCall(toolName: string, params: unknown): boolean {
  if (toolName === "command_status") return true;
  if (toolName !== "process" || typeof params !== "object" || params === null) return false;
  const action = (params as Record<string, unknown>).action;
  return action === "poll" || action === "log";
}

function extractTextContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((e: any) => e?.type === "text" && typeof e.text === "string")
    .map((e: any) => e.text)
    .join("\n")
    .trim();
}

// --- Streak Detectors ---

function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i]!;
    if (rec.toolName !== toolName || rec.argsHash !== argsHash) continue;
    if (!rec.resultHash) continue;

    if (!latestResultHash) {
      latestResultHash = rec.resultHash;
      streak = 1;
      continue;
    }
    if (rec.resultHash !== latestResultHash) break;
    streak++;
  }

  return { count: streak, latestResultHash };
}

function getPingPongStreak(
  history: ToolCallRecord[],
  currentSignature: string,
): { count: number; pairedToolName?: string; noProgressEvidence: boolean } {
  const last = history.at(-1);
  if (!last) return { count: 0, noProgressEvidence: false };

  // Find the most recent DIFFERENT signature
  let otherSignature: string | undefined;
  let otherToolName: string | undefined;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i]!.argsHash !== last.argsHash) {
      otherSignature = history[i]!.argsHash;
      otherToolName = history[i]!.toolName;
      break;
    }
  }
  if (!otherSignature) return { count: 0, noProgressEvidence: false };

  // Count alternating tail
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherSignature;
    if (history[i]!.argsHash !== expected) break;
    count++;
  }

  if (count < 2 || currentSignature !== otherSignature) {
    return { count: 0, noProgressEvidence: false };
  }

  // Check if both sides produce stable (identical) results
  const tailStart = Math.max(0, history.length - count);
  let hashA: string | undefined, hashB: string | undefined;
  let noProgress = true;
  for (let i = tailStart; i < history.length; i++) {
    const call = history[i]!;
    if (!call.resultHash) { noProgress = false; break; }
    if (call.argsHash === last.argsHash) {
      if (!hashA) hashA = call.resultHash;
      else if (hashA !== call.resultHash) { noProgress = false; break; }
    } else {
      if (!hashB) hashB = call.resultHash;
      else if (hashB !== call.resultHash) { noProgress = false; break; }
    }
  }
  if (!hashA || !hashB) noProgress = false;

  return { count: count + 1, pairedToolName: last.toolName, noProgressEvidence: noProgress };
}

/** Canonical pair key for deduplicating ping-pong warnings. */
function canonicalPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

// --- Main Detector ---

export function detectToolCallLoop(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
  config?: LoopDetectionConfig,
): LoopDetectionResult {
  const cfg = resolveConfig(config);
  if (!cfg.enabled) return { stuck: false };

  const history = state.toolCallHistory ?? [];
  const currentHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(history, toolName, currentHash);
  const knownPoll = isKnownPollToolCall(toolName, params);
  const pingPong = getPingPongStreak(history, currentHash);

  // 1. Global circuit breaker (highest priority)
  if (noProgress.count >= cfg.globalCircuitBreakerThreshold) {
    return {
      stuck: true, level: "critical", detector: "global_circuit_breaker",
      count: noProgress.count,
      message: `CRITICAL: ${toolName} repeated ${noProgress.count} times with no progress. Blocked by circuit breaker.`,
      warningKey: `global:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  // 2. Known poll no-progress (critical)
  if (knownPoll && cfg.detectors.knownPollNoProgress && noProgress.count >= cfg.criticalThreshold) {
    return {
      stuck: true, level: "critical", detector: "known_poll_no_progress",
      count: noProgress.count,
      message: `CRITICAL: ${toolName} stuck polling ${noProgress.count} times. Blocked.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  // 3. Known poll no-progress (warning)
  if (knownPoll && cfg.detectors.knownPollNoProgress && noProgress.count >= cfg.warningThreshold) {
    return {
      stuck: true, level: "warning", detector: "known_poll_no_progress",
      count: noProgress.count,
      message: `WARNING: ${toolName} called ${noProgress.count} times with no progress. Stop polling or increase wait time.`,
      warningKey: `poll:${toolName}:${currentHash}:${noProgress.latestResultHash ?? "none"}`,
    };
  }

  // 4. Ping-pong (critical)
  const ppWarningKey = pingPong.pairedToolName
    ? `pingpong:${canonicalPairKey(currentHash, currentHash)}`
    : `pingpong:${toolName}:${currentHash}`;

  if (cfg.detectors.pingPong && pingPong.count >= cfg.criticalThreshold && pingPong.noProgressEvidence) {
    return {
      stuck: true, level: "critical", detector: "ping_pong",
      count: pingPong.count,
      message: `CRITICAL: Alternating tool loop (${pingPong.count} calls) with no progress. Blocked.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: ppWarningKey,
    };
  }

  // 5. Ping-pong (warning)
  if (cfg.detectors.pingPong && pingPong.count >= cfg.warningThreshold) {
    return {
      stuck: true, level: "warning", detector: "ping_pong",
      count: pingPong.count,
      message: `WARNING: Alternating tool pattern (${pingPong.count} calls). Report as failed if no progress.`,
      pairedToolName: pingPong.pairedToolName,
      warningKey: ppWarningKey,
    };
  }

  // 6. Generic repeat (warning only, non-poll tools)
  const recentCount = history.filter((h) => h.toolName === toolName && h.argsHash === currentHash).length;
  if (!knownPoll && cfg.detectors.genericRepeat && recentCount >= cfg.warningThreshold) {
    return {
      stuck: true, level: "warning", detector: "generic_repeat",
      count: recentCount,
      message: `WARNING: ${toolName} called ${recentCount} times with identical args. Report as failed if stuck.`,
      warningKey: `generic:${toolName}:${currentHash}`,
    };
  }

  return { stuck: false };
}

// --- History Management ---

/** Record a tool call before execution. Enforces sliding window. */
export function recordToolCall(
  state: LoopDetectionState,
  toolName: string,
  params: unknown,
  toolCallId?: string,
  config?: LoopDetectionConfig,
): void {
  const cfg = resolveConfig(config);
  if (!state.toolCallHistory) state.toolCallHistory = [];

  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    toolCallId,
    timestamp: Date.now(),
  });

  // Use shift() instead of slice() — more efficient for sliding window
  if (state.toolCallHistory.length > cfg.historySize) {
    state.toolCallHistory.shift();
  }
}

/**
 * Patch result hash onto matching history entry after tool execution.
 *
 * Match strategy: find last entry with same toolName+argsHash that has no
 * resultHash yet. If toolCallId is present, require it to match too.
 * If no match found, append a new entry (late-arrival tolerance).
 */
export function recordToolCallOutcome(
  state: LoopDetectionState,
  params: {
    toolName: string;
    toolParams: unknown;
    toolCallId?: string;
    result?: unknown;
    error?: unknown;
    config?: LoopDetectionConfig;
  },
): void {
  const cfg = resolveConfig(params.config);
  const resultHash = hashToolOutcome(params.toolName, params.toolParams, params.result, params.error);
  if (!resultHash) return;
  if (!state.toolCallHistory) state.toolCallHistory = [];

  const argsHash = hashToolCall(params.toolName, params.toolParams);
  let matched = false;

  for (let i = state.toolCallHistory.length - 1; i >= 0; i--) {
    const call = state.toolCallHistory[i]!;
    if (params.toolCallId && call.toolCallId !== params.toolCallId) continue;
    if (call.toolName !== params.toolName || call.argsHash !== argsHash) continue;
    if (call.resultHash !== undefined) continue;
    call.resultHash = resultHash;
    matched = true;
    break;
  }

  // Late-arrival: no matching pending entry → append new one
  if (!matched) {
    state.toolCallHistory.push({
      toolName: params.toolName,
      argsHash,
      toolCallId: params.toolCallId,
      resultHash,
      timestamp: Date.now(),
    });
  }

  // Enforce sliding window
  if (state.toolCallHistory.length > cfg.historySize) {
    state.toolCallHistory.splice(0, state.toolCallHistory.length - cfg.historySize);
  }
}

// --- Stats for monitoring ---

export function getToolCallStats(state: LoopDetectionState): {
  totalCalls: number;
  uniquePatterns: number;
  mostFrequent: { toolName: string; count: number } | null;
} {
  const history = state.toolCallHistory ?? [];
  const patterns = new Map<string, { toolName: string; count: number }>();
  for (const call of history) {
    const existing = patterns.get(call.argsHash);
    if (existing) existing.count++;
    else patterns.set(call.argsHash, { toolName: call.toolName, count: 1 });
  }
  let mostFrequent: { toolName: string; count: number } | null = null;
  for (const p of patterns.values()) {
    if (!mostFrequent || p.count > mostFrequent.count) mostFrequent = p;
  }
  return { totalCalls: history.length, uniquePatterns: patterns.size, mostFrequent };
}

// --- Usage Example ---

/*
const state: LoopDetectionState = { toolCallHistory: [] };
const config: LoopDetectionConfig = {
  enabled: true,
  warningThreshold: 8,
  criticalThreshold: 15,
  globalCircuitBreakerThreshold: 25,
};

// Before each tool call:
const detection = detectToolCallLoop(state, "process", { action: "poll" }, config);
if (detection.stuck && detection.level === "critical") {
  // Block tool — return error as tool_result to LLM
  return { result: detection.message, isError: true };
}
recordToolCall(state, "process", { action: "poll" }, toolCallId, config);

// After tool execution:
recordToolCallOutcome(state, {
  toolName: "process",
  toolParams: { action: "poll" },
  toolCallId,
  result: { content: [{ type: "text", text: "running" }], details: { status: "running" } },
  config,
});
*/
