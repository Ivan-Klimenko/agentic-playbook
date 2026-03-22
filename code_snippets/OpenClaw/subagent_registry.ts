/**
 * Subagent Run Registry with Announce Dispatch & Orphan Recovery
 *
 * Pattern: Centralized registry tracking subagent lifecycle, multi-path result
 * delivery, and post-restart orphan recovery.
 * From: OpenClaw src/agents/subagent-registry.ts, subagent-registry.types.ts,
 *       src/agents/subagent-announce-dispatch.ts, src/agents/subagent-orphan-recovery.ts
 *
 * Key ideas:
 * - SubagentRunRecord tracks full lifecycle: created -> started -> ended -> cleaned up
 * - Frozen result text captured at completion for announce delivery (100KB cap)
 * - Announce dispatch: 3-phase delivery (queue-primary -> direct-primary -> queue-fallback)
 *   with exponential backoff retry (max 3 attempts)
 * - Sweeper interval archives/deletes expired subagent sessions
 * - Orphan recovery after gateway restart: scans for abortedLastRun=true sessions,
 *   sends synthetic resume message, retries with exponential backoff
 * - Lifecycle error grace period: defers terminal error cleanup 15s to tolerate
 *   transient provider errors during retry
 * - Context engine notification on subagent end (swept/completed/deleted)
 * - Persisted to disk so registry survives gateway reloads
 */

// --- SubagentRunRecord ---

type SubagentRunOutcome = { status: "ok" } | { status: "error"; error?: string } | { status: "timeout" };
type SubagentEndReason = "complete" | "error" | "killed";
type SpawnMode = "run" | "session";

/**
 * Full lifecycle record for a single subagent run.
 * Stored in an in-memory Map<runId, SubagentRunRecord> and persisted to disk.
 */
interface SubagentRunRecord {
  runId: string;
  childSessionKey: string;
  controllerSessionKey?: string;       // who controls the child (usually = requester)
  requesterSessionKey: string;         // who spawned and expects results
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";          // delete session on completion vs keep for follow-up
  spawnMode?: SpawnMode;               // "run" (one-shot) vs "session" (persistent)
  label?: string;
  model?: string;

  // Timing
  createdAt: number;
  startedAt?: number;                  // current run attempt start
  sessionStartedAt?: number;           // stable start across follow-up runs
  accumulatedRuntimeMs?: number;       // prior completed runs' total
  endedAt?: number;
  archiveAtMs?: number;                // sweeper deadline

  // Outcome
  outcome?: SubagentRunOutcome;
  endedReason?: SubagentEndReason;

  // Announce delivery state
  suppressAnnounceReason?: "steer-restart" | "killed";
  expectsCompletionMessage?: boolean;
  announceRetryCount?: number;
  lastAnnounceRetryAt?: number;
  frozenResultText?: string | null;    // captured completion output (100KB cap)

  // Cleanup tracking
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
}

// --- Registration & Completion ---

const subagentRuns = new Map<string, SubagentRunRecord>();

function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  task: string;
  cleanup: "delete" | "keep";
  spawnMode?: SpawnMode;
}) {
  const now = Date.now();
  subagentRuns.set(params.runId, {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: params.requesterSessionKey,
    task: params.task,
    cleanup: params.cleanup,
    spawnMode: params.spawnMode ?? "run",
    createdAt: now,
    startedAt: now,
    sessionStartedAt: now,
    accumulatedRuntimeMs: 0,
    cleanupHandled: false,
  });
  // In real impl: persist to disk, start sweeper, wait for completion via RPC
}

function completeSubagentRun(params: {
  runId: string;
  outcome: SubagentRunOutcome;
  reason: SubagentEndReason;
}) {
  const entry = subagentRuns.get(params.runId);
  if (!entry) return;

  entry.endedAt = Date.now();
  entry.outcome = params.outcome;
  entry.endedReason = params.reason;

  // Capture frozen result text for announce delivery
  // In real impl: read last assistant message from session transcript
}

