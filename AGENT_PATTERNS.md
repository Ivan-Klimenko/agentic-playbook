# Agentic Patterns & Best Practices

A practitioner's reference for building LLM-powered agents. Framework-agnostic principles applicable to any agent system.

> **See also:** [LangGraph Patterns](./LANGGRAPH_PATTERNS.md) | [Production Patterns](./PRODUCTION_PATTERNS.md) | [Anti-Patterns](./ANTI_PATTERNS.md) | [Orchestration Topologies](./ORCHESTRATION_PATTERNS.md) | [Infrastructure](./INFRA_PATTERNS.md)

---

## 1. Decision Tree: Choosing the Right Architecture

```
Is the task a single LLM call with tools?
  YES → Simple ReAct loop
  NO ↓

Does the LLM need to decide which specialist to call?
  YES → ReAct Orchestrator (LLM picks tools dynamically)
  NO ↓

Is the routing deterministic (known input → known path)?
  YES → Router (conditional edges, no LLM in the loop)
  NO ↓

Does the task require multi-step planning before execution?
  YES → Plan-and-Execute (planner → executor loop)
  NO ↓

Do multiple peers need to hand off control to each other?
  YES → Swarm / Handoff pattern
  NO → Start with ReAct, refactor when the pattern emerges
```

**Rule of thumb**: start with the simplest architecture that works. ReAct covers ~80% of cases. Add planning or multi-agent only when a single agent demonstrably fails at coordination.

---

## 2. Architectural Patterns (Framework-Agnostic)

### 2.1 Orchestrator Types

| Pattern | When to use | Tradeoff |
|---------|-------------|----------|
| **ReAct** | General-purpose, unknown number of steps | Flexible but token-heavy on long chains |
| **Router** | Fixed, deterministic paths based on classification | Fast but brittle to new categories |
| **Plan-and-Execute** | Complex tasks needing upfront decomposition | Better coherence but higher latency (2 LLM calls minimum) |
| **Orchestrator-Worker** | Fan-out to parallel specialists, then synthesize | Great throughput but complex state merging |
| **Swarm/Handoff** | Peer agents with distinct personas/capabilities | Natural conversation flow but hard to debug |

### 2.2 State Management Principles

- **Single source of truth**: one state object that all agents read/write. No hidden side channels.
- **Reducers over overwrites**: use merge/append semantics for shared fields (references, messages). Only use replace for fields owned by one writer (plan).
- **Minimal state surface**: sub-agents get only the fields they need, not the full orchestrator state. Map state at boundaries.
- **Output schema**: restrict what the graph returns to the caller. Internal state stays internal.

### 2.3 Sub-Agent Composition

**Tool-as-agent** (recommended default): sub-agent is a compiled graph invoked inside a `@tool` function. The tool function maps orchestrator state → sub-agent input, invokes, maps result → orchestrator state update.

Why this works:
- Orchestrator LLM sees a clean tool schema, not graph internals
- Sub-agent can have its own state, prompts, recursion limits
- `Command` return lets the tool write to orchestrator state directly

**Nested sub-graph**: embed a compiled graph as a node. Better when you need the sub-graph's messages to merge into the parent message history. Harder to control state isolation.

### 2.4 Error Boundaries & Graceful Degradation

- Wrap sub-agent invocations in try/except. Return structured error via `ToolMessage`, not an exception. Let the orchestrator LLM decide how to handle it.
- Set `recursion_limit` per graph. A runaway ReAct loop is the most common failure mode.
- Provide fallback paths: if a specialized approach fails, fall back to a manual ReAct with `ToolNode`.
- Stub/circuit-breaker: check external service health before entering the main agent loop.
- **Error messages for LLM consumption**: design tool error strings with actionable information (valid options, what went wrong, how to retry). The LLM is the consumer, not a human.

**Error-typed provider failover (multi-model agents):**

When an LLM call fails, classify the error by type and select a recovery strategy per type:

