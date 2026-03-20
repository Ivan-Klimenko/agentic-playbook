# Claude Code — Inspection

> **Repository**: [anthropics/claude-code](https://github.com/anthropics/claude-code)
> **Language**: TypeScript (core, closed-source), Python (hooks), Markdown (agents/commands/skills)
> **Framework**: Custom agentic CLI runtime with plugin system
> **Inspected**: 2026-03-21
> **Scope**: Public repository — plugin ecosystem, hook system, settings, agent definitions, marketplace. Core runtime is closed-source; this inspection covers the extensibility architecture and the agentic patterns visible in public artifacts.

---

## 1. Architecture & Agent Topology

### Topology: Hub-and-spoke with hierarchical sub-agent delegation

Claude Code follows a **single primary agent** topology with a rich **sub-agent spawning** mechanism. The main agent (the Claude Code CLI session) can spawn specialized sub-agents via the `Agent` / `Task` tool. Sub-agents are defined as **markdown files** with frontmatter specifying model, tools, color, and triggering conditions.

### Agent hierarchy

```
Claude Code Session (primary agent — Opus/Sonnet)
├── Plugin Agents (autonomous, trigger on pattern match)
│   ├── code-explorer (sonnet, yellow) — traces codebase
│   ├── code-architect (sonnet) — designs approaches
│   ├── code-reviewer (opus, green) — reviews with confidence scoring
│   ├── comment-analyzer, silent-failure-hunter, type-design-analyzer ...
│   └── conversation-analyzer — detects problematic patterns
├── Command-driven workflows (user-initiated via /slash)
│   ├── /feature-dev → 7-phase structured workflow → spawns 6+ agents
│   ├── /code-review → multi-stage parallel agent review pipeline
│   ├── /review-pr → 6 specialized reviewer agents
│   └── /dedupe → 5 parallel search agents + filter agent
└── Hook scripts (Python/Bash, event-driven, non-agent)
    ├── PreToolUse → validation before tool execution
    ├── PostToolUse → post-action checks
    ├── Stop → completion verification
    └── SessionStart/UserPromptSubmit → context/prompt interception
```

### Instantiation & composition

Agents are **markdown-defined, not code-defined**. Each agent is a `.md` file with:
- **Frontmatter**: `name`, `description` (with triggering examples), `model`, `tools`, `color`
- **Body**: System prompt — instructions for the agent's behavior

```yaml
---
name: code-explorer
description: Use this agent when [conditions]...
tools: Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch
model: sonnet
color: yellow
---
You are an expert code analyst...
```

Key architectural properties:
- **Agent = system prompt + tool set + model choice** — no code, pure configuration
- **Agents are stateless** — fresh per invocation, no persistent state across turns
- **Sub-agents cannot spawn further sub-agents** (1 level deep by design, via `Agent` tool)
- **Agent frontmatter supports**: `maxTurns`, `disallowedTools`, `effort` for fine-grained control

### Communication

- **Parent → child**: Prompt string passed via `Agent` tool invocation
- **Child → parent**: Single return message with full results
- **No shared state**: Sub-agents get a fresh context, no access to parent conversation
- **No message passing between siblings**: Parallel agents are fully isolated

### Delegation logic

Two delegation modes:
1. **Command-driven** (explicit): User invokes `/feature-dev`, command orchestrates agent launches
2. **Agent auto-trigger** (implicit): The `description` field in agent frontmatter teaches Claude when to launch the agent. Must include `<example>` blocks showing triggering conditions.

---

## 2. Thinking & Reasoning

### No explicit think step

Claude Code relies on the underlying model's native reasoning capabilities (chain-of-thought in Opus/Sonnet). There is:
- **No dedicated think tool** (unlike some agentic frameworks)
- **No separate "planning thinking" vs "execution thinking"** distinction
- **No reasoning trace storage** — thinking is inline in the conversation

### Extended thinking

The system leverages model-native extended thinking (Claude's built-in). The `effort` frontmatter in skills/commands can control reasoning depth:
```yaml
---
effort: high  # Override model effort level
---
```

### Tool selection reasoning

Tool selection is entirely LLM-driven. The system prompt provides detailed guidance on when to use which tool:
- "Do NOT use the Bash to run commands when a relevant dedicated tool is provided"
- "For simple, directed codebase searches use Glob or Grep directly"
- "For broader codebase exploration, use the Agent tool with subagent_type=Explore"

### Post-execution reflection

No formal reflection step. The agent loop naturally reflects after each tool result. Quality assurance is achieved via:
- **Stop hooks** that block stopping if conditions aren't met (e.g., "tests must run")
- **Multi-agent validation** — review agents validate each other's findings (code-review plugin)

---

## 3. Planning & Execution

### Planning approach: Structured command workflows, not dynamic plans

Claude Code does not have a dynamic planning/re-planning system. Instead, planning is embedded in:

1. **Command definitions** — multi-phase structured workflows baked into markdown
2. **TodoWrite tool** — lightweight task tracking within a session

### Phase-based workflows (commands as plans)

The `/feature-dev` command is the canonical example — a 7-phase structured plan:

| Phase | Goal | Agent launches |
|-------|------|---------------|
| 1. Discovery | Understand requirements | None (clarifying questions) |
| 2. Exploration | Map codebase | 2-3 parallel code-explorer agents |
| 3. Clarifying Qs | Resolve ambiguities | None (HITL gate) |
| 4. Architecture | Design approaches | 2-3 parallel code-architect agents |
| 5. Implementation | Build feature | None (main agent executes) |
| 6. Quality Review | Validate code | 3 parallel code-reviewer agents |
| 7. Summary | Document results | None |

Key properties:
- **Plan is static** — defined in the command markdown, not dynamically generated
- **HITL gates** between phases: "DO NOT START WITHOUT USER APPROVAL"
- **Parallel agent launches** at exploration and review phases
- **No re-planning** — the phase structure is fixed, agent results feed forward

### The code-review pipeline — a multi-stage plan with validation

The `/code-review` command implements a more sophisticated execution plan:

```
Stage 1: Guard check (haiku) → skip if draft/closed/already-reviewed
Stage 2: Context gathering (haiku) → find CLAUDE.md files
Stage 3: Summarize changes (sonnet)
Stage 4: 4 parallel review agents (2x sonnet CLAUDE.md + 2x opus bugs)
Stage 5: Validation agents — per-issue (opus for bugs, sonnet for CLAUDE.md)
Stage 6: Filter → only issues validated with high confidence
Stage 7: Output or post inline comments
```

This is a **plan with confidence-based filtering** — issues pass through multiple validation stages before surfacing.

### Plan tracking

Via `TodoWrite` tool — a lightweight task list within the session. Not persistent across sessions.

---

## 4. Context Management

### Context splitting

- **Main agent**: Full conversation context with user messages, tool results, system prompts
- **Sub-agents**: Start fresh — only see the prompt passed to them, no parent context
- **Complete isolation**: Sub-agents cannot read parent conversation history

### Context injection patterns

1. **System prompt injection**: CLAUDE.md files (project, user, global) are automatically loaded as system reminders
2. **Plugin context**: Skills load progressively — metadata always available, full SKILL.md on trigger, references on demand
3. **Command arguments**: `$ARGUMENTS` substituted in command markdown at invocation time
4. **Dynamic context**: Commands can include bash backticks that execute and inject results

### Token budget strategy

- **1M context window** for Opus 4.6
- **Auto-compaction**: System automatically compresses prior messages as context limits approach
- **Circuit breaker**: Max 3 compaction attempts before stopping
- **Sub-agent isolation**: Sub-agents work in bounded context — prevents parent window pollution

### Tool result injection

Tool results are injected directly into conversation context. Large results may be:
- Truncated by the tool itself (e.g., Read tool defaults to 2000 lines)
- Compressed during auto-compaction
- Offloaded to transcript files (hooks can read `transcript_path`)

### Long-running flow handling

- **Auto-compaction** — prior messages compressed transparently
- **Session resume** — `/resume` can restore from crashed sessions with parallel tool result restoration
- **Worktrees** — `isolation: "worktree"` gives agents their own git working copy

---

## 5. Tool System

### Tool definition & registration

Tools are provided to Claude Code at multiple levels:

1. **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep, Agent, TaskCreate/Update/Get/List, WebFetch, WebSearch, NotebookEdit, etc.
2. **MCP tools**: External tools via Model Context Protocol servers (defined in `.mcp.json`)
3. **Plugin-contributed tools**: Via MCP servers bundled with plugins
4. **Deferred tools**: Tools registered but only loaded on-demand via `ToolSearch` (lazy loading for token efficiency)

### Tool selection

Entirely LLM-driven with extensive system prompt guidance:
- Tool preference hierarchy (dedicated tools > Bash for same operation)
- Parallel tool calls encouraged for independent operations
- Model told to "maximize use of parallel tool calls where possible"

### Tool-level permission gating

Sophisticated three-tier permission model:

```json
{
  "permissions": {
    "allow": ["Read", "Glob", "Grep"],
    "ask": ["Bash"],
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

- **allow**: Auto-approved
- **ask**: Requires user confirmation
- **deny**: Blocked entirely (tool hidden from agent)
- **Pattern-based**: `Bash(git checkout:*)` allows only specific bash commands

### Parallel execution

Encouraged at the prompt level:
- "If you intend to call multiple tools and there are no dependencies, make all independent calls in parallel"
- Agent tool supports concurrent sub-agent launches
- Commands explicitly orchestrate parallel agent launches (e.g., "Launch 4 agents in parallel")

### Tool sandbox

```json
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": false,
    "network": {
      "allowUnixSockets": [],
      "allowLocalBinding": false,
      "allowedDomains": []
    }
  }
}
```

Network isolation, command allowlists, and nested sandbox controls.

### Meta-tools

- `Agent` — spawn sub-agents (the key delegation tool)
- `TaskCreate/Update/Get/List` — task tracking within session
- `Skill` — invoke registered skills
- `ToolSearch` — lazy-load deferred tool schemas
- `EnterPlanMode/ExitPlanMode` — switch to planning mode
- `EnterWorktree/ExitWorktree` — git worktree isolation

---

## 6. Flow Control & Error Handling

### Core loop

The core agent loop is closed-source, but behavioral properties are visible:
- Standard agentic loop: receive message → reason → call tools → observe results → repeat
- Terminates when agent produces a text response without tool calls
- Can be intercepted by hooks at multiple points

### Iteration limits

- `maxTurns` frontmatter on agents/skills — limits sub-agent execution depth
- System-level iteration limits (not publicly documented)
- Cost/token tracking visible in statusline (rate limits displayed)

### Termination

- Agent decides it's "done" by producing a text-only response
- **Stop hooks** can block termination — force the agent to continue
- **Completion promises** (ralph-wiggum plugin): Agent can only output a specific string when task is truly complete

### Failure handling

- **Hook errors**: Always fail-safe — hooks exit 0 even on error, never block operations
- **Import errors in hooks**: Gracefully caught, operation allowed to proceed
- **API errors**: `StopFailure` hook fires on API errors
- **Auto-recovery**: Sessions can resume after crashes via `/resume`

### Human-in-the-loop

Multiple HITL patterns:
1. **Permission gates**: `ask` permission level requires user approval per tool call
2. **Command-level gates**: "DO NOT START WITHOUT USER APPROVAL" in command definitions
3. **Phase gates**: Commands pause between phases for user input
4. **Clarification**: Agent can ask user questions naturally (no dedicated tool needed)
5. **Hook-level HITL**: Hooks can return `permissionDecision: "ask"` to prompt user

### Cost tracking

Token usage and rate limits displayed in statusline. No hard budget enforcement visible.

---

## 7. User Interruption & Interference

### Interrupt primitive

- **AbortSignal-based**: Sub-agents receive abort signals on cancellation
- **Per-tool granularity**: Individual tool calls can be cancelled
- **Worktree cleanup**: Abandoned worktrees auto-cleaned on session recovery

### Permission-as-data

Three-state permission model: `allow` / `deny` / `ask`
- Per-tool configuration in settings
- Pattern-based rules: `Bash(git push:*)` for fine-grained control
- Managed settings override user settings for organizational enforcement

### Cancellation propagation

- Cancel signal terminates current tool execution
- Sub-agents are torn down (worktree cleanup if applicable)
- Hook-based operations always complete (10-second timeout)

### Message steering

New user messages can be injected between tool calls. The system handles:
- Pending message queue at tool boundaries
- Context compaction if needed before processing new input

### Dangling tool call recovery

- `/resume` restores sessions with "parallel tool result restoration"
- Auto-compaction handles incomplete tool results during compression

---

## 8. State & Persistence

### State schema

No formal state schema — state is the conversation message history. Key state carriers:

1. **Conversation messages**: The primary state — user messages, assistant messages, tool results
2. **TodoWrite**: In-session task tracking (ephemeral)
3. **Memory system**: File-based persistent memory at `~/.claude/projects/<path>/memory/`
4. **CLAUDE.md files**: Project-level persistent instructions (3 tiers: global, user, project)
5. **Settings**: Permission and configuration state (managed, user, project levels)

### Memory tiers

| Tier | Scope | Persistence | Example |
|------|-------|-------------|---------|
| Conversation | Current session | Until compaction | Message history |
| TodoWrite | Current session | Ephemeral | Task tracking |
| Memory files | Cross-session | Permanent | User preferences, project context |
| CLAUDE.md | Cross-session | Permanent | Project instructions |
| Settings | Cross-session | Permanent | Permissions, hooks, MCP servers |
| Plugin data | Cross-session | Permanent | `${CLAUDE_PLUGIN_DATA}` directory |

### Memory system

File-based memory with typed categories:
- `user` — role, preferences, knowledge
- `feedback` — behavioral corrections and confirmations
- `project` — ongoing work context
- `reference` — pointers to external resources

Each memory is a markdown file with frontmatter. An index file (`MEMORY.md`) provides quick lookup.

### Settings hierarchy

```
managed-settings.json (org-level, highest priority)
  └── ~/.claude/settings.json (user-level)
       └── .claude/settings.json (project-level)
            └── .claude/settings.local.json (local overrides, gitignored)
