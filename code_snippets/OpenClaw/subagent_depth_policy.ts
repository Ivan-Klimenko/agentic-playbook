/**
 * Sub-Agent Depth-Aware Capability Resolution
 *
 * Pattern: 3-role model (main/orchestrator/leaf) with control scope and
 * persistent capability storage for sub-agent sessions.
 * From: OpenClaw src/agents/subagent-capabilities.ts, src/agents/subagent-depth.ts
 *
 * Key ideas:
 * - 3 roles: main (depth 0), orchestrator (0 < depth < max), leaf (depth >= max)
 * - Control scope: "children" (can spawn/manage) vs "none" (leaf, no spawning)
 * - Capabilities resolved from depth OR loaded from persisted session store
 * - Persisted roles survive restarts — store overrides computed role
 * - Depth resolution walks the spawnedBy chain for inherited depth
 * - Always-denied + leaf-denied tool lists remain (see tool_policy_pipeline.ts)
 */

// --- Roles & Control Scope ---

const SUBAGENT_SESSION_ROLES = ["main", "orchestrator", "leaf"] as const;
type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];

const SUBAGENT_CONTROL_SCOPES = ["children", "none"] as const;
type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

const DEFAULT_MAX_SPAWN_DEPTH = 2;

// --- Capability Bundle ---

interface SubagentCapabilities {
  depth: number;
  role: SubagentSessionRole;
  controlScope: SubagentControlScope;
  canSpawn: boolean;           // main or orchestrator
  canControlChildren: boolean; // controlScope === "children"
}

// --- Pure resolution from depth ---

/** Map depth to role. depth=0 is main, depth<max is orchestrator, else leaf. */
function resolveSubagentRoleForDepth(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentSessionRole {
  const depth = Math.max(0, Math.floor(params.depth));
  const maxSpawnDepth = Math.max(1, Math.floor(params.maxSpawnDepth ?? DEFAULT_MAX_SPAWN_DEPTH));

  if (depth <= 0) return "main";
  return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}

/** Leaf agents get "none" scope — they cannot spawn or manage children. */
function resolveSubagentControlScopeForRole(role: SubagentSessionRole): SubagentControlScope {
  return role === "leaf" ? "none" : "children";
}

/** Compute full capability bundle from depth alone. */
function resolveSubagentCapabilities(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentCapabilities {
  const role = resolveSubagentRoleForDepth(params);
  const controlScope = resolveSubagentControlScopeForRole(role);
  return {
    depth: Math.max(0, Math.floor(params.depth)),
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

// --- Persistent capability resolution ---

/**
 * Session store entries may have persisted role and control scope from
 * a prior run. This allows capabilities to survive gateway restarts.
 */
interface SessionCapabilityEntry {
  sessionId?: string;
  spawnDepth?: number;
  spawnedBy?: string;            // parent session key (for chain walk)
  subagentRole?: string;         // persisted role override
  subagentControlScope?: string; // persisted scope override
}

/**
 * Resolve capabilities with store fallback.
 *
 * Priority:
 *   1. Stored role/scope from session store (survives restarts)
 *   2. Computed from depth (fresh spawn or missing store data)
 *
 * Why persist? After a gateway reload, the in-memory depth chain is lost.
 * The store preserves the role so the sub-agent doesn't accidentally get
 * elevated capabilities.
 */
function resolveStoredSubagentCapabilities(
  sessionKey: string,
  store: Record<string, SessionCapabilityEntry>,
  maxSpawnDepth: number,
): SubagentCapabilities {
  // Walk spawnedBy chain to resolve depth from store
  const depth = getSubagentDepthFromStore(sessionKey, store);

  // Compute baseline from depth
  const fallback = resolveSubagentCapabilities({ depth, maxSpawnDepth });

  // Check for persisted overrides
  const entry = store[sessionKey];
  const storedRole = normalizeRole(entry?.subagentRole);
  const storedControlScope = normalizeControlScope(entry?.subagentControlScope);

  const role = storedRole ?? fallback.role;
  const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);

  return {
    depth,
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

// --- Depth chain walk ---

/**
 * Resolve depth by walking the spawnedBy chain in the session store.
 * Handles cycles via visited set. Falls back to key-based heuristic
 * (counting ":subagent:" segments) when store data is incomplete.
 */
function getSubagentDepthFromStore(
  sessionKey: string,
  store: Record<string, SessionCapabilityEntry>,
): number {
  const visited = new Set<string>();

  const walk = (key: string): number | undefined => {
    if (visited.has(key)) return undefined; // cycle guard
    visited.add(key);

    const entry = store[key];
    if (typeof entry?.spawnDepth === "number" && entry.spawnDepth >= 0) {
      return entry.spawnDepth;
    }

    // Walk up the parent chain
    const parentKey = entry?.spawnedBy?.trim();
    if (!parentKey) return undefined;

    const parentDepth = walk(parentKey);
    if (parentDepth !== undefined) return parentDepth + 1;

    // Fallback: infer from parent key structure
    return getSubagentDepthFromKey(parentKey) + 1;
  };

  return walk(sessionKey) ?? getSubagentDepthFromKey(sessionKey);
}

/** Heuristic: count ":subagent:" segments in session key to infer depth. */
function getSubagentDepthFromKey(sessionKey: string): number {
  return (sessionKey.match(/:subagent:/g) || []).length;
}

// --- Helpers ---

function normalizeRole(value: unknown): SubagentSessionRole | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return SUBAGENT_SESSION_ROLES.find((r) => r === trimmed);
}

function normalizeControlScope(value: unknown): SubagentControlScope | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return SUBAGENT_CONTROL_SCOPES.find((s) => s === trimmed);
}

// --- Usage example ---

/*
// Fresh spawn at depth 1:
const caps = resolveSubagentCapabilities({ depth: 1, maxSpawnDepth: 3 });
// caps = { depth: 1, role: "orchestrator", controlScope: "children",
//          canSpawn: true, canControlChildren: true }

// Leaf at max depth:
const leaf = resolveSubagentCapabilities({ depth: 3, maxSpawnDepth: 3 });
// leaf = { depth: 3, role: "leaf", controlScope: "none",
//          canSpawn: false, canControlChildren: false }

// After gateway restart, resolve from persisted store:
const store = {
  "agent:coding:subagent:abc": {
    spawnDepth: 1,
    subagentRole: "orchestrator",
    subagentControlScope: "children",
  },
};
const restored = resolveStoredSubagentCapabilities(
  "agent:coding:subagent:abc", store, 3,
);
// restored.role === "orchestrator" (from store, not recomputed)
*/