```
Error arrives → classify:
  401/403        → "auth"       → refresh token, then rotate profile
  402            → "billing"    → mark profile, rotate immediately
  429            → "rate_limit" → backoff (exponential), then rotate
  503            → "overloaded" → backoff, rotate
  408/ETIMEDOUT  → "timeout"    → rotate (no cooldown — timeouts aren't auth issues)
```

Key decisions: cooldown per profile (not global), probe cooldowned profiles periodically (throttled to 1/30s), walk `error.cause` recursively (providers wrap errors inconsistently), backoff policy per reason (rate_limit gets backoff; auth gets rotation).

**Anti-pattern:** Treating all errors the same (retry + rotate). This hammers a rate-limited provider, wastes time refreshing tokens on billing errors, and applies cooldown to timeouts that don't need it.

> Source: [OpenClaw](./inspections/openclaw.md) §8.6

### 2.5 Dynamic State Injection (Working Memory)

Give the LLM a structured "working memory" view of accumulated state without relying on it to parse long message histories.

**Where to inject:** into the **latest user message**, not the system prompt. The system prompt should stay static so it remains cached across turns (see §3.7).

```
System prompt (STATIC — cached once, reused every turn):
  Role definition, tool descriptions, instructions, few-shot examples

Latest user message (DYNAMIC — appended each turn, after cached prefix):
  <working_memory>
    <plan>
      1. [completed] Fetch CFR data for A
      2. [in_progress] Fetch CFR data for B
    </plan>
    <active_references>
      metrics_a1b2: CFR data for A (metrics, diff)
    </active_references>
  </working_memory>

  [actual user query or tool results here]
```

Best format: structured text (XML tags, markdown sections). In framework code, inject by prepending to the latest `HumanMessage` content before the LLM call.

### 2.6 Agents-as-Config (No Agent Classes)

Define agents as **named configuration objects**, not classes with behavior. The runtime is generic — it interprets configs to assemble prompts, select tools, and enforce permissions.

```typescript
AgentConfig = {
  name: string,
  mode: "primary" | "subagent" | "hidden",
  prompt: string,             // system prompt
  permission: Ruleset,        // tool access rules (declarative)
  model: { provider, id },    // optional model override
  steps: number,              // max agentic iterations
}
```

**Why configs, not classes:**
- Adding a new agent = adding a config file, not writing code
- Runtime stays generic — one loop handles all agents
- Composition via merging — permissions merge with defaults and user overrides
- Hot-reloadable — config changes take effect without restart

**When to use classes instead:** When agents need genuinely different execution strategies (graph topology, custom tool orchestration). But often what feels like "different behavior" is really "different config."

### 2.7 Mode Switching via Synthetic Messages

Switch between agents within the same session by injecting synthetic user messages with an agent field. The loop resolves the corresponding config on the next iteration — no graph rewiring.

```
Agent A (plan) → calls mode_switch tool
  → Creates synthetic message: { role: "user", agent: "build", text: "Execute the plan." }
  → Loop picks up agent="build", resolves tools/permissions
  → Agent B (build) continues in same session with same history
```

Conversation history is preserved, the switch is auditable, and `insertReminders()` can inject transition-specific instructions.

### 2.8 Parallel Multi-Tool Execution (Batch Tool)

Let the LLM request multiple independent tool calls in a single response, executed in parallel. This cuts wall-clock time for parallel-safe operations (file reads, searches, fetches).

Design decisions: disallow nesting (no batch-in-batch), per-call permission checks, per-call state tracking for UI streaming. **When NOT to use:** tool calls with dependencies or conflicting side effects.

### 2.9 Two-Tier Model Strategy

Use different models for different cognitive loads:
- **Expensive model** (Sonnet/Opus) — reasoning, planning, orchestration, tool selection
- **Cheap model** (GPT-4o-mini, Haiku) — summarization, extraction, classification, formatting

Summarization doesn't need frontier-model reasoning — it's a compression task.

### 2.10 No-Plan Architecture (Planning via System Prompt)

