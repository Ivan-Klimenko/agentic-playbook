/**
 * Dual-Loop Architecture (Retry/Recovery + Tool Execution)
 *
 * Pattern: Separate the retry/recovery loop from the tool-use loop.
 * They handle different concerns, different error types, different recovery strategies.
 * From: OpenClaw src/agents/pi-embedded-runner/run.ts, src/agents/pi-embedded-runner/run/attempt.ts
 *
 * Key ideas:
 *   - Outer loop: retry, auth failover, compaction, thinking downgrade
 *   - Inner loop: LLM call → tool execution → message building → done detection
 *   - Max iterations = 24 base + 8 per auth profile (min 32, max 160)
 *   - Done detection via stop_reason, not a "done" tool
 *   - Error classification drives recovery strategy selection
 *   - 5-tier escalating recovery
 */

// ─── Types ─────────────────────────────────────────────────────────────────

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AuthProfile {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  cooldownUntil?: number;
}

interface AttemptResult {
  success: boolean;
  payloads: ResponsePayload[];
  error?: AttemptError;
  tokenUsage: TokenUsage;
}

interface AttemptError {
  type: "auth" | "overflow" | "timeout" | "rate_limit" | "thinking_mismatch" | "unknown";
  message: string;
  retryable: boolean;
}

interface ResponsePayload {
  text: string;
  isError?: boolean;
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface RunParams {
  sessionKey: string;
  agentId: string;
  systemPrompt: string;
  messages: AgentMessage[];
  authProfiles: AuthProfile[];
  thinkLevel: ThinkLevel;
  tools: AgentTool[];
}

interface AgentMessage {
  role: "user" | "assistant" | "toolResult";
  content: string;
  [key: string]: unknown;
}

interface AgentTool {
  name: string;
  execute: (params: unknown) => Promise<string>;
}

// ─── Max Iterations Calculation ────────────────────────────────────────────

const BASE_ITERATIONS = 24;
const PER_PROFILE_ITERATIONS = 8;
const MIN_ITERATIONS = 32;
const MAX_ITERATIONS = 160;

/**
 * Scale iteration budget with the number of auth profiles.
 * More profiles = more failover options = more retries are reasonable.
 */
function resolveMaxRunRetryIterations(profileCount: number): number {
  const raw = BASE_ITERATIONS + profileCount * PER_PROFILE_ITERATIONS;
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, raw));
}

// ─── Error Classification ──────────────────────────────────────────────────

function classifyError(error: unknown): AttemptError {
  const message = error instanceof Error ? error.message : String(error);

  if (/401|403|invalid.*key|unauthorized/i.test(message)) {
    return { type: "auth", message, retryable: true };
  }
  if (/context.*length|too many tokens|overflow/i.test(message)) {
    return { type: "overflow", message, retryable: true };
  }
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { type: "timeout", message, retryable: true };
  }
  if (/rate.?limit|429|too many requests/i.test(message)) {
    return { type: "rate_limit", message, retryable: true };
  }
  if (/thinking.*not supported|budget_tokens/i.test(message)) {
    return { type: "thinking_mismatch", message, retryable: true };
  }

  return { type: "unknown", message, retryable: false };
}

// ─── Inner Loop: Single Attempt ────────────────────────────────────────────

/**
 * Run a single agent attempt: LLM call → tool loop → done detection.
 *
 * This is the INNER LOOP. It drives the SDK's tool-use cycle:
 *   LLM response → parse tool calls → execute tools → append results → loop
 *   Until stop_reason !== "tool_use" (agent is done)
 *
 * Concerns: tool execution, message building, streaming, loop detection.
 * NOT concerned with: auth failover, compaction, retry logic.
 */
async function runSingleAttempt(params: {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  authProfile: AuthProfile;
  thinkLevel: ThinkLevel;
}): Promise<AttemptResult> {
  const { systemPrompt, messages, tools, authProfile, thinkLevel } = params;
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  try {
    // In OpenClaw, this calls the PI SDK's activeSession.prompt()
    // which internally runs the full tool-use loop
    const result = await callLLMWithToolLoop({
      systemPrompt,
      messages,
      tools,
      model: authProfile.model,
      apiKey: authProfile.apiKey,
      thinkLevel,
    });

    tokenUsage.inputTokens = result.usage.inputTokens;
    tokenUsage.outputTokens = result.usage.outputTokens;

    return {
      success: true,
      payloads: [{ text: result.finalResponse }],
      tokenUsage,
    };
  } catch (error) {
    return {
      success: false,
      payloads: [],
      error: classifyError(error),
      tokenUsage,
    };
  }
}

// ─── Outer Loop: Retry & Recovery ──────────────────────────────────────────

/**
 * Run the agent with full retry/recovery logic.
 *
 * This is the OUTER LOOP. It wraps single attempts with:
 *   - Auth profile rotation on auth errors
 *   - Context compaction on overflow
 *   - Thinking level downgrade on mismatch
 *   - Rate limit backoff
 *   - Max iteration budget
 *
 * Concerns: error recovery, failover, compaction.
 * NOT concerned with: tool execution, message building, streaming.
 */
