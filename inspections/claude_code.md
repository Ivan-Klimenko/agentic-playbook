# Claude Code — Inspection

> **Repository**: [anthropics/claude-code](https://github.com/anthropics/claude-code)
> **Language**: TypeScript (core, closed-source), Python (hooks), Bash (scripts), Markdown (agents/commands/skills)
> **Framework**: Custom agentic CLI runtime with plugin system
> **Inspected**: 2026-03-24 (reinspection; original 2026-03-21)
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
│   ├── code-architect (sonnet, green) — designs approaches
│   ├── code-reviewer (sonnet/opus, red/green) — reviews with confidence scoring
│   ├── agent-creator (sonnet, magenta) — creates new agent definitions
│   ├── plugin-validator (inherit, yellow) — validates plugin structure
│   ├── skill-reviewer (inherit, cyan) — reviews skill quality
│   ├── agent-sdk-verifier-py/ts (sonnet) — validates SDK apps
│   ├── code-simplifier (opus) — simplifies code while preserving behavior
│   ├── comment-analyzer (inherit, green) — comment accuracy and rot detection
│   ├── pr-test-analyzer (inherit, cyan) — test coverage with criticality ratings
│   ├── silent-failure-hunter (inherit, yellow) — error handling audit
│   ├── type-design-analyzer (inherit, pink) — type invariant analysis
│   └── conversation-analyzer (inherit, yellow) — detects problematic patterns
├── Command-driven workflows (user-initiated via /slash)
│   ├── /feature-dev → 7-phase structured workflow → spawns 6+ agents
│   ├── /code-review → multi-stage parallel agent review pipeline
│   ├── /review-pr → 6 specialized reviewer agents
│   ├── /create-plugin → 8-phase guided creation → spawns 3 agents
│   ├── /new-sdk-app → 5-step setup → spawns verifier agent
│   ├── /hookify → conversation analysis → rule generation
│   ├── /dedupe → 5 parallel search agents + filter agent
│   ├── /ralph-loop → self-referential loop via Stop hook
│   └── /commit, /commit-push-pr, /clean_gone → git workflows
└── Hook scripts (Python/Bash, event-driven, non-agent)
    ├── PreToolUse → validation before tool execution
    ├── PostToolUse → post-action checks
    ├── Stop → completion verification / self-referential loops
    ├── SessionStart → context injection
    ├── UserPromptSubmit → prompt interception
    ├── SubagentStop → multi-agent coordination
    ├── StopFailure → API error handling
    └── PreCompact/PostCompact → compaction hooks
```

### Complete plugin inventory (13 plugins, 20+ agents)

| Plugin | Agents | Commands | Skills | Focus |
|--------|--------|----------|--------|-------|
| feature-dev | 3 (explorer, architect, reviewer) | 1 | 0 | Feature development workflow |
| pr-review-toolkit | 6 (reviewer, simplifier, comment, test, failure, type) | 1 | 0 | Comprehensive PR review |
| plugin-dev | 3 (agent-creator, plugin-validator, skill-reviewer) | 1 | 7 | Plugin development toolkit |
| code-review | 0 (inline via command) | 1 | 0 | PR code review with confidence filtering |
| agent-sdk-dev | 2 (verifier-py, verifier-ts) | 1 | 0 | Agent SDK setup & validation |
| hookify | 1 (conversation-analyzer) | 4 | 1 | Declarative rule engine |
| ralph-wiggum | 0 | 2 | 0 | Self-referential iteration loops |
| commit-commands | 0 | 3 | 0 | Git workflow automation |
| security-guidance | 0 | 0 | 0 | Security warning hooks |
| frontend-design | 0 | 0 | 1 | Frontend design guidance |
| claude-opus-4-5-migration | 0 | 0 | 1 | Model migration guidance |
| learning-output-style | 0 | 0 | 0 | Interactive learning mode (hook) |
| explanatory-output-style | 0 | 0 | 0 | Educational context (hook) |

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

Three effort levels: `low` (○), `medium` (◐), `high` (●) with optional `auto` mode. Opus 4.6 defaults to medium effort for Max/Team subscribers. "Ultrathink" keyword enables one-turn high-effort activation.

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
3. **Plan mode** — `EnterPlanMode`/`ExitPlanMode` tools for structured planning with markdown preview and feedback

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

### The `/create-plugin` pipeline — 8-phase meta-development

The plugin-dev plugin implements an even more elaborate workflow:

```
Phase 1: Discovery (requirements gathering)
Phase 2: Component Planning (identify needed primitives)
Phase 3: Detailed Design (architecture for each component)
Phase 4: Structure Creation (directory layout + manifest)
Phase 5: Implementation (agent-creator generates agents)
Phase 6: Validation (plugin-validator checks structure)
Phase 7: Testing (skill-reviewer reviews skills)
Phase 8: Documentation (README generation)
```

### The code-review pipeline — multi-stage plan with validation

The `/code-review` command implements the most sophisticated execution plan:

```
Stage 1: Guard check (haiku) → skip if draft/closed/already-reviewed
Stage 2: Context gathering (haiku) → find CLAUDE.md files
Stage 3: Summarize changes (sonnet)
Stage 4: 4 parallel review agents (2x sonnet CLAUDE.md + 2x opus bugs)
Stage 5: Validation agents — per-issue (opus for bugs, sonnet for CLAUDE.md)
Stage 6: Filter → only issues validated with high confidence
Stage 7: Output or post inline comments with `confirmed: true`
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
5. **SessionStart hooks**: Inject additional context at session start (e.g., learning-output-style injects 1500+ chars of educational framing)

### Token budget strategy

- **1M context window** for Opus 4.6
- **Auto-compaction**: System automatically compresses prior messages as context limits approach
- **Circuit breaker**: Max 3 compaction attempts before stopping
- **PreCompact/PostCompact hooks**: Plugins can intervene before/after compaction
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
- **Worktree sparse-checkout** — for large monorepos, selective checkout reduces disk usage

---

## 5. Tool System

### Tool definition & registration

Tools are provided to Claude Code at multiple levels:

1. **Built-in tools**: Read, Write, Edit, MultiEdit, Bash, Glob, Grep, Agent, TaskCreate/Update/Get/List/Stop, WebFetch, WebSearch, NotebookEdit, CronCreate/Delete/List, RemoteTrigger, etc.
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
- **Command-level**: `allowed-tools` in command frontmatter restricts tool access per workflow

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
    "allowUnsandboxedCommands": false,
    "network": {
      "allowUnixSockets": [],
      "allowAllUnixSockets": false,
      "allowLocalBinding": false,
      "allowedDomains": []
    },
    "enableWeakerNestedSandbox": false
  }
}
```

Network isolation, command allowlists, and nested sandbox controls.

### Meta-tools

- `Agent` — spawn sub-agents (the key delegation tool)
- `TaskCreate/Update/Get/List/Stop` — task tracking within session
- `Skill` — invoke registered skills
- `ToolSearch` — lazy-load deferred tool schemas
- `EnterPlanMode/ExitPlanMode` — switch to planning mode with structured feedback
- `EnterWorktree/ExitWorktree` — git worktree isolation
- `SendMessage` — communicate with and resume previously spawned agents
- `CronCreate/Delete/List` — schedule recurring tasks within sessions
- `RemoteTrigger` — schedule remote agent execution on cron

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
- Ralph Wiggum's `--max-iterations` for self-referential loops

### Termination

- Agent decides it's "done" by producing a text-only response
- **Stop hooks** can block termination — force the agent to continue
- **Completion promises** (ralph-wiggum plugin): Agent can only output a specific string when task is truly complete
- **SubagentStop hooks**: Can block sub-agent termination

### Failure handling

- **Hook errors**: Always fail-safe — hooks exit 0 even on error, never block operations
- **Import errors in hooks**: Gracefully caught, operation allowed to proceed
- **API errors**: `StopFailure` hook fires on API errors (rate limit, auth failure)
- **Auto-recovery**: Sessions can resume after crashes via `/resume`
- **Memory leaks**: Fixed issues with React Compiler cache, REPL scopes, teammate history in long sessions
- **OAuth**: Fixed token refresh race condition across concurrent sessions

### Human-in-the-loop

Multiple HITL patterns:
1. **Permission gates**: `ask` permission level requires user approval per tool call
2. **Command-level gates**: "DO NOT START WITHOUT USER APPROVAL" in command definitions
3. **Phase gates**: Commands pause between phases for user input
4. **Clarification**: Agent can ask user questions naturally (no dedicated tool needed)
5. **Hook-level HITL**: Hooks can return `permissionDecision: "ask"` to prompt user
6. **Elicitation**: MCP interactive input dialogs via `Elicitation`/`ElicitationResult` hooks

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
- `disableBypassPermissionsMode: "disable"` prevents users from overriding

### Cancellation propagation

- Cancel signal terminates current tool execution
- Sub-agents are torn down (worktree cleanup if applicable)
- Hook-based operations always complete (10-second timeout)
- Ralph Wiggum loop can be cancelled via `/cancel-ralph` (deletes state file)

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
6. **Ralph loop state**: `.claude/ralph-loop.local.md` with YAML frontmatter tracking iteration count

### Memory tiers

| Tier | Scope | Persistence | Example |
|------|-------|-------------|---------|
| Conversation | Current session | Until compaction | Message history |
| TodoWrite | Current session | Ephemeral | Task tracking |
| Memory files | Cross-session | Permanent | User preferences, project context |
| CLAUDE.md | Cross-session | Permanent | Project instructions |
| Settings | Cross-session | Permanent | Permissions, hooks, MCP servers |
| Plugin data | Cross-session | Permanent | `${CLAUDE_PLUGIN_DATA}` directory |
| Hookify rules | Cross-session | Permanent | `.claude/hookify.*.local.md` |

### Memory system

File-based memory with typed categories:
- `user` — role, preferences, knowledge
- `feedback` — behavioral corrections and confirmations
- `project` — ongoing work context
- `reference` — pointers to external resources

Each memory is a markdown file with frontmatter. An index file (`MEMORY.md`) provides quick lookup. Memory content is verified against current state before acting on it.

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
- Transcript files available for hooks to read session history (JSONL format)

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
├── skills/*/SKILL.md            # Auto-discovered (progressive disclosure)
│   ├── references/              # Loaded on demand
│   ├── scripts/                 # Run without loading to context
│   └── assets/                  # Templates, images
├── hooks/hooks.json             # Auto-discovered
└── .mcp.json                    # Auto-discovered
```