Not every agent needs a formal plan-and-execute phase. Delegate planning to the LLM via the system prompt — no plan object, no plan tool, no plan state machine.

**When this works:** Conversational agents (1-5 tool calls), diverse task types, latency-sensitive environments.

**When you need explicit planning:** Complex multi-step tasks (20+ tool calls), plan visibility for user approval, parallel fan-out requiring upfront decomposition.

**The tradeoff:** Without explicit planning, the agent can lose coherence on long runs. Mitigate through TODO anchoring (§3.1), think tool (§3.6), and context recovery (§3.10).

**Prompt-driven plan alternative:** The plan agent writes a plan to a markdown file, then mode-switches (§2.7) to a build agent. The build agent reads the plan file and follows it using standard tools. The plan is a regular file — human-readable, no schema, no engine. TodoWrite provides optional progress tracking. This works when the LLM is capable enough to follow written instructions reliably.

### 2.11 Pure LLM Tool Selection (No Planner, No Router)

No tool routing logic — the LLM selects tools purely from its available tool set.

**Why this works at scale (30+ tools, 50+ skills):**
1. Policy filtering removes tools the agent shouldn't use
2. Canonical ordering prevents positional bias
3. Dynamic descriptions stay accurate
4. Skills listed as catalog, not inlined

**When you need a planner/router:** 100+ tools, accuracy drops below threshold, deterministic guarantees required. **Anti-pattern:** Adding a tool recommender as first optimization — improve descriptions and ordering first.

### 2.12 Fuzzy Tool Input Resilience

LLMs hallucinate whitespace, indentation, and escape characters. For tools requiring exact matching (find-and-replace), use a **fallback chain of increasingly fuzzy matchers**: exact → whitespace-trimmed → whitespace-normalized → indentation-agnostic → escape-normalized → context-aware anchoring.

First strategy producing exactly ONE unique match wins. Multiple matches → try next strategy (ambiguity is worse than no match). Each strategy is a lazy generator — expensive strategies only run if cheap ones fail. Takes edit tool success rate from ~80% to ~98%.

> See: [OpenCode](./inspections/opencode.md) — `code_snippets/opencode/tool_system.ts`

### 2.13 Post-Model Guardrails

Prompt instructions are best-effort — the LLM will violate them. Add **post-model output processing** that silently corrects violations before tool execution.

**Three enforcement layers (use all three):**

| Layer | When | Mechanism | Failure mode |
|-------|------|-----------|--------------|
| Prompt instructions | Before generation | "Max N task calls per response" | LLM ignores (~10-20%) |
| Post-model guardrail | After generation | `after_model` hook truncates excess | Silent, deterministic |
| Recursion limit | Across turns | `recursion_limit=100` | Stops infinite loops |

**Why silent truncation, not error feedback:** Returning an error wastes a turn. Silent truncation achieves the same result in zero extra turns.

### 2.14 Tool Mutation Tracking (Action Fingerprinting)

When tools have side effects, track *which specific action* caused an error and only clear the error state when the *same action* succeeds — not when any unrelated tool succeeds.

```
Tool call → mutating? → build fingerprint: "tool=write|action=create|path=config.yaml"
  → on error: store { fingerprint, error }
  → on success: clear ONLY IF fingerprint matches stored error
  Non-mutating tools → clear error immediately on success
```

**Why this matters:** Without action fingerprinting, agents develop "false recovery" — they believe a problem is fixed because *some* tool succeeded, when the actual failing operation was never retried. The failure is subtle: the agent's behavior looks correct (tried something, got success, moved on) but the underlying issue persists.

Mutating tools: write, edit, exec, deploy. Action-dependent: process (write/send_keys/kill), message (send/reply/delete). Never: read, glob, grep, search.

> Source: [OpenClaw](./inspections/openclaw.md) §8.5

### 2.15 Push-Based Sub-Agent Results (No Polling)

When sub-agents complete, deliver results to the parent via push — don't let the parent poll.

