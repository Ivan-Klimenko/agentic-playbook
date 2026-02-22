/**
 * Layered Tool Policy Pipeline
 *
 * Pattern: 7-layer composable tool access control with glob matching.
 * From: OpenClaw src/agents/tool-policy-pipeline.ts, pi-tools.policy.ts
 *
 * Key ideas:
 * - Each layer can independently filter the available toolset
 * - Glob patterns for flexible matching (exec*, sessions_*)
 * - Plugin tools resolved separately from core tools
 * - Unknown allowlist entries warn, don't fail
 */

// --- Types ---

interface AgentTool {
  name: string;
  description: string;
  handler: (input: unknown) => Promise<unknown>;
}

interface ToolPolicy {
  allow?: string[]; // Glob patterns of allowed tools (empty = allow all)
  deny?: string[];  // Glob patterns of denied tools
}

interface PolicyPipelineStep {
  policy?: ToolPolicy;
  label: string; // For logging/debugging
}

interface ToolMeta {
  pluginId?: string; // If set, this is a plugin-provided tool
}

// --- Glob pattern matching ---

function matchesGlob(name: string, pattern: string): boolean {
  // Convert glob to regex: * → .*, ? → .
  const regex = new RegExp(
    "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i",
  );
  return regex.test(name);
}

function matchesAnyPattern(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(name, pattern));
}

// --- Single-layer policy matching ---

function makeToolPolicyMatcher(policy: ToolPolicy): (name: string) => boolean {
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];

  return (name: string) => {
    const normalized = name.toLowerCase().trim();

    // Deny takes priority
    if (matchesAnyPattern(normalized, deny)) {
      return false;
    }

    // If no allow list, everything not denied is allowed
    if (allow.length === 0) {
      return true;
    }

    // Must match at least one allow pattern
    return matchesAnyPattern(normalized, allow);
  };
}

function filterToolsByPolicy(tools: AgentTool[], policy?: ToolPolicy): AgentTool[] {
  if (!policy) return tools;
  const matcher = makeToolPolicyMatcher(policy);
  return tools.filter((tool) => matcher(tool.name));
}

// --- Pipeline construction ---

function buildDefaultPipelineSteps(params: {
  profilePolicy?: ToolPolicy;
  globalPolicy?: ToolPolicy;
  globalProviderPolicy?: ToolPolicy;
  agentPolicy?: ToolPolicy;
  agentProviderPolicy?: ToolPolicy;
  groupPolicy?: ToolPolicy;
  agentId?: string;
}): PolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  return [
    { policy: params.profilePolicy, label: "tools.profile" },
    { policy: params.globalPolicy, label: "tools.allow" },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
    },
    { policy: params.groupPolicy, label: "group tools.allow" },
  ];
}

// --- Pipeline execution ---

function applyToolPolicyPipeline(params: {
  tools: AgentTool[];
  steps: PolicyPipelineStep[];
  toolMeta?: (tool: AgentTool) => ToolMeta | undefined;
  warn?: (message: string) => void;
}): AgentTool[] {
  const warn = params.warn ?? console.warn;
  let filtered = params.tools;

  for (const step of params.steps) {
    if (!step.policy) continue;

    const before = filtered.length;
    filtered = filterToolsByPolicy(filtered, step.policy);
    const after = filtered.length;

    if (before !== after) {
      warn(
        `[tool-policy] ${step.label}: filtered ${before} → ${after} tools ` +
          `(removed: ${before - after})`,
      );
    }
  }

  return filtered;
}

// --- Usage example ---

/*
const allTools: AgentTool[] = [
  { name: "read", description: "Read file", handler: async () => {} },
  { name: "write", description: "Write file", handler: async () => {} },
  { name: "exec", description: "Execute command", handler: async () => {} },
  { name: "sessions_spawn", description: "Spawn sub-agent", handler: async () => {} },
  { name: "sessions_send", description: "Send message", handler: async () => {} },
  { name: "gateway", description: "Admin operations", handler: async () => {} },
];

const steps = buildDefaultPipelineSteps({
  globalPolicy: { deny: ["gateway"] },          // Admin: deny gateway globally
  agentPolicy: { allow: ["read", "write", "exec*"] }, // Agent config: only these
  groupPolicy: { deny: ["exec*"] },             // User group: no shell access
  agentId: "coding-agent",
});

const available = applyToolPolicyPipeline({ tools: allTools, steps });
// Result: [read, write] — exec denied by group, gateway denied globally
*/
