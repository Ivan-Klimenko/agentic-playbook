/**
 * Pluggable Context Engine Abstraction
 *
 * Pattern: Interface + registry for swappable context management strategies.
 * From: OpenClaw src/context-engine/types.ts, src/context-engine/registry.ts
 *
 * Key ideas:
 * - ContextEngine interface defines a full lifecycle: bootstrap, ingest, assemble, compact, dispose
 * - Engines own how context is stored and retrieved; runtime owns transcript I/O
 * - Registry is process-global (Symbol.for) so duplicated bundles share state
 * - Two registration paths: core (trusted, can refresh) vs public SDK (unprivileged)
 * - Resolution: config slot override -> default engine id
 * - Legacy compat proxy: auto-strips unrecognized params (sessionKey, prompt)
 *   when older engine plugins reject them, learned per-method and cached
 * - CompactResult carries token counts for before/after so caller can track savings
 * - Subagent lifecycle hooks: prepareSubagentSpawn (with rollback) + onSubagentEnded
 * - Transcript rewrite: engines request rewrites via runtimeContext callback,
 *   keeping engine logic decoupled from session DAG implementation
 */

// --- Result Types ---

/** Assembled context ready for the LLM prompt. */
type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  /** Extra instructions prepended to system prompt by the engine. */
  systemPromptAddition?: string;
};

/** Outcome of a compaction operation. */
type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
};

type IngestResult = { ingested: boolean };
type IngestBatchResult = { ingestedCount: number };
type BootstrapResult = { bootstrapped: boolean; importedMessages?: number; reason?: string };

type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string;
  /** True when the engine manages its own compaction lifecycle
   * (the runtime should not auto-compact independently). */
  ownsCompaction?: boolean;
};

type SubagentSpawnPreparation = {
  /** Rollback pre-spawn setup when subagent launch fails. */
  rollback: () => void | Promise<void>;
};

type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

// Simplified stand-in for actual message type
type AgentMessage = Record<string, unknown>;

// --- Transcript Rewrite (Engine -> Runtime boundary) ---

/**
 * Engines decide what to rewrite; the runtime owns how the session DAG is
 * updated on disk. This callback-based boundary prevents engines from
 * depending on internal session storage formats.
 */
type TranscriptRewriteRequest = {
  replacements: Array<{ entryId: string; message: AgentMessage }>;
};

type TranscriptRewriteResult = {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
};

type ContextEngineRuntimeContext = Record<string, unknown> & {
  rewriteTranscriptEntries?: (req: TranscriptRewriteRequest) => Promise<TranscriptRewriteResult>;
};

// --- ContextEngine Interface ---

interface ContextEngine {
  readonly info: ContextEngineInfo;

  /** Initialize engine for a session, optionally importing history. */
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  /** Run transcript maintenance after turns or compaction. */
  maintain?(params: {
    sessionId: string;
    sessionFile: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<TranscriptRewriteResult>;

  /** Ingest a single message. */
  ingest(params: { sessionId: string; message: AgentMessage; isHeartbeat?: boolean }): Promise<IngestResult>;

  /** Ingest a completed turn batch as a single unit. */
  ingestBatch?(params: { sessionId: string; messages: AgentMessage[]; isHeartbeat?: boolean }): Promise<IngestBatchResult>;

  /** Post-turn lifecycle work (persist canonical context, trigger compaction). */
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;

  /** Assemble model context under a token budget. */
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult>;

  /** Compact context to reduce token usage. */
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<CompactResult>;

  /** Prepare context-engine-managed state before subagent spawn. */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  /** Notify engine that a subagent lifecycle ended. */
  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;

  /** Dispose of resources held by the engine. */
  dispose?(): Promise<void>;
}

// --- Registry (Process-Global Singleton) ---

type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;
type RegistrationResult = { ok: true } | { ok: false; existingOwner: string };

/**
 * Process-global registry using Symbol.for so duplicated dist chunks
 * (different bundler outputs) still share one registry map at runtime.
 */
const REGISTRY_KEY = Symbol.for("app.contextEngineRegistry");
type RegistryState = { engines: Map<string, { factory: ContextEngineFactory; owner: string }> };

function getRegistry(): RegistryState {
  const g = globalThis as any;
  if (!g[REGISTRY_KEY]) g[REGISTRY_KEY] = { engines: new Map() };
  return g[REGISTRY_KEY];
}

const CORE_OWNER = "core";
const PUBLIC_OWNER = "public-sdk";

/**
 * Trusted registration path. Core can refresh its own registrations.
 * Rejects attempts to claim core-owned IDs from non-core owners.
 */
function registerContextEngineForOwner(
  id: string,
  factory: ContextEngineFactory,
  owner: string,
  opts?: { allowSameOwnerRefresh?: boolean },
): RegistrationResult {
  const registry = getRegistry().engines;
  const existing = registry.get(id);

  // Protect core-owned IDs
  if (id === "legacy" && owner !== CORE_OWNER) {
    return { ok: false, existingOwner: CORE_OWNER };
  }
  if (existing && existing.owner !== owner) {
    return { ok: false, existingOwner: existing.owner };
  }
  if (existing && !opts?.allowSameOwnerRefresh) {
    return { ok: false, existingOwner: existing.owner };
  }

  registry.set(id, { factory, owner });
  return { ok: true };
}

/** Public SDK entry point — unprivileged, cannot claim core IDs. */
function registerContextEngine(id: string, factory: ContextEngineFactory): RegistrationResult {
  return registerContextEngineForOwner(id, factory, PUBLIC_OWNER);
}

function getContextEngineFactory(id: string): ContextEngineFactory | undefined {
  return getRegistry().engines.get(id)?.factory;
}

function listContextEngineIds(): string[] {
  return [...getRegistry().engines.keys()];
}

// --- Resolution ---

/**
 * Resolve which ContextEngine to use.
 *
 * Resolution order:
 *   1. config.plugins.slots.contextEngine (explicit slot override)
 *   2. Default engine id ("legacy")
 *
 * The resolved engine is wrapped in a legacy-compat proxy that auto-strips
 * unrecognized params when older plugins reject them.
 */
async function resolveContextEngine(config?: { plugins?: { slots?: { contextEngine?: string } } }): Promise<ContextEngine> {
  const engineId = config?.plugins?.slots?.contextEngine?.trim() || "legacy";
  const entry = getRegistry().engines.get(engineId);

  if (!entry) {
    throw new Error(
      `Context engine "${engineId}" not registered. Available: ${listContextEngineIds().join(", ") || "(none)"}`,
    );
  }

  return await entry.factory();
}

// --- Usage Example ---

/*
// Plugin registers a custom context engine:
registerContextEngine("vector-rag", () => new VectorRAGContextEngine());

// Core registers the default:
registerContextEngineForOwner("legacy", () => new LegacyContextEngine(), "core", {
  allowSameOwnerRefresh: true,
});

// Runtime resolves and uses:
const engine = await resolveContextEngine(config);

// Assemble context for a turn:
const { messages, estimatedTokens } = await engine.assemble({
  sessionId, messages: rawMessages, tokenBudget: 200_000,
});

// After turn, let engine do post-processing:
await engine.afterTurn?.({ sessionId, sessionFile, messages, prePromptMessageCount: 10 });

// Overflow recovery compaction:
const result = await engine.compact({ sessionId, sessionFile, tokenBudget: 200_000, force: true });
if (result.compacted) console.log(`Compacted: ${result.result?.tokensBefore} -> ${result.result?.tokensAfter} tokens`);
*/