```
Anti-pattern:                           Pattern:
  Parent calls sessions_list ×3           Child completes → result pushed
  Parent calls sessions_history ×3        as user message to parent
  = 6 wasted tool calls                  = 0 tool calls to collect
```

Key design decisions:
- **Explicit instruction in spawn response:** "Do NOT call sessions_list. Wait for completion events as user messages."
- **Frozen result capture:** Freeze last assistant text (capped 100KB) on completion for delayed delivery
- **Delivery retry:** Exponential backoff (1s → 2s → 4s, max 3 attempts); 5 min expiry for status, 30 min for completion
- **Push for completion, poll for progress:** Polling is acceptable only for in-progress status checks

> Source: [OpenClaw](./inspections/openclaw.md) §8.1

---

## 3. Context Engineering

As agent tasks grow longer (~50+ tool calls), **context rot** becomes the primary failure mode: the LLM's attention degrades with distance from the current position, causing mission drift, forgotten objectives, and information loss across multi-agent handoffs ("game of telephone"). These patterns address context management as a first-class concern.

### 3.1 TODO Lists as Context Anchors

A TODO tool that the agent continuously rewrites to combat context rot.

**Core insight**: forcing the LLM to rewrite the full TODO list acts as self-prompting — it recites its objectives at the end of the context, re-anchoring attention.

**Design decisions:**
- **Full overwrite, not append**: the LLM rewrites the entire list each time, allowing it to reprioritize and prune.
- **One `in_progress` at a time**: prevents the agent from losing focus across concurrent tasks.
- **Write-read-reflect cycle**: after completing a task, read the TODO back, reflect on progress, then update.

```python
class Todo(TypedDict):
    content: str
    status: Literal["pending", "in_progress", "completed"]

@tool(description=WRITE_TODOS_DESCRIPTION, parse_docstring=True)
def write_todos(todos: list[Todo], tool_call_id: Annotated[str, InjectedToolCallId]) -> Command:
    return Command(update={
        "todos": todos,
        "messages": [ToolMessage(f"Updated todo list to {todos}", tool_call_id=tool_call_id)],
    })
```

### 3.2 Virtual Filesystem for Context Offloading

A `dict[str, str]` virtual filesystem in agent state. Agents write token-heavy content (search results, analysis drafts) to files and keep only lightweight summaries in messages.

**Why virtual, not real files:** Enables backtracking via checkpointing, thread-scoped persistence, no sandbox concerns.

**Key:** `write_file` returns only a confirmation in the `ToolMessage`, NOT the file content. Heavy content goes to state; lightweight acknowledgment goes to messages. For long-running agents, save collected content to files immediately — before context compression can eliminate it (orient → save → read workflow).

### 3.3 Context Isolation via Sub-Agents

Sub-agents receive a **completely fresh context** containing only their task description. Replace messages entirely before invoking:

```python
@tool
def task(description: str, subagent_type: str, state, tool_call_id):
    sub_agent = agents[subagent_type]
    state["messages"] = [{"role": "user", "content": description}]
    result = sub_agent.invoke(state)
    return Command(update={
        "files": result.get("files", {}),  # Merge file changes back
        "messages": [ToolMessage(result["messages"][-1].content, tool_call_id=tool_call_id)],
    })
```

**Shared state, isolated messages**: the `files` dict is shared (merged back via reducer), enabling file-based inter-agent communication. But `messages` are replaced — each sub-agent starts clean.

### 3.4 Content Summarization Pipeline

When a tool fetches external content, summarize it before it enters the agent's context:

```
Search query → HTTP fetch → HTML-to-markdown → Structured summarize (cheap model)
  → UUID filename → Write to virtual file → Return minimal summary to agent
```

Key: UUID suffix on filenames prevents collisions. The summarization model is cheap (GPT-4o-mini), not the main reasoning model. Full content goes to the file; only the summary enters messages.

### 3.5 Think Tool (No-Op Forced Reflection)

A tool that returns its input unchanged. Forces the LLM to produce a structured reasoning step that persists in context as a `ToolMessage`:

