# Planning & Execution Patterns

How agents decide what to do, track what's done, and keep humans in the loop. A cross-project comparison of planning mechanisms extracted from real agentic codebases.

> **See also:** [Agent Patterns](./AGENT_PATTERNS.md) | [Orchestration Topologies](./ORCHESTRATION_PATTERNS.md) | [Production Patterns](./PRODUCTION_PATTERNS.md) | [Anti-Patterns](./ANTI_PATTERNS.md) | [Infrastructure](./INFRA_PATTERNS.md)

---

## 1. Three Concerns: Planning vs Tracking vs Governance

Planning is not one problem — it's three, and mixing them creates confused abstractions.

| Concern | What it does | Mechanism examples |
|---------|-------------|-------------------|
| **Planning** | Deciding what to do | Plan mode, think tool, LLM reasoning, CLARIFY→PLAN→ACT prompt |
| **Tracking** | Knowing what's been done | Task tools, TODO state, step counters |
| **Governance** | Ensuring human stays in the loop | Plan approval, checkpoints, clarification gates |

A plan node that generates a plan, tracks execution, AND requires approval is doing three jobs poorly. The best implementations (Claude Code, DeerFlow) separate these cleanly — different tools for different concerns.

---

## 2. Planning Approach Taxonomy

Seven approaches observed across inspected projects, ordered from simplest to most structured.

### 2.1 TODO Tools — Planning as Emergent Tool Use