```

### Plugin state persistence

Plugins get a dedicated data directory via `${CLAUDE_PLUGIN_DATA}` environment variable. This survives across sessions.

### Session persistence

- Sessions can be named (`/rename`)
- Auto-naming from plan content
- `/resume` restores crashed sessions
- Transcript files available for hooks to read session history

---

## Cross-Cutting Patterns

### Plugin System Architecture

Claude Code's most distinctive architectural feature is its **markdown-as-code plugin system**. Plugins compose four orthogonal primitives:

| Primitive | Trigger | Format | Purpose |
|-----------|---------|--------|---------|
| **Command** | User invokes `/name` | Markdown + frontmatter | Structured workflows |
| **Agent** | Claude detects trigger condition | Markdown + frontmatter | Autonomous subtasks |
| **Skill** | Claude detects relevance | SKILL.md + resources | Domain knowledge |
| **Hook** | System event fires | JSON config + scripts | Event-driven automation |

Discovery is convention-based:
```
plugin-name/
├── .claude-plugin/plugin.json   # Required manifest
├── commands/*.md                # Auto-discovered
├── agents/*.md                  # Auto-discovered
├── skills/*/SKILL.md            # Auto-discovered
├── hooks/hooks.json             # Auto-discovered
└── .mcp.json                    # Auto-discovered
```

### Hook System — Event-Driven Agent Control

The hook system provides **event-driven interception** of the agent loop without modifying the core runtime:

**Hook events**: PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, PostCompact, StopFailure, Notification, Elicitation, ElicitationResult

**Hook types**:
1. **Command hooks**: Execute bash/Python scripts, communicate via stdin/stdout JSON
2. **Prompt hooks**: LLM-evaluated — Claude itself decides whether to approve/deny

**Hook I/O protocol**:
```
Claude Code → stdin (JSON) → Hook Script → stdout (JSON) → Claude Code
                                         → stderr → User display
                                         → exit code: 0=ok, 1=show stderr to user, 2=block+show to Claude
