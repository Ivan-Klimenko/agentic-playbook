/**
 * Claude Code — Plugin System Architecture
 *
 * Claude Code's plugin system uses markdown-as-code for defining agents,
 * commands, and skills. Four orthogonal primitives compose into rich
 * workflows. This snippet documents the schemas and composition patterns.
 *
 * Source: plugins/plugin-dev/skills/plugin-structure/references/manifest-reference.md,
 *         plugins/feature-dev/, plugins/code-review/, plugins/hookify/
 */

// --- Plugin Manifest (.claude-plugin/plugin.json) ---
// The only required file. Convention-based discovery handles the rest.

```json
{
  "name": "my-plugin",              // Required. kebab-case, unique.
  "version": "1.0.0",               // Semver.
  "description": "What it does",    // 50-200 chars, active voice.
  "author": { "name": "...", "email": "..." },
  "commands": "./commands",          // Supplements default dirs, doesn't replace.
  "agents": "./agents",
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./.mcp.json"
}
```

// --- Command Definition (commands/*.md) ---
// User-invoked via /slash. Instructions FOR Claude, not for users.

```markdown
---
description: Brief description for /help display (~60 chars)
allowed-tools: Read, Write, Bash(git:*)    # Constrain tool access
model: sonnet                               # Override model
argument-hint: [feature-name]               # Usage pattern
effort: high                                # Override reasoning effort
---

# Instructions for Claude

Phase 1: Do X with $ARGUMENTS
Phase 2: Launch agents...
Phase 3: Wait for user approval...
```

// --- Agent Definition (agents/*.md) ---
// Autonomous sub-agents triggered by Claude when conditions match.
// Key insight: the `description` field IS the trigger logic.

```markdown
---
name: code-explorer
description: Use this agent when you need to deeply analyze existing code...

<example>
Context: User wants to add a new feature
user: "Add dark mode support"
assistant: "I'll launch a code-explorer agent to trace the theme system"
<commentary>Feature work requires understanding existing patterns</commentary>
</example>

tools: [Glob, Grep, Read, WebFetch]     # Available tools
model: sonnet                            # Can differ from parent
color: yellow                            # Visual indicator in CLI
maxTurns: 20                             # Iteration limit
disallowedTools: [Write, Edit]           # Restrict dangerous tools
---

You are an expert code analyst...
[Full system prompt for the agent]
```

// --- Skill Definition (skills/name/SKILL.md) ---
// Progressive disclosure: metadata always loaded, body on trigger, resources on demand.

```
skills/
  frontend-design/
    SKILL.md           # Core knowledge (<5k words)
    references/        # Detailed docs (loaded as needed)
    scripts/           # Executable code (run without loading to context)
    assets/            # Templates, images (used in output)
```

```markdown
---
name: Frontend Design Guidance
description: This skill should be used when the user asks about UI implementation...
version: 0.1.0
---

## Core Workflow
1. Analyze requirements
2. Reference design system...

## Scripts
Run `scripts/generate-component.sh` for scaffolding.

## References
See references/design-tokens.md for the full token list.
```

// --- Hook Registration (hooks/hooks.json) ---
// Event-driven interception of the agent loop.
// Two types: command (scripts) and prompt (LLM-evaluated).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",              // Regex on tool name
        "hooks": [{
          "type": "command",                   // Execute a script
          "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/validate.py",
          "timeout": 10
        }]
      },
      {
        "matcher": "Bash",
        "hooks": [{
          "type": "prompt",                    // LLM evaluates
          "prompt": "If command contains 'rm -rf', return 'deny'. Otherwise 'approve'."
        }]
      }
    ],
    "Stop": [
      {
        "hooks": [{
          "type": "prompt",
          "prompt": "If code was modified but no tests were run, block stopping."
        }]
      }
    ]
  }
}
```

// --- Composition Example: Feature Development Pipeline ---
// Commands orchestrate multi-phase workflows with agent delegation.

```
/feature-dev "add notifications"
  │
  ├─ Phase 1: Discovery (main agent asks clarifying questions)
  │
  ├─ Phase 2: Exploration
  │   ├── Agent: code-explorer "trace notification patterns" (parallel)
  │   ├── Agent: code-explorer "map event bus architecture" (parallel)
  │   └── Agent: code-explorer "analyze UI notification components" (parallel)
  │
  ├─ Phase 3: Clarifying Questions (HITL gate — wait for user)
  │
  ├─ Phase 4: Architecture Design
  │   ├── Agent: code-architect "minimal approach" (parallel)
  │   ├── Agent: code-architect "clean architecture" (parallel)
  │   └── Agent: code-architect "pragmatic balance" (parallel)
  │   └── Present trade-offs → user chooses
  │
  ├─ Phase 5: Implementation (main agent, after explicit user approval)
  │
  ├─ Phase 6: Quality Review
  │   ├── Agent: code-reviewer "simplicity/DRY" (parallel)
  │   ├── Agent: code-reviewer "bugs/correctness" (parallel)
  │   └── Agent: code-reviewer "conventions" (parallel)
  │
  └─ Phase 7: Summary
```

// --- Composition Example: Code Review with Confidence Filtering ---

```
/code-review PR#123
  │
  ├─ Stage 1: Guard (haiku) — skip if draft/closed/already-reviewed
  ├─ Stage 2: Context (haiku) — find relevant CLAUDE.md files
  ├─ Stage 3: Summary (sonnet) — summarize PR changes
  │
  ├─ Stage 4: Parallel Review
  │   ├── Agent: CLAUDE.md compliance (sonnet) ─┐
  │   ├── Agent: CLAUDE.md compliance (sonnet) ─┤ Redundancy for recall
  │   ├── Agent: Bug detection (opus) ──────────┤
  │   └── Agent: Logic/security (opus) ─────────┘
  │
  ├─ Stage 5: Per-Issue Validation
  │   └── For each finding: launch validator agent → score 0-100
  │
  ├─ Stage 6: Filter (confidence ≥ 80 only)
  │
  └─ Stage 7: Post inline comments with GitHub links
```