```python
@tool(parse_docstring=True)
def think_tool(reflection: str) -> str:
    """Tool for strategic reflection. Reflection should address:
    1. Analysis of current findings  2. Gap assessment  3. Quality evaluation  4. Next step"""
    return f"Reflection recorded: {reflection}"
```

The LLM produces better decisions when forced to articulate reasoning as a tool call. The detailed docstring guides what to reflect about.

### 3.6 Prompt Caching-Aware Context Design

Most providers support **prompt caching** — reusing the KV-cache of a previously seen prefix. Cache hits are ~10x cheaper. Agents benefit enormously, but only if context maximizes prefix reuse.

**Cache hierarchy:** `tools → system prompt → messages (in order)`. Changes at any level invalidate that level and everything after it.

**Core principle — append-only context:** Never modify or reorder earlier messages. Only append new ones.

**Practical rules:**
1. **Static content first, dynamic last.** System instructions and tool definitions at the beginning (cached); conversation at the end.
2. **Don't rewrite history.** For dynamic state (§2.5), inject into the latest user message — system prompt stays static.
3. **Summarize-and-append, don't replace.** Start a new conversation branch: `[system] + [summary] + [recent messages]`.
4. **Explicit cache breakpoints** at stability boundaries (end of system prompt/tool definitions).
5. **Keep tool definitions static.** Disable tools via error responses first (cache-safe); only remove from schema if the LLM ignores the error (cache-breaking fallback).

**Provider notes:**
- **Anthropic**: 1024-4096 token min prefix, up to 4 breakpoints, 5-min TTL, reads = 10% of base price
- **OpenAI**: Automatic on ≥1024 tokens, fully prefix-based, no extra cost
- **Google**: Explicit "cached content" objects with configurable TTL

### 3.7 Tool Output Truncation with File Offloading

Tool outputs can be arbitrarily large. Truncate automatically and offload the full output to a retrievable location.

**Basic pattern:** output > threshold → truncate + save to temp file + append hint with file path. Automatic (not opt-in), dual threshold (lines AND bytes), retrievable full output.

**Smart head+tail truncation:** Blind truncation cuts the most useful part — errors, stack traces, and summaries tend to appear at the **end**.

1. Check if tail (~2K chars) contains important content (regex: `error`, `exception`, `traceback`, `panic`, JSON `}`)
2. If important: head budget + tail budget (min 30% of total, 4KB) + middle omission marker
3. If not: standard head-only with newline alignment

**Budget distribution for multi-block results:** Distribute proportionally by block size — a 100-byte block and a 50KB block should not get the same budget.

> See: [OpenClaw](./inspections/openclaw.md) §7.6

### 3.8 Context-Loss Detection & Re-injection

When the agent writes state to a tool call (TODO list, plan), it scrolls out of the attention window over time. Detect when the original write is no longer in recent context (~last 20 messages) and re-inject a concise reminder as a `HumanMessage`.

**Design choice — reminder, not full replay:** Inject "You have an active TODO list: ..." rather than replaying the full tool call. Fewer tokens, same effect.

### 3.9 Auto-Continue After Context Recovery

When context compaction is triggered automatically, inject a synthetic continuation message:

```
"Continue if you have next steps, or stop and ask for
 clarification if you are unsure how to proceed."
```

The user shouldn't babysit compaction. The escape hatch ("stop if unsure") prevents runaway behavior after context loss. **Don't** auto-continue when compaction was user-initiated.

### 3.10 Periodic Self-Check Injection

System-initiated cognitive checkpoints at fixed intervals (e.g., every 50 rounds), distinct from the agent-initiated think tool (§3.5):

```
[CHECKPOINT — round {n}/{max}]
Context: ~{tokens} tokens | Cost: ${cost} | Remaining: {remaining} rounds
PAUSE: Am I making progress? Is my strategy working? Should I stop?
```

Key differences from think tool: system-injected (not agent-initiated), resource-aware (token/cost/round stats), non-blocking (system message, not tool call), soft ("you decide").

