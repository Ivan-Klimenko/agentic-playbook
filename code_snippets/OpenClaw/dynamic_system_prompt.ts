/**
 * Dynamic System Prompt Assembly with Conditional Sections
 *
 * Pattern: Build system prompts from conditional sections that activate
 * based on runtime state — available tools, agent mode, channel capabilities.
 * From: OpenClaw src/agents/system-prompt.ts
 *
 * Key ideas:
 *   - 3 prompt modes: full (main agent), minimal (sub-agents), none (leaf agents)
 *   - Sections only emitted when relevant (e.g., memory section only if memory tools available)
 *   - Tool summaries extracted dynamically from tool objects
 *   - Canonical tool ordering to prevent positional bias
 *   - Skill discovery with token budget caps
 */

// ─── Types ─────────────────────────────────────────────────────────────────

type PromptMode = "full" | "minimal" | "none";

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface AgentTool {
  name: string;
  description?: string;
  label?: string;
}

interface SkillEntry {
  name: string;
  description: string;
  location: string;
  disableModelInvocation?: boolean;
}

interface RuntimeInfo {
  model: string;
  os: string;
  shell: string;
  repoRoot?: string;
}

interface SystemPromptParams {
  mode: PromptMode;
  agentId: string;
  tools: AgentTool[];
  skills?: SkillEntry[];
  workspaceDir?: string;
  sandboxInfo?: string;
  runtime: RuntimeInfo;
  thinkLevel: ThinkLevel;
  citationsMode?: "on" | "off";
  channelCapabilities?: string[];
}

// ─── Tool Summaries (Dynamic Extraction) ───────────────────────────────────

/**
 * Extract tool descriptions at runtime from tool objects.
 * This means descriptions update automatically when plugins change —
 * no hardcoded prompt maintenance needed.
 */
function buildToolSummaryMap(tools: AgentTool[]): Record<string, string> {
  const summaries: Record<string, string> = {};
  for (const tool of tools) {
    const summary = tool.description?.trim() || tool.label?.trim();
    if (summary) {
      summaries[tool.name.toLowerCase()] = summary;
    }
  }
  return summaries;
}

// ─── Tool Ordering (Canonical + Alphabetical Extras) ───────────────────────

/**
 * Canonical order for core tools. Listed first to prevent positional bias
 * (LLMs favor tools listed earlier). Plugin/extra tools sorted alphabetically after.
 */
const CORE_TOOL_ORDER = [
  "read", "write", "edit", "exec",
  "web_search", "web_fetch",
  "memory_search", "memory_get",
  "sessions_spawn", "sessions_send",
];

function orderToolNames(toolNames: string[]): string[] {
  const nameSet = new Set(toolNames.map((n) => n.toLowerCase()));
  const ordered: string[] = [];

  // Core tools first, in canonical order
  for (const core of CORE_TOOL_ORDER) {
    if (nameSet.has(core)) {
      ordered.push(core);
      nameSet.delete(core);
    }
  }

  // Extra tools alphabetically
  const extras = [...nameSet].sort();
  ordered.push(...extras);

  return ordered;
}

// ─── Skill Budget ──────────────────────────────────────────────────────────

const MAX_SKILLS_IN_PROMPT = 150;
const MAX_SKILLS_PROMPT_CHARS = 30_000;

interface SkillBudgetResult {
  skills: SkillEntry[];
  truncated: boolean;
}

function applySkillBudget(skills: SkillEntry[]): SkillBudgetResult {
  // Filter out CLI-only skills
  const eligible = skills.filter((s) => !s.disableModelInvocation);

  let totalChars = 0;
  const included: SkillEntry[] = [];

  for (const skill of eligible) {
    if (included.length >= MAX_SKILLS_IN_PROMPT) break;
    const entryChars = skill.name.length + skill.description.length + skill.location.length + 10;
    if (totalChars + entryChars > MAX_SKILLS_PROMPT_CHARS) break;
    totalChars += entryChars;
    included.push(skill);
  }

  return {
    skills: included,
    truncated: included.length < eligible.length,
  };
}

/**
 * Compact home directory paths to save tokens.
 * ~5-6 tokens per skill × 150 skills = 750-900 tokens saved.
 */
function compactPath(path: string, homeDir: string): string {
  if (path.startsWith(homeDir + "/")) {
    return "~" + path.slice(homeDir.length);
  }
  return path;
}

// ─── Section Builders ──────────────────────────────────────────────────────

function buildToolsSection(
  tools: AgentTool[],
  summaries: Record<string, string>,
): string[] {
  if (tools.length === 0) return [];

  const ordered = orderToolNames(tools.map((t) => t.name));
  const lines = ["## Tools"];

  for (const name of ordered) {
    const desc = summaries[name];
    if (desc) {
      lines.push(`- \`${name}\`: ${desc}`);
    } else {
      lines.push(`- \`${name}\``);
    }
  }

  lines.push("");
  return lines;
}

function buildSkillsSection(
  skills: SkillEntry[] | undefined,
  isMinimal: boolean,
  homeDir: string,
): string[] {
  // Sub-agents (minimal mode) don't get skills
  if (isMinimal || !skills?.length) return [];

  const { skills: budgeted, truncated } = applySkillBudget(skills);
  if (budgeted.length === 0) return [];

  const lines = [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> descriptions.",
    "If exactly one skill clearly applies: read its SKILL.md, then follow it.",
    "If zero or multiple skills match: proceed without skills.",
    "",
    "<available_skills>",
  ];

  for (const skill of budgeted) {
    const loc = compactPath(skill.location, homeDir);
    lines.push(`- ${skill.name}: ${skill.description} [${loc}]`);
  }

  if (truncated) {
    lines.push(`(${skills!.length - budgeted.length} more skills not shown — use search if needed)`);
  }

  lines.push("</available_skills>", "");
  return lines;
}

