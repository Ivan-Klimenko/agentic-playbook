/**
 * Sub-Agent Depth-Aware Tool Restrictions
 *
 * Pattern: Restrict sub-agent capabilities based on spawn depth.
 * From: OpenClaw src/agents/pi-tools.policy.ts, subagent-spawn.ts
 *
 * Key ideas:
 * - Always-denied tools for ALL sub-agents (system admin, memory, direct sends)
 * - Additional denials for leaf sub-agents (spawning, session management)
 * - Max spawn depth and max children per agent
 * - Cross-agent spawning requires explicit allowlist
 */

// --- Constants ---

const DEFAULT_MAX_SPAWN_DEPTH = 2;
const DEFAULT_MAX_CHILDREN_PER_AGENT = 5;

/**
 * Tools always denied for sub-agents regardless of depth.
 * These are system-level or interactive tools that sub-agents should never use.
 */
const SUBAGENT_DENY_ALWAYS = [
  // System admin
  "gateway",
  "agents_list",
  // Interactive setup
  "whatsapp_login",
  // Status/scheduling — main agent coordinates these
  "session_status",
  "cron",
  // Memory — pass relevant info in spawn prompt instead
  "memory_search",
  "memory_get",
  // Direct session sends — sub-agents communicate through announce chain
  "sessions_send",
];

/**
 * Additional tools denied for leaf sub-agents (depth >= maxSpawnDepth).
 * Leaf agents can't orchestrate, so they don't need spawn/session tools.
 */
const SUBAGENT_DENY_LEAF = [
  "sessions_list",
  "sessions_history",
  "sessions_spawn",
];

// --- Types ---

interface SubagentConfig {
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
  allowAgents?: string[]; // Cross-agent spawn allowlist
}

interface ToolPolicy {
  allow?: string[];
  deny: string[];
}

interface SpawnValidation {
  allowed: boolean;
  reason?: string;
}

// --- Depth-aware deny list ---

function resolveSubagentDenyList(depth: number, maxSpawnDepth: number): string[] {
  const isLeaf = depth >= Math.max(1, Math.floor(maxSpawnDepth));

  if (isLeaf) {
    // Leaf agent: deny system tools + orchestration tools
    return [...SUBAGENT_DENY_ALWAYS, ...SUBAGENT_DENY_LEAF];
  }

  // Orchestrator sub-agent: only deny system tools
  // sessions_spawn, sessions_list, sessions_history remain allowed
  return [...SUBAGENT_DENY_ALWAYS];
}

function resolveSubagentToolPolicy(
  config: SubagentConfig,
  depth: number,
  explicitAllow?: string[],
): ToolPolicy {
  const baseDeny = resolveSubagentDenyList(depth, config.maxSpawnDepth);

  // Explicit allow overrides can remove items from deny list
  const allowSet = new Set((explicitAllow ?? []).map((t) => t.toLowerCase()));
  const effectiveDeny = baseDeny.filter((tool) => !allowSet.has(tool.toLowerCase()));

  return { deny: effectiveDeny };
}

// --- Spawn validation ---

function validateSpawn(params: {
  callerDepth: number;
  activeChildren: number;
  callerAgentId: string;
  targetAgentId: string;
  config: SubagentConfig;
}): SpawnValidation {
  const { callerDepth, activeChildren, callerAgentId, targetAgentId, config } = params;

  // Check depth limit
  if (callerDepth >= config.maxSpawnDepth) {
    return {
      allowed: false,
      reason:
        `Spawn denied: current depth ${callerDepth} >= max ${config.maxSpawnDepth}`,
    };
  }

  // Check children limit
  if (activeChildren >= config.maxChildrenPerAgent) {
    return {
      allowed: false,
      reason:
        `Spawn denied: ${activeChildren}/${config.maxChildrenPerAgent} active children`,
    };
  }

  // Check cross-agent allowlist
  if (targetAgentId !== callerAgentId) {
    const allowAgents = config.allowAgents ?? [];
    const allowAny = allowAgents.includes("*");
    const allowSet = new Set(allowAgents.map((a) => a.toLowerCase()));

    if (!allowAny && !allowSet.has(targetAgentId.toLowerCase())) {
      return {
        allowed: false,
        reason:
          `Cross-agent spawn denied: "${targetAgentId}" not in allowAgents ` +
          `(allowed: ${allowAgents.join(", ") || "none"})`,
      };
    }
  }

  return { allowed: true };
}

// --- Sub-agent session key ---

function buildSubagentSessionKey(
  targetAgentId: string,
): string {
  const uuid = crypto.randomUUID();
  return `agent:${targetAgentId}:subagent:${uuid}`;
}

// --- Context message for sub-agent ---

function buildSubagentContextMessage(params: {
  task: string;
  childDepth: number;
  maxSpawnDepth: number;
  isPersistent: boolean;
}): string {
  const lines = [
    `[Subagent Context] You are running as a subagent ` +
      `(depth ${params.childDepth}/${params.maxSpawnDepth}). ` +
      `Results auto-announce to your requester; do not busy-poll for status.`,
  ];

  if (params.isPersistent) {
    lines.push(
      "[Subagent Context] This subagent session is persistent " +
        "and remains available for thread follow-up messages.",
    );
  }

  lines.push(`[Subagent Task]: ${params.task}`);

  return lines.join("\n\n");
}

// --- Usage example ---

/*
const config: SubagentConfig = {
  maxSpawnDepth: 3,
  maxChildrenPerAgent: 5,
  allowAgents: ["coding-agent", "research-agent"],
};

// Main agent (depth 0) spawns orchestrator sub-agent
const validation = validateSpawn({
  callerDepth: 0,
  activeChildren: 1,
  callerAgentId: "main",
  targetAgentId: "coding-agent",
  config,
});
// validation.allowed === true

// Get tool policy for the child (depth 1, orchestrator)
const orchestratorPolicy = resolveSubagentToolPolicy(config, 1);
// orchestratorPolicy.deny = SUBAGENT_DENY_ALWAYS (can still spawn)

// Orchestrator sub-agent spawns leaf (depth 2)
const leafPolicy = resolveSubagentToolPolicy(config, 2);
// leafPolicy.deny = SUBAGENT_DENY_ALWAYS + SUBAGENT_DENY_LEAF (can't spawn)

// Depth 3 spawn attempt from leaf → blocked
const blocked = validateSpawn({
  callerDepth: 3,
  activeChildren: 0,
  callerAgentId: "coding-agent",
  targetAgentId: "coding-agent",
  config,
});
// blocked.allowed === false, blocked.reason = "depth 3 >= max 3"
*/
