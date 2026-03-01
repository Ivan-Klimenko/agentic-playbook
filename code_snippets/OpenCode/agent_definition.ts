/**
 * OpenCode Agent Definition Pattern
 *
 * Agents are named configs — not classes. The runtime interprets
 * them to assemble prompts, select tools, and enforce permissions.
 *
 * Source: packages/opencode/src/agent/agent.ts
 */

import z from "zod"

// --- Permission Ruleset ---
// Three-state: allow | deny | ask
// Pattern-matched with wildcard support, last-match-wins

const Action = z.enum(["allow", "deny", "ask"])
const Rule = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: Action,
})
const Ruleset = Rule.array()

// --- Agent Schema ---

const AgentInfo = z.object({
  name: z.string(),
  description: z.string().optional(),
  mode: z.enum(["subagent", "primary", "all"]),
  native: z.boolean().optional(),
  hidden: z.boolean().optional(),
  topP: z.number().optional(),
  temperature: z.number().optional(),
  color: z.string().optional(),
  permission: Ruleset,
  model: z
    .object({
      modelID: z.string(),
      providerID: z.string(),
    })
    .optional(),
  variant: z.string().optional(),
  prompt: z.string().optional(),
  options: z.record(z.string(), z.any()),
  steps: z.number().int().positive().optional(),
})

// --- Permission Merging ---
// Hierarchy: defaults < agent-specific < user config
// Later rules override earlier ones (last-match-wins)

function merge(...rulesets: z.infer<typeof Ruleset>[]) {
  return rulesets.flat()
}

function fromConfig(config: Record<string, any>): z.infer<typeof Ruleset> {
  const rules: z.infer<typeof Ruleset> = []
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      rules.push({ permission, pattern: "*", action: value as any })
    }
    if (typeof value === "object") {
      for (const [pattern, action] of Object.entries(value as Record<string, string>)) {
        rules.push({ permission, pattern, action: action as any })
      }
    }
  }
  return rules
}

function evaluate(permission: string, pattern: string, ruleset: z.infer<typeof Ruleset>) {
  let result = { action: "ask" as const }
  for (const rule of ruleset) {
    if (wildcardMatch(rule.permission, permission) && wildcardMatch(rule.pattern, pattern)) {
      result = rule
    }
  }
  return result
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  return pattern === value // simplified — real impl uses glob matching
}

// --- Built-in Agent Definitions ---

const defaults = fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask" },
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask" },
})

const agents: Record<string, z.infer<typeof AgentInfo>> = {
  // Default full-access agent
  build: {
    name: "build",
    description: "The default agent. Executes tools based on configured permissions.",
    options: {},
    permission: merge(defaults, fromConfig({ question: "allow", plan_enter: "allow" })),
    mode: "primary",
    native: true,
  },

  // Read-only planning agent
  plan: {
    name: "plan",
    description: "Plan mode. Disallows all edit tools.",
    options: {},
    permission: merge(
      defaults,
      fromConfig({
        question: "allow",
        plan_exit: "allow",
        edit: { "*": "deny", ".opencode/plans/*.md": "allow" },
      }),
    ),
    mode: "primary",
    native: true,
  },

  // Background parallel task execution
  general: {
    name: "general",
    description: "General-purpose agent for multi-step tasks. Parallel execution.",
    permission: merge(defaults, fromConfig({ todoread: "deny", todowrite: "deny" })),
    options: {},
    mode: "subagent",
    native: true,
  },

  // Read-only codebase explorer
  explore: {
    name: "explore",
    permission: merge(
      defaults,
      fromConfig({
        "*": "deny",
        grep: "allow",
        glob: "allow",
        bash: "allow",
        read: "allow",
        webfetch: "allow",
        websearch: "allow",
        codesearch: "allow",
      }),
    ),
    description: "Fast agent for exploring codebases. Read-only search tools only.",
    prompt: "You are a file search specialist...", // loaded from .txt
    options: {},
    mode: "subagent",
    native: true,
  },

  // Summarizes conversation when context overflows (hidden, no tools)
  compaction: {
    name: "compaction",
    mode: "primary",
    native: true,
    hidden: true,
    prompt: "Provide a detailed summary for continuing this conversation...",
    permission: merge(defaults, fromConfig({ "*": "deny" })),
    options: {},
  },

  // Generates session titles (hidden, low temperature)
  title: {
    name: "title",
    mode: "primary",
    native: true,
    hidden: true,
    temperature: 0.5,
    permission: merge(defaults, fromConfig({ "*": "deny" })),
    prompt: "Generate a short title (≤50 chars)...",
    options: {},
  },
}

// --- Custom Agent Loading from Markdown ---
// File: .opencode/agents/my-agent.md
//
// ---
// mode: subagent
// temperature: 0.7
// model: openai/gpt-4o
// permission:
//   bash: deny
//   edit: { "*.test.ts": allow, "*": deny }
// ---
// You are a code reviewer. Focus on test quality...
//
// Frontmatter → agent config. Body → system prompt.
// Unknown properties → options. Full parity with built-ins.