> Source: [deep-agents-from-scratch](../deep-agents-from-scratch/) | See also: [AGENT_PATTERNS §3.1](./AGENT_PATTERNS.md#31-todo-lists-as-context-anchors)

**How it works:**
- `write_todos(items)` — creates/updates TODO list with statuses (pending/in_progress/completed)
- `read_todos()` — reads current list for context
- Planning is emergent: agent decides when to create a plan via tool calls
- One task `in_progress` at a time (serialization)
- Same ReAct loop for everything — no separate planning graph

**Tradeoffs:**
- (+) Planning = tool use. No special graph topology needed
- (+) Re-planning for free — agent can update TODOs at any point
- (+) Step tracking is structured state, not lost in message text
- (+) Agent decides whether to plan (simple tasks skip it naturally)
- (−) Relies on LLM discipline to use TODOs properly (prompt engineering)
- (−) Extra tool calls = extra tokens for simple tasks
- (−) No enforcement — agent can ignore TODOs and freewheel

**Key insight:** TODO tools serve double duty: planning *and* context anchoring. Forcing the LLM to rewrite the full TODO list acts as self-prompting — it recites its objectives at the end of the context, re-anchoring attention.

### 2.2 Task Tools with Dependencies

> Source: [Claude Code](./inspections/claude_code.md)

**How it works:**
- Three tools: `TaskCreate`, `TaskUpdate`, `TaskList`
- Tasks have rich metadata: subject, description, status, owner, dependencies (blockedBy/blocks)
- Status lifecycle: `pending → in_progress → completed` (also `deleted`)
- Dependencies are bidirectional — a task can be blocked by others and block others
- `activeForm` field shown in UI spinner while task is in_progress
- Agent decides when to create tasks — no forced planning phase

**Tradeoffs:**
- (+) Richer than simple TODOs — dependencies, ownership, metadata
- (+) Bidirectional blocking enables complex task graphs
- (+) UI integration (spinner shows active task description)
- (+) Agent-driven — creates tasks when needed, skips for simple questions
- (−) Three tools instead of two — slightly more toolbox overhead
- (−) Dependency tracking adds complexity agent may not always use
- (−) No plan approval step — agent just executes

**Key insight:** Tasks are the *execution tracking* layer, not the planning layer. Planning is a separate concern (see §2.3).

### 2.3 Plan Mode — Plan File + User Approval

> Source: [Claude Code](./inspections/claude_code.md)

**How it works:**
- User or agent enters "plan mode" (`EnterPlanMode`)
- Agent creates a plan as a **markdown file** (not messages, not state)
- Agent is **read-only** during planning — can explore code, search, read, but cannot edit/write/execute
- Plan file is the only writable file during plan mode
- User reviews plan and approves (`ExitPlanMode`) or rejects with feedback
- After approval, agent executes the plan using tasks (§2.2) for progress tracking
- Plan file persists across context compaction

**Tradeoffs:**
- (+) Explicit user checkpoint — user sees the plan before any action
- (+) Plan is a durable artifact (file), not ephemeral messages
- (+) Read-only constraint forces thorough research before committing
- (+) Survives context compaction (it's a file, not conversation state)
- (+) Can use cheaper/faster model for planning, better model for execution
- (−) Requires user interaction — not suitable for fully autonomous agents
- (−) Two-phase workflow adds latency for simple tasks
- (−) Rigid — no mid-execution re-planning without re-entering plan mode

**Key insight:** Plan Mode is a *governance* mechanism, not a planning algorithm. It ensures the human stays in the loop on strategy while the agent handles execution autonomously.

### 2.4 Phased Workflows with Parallel Agents

> Source: [Claude Code plugins](./inspections/claude_code.md) (feature-dev plugin)

**How it works:**
- Pre-defined multi-phase workflow (7 phases for feature development)
- Each phase has explicit entry/exit criteria and user checkpoints
- Phases launch **parallel sub-agents** for different perspectives:
  - Phase 2: 2-3 code-explorer agents explore codebase in parallel
  - Phase 4: 2-3 code-architect agents propose different approaches in parallel
  - Phase 6: 3 code-reviewer agents review from different angles in parallel
- Parent agent synthesizes sub-agent results
- User approves at multiple checkpoints (after exploration, after architecture choice, before implementation, after review)

**Tradeoffs:**
- (+) Structured and predictable — user knows what to expect at each phase
- (+) Parallel agents give diverse perspectives (multiple architectures, multiple review angles)
- (+) User checkpoints at every critical decision
- (+) Each sub-agent has focused context (not the entire conversation)
- (−) Rigid structure — not all tasks need 7 phases
- (−) High token cost — multiple parallel LLM calls per phase
- (−) Over-engineered for simple tasks
- (−) Pre-defined phases don't adapt to task type

**Key insight:** This is a *workflow template*, not a generic planning mechanism. Works great for repeatable complex processes (feature dev, code review), poorly for ad-hoc tasks.

### 2.5 Iterative Self-Improvement Loop

> Source: [Claude Code plugins](./inspections/claude_code.md) (Ralph Wiggum / stop hook pattern) | See also: [stop_hook_quality_gate.md](./code_snippets/claude_code/stop_hook_quality_gate.md), [self_referential_loop.sh](./code_snippets/claude_code/self_referential_loop.sh)

**How it works:**
- Agent receives a task with explicit completion criteria
- Executes, produces artifacts (files, code)
- A hook intercepts the agent's exit and re-invokes it with the **same prompt**
- Agent sees its own previous work (files on disk, git history)
- Iteratively improves until completion criteria are met or max iterations reached
- Completion detected by a specific output string (e.g. "DONE")

**Tradeoffs:**
- (+) Emergent self-improvement without complex orchestration
- (+) Each iteration builds on previous work (file persistence)
- (+) Simple implementation — just a hook + re-invocation
- (+) Works for tasks where quality improves incrementally (TDD, writing, refactoring)
- (−) No structured plan — agent may repeat mistakes or go in circles
- (−) Same prompt every time — no learning/adaptation between iterations
- (−) Token-expensive — full context reload each iteration
- (−) Needs clear completion criteria — vague tasks loop forever

**Key insight:** This is *brute-force iteration*, not planning. Useful as a complementary pattern for "polish until done" tasks, not as a primary planning mechanism.

### 2.6 No Planning — Pure Reactive Agent

> Source: [OpenClaw](./inspections/openclaw.md) | See also: [AGENT_PATTERNS §2.10](./AGENT_PATTERNS.md#210-no-plan-architecture-planning-via-system-prompt)

**How it works:**

No plan node, no TODO tools, no task decomposition middleware. The agent is purely reactive:

- Standard ReAct loop: LLM generates response → tool calls execute → results return → repeat
- LLM decides everything: tool selection, task complexity assessment, when to delegate
- System prompt provides heuristic guidance ("if complex, spawn a subagent") but no structured planning
- All "planning" happens inside the LLM's reasoning (optionally inside `<think>` blocks)

**Subagent orchestration (the only decomposition mechanism):**
- `sessions_spawn()` — fire-and-forget subagent creation
- Push-based completion: child announces result to parent when done (no polling)
- Role hierarchy: main → orchestrator → leaf (depth-based capability gating)

**Context management instead of planning:**
- Auto-compaction when context overflows (summarize old messages)
- Tool call history (30-call sliding window) for loop detection
- Context budgets for bootstrap files (20K per file, 150K total)

**Tradeoffs:**
- (+) Maximum simplicity — one loop, no modes, no config switches
- (+) LLM has full autonomy — no framework-imposed structure
- (+) No wasted tokens on planning for simple tasks
- (+) Thinking blocks (`<think>`) serve as lightweight reflection without tool overhead
- (−) No structured progress tracking — user has no visibility into complex task progress
- (−) Relies entirely on LLM quality — weaker models will flounder
- (−) No task persistence — if session crashes, no TODO list to resume from
- (−) "Planning" is implicit reasoning — not inspectable, not debuggable

**Key insight:** OpenClaw bets that **the LLM IS the planner**. The framework's job is to give it good tools and get out of the way. This works great with frontier models but degrades with weaker ones.

### 2.7 Middleware-Based Planning — Clarify→Plan→Act

> Source: [DeerFlow](./inspections/deer_flow.md) | See also: [prompt_engineering.py](./code_snippets/deer_flow/prompt_engineering.py)

**How it works:**

Planning as a **middleware layer**, not a graph node or tool. Three composable components:

**A. Clarification-first workflow (ClarificationMiddleware):**
- Before any action, agent analyzes request for ambiguity
- If unclear → calls `ask_clarification()` tool, execution **pauses until user responds**
- Five types: missing_info, ambiguous_requirement, approach_choice, risk_confirmation, suggestion
- Hard priority: CLARIFY → PLAN → ACT (enforced in system prompt)

**B. TODO middleware (TodoListMiddleware):**
- Activated per-request via `is_plan_mode: True` in config (not a graph mode — a middleware flag)
- Provides `write_todos` / `read_todos` tools (similar to §2.1)
- Context loss detection: if TODOs scroll out of context window, middleware reminds agent
- Agent updates TODO status in real-time as it works

**C. Parallel subagent decomposition (task tool):**
- Agent can launch up to 3 subagents in parallel via `task()` tool
- For >3 subtasks: automatic multi-batch execution (batch of 3, wait, next batch)
- Subagents inherit sandbox + workspace but get **clean message context** (only task description)
- Subagents can't spawn their own subagents (no recursion)

**Decision flow (from system prompt):**
```
Request → Clarification check → Decomposition check (parallel?) → Planning check (complex?) → Execute
```

**Tradeoffs:**
- (+) Clean separation: clarification, planning, and execution are independent middlewares
- (+) Middleware = composable. Enable/disable per request, not per agent config
- (+) Clarification-first prevents wasted work on misunderstood tasks
- (+) Context loss detection for TODOs recovers from compaction
- (+) Per-request configuration — same agent can plan or not plan depending on the request
- (−) Middleware chain order matters (12 middlewares in strict sequence) — fragile
- (−) `is_plan_mode` is still a binary flag, not agent-driven
- (−) Clarification pauses execution — not suitable for fully async/autonomous agents
- (−) Complex infrastructure — middleware chain, subagent executor, background task management

**Key insight:** DeerFlow treats planning as *request-level configuration* rather than agent-level configuration. The CLARIFY→PLAN→ACT priority in the system prompt is the real orchestration — it's prompt engineering, not code, which makes it portable across implementations.

---

## 3. Comparison Matrix

| Criteria | TODO | Tasks | Plan Mode | Phased | Iterative | No Plan | Middleware |
|----------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Re-planning | ✅ | ✅ | ⚠️ | ❌ | ✅ | ✅ (implicit) | ✅ |
| Step tracking | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Graph simplicity | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Token efficiency | ⚠️ | ⚠️ | ✅ | ❌ | ❌ | ✅ | ⚠️ |
| User approval | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ (clarify) |
| Agent autonomy | ✅ | ✅ | ❌ | ❌ | ✅ | ✅✅ | ⚠️ (flag) |
| Dependencies | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Simple tasks | ✅ | ✅ | ❌ | ❌ | ❌ | ✅✅ | ✅ |
| Parallel exec | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ (subagents) | ✅ |
| Clarification | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Per-request cfg | ❌ | ❌ | ❌ | ❌ | ❌ | n/a | ✅ |
| Weak model safe | ⚠️ | ⚠️ | ✅ | ✅ | ❌ | ❌ | ⚠️ |
| Impl. complexity | Low | Med | Med | High | Low | **None** | High |

---

## 4. Decision Guidance

### Planning infrastructure is a model-quality hedge

The spectrum from "no planning" to "middleware-based planning" maps directly to model capability:

- **Frontier models** (Claude Opus, GPT-4) → No Planning (§2.6) works. The LLM already reasons about task complexity, decomposes naturally, and can spawn subagents when needed. Planning infrastructure is unnecessary overhead.
- **Strong models** (Claude Sonnet, GPT-4o) → TODO tools (§2.1) or Task tools (§2.2) provide enough structure. The model is smart enough to use them well.
- **Mid-tier models** → Middleware-based (§2.7) or Phased (§2.4) approaches compensate for weaker reasoning by providing external structure.

**Implication:** If you only target top-tier models, go minimal. If you need to support weaker models, structured planning compensates for model limitations.

### Claude Code's layered composition

Claude Code doesn't have ONE planning mechanism — it has several that compose:
- **Task tools** (§2.2) for execution tracking (always available)
- **Plan mode** (§2.3) for strategy governance (user-initiated)
- **Phased workflows** (§2.4) for repeatable complex processes (command-initiated)
- **Iterative loops** (§2.5) for polish/refinement (hook-initiated)

The model itself decides which to use based on context. There's no "planning mode" switch — planning emerges from tool availability. This is the strongest evidence that **planning approaches are composable, not mutually exclusive**.

### Clarification before planning

DeerFlow's CLARIFY→PLAN→ACT priority chain (§2.7) is a cross-cutting insight: before planning, verify the request is understood. This prevents the most wasteful failure mode — executing a well-structured plan for the wrong task. The pattern is pure prompt engineering and portable to any implementation.

### When to use what

| Situation | Recommended approach |
|-----------|---------------------|
| Simple conversational agent (1-5 tool calls) | No Planning (§2.6) |
| General-purpose agent, strong model | TODO tools (§2.1) |
| Complex tasks needing progress visibility | Task tools with dependencies (§2.2) |
| User must approve strategy before execution | Plan Mode (§2.3) |
| Repeatable complex workflows (feature dev, review) | Phased workflows (§2.4) |
| Quality-sensitive tasks (TDD, writing) | Iterative loops (§2.5) as complement |
| Multi-model support, ambiguous requests | Middleware-based (§2.7) |
| All of the above | Layer them (Claude Code approach) |

---

## Sources

- [deep-agents-from-scratch](../deep-agents-from-scratch/) — TODO tools, context anchoring
- [Claude Code](./inspections/claude_code.md) — task tools, plan mode, phased workflows, iterative loops
- [OpenClaw](./inspections/openclaw.md) — no-planning architecture, LLM-as-planner
- [DeerFlow](./inspections/deer_flow.md) — middleware-based planning, CLARIFY→PLAN→ACT