### Hook System — Event-Driven Agent Control

The hook system provides **event-driven interception** of the agent loop without modifying the core runtime:

**Hook events (13 types)**:

| Event | When | Can Block | Can Modify |
|-------|------|-----------|------------|
| PreToolUse | Before tool execution | Yes (exit 2 or `deny`) | Yes (updatedInput) |
| PostToolUse | After tool execution | Yes (exit 2) | No |
| Stop | Session exit attempt | Yes (`decision: "block"`) | Yes (reason field) |
| SubagentStop | Subagent stops | Yes | No |
| SessionStart | New session begins | No | Yes (additionalContext) |
| SessionEnd | Session ends | No | No |
| UserPromptSubmit | Prompt submission | Yes (`deny`) | No |
| StopFailure | API error on turn end | No | No |
| PreCompact | Before compaction | No | No |
| PostCompact | After compaction | No | No |
| Elicitation | MCP interactive dialog | Yes | No |
| ElicitationResult | Elicitation response | No | No |
| Notification | Various notifications | No | No |

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
- SessionStart: `{ hookSpecificOutput: { additionalContext: "..." } }`
- Others: `{ systemMessage: "..." }`

### Self-Referential Loop Pattern (Ralph Wiggum)

A novel flow control pattern using Stop hooks to create iterative loops without external infrastructure:

```
1. User runs: /ralph-loop "Build a REST API" --completion-promise "DONE" --max-iterations 20
2. Setup script creates .claude/ralph-loop.local.md with YAML frontmatter:
   { active: true, iteration: 1, max_iterations: 20, completion_promise: "DONE" }
3. Claude works on the task
4. Claude tries to stop → Stop hook fires
5. Hook checks:
   a. Max iterations reached? → allow exit
   b. <promise>DONE</promise> in last assistant message (exact match)? → allow exit
   c. Otherwise: block stop, feed SAME prompt back as "reason"
6. Claude sees previous work in modified files → continues from where it left off
7. Iteration counter incremented atomically (temp file + mv)
```

Key design decisions:
- **Literal string comparison** for completion promise (not glob matching, prevents `*` injection)
- **Perl multiline regex** for `<promise>` tag extraction
- **Atomic file updates** with `mv` for POSIX safety
- **Strict numeric validation** with regex `^[0-9]+$` to detect corruption
- **Fail-safe**: corrupted state → cleanup and allow exit (never hang)

### Security Warning Pattern

The security-guidance plugin implements a **session-scoped security reminder system**:

- Pattern-matching against 9 security anti-patterns (command injection, eval, XSS, pickle, etc.)
- **Show-once semantics**: tracks `{file_path}-{rule_name}` keys per session
- **State file**: `~/.claude/security_warnings_state_{session_id}.json`
- **Probabilistic cleanup**: 10% chance per hook run to clean files >30 days old
- **Environment toggle**: `ENABLE_SECURITY_REMINDER=0` disables
- **Blocks on first detection** (exit code 2), allows on subsequent same-file same-rule

### Multi-Agent Review Pattern

A recurring pattern across plugins is **parallel multi-agent review with confidence filtering**:

```
1. Launch N agents in parallel (different focus areas)
2. Each agent returns findings with confidence scores (0-100)
3. Launch validation agents per finding
4. Filter: only findings ≥ threshold (e.g., 80) survive
5. Post or report filtered findings
```