> Source: [Ouroboros](./inspections/ouroboros.md) — self-check injection

### 3.11 Identifier Preservation in Compaction

When compacting conversation history, opaque identifiers must survive verbatim. Summarizers will abbreviate UUIDs, reconstruct file paths, and omit URLs — corrupting them silently.

```
Before compaction: "Created deployment dep_a1b2c3d4e5f6 in us-east-1-prod"
After naive compaction: "Created a deployment in production"  ← ID lost
```

**Pattern:** Inject explicit preservation instructions into the summarization prompt:

```
CRITICAL: Preserve all opaque identifiers exactly as written —
UUIDs, resource IDs, file paths, URLs, commit SHAs, hostnames, version numbers.
```

**Three policies:** `strict` (always preserve, default), `custom` (domain-specific), `off` (casual chat).

**With staged summarization**, identifier instructions must be present in *every* stage — identifiers dropped in a partial summary can't be recovered during merge. Strip `toolResult.details` before summarization to avoid untrusted content injection.

> Source: [OpenClaw](./inspections/openclaw.md) §8.2

---

## 4. Prompt Engineering for Agents

### System Prompt Structure

```
1. Role & scope (1-2 sentences)
2. Available tools (name + when to use each)
3. Protocol (numbered steps: assess → plan → collect → analyze → respond)
4. Delegation principle ("you coordinate, agents do the work")
5. Dynamic state context (injected XML/markdown)
6. Output rules (language, format, what NOT to mention)
```

### Tool Descriptions & Structured Output

- Docstring = the LLM's only guide. Be specific about **when** to use the tool, not just what it does.
- Keep parameter names semantic: `task` not `input`, `context` not `extra`.
- **Override pattern**: `@tool(description=CONSTANT)` separates the LLM-facing description from the code docstring.
- For structured output with Pydantic: **remove** JSON format examples (schema is provided via function calling), **keep** semantic rules and classification logic.

### Composite Prompt Assembly

Build system prompts from modular constants, not monolithic strings. Each module owns its prompt section. Use separator lines and XML tags (`<Task>`, `<Hard Limits>`) for structure.

### Delegation Limits & Scaling

Prevent runaway loops at the prompt level (complementing `recursion_limit` at the graph level):

```
<Hard Limits>
- Simple queries: 1-2 tool calls max
- Normal research: 2-3 tool calls max
- Complex multi-faceted: up to 5 tool calls max
- STOP when 3+ relevant sources found
</Hard Limits>
```

Give the orchestrator concrete scaling guidance: 1 sub-agent for simple tasks, 1 per element for comparisons, parallel agents for multi-faceted research, max N per iteration. Instruct parallel execution explicitly.

---

## 5. References

### Key Papers & Posts
- [ReAct: Synergizing Reasoning and Acting](https://arxiv.org/abs/2210.03629) — the foundational pattern
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) — planning before execution
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production

### Architecture Deep-Dives
- [OpenCode Architecture](./inspections/opencode.md) — agents-as-config, fuzzy edit matching, permission-as-data, prompt-driven planning, batch tool, snapshot/revert, markdown-as-code plugins, event-driven hooks
- [OpenClaw Architecture](./inspections/openclaw.md) — multi-channel agent platform, tool policy pipeline, auth failover, dual-loop, HITL, subagent registry, context engine
- [DeerFlow Inspection](./inspections/deer_flow.md) — middleware chain architecture, subagent executor with background pools, memory system with upload scrubbing, post-model guardrails
- [Ouroboros Inspection](./inspections/ouroboros.md) — self-modifying agent with background consciousness, LLM-controlled model switching, periodic self-check injection, budget drift detection
- [Claude Code Inspection](./inspections/claude_code.md) — markdown-as-code plugin system (agents, commands, skills, hooks as markdown), event-driven hook interception, multi-agent review pipelines

### Tutorials
- [deep-agents-from-scratch](../deep-agents-from-scratch/) — progressive tutorial: TODO anchoring → virtual filesystem → sub-agents → full research agent