function buildMemorySection(
  availableTools: Set<string>,
  isMinimal: boolean,
  citationsMode?: "on" | "off",
): string[] {
  // Only include if memory tools are actually available (passed policy pipeline)
  if (isMinimal) return [];
  if (!availableTools.has("memory_search") && !availableTools.has("memory_get")) {
    return [];
  }

  const lines = [
    "## Memory Recall",
    "Before answering about prior work, decisions, preferences, or todos:",
    "run memory_search on MEMORY.md + memory/*.md; then memory_get for needed lines.",
  ];

  if (citationsMode === "off") {
    lines.push("Citations disabled: do not mention file paths in replies.");
  } else {
    lines.push("Citations: include Source: <path#line> when helpful.");
  }

  lines.push("");
  return lines;
}

function buildWorkspaceSection(
  workspaceDir: string | undefined,
  sanitize: (v: string) => string,
): string[] {
  if (!workspaceDir) return [];
  return [
    "## Workspace",
    `Directory: ${sanitize(workspaceDir)}`,
    "",
  ];
}

function buildSandboxSection(sandboxInfo: string | undefined): string[] {
  if (!sandboxInfo) return [];
  return [
    "## Sandbox",
    sandboxInfo,
    "",
  ];
}

function buildRuntimeSection(
  runtime: RuntimeInfo,
  thinkLevel: ThinkLevel,
): string[] {
  const parts = [
    `Model: ${runtime.model}`,
    `OS: ${runtime.os}`,
    `Shell: ${runtime.shell}`,
  ];
  if (runtime.repoRoot) {
    parts.push(`Repo: ${runtime.repoRoot}`);
  }

  return [
    "## Runtime",
    parts.join(" | "),
    `Reasoning: ${thinkLevel}`,
    "",
  ];
}

// ─── Main Builder ──────────────────────────────────────────────────────────

/**
 * Build a system prompt with conditional sections based on runtime state.
 *
 * - "full" mode: all sections (main agent)
 * - "minimal" mode: identity + tools + runtime only (sub-agents)
 * - "none" mode: bare identity only (leaf agents)
 */
export function buildAgentSystemPrompt(params: SystemPromptParams): string {
  const { mode, agentId, tools } = params;

  // "none" mode — bare minimum for leaf agents
  if (mode === "none") {
    return `You are agent "${agentId}". Follow the task instructions precisely.`;
  }

  const isMinimal = mode === "minimal";
  const toolSet = new Set(tools.map((t) => t.name.toLowerCase()));
  const summaries = buildToolSummaryMap(tools);

  // Sanitize values injected into the prompt
  const sanitize = (v: string) => v.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "");
  const homeDir = process.env.HOME ?? "/home/user";

  const sections: string[][] = [
    // Identity (always)
    [`# Agent: ${sanitize(agentId)}`, ""],

    // Tools (always, but filtered by policy)
    buildToolsSection(tools, summaries),

    // Skills (full mode only, within token budget)
    buildSkillsSection(params.skills, isMinimal, homeDir),

    // Memory (only if memory tools available)
    buildMemorySection(toolSet, isMinimal, params.citationsMode),

    // Workspace (if configured)
    buildWorkspaceSection(params.workspaceDir, sanitize),

    // Sandbox (if sandboxed)
    buildSandboxSection(params.sandboxInfo),

    // Runtime (always in full/minimal)
    buildRuntimeSection(params.runtime, params.thinkLevel),
  ];

  return sections
    .filter((section) => section.length > 0)
    .map((section) => section.join("\n"))
    .join("\n");
}

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// Main agent — full prompt with all sections
const mainPrompt = buildAgentSystemPrompt({
  mode: "full",
  agentId: "general-assistant",
  tools: [
    { name: "read", description: "Read file contents" },
    { name: "write", description: "Create or overwrite files" },
    { name: "exec", description: "Run shell commands" },
    { name: "memory_search", description: "Search memory files" },
    { name: "memory_get", description: "Get memory lines" },
    { name: "my_plugin_tool", description: "Custom plugin capability" },
  ],
  skills: [
    { name: "github", description: "GitHub operations", location: "/home/user/.openclaw/skills/github" },
    { name: "jira", description: "Jira ticket management", location: "/home/user/.openclaw/skills/jira" },
  ],
  workspaceDir: "/home/user/projects/myapp",
  runtime: { model: "claude-opus-4-6", os: "linux", shell: "zsh", repoRoot: "/home/user/projects/myapp" },
  thinkLevel: "high",
  citationsMode: "on",
});
// → Includes: identity, tools (canonical order), skills, memory, workspace, runtime

// Sub-agent — minimal prompt (no skills, no memory instructions)
const subPrompt = buildAgentSystemPrompt({
  mode: "minimal",
  agentId: "coding-helper",
  tools: [
    { name: "read", description: "Read file contents" },
    { name: "write", description: "Create or overwrite files" },
    { name: "exec", description: "Run shell commands" },
  ],
  runtime: { model: "claude-opus-4-6", os: "linux", shell: "zsh" },
  thinkLevel: "medium",
});
// → Includes: identity, tools, runtime (no skills, no memory, no workspace)

// Leaf agent — bare identity only
const leafPrompt = buildAgentSystemPrompt({
  mode: "none",
  agentId: "formatter",
  tools: [],
  runtime: { model: "claude-haiku-4-5", os: "linux", shell: "bash" },
  thinkLevel: "off",
});
// → 'You are agent "formatter". Follow the task instructions precisely.'
*/