This pattern appears in:
- `/code-review` — 4 parallel reviewers + per-issue validators
- `/review-pr` — 6 specialized agents (comments, tests, errors, types, code, simplify)
- `/feature-dev` — 3 parallel code-reviewers in quality phase
- `/create-plugin` — plugin-validator + skill-reviewer for validation

### Specialty Agent Dimensions

The pr-review-toolkit reveals a mature agent specialization taxonomy:

| Agent | Focus | Scoring | Model |
|-------|-------|---------|-------|
| code-reviewer | CLAUDE.md compliance + general quality | Confidence 0-100, threshold ≥80 | opus |
| pr-test-analyzer | Test coverage quality | Criticality 1-10 | inherit |
| silent-failure-hunter | Error handling audit | Severity CRITICAL/HIGH/MEDIUM | inherit |
| type-design-analyzer | Type design invariants | 4 ratings (encapsulation, invariant expression, usefulness, enforcement) | inherit |
| comment-analyzer | Comment accuracy & rot | Binary (accurate/inaccurate) | inherit |
| code-simplifier | Simplification opportunities | N/A (suggests changes) | opus |

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
- **Fail-safe**: All hooks exit 0 even on error — never blocks operations due to hook bugs
- **Composable conditions**: Multiple conditions with AND logic
- **Action hierarchy**: `block` > `warn` — blocking takes priority over warnings
- **Cached regexes**: LRU cache (max 128) for compiled patterns with `re.IGNORECASE`
- **Transcript access**: Stop rules can read full session transcript for retrospective checks
- **Legacy support**: Simple `pattern` field auto-converted to `conditions` list
- **Custom YAML parser**: No external dependencies — minimal parser handles inline dicts, multi-line items

### Context Injection via SessionStart Hooks

Plugins use SessionStart hooks to inject behavioral framing at the start of every session:
- **learning-output-style**: Injects interactive learning mode — identifies decision points where user should write 5-10 lines of code, combined with educational `★ Insight` blocks
- **explanatory-output-style**: Injects educational framing — explains "why" behind implementation choices

This pattern enables behavior modification without changing the core system prompt.

### Multi-Agent Team Support

Recent additions (from CHANGELOG):
- **Leader-teammate architecture**: Multi-agent teams with leader coordination
- **TeammateIdle/TaskCompleted hooks**: Events for multi-agent coordination with `{"continue": false, "stopReason": "..."}` support
- **SendMessage tool**: Resume previously spawned agents with preserved context
- **Background task execution**: Agents run in background with progress tracking

---

## Gaps & Observations

1. **No dynamic planning**: Plans are static command definitions. No plan generation, revision, or re-planning based on results. This is a deliberate simplicity choice — plans are replaced by well-tested command templates.

2. **No cross-agent communication**: Parallel agents cannot share findings. Each returns independently to the parent, which must synthesize. The new `SendMessage` tool enables sequential agent communication but not peer-to-peer.

3. **No formal state machine**: The agent loop is implicit (LLM decides when to stop). State transitions are managed by conversation flow, not an explicit graph.

4. **No cost ceiling enforcement**: Token/cost tracking is informational only — no hard limits visible except `maxTurns` on sub-agents and `--max-iterations` on Ralph loops.

5. **No tool result summarization**: Tool results injected verbatim (up to tool-specific limits). No intermediate summarization layer.

6. **Clever use of markdown as code**: The entire plugin system — agents, commands, skills — is markdown. This makes the system accessible to non-developers and LLM-native (Claude can read and write plugins naturally).

7. **Three-state permission model is elegant**: `allow/ask/deny` with pattern-based rules provides fine-grained control without complexity. Managed settings hierarchy enables organizational enforcement.

8. **Stop hooks as quality gates**: Using Stop hooks to prevent the agent from finishing until quality criteria are met (tests run, build passes) is a powerful pattern for enforcing workflow discipline.

9. **Confidence-based filtering in code review**: The multi-stage validation pipeline (find issues → validate each → filter by confidence ≥80) effectively reduces false positives, which is the key challenge in automated code review.

10. **Self-referential loops are novel**: The Ralph Wiggum pattern — using Stop hooks to create iterative development loops without external infrastructure — is a creative abuse of the hook system that enables capabilities (persistent iteration, completion promises) not explicitly designed for.

11. **13 hook event types provide comprehensive interception**: The event system covers the full agent lifecycle — from session start through tool execution, compaction, sub-agent management, and error handling. Prompt-type hooks (LLM evaluates) and command-type hooks (scripts execute) cover both flexible and deterministic interception needs.

12. **Progressive skill disclosure is context-efficient**: The three-level skill loading (metadata → SKILL.md → references) keeps token usage minimal until knowledge is actually needed. The plugin-dev plugin demonstrates this fully with 7 skills totaling thousands of words of knowledge, loaded incrementally.