export async function runAgentWithRetry(params: RunParams): Promise<{
  payloads: ResponsePayload[];
  totalTokenUsage: TokenUsage;
}> {
  const maxIterations = resolveMaxRunRetryIterations(params.authProfiles.length);
  let iterations = 0;
  let overflowCompactionAttempts = 0;
  let currentProfileIndex = 0;
  let currentThinkLevel = params.thinkLevel;
  let messages = [...params.messages];

  // Token tracking: accumulated across all attempts
  const totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  while (true) {
    // ── Guard: max iterations ──
    if (iterations >= maxIterations) {
      return {
        payloads: [{ text: "Request failed after repeated internal retries.", isError: true }],
        totalTokenUsage,
      };
    }
    iterations++;

    // ── Select auth profile ──
    const profile = params.authProfiles[currentProfileIndex % params.authProfiles.length]!;

    // Skip profiles in cooldown
    if (profile.cooldownUntil && Date.now() < profile.cooldownUntil) {
      currentProfileIndex++;
      continue;
    }

    // ── Run single attempt (inner loop) ──
    const attempt = await runSingleAttempt({
      systemPrompt: params.systemPrompt,
      messages,
      tools: params.tools,
      authProfile: profile,
      thinkLevel: currentThinkLevel,
    });

    // Accumulate token usage
    totalTokenUsage.inputTokens += attempt.tokenUsage.inputTokens;
    totalTokenUsage.outputTokens += attempt.tokenUsage.outputTokens;

    // ── Success → return ──
    if (attempt.success) {
      return { payloads: attempt.payloads, totalTokenUsage };
    }

    // ── Error recovery (5-tier escalation) ──
    const error = attempt.error!;

    switch (error.type) {
      case "overflow": {
        // Tier 1-3: compaction → tool result truncation
        overflowCompactionAttempts++;
        if (overflowCompactionAttempts <= 3) {
          messages = await compactMessages(messages, overflowCompactionAttempts);
          continue; // Retry with compacted messages
        }

        // Tier 4: thinking downgrade
        if (currentThinkLevel !== "off") {
          currentThinkLevel = downgradeThinkLevel(currentThinkLevel);
          continue;
        }

        // Tier 5: try different auth profile (might have larger context)
        currentProfileIndex++;
        continue;
      }

      case "auth": {
        // Mark profile with cooldown, rotate to next
        profile.cooldownUntil = Date.now() + 60_000; // 1 min cooldown
        currentProfileIndex++;
        continue;
      }

      case "timeout": {
        // Mark profile, rotate
        profile.cooldownUntil = Date.now() + 30_000;
        currentProfileIndex++;
        continue;
      }

      case "rate_limit": {
        // Wait briefly, then retry same profile
        await sleep(5_000);
        continue;
      }

      case "thinking_mismatch": {
        // Model doesn't support requested think level → downgrade
        currentThinkLevel = downgradeThinkLevel(currentThinkLevel);
        continue;
      }

      default: {
        // Unknown error, not retryable
        return {
          payloads: [{ text: `Error: ${error.message}`, isError: true }],
          totalTokenUsage,
        };
      }
    }
  }
}

// ─── Recovery Helpers ──────────────────────────────────────────────────────

function downgradeThinkLevel(current: ThinkLevel): ThinkLevel {
  const levels: ThinkLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const idx = levels.indexOf(current);
  return idx > 0 ? levels[idx - 1]! : "off";
}

async function compactMessages(
  messages: AgentMessage[],
  attempt: number,
): Promise<AgentMessage[]> {
  // Escalating compaction:
  // Attempt 1: summarize oldest 50% of messages
  // Attempt 2: truncate oversized tool results
  // Attempt 3: aggressive compression (keep only last 25%)
  const ratio = attempt === 1 ? 0.5 : attempt === 2 ? 0.5 : 0.25;
  const keepCount = Math.ceil(messages.length * ratio);
  const toSummarize = messages.slice(0, messages.length - keepCount);
  const toKeep = messages.slice(-keepCount);

  const summary = await summarizeMessages(toSummarize); // cheap model
  return [
    { role: "user" as const, content: `<context_summary>\n${summary}\n</context_summary>` },
    { role: "assistant" as const, content: "Understood. Continuing with the summarized context." },
    ...toKeep,
  ];
}

// Stubs for completeness
async function callLLMWithToolLoop(params: any): Promise<any> { throw new Error("stub"); }
async function summarizeMessages(messages: AgentMessage[]): Promise<string> { return ""; }
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// The dual-loop in action:
const result = await runAgentWithRetry({
  sessionKey: "telegram:123:456:789",
  agentId: "general-assistant",
  systemPrompt: "You are a helpful assistant...",
  messages: [{ role: "user", content: "Analyze this codebase" }],
  authProfiles: [
    { id: "primary", provider: "anthropic", model: "claude-opus-4-6", apiKey: "sk-..." },
    { id: "fallback", provider: "anthropic", model: "claude-sonnet-4-6", apiKey: "sk-..." },
  ],
  thinkLevel: "high",
  tools: [...],
});

// Execution flow:
// Iteration 1: attempt with claude-opus-4-6, thinkLevel=high
//   Inner loop: LLM → read_file → LLM → edit_file → LLM → done
//   → Success! Return result.
//
// Or error path:
// Iteration 1: attempt with claude-opus-4-6 → auth error (expired key)
//   → Mark profile with cooldown, rotate to fallback
// Iteration 2: attempt with claude-sonnet-4-6 → context overflow
//   → Compact messages (summarize oldest 50%)
// Iteration 3: attempt with claude-sonnet-4-6 → success
//   → Return result with accumulated token usage

// Token tracking:
// totalTokenUsage = sum of ALL attempts (not just the successful one)
// This gives accurate billing while the per-attempt usage prevents
// inflating context size estimates (don't multiply context × N attempts)
*/