// --- Announce Dispatch (3-Phase Delivery) ---

type DeliveryPath = "queued" | "steered" | "direct" | "none";
type QueueOutcome = "steered" | "queued" | "none";

type AnnounceDeliveryResult = {
  delivered: boolean;
  path: DeliveryPath;
  error?: string;
  phases?: Array<{ phase: string; delivered: boolean; path: DeliveryPath; error?: string }>;
};

/**
 * Multi-phase announce dispatch. Tries the fastest delivery path first,
 * falls back to alternatives.
 *
 * When expectsCompletionMessage=false (fire-and-forget subagent):
 *   1. queue-primary: try to steer/queue into requester's active session
 *   2. direct-primary: send a direct message if queuing failed
 *
 * When expectsCompletionMessage=true (requester waits for reply):
 *   1. direct-primary: try direct delivery first (fastest)
 *   2. queue-fallback: queue if direct failed (requester may be busy)
 */
async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  signal?: AbortSignal;
  queue: () => Promise<QueueOutcome>;
  direct: () => Promise<AnnounceDeliveryResult>;
}): Promise<AnnounceDeliveryResult> {
  const phases: AnnounceDeliveryResult["phases"] = [];

  if (params.signal?.aborted) {
    return { delivered: false, path: "none", phases };
  }

  if (!params.expectsCompletionMessage) {
    // Fire-and-forget: queue first, then direct
    const queueResult = await params.queue();
    const queueDelivery = mapQueueOutcome(queueResult);
    phases.push({ phase: "queue-primary", ...queueDelivery });
    if (queueDelivery.delivered) return { ...queueDelivery, phases };

    const direct = await params.direct();
    phases.push({ phase: "direct-primary", ...direct });
    return { ...direct, phases };
  }

  // Completion expected: direct first, then queue fallback
  const direct = await params.direct();
  phases.push({ phase: "direct-primary", ...direct });
  if (direct.delivered) return { ...direct, phases };

  if (params.signal?.aborted) return { delivered: false, path: "none", phases };

  const fallback = await params.queue();
  const fallbackDelivery = mapQueueOutcome(fallback);
  phases.push({ phase: "queue-fallback", ...fallbackDelivery });
  if (fallbackDelivery.delivered) return { ...fallbackDelivery, phases };

  return { ...direct, phases }; // return primary result even if fallback failed
}

function mapQueueOutcome(outcome: QueueOutcome): { delivered: boolean; path: DeliveryPath } {
  if (outcome === "steered") return { delivered: true, path: "steered" };
  if (outcome === "queued") return { delivered: true, path: "queued" };
  return { delivered: false, path: "none" };
}

// --- Announce Retry with Backoff ---

const MAX_ANNOUNCE_RETRY_COUNT = 3;
const MIN_ANNOUNCE_RETRY_DELAY_MS = 1_000;
const MAX_ANNOUNCE_RETRY_DELAY_MS = 8_000;

/** Exponential backoff: 1s, 2s, 4s, 8s (capped). */
function resolveAnnounceRetryDelay(retryCount: number): number {
  const exponent = Math.max(0, Math.min(retryCount - 1, 10));
  const base = MIN_ANNOUNCE_RETRY_DELAY_MS * 2 ** exponent;
  return Math.min(base, MAX_ANNOUNCE_RETRY_DELAY_MS);
}

// --- Sweeper (Archive/Delete Expired Sessions) ---

const SWEEP_INTERVAL_MS = 60_000;

function sweepSubagentRuns() {
  const now = Date.now();
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) continue;

    // Notify context engine that subagent lifecycle ended
    // await contextEngine.onSubagentEnded?.({ childSessionKey, reason: "swept" });

    subagentRuns.delete(runId);
    // In real impl: delete session transcript, remove attachments
  }
}

// --- Orphan Recovery (Post-Restart) ---

const DEFAULT_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_RETRIES = 3;
const RETRY_BACKOFF_MULTIPLIER = 2;

