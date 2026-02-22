/**
 * Auth Profile Failover with Cooldown
 *
 * Pattern: Maintain ordered auth profiles, rotate on failure, track cooldowns.
 * From: OpenClaw src/agents/pi-embedded-runner/run.ts
 *
 * Key ideas:
 * - Max retries scale with profile count: base + N * profiles
 * - Failed profiles enter cooldown (prevent hammering broken provider)
 * - Profiles in cooldown are skipped during rotation
 * - On success, the winning profile is remembered for next run
 */

// --- Types ---

interface AuthProfile {
  id: string;
  provider: string; // "anthropic" | "openai" | ...
  apiKey: string;
  cooldownUntil?: number; // timestamp ms
}

interface AuthStore {
  profiles: AuthProfile[];
  lastUsedProfileId?: string;
  failures: Map<string, { count: number; lastAt: number; reason: string }>;
}

interface RunResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
}

// --- Cooldown logic ---

const COOLDOWN_MS = 60_000; // 1 minute cooldown after failure

function isProfileInCooldown(store: AuthStore, profile: AuthProfile): boolean {
  const failure = store.failures.get(profile.id);
  if (!failure) return false;
  return Date.now() < failure.lastAt + COOLDOWN_MS;
}

function markProfileFailure(
  store: AuthStore,
  profileId: string,
  reason: "timeout" | "auth_error" | "rate_limit" | "unknown",
): void {
  const existing = store.failures.get(profileId) ?? { count: 0, lastAt: 0, reason: "" };
  store.failures.set(profileId, {
    count: existing.count + 1,
    lastAt: Date.now(),
    reason,
  });
}

// --- Retry iteration limit ---

function resolveMaxRetryIterations(profileCount: number): number {
  const BASE = 24;
  const PER_PROFILE = 8;
  return BASE + PER_PROFILE * Math.max(1, profileCount);
}

// --- Profile advancement ---

function advanceAuthProfile(
  store: AuthStore,
  candidates: AuthProfile[],
  currentIndex: number,
): { profile: AuthProfile; index: number } | null {
  let nextIndex = currentIndex + 1;

  while (nextIndex < candidates.length) {
    const candidate = candidates[nextIndex];
    if (!candidate || isProfileInCooldown(store, candidate)) {
      nextIndex += 1;
      continue;
    }
    return { profile: candidate, index: nextIndex };
  }

  return null; // No more profiles available
}

// --- Main retry loop ---

async function runAgentWithFailover(params: {
  store: AuthStore;
  profiles: AuthProfile[];
  runAttempt: (profile: AuthProfile) => Promise<RunResult>;
}): Promise<RunResult> {
  const { store, profiles, runAttempt } = params;
  const maxIterations = resolveMaxRetryIterations(profiles.length);

  let profileIndex = 0;
  let currentProfile = profiles[0];
  if (!currentProfile) throw new Error("No auth profiles configured");

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    try {
      const result = await runAttempt(currentProfile);
      // Success: remember this profile
      store.lastUsedProfileId = currentProfile.id;
      return result;
    } catch (error) {
      const reason = classifyError(error);

      if (reason === "auth_error" || reason === "rate_limit" || reason === "timeout") {
        // Mark failure and try next profile
        markProfileFailure(store, currentProfile.id, reason);

        const next = advanceAuthProfile(store, profiles, profileIndex);
        if (next) {
          currentProfile = next.profile;
          profileIndex = next.index;
          continue; // Retry with new profile
        }
      }

      // No more profiles or non-retryable error
      throw error;
    }
  }

  throw new Error(`Exceeded retry limit after ${maxIterations} attempts`);
}

// --- Error classification ---

function classifyError(error: unknown): "auth_error" | "rate_limit" | "timeout" | "unknown" {
  const message = error instanceof Error ? error.message : String(error);

  if (/401|403|invalid.*key|unauthorized/i.test(message)) return "auth_error";
  if (/429|rate.?limit|too many requests/i.test(message)) return "rate_limit";
  if (/timeout|ETIMEDOUT|ECONNABORTED/i.test(message)) return "timeout";

  return "unknown";
}

// --- Usage example ---

/*
const store: AuthStore = {
  profiles: [
    { id: "primary", provider: "anthropic", apiKey: "sk-ant-..." },
    { id: "backup",  provider: "anthropic", apiKey: "sk-ant-..." },
    { id: "openai",  provider: "openai",    apiKey: "sk-..." },
  ],
  failures: new Map(),
};

const result = await runAgentWithFailover({
  store,
  profiles: store.profiles,
  runAttempt: async (profile) => {
    return await callLLM({ apiKey: profile.apiKey, messages: [...] });
  },
});
*/