```

**Response format** varies by event:
- PreToolUse: `{ hookSpecificOutput: { permissionDecision: "allow|deny|ask" }, systemMessage: "..." }`
- Stop: `{ decision: "block", reason: "..." }`
- Others: `{ systemMessage: "..." }`

### Multi-Agent Review Pattern

A recurring pattern across plugins is **parallel multi-agent review with confidence filtering**:

```
1. Launch N agents in parallel (different focus areas)
2. Each agent returns findings with confidence scores
3. Launch validation agents per finding
4. Filter: only findings ≥ threshold (e.g., 80) survive
5. Post or report filtered findings
```

This pattern appears in:
- `/code-review` — 4 parallel reviewers + per-issue validators
- `/review-pr` — 6 specialized agents
- `/feature-dev` — 3 parallel code-reviewers in quality phase

### Declarative Rule Engine (Hookify)

The hookify plugin implements a **declarative rule engine** for agent behavior control:

Rules are markdown files (`.claude/hookify.*.local.md`) with YAML frontmatter:
```yaml
---
name: block-rm-rf
enabled: true
event: bash
action: block
conditions:
  - field: command, operator: regex_match, pattern: "rm\\s+-rf"
---
⚠️ Dangerous rm command detected!
```

Key design decisions:
- **Hot-reloadable**: Rules loaded from disk on every hook invocation (no restart needed)
- **Fail-safe**: All hooks exit 0 even on error
- **Composable conditions**: Multiple conditions with AND logic
- **Action hierarchy**: `block` > `warn` — blocking takes priority
- **Cached regexes**: LRU cache (max 128) for compiled patterns
- **Transcript access**: Stop rules can read full session transcript for retrospective checks

---

## Gaps & Observations

1. **No dynamic planning**: Plans are static command definitions. No plan generation, revision, or re-planning based on results. This is a deliberate simplicity choice.

2. **No cross-agent communication**: Parallel agents cannot share findings. Each returns independently to the parent, which must synthesize.

3. **No formal state machine**: The agent loop is implicit (LLM decides when to stop). State transitions are managed by conversation flow, not an explicit graph.

4. **No cost ceiling enforcement**: Token/cost tracking is informational only — no hard limits visible.

5. **No tool result summarization**: Tool results injected verbatim (up to tool-specific limits). No intermediate summarization layer.

6. **Clever use of markdown as code**: The entire plugin system — agents, commands, skills — is markdown. This makes the system accessible to non-developers and LLM-native (Claude can read and write plugins naturally).

7. **Three-state permission model is elegant**: `allow/ask/deny` with pattern-based rules provides fine-grained control without complexity. Managed settings hierarchy enables organizational enforcement.

8. **Stop hooks as quality gates**: Using Stop hooks to prevent the agent from finishing until quality criteria are met (tests run, build passes) is a powerful pattern for enforcing workflow discipline.

9. **Confidence-based filtering in code review**: The multi-stage validation pipeline (find issues → validate each → filter by confidence) effectively reduces false positives, which is the key challenge in automated code review.