interface SessionStoreEntry {
  sessionId: string;
  sessionFile?: string;
  abortedLastRun?: boolean;
  updatedAt?: number;
}

/**
 * Build resume message for an orphaned subagent.
 * Includes the original task so the agent can continue without re-prompting.
 */
function buildResumeMessage(task: string, lastHumanMessage?: string): string {
  const maxTaskLen = 2000;
  const truncated = task.length > maxTaskLen ? `${task.slice(0, maxTaskLen)}...` : task;
  let msg = `[System] Your previous turn was interrupted by a gateway reload. ` +
    `Your original task was:\n\n${truncated}\n\n`;
  if (lastHumanMessage) {
    msg += `The last message from the user was:\n\n${lastHumanMessage}\n\n`;
  }
  msg += `Please continue where you left off.`;
  return msg;
}

/**
 * Scan for orphaned subagent sessions after a gateway restart.
 *
 * Orphaned = active in registry + abortedLastRun=true in session store.
 * For each orphan:
 *   1. Send synthetic resume message via gateway RPC
 *   2. Remap the old runId to the new one (replaceSubagentRunAfterSteer)
 *   3. Clear abortedLastRun flag only after confirmed successful resume
 *
 * Why not clear the flag first? If callGateway fails (gateway still booting),
 * the flag stays true so the next restart can retry.
 */
async function recoverOrphanedSubagentSessions(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  resumedSessionKeys?: Set<string>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };
  const resumedKeys = params.resumedSessionKeys ?? new Set<string>();

  const activeRuns = params.getActiveRuns();
  for (const [runId, record] of activeRuns.entries()) {
    if (record.endedAt) continue; // already ended
    const childKey = record.childSessionKey?.trim();
    if (!childKey || resumedKeys.has(childKey)) { result.skipped++; continue; }

    // In real impl: load session store, check abortedLastRun flag
    const entry: SessionStoreEntry | undefined = undefined; // loadSessionStore(...)
    if (!entry?.abortedLastRun) { result.skipped++; continue; }

    // Send resume message
    const resumed = false; // await callGateway({ method: "agent", params: { message, sessionKey } })
    if (resumed) {
      resumedKeys.add(childKey);
      // Clear abortedLastRun flag in session store
      result.recovered++;
    } else {
      // Flag stays true for next restart retry
      result.failed++;
    }
  }

  return result;
}

/**
 * Schedule orphan recovery with delay + exponential backoff retry.
 * Delay gives the gateway time to finish bootstrapping after restart.
 */
function scheduleOrphanRecovery(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  delayMs?: number;
}) {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const resumedKeys = new Set<string>();

  const attempt = (n: number, delay: number) => {
    setTimeout(async () => {
      const result = await recoverOrphanedSubagentSessions({
        ...params, resumedSessionKeys: resumedKeys,
      });
      if (result.failed > 0 && n < MAX_RECOVERY_RETRIES) {
        attempt(n + 1, delay * RETRY_BACKOFF_MULTIPLIER);
      }
    }, delay);
  };

  attempt(0, initialDelay);
}

// --- Usage Example ---

/*
// At spawn time:
registerSubagentRun({
  runId: "run-123",
  childSessionKey: "agent:coding:subagent:abc",
  requesterSessionKey: "agent:coding:main",
  task: "Fix the auth bug in login.ts",
  cleanup: "delete",
});

// When subagent completes:
completeSubagentRun({
  runId: "run-123",
  outcome: { status: "ok" },
  reason: "complete",
});

// Announce result to requester:
const delivery = await runSubagentAnnounceDispatch({
  expectsCompletionMessage: true,
  queue: async () => "queued",    // try to steer into active session
  direct: async () => ({          // send direct message
    delivered: true, path: "direct",
  }),
});
// delivery.phases shows which path succeeded

// After gateway restart:
scheduleOrphanRecovery({
  getActiveRuns: () => subagentRuns,
  delayMs: 5_000,
});
*/
