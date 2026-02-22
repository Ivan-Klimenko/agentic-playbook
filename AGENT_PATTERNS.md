# Agent Patterns & Best Practices

A practitioner's reference for building LLM-powered agents. Framework-agnostic principles + LangGraph snippets.

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
- Provide fallback paths: if a specialized approach fails (e.g., `create_react_tunnel`), fall back to a manual ReAct with `ToolNode`.
- Stub/circuit-breaker: check external service health before entering the main agent loop. Short-circuit with a canned response when the backend is down.

### 2.5 Dynamic Prompt Injection

Serialize accumulated state (plan, references, analyses) into the system prompt on every LLM call. This gives the LLM a "working memory" view without relying on it to parse long message histories.

Best format: structured text (XML tags, markdown sections). Keeps it parseable but doesn't waste tokens on JSON syntax.

```
<plan>
  1. [✅ completed] Fetch CFR data for УОР
  2. [🔄 in_progress] Fetch CFR data for УРТВБ
  3. [⏳ pending] Compare and analyze
</plan>
<active_references>
  metrics_a1b2: CFR data for УОР (metrics, diff)
</active_references>
```

### 2.6 Pre-processing & Shortcuts

Not every request needs the full agent loop. Add a lightweight pre-processing node before the LLM:
- **Button/command detection**: exact text match → skip LLM entirely, call the right API directly
- **Stub/maintenance check**: query backend health → return canned response if down
- **Classification cache**: if the same query type was just classified, reuse the result

This saves latency and tokens for predictable inputs.

---

## 3. LangGraph Patterns (Snippets)

### 3.1 State with Reducers and Output Schema

```python
class OrchestratorState(TypedDict):
    messages: Annotated[list, add_messages]          # append reducer
    refs: Annotated[dict[str, Ref], refs_reducer]    # merge-dict reducer
    analyses: Annotated[list[Summary], operator.add]  # list append
    plan: Annotated[list[PlanItem], plan_reducer]     # replace-all reducer
    output: str

class OrchestratorOutput(TypedDict):  # only these fields returned to caller
    output: str

graph = StateGraph(OrchestratorState, output_schema=OrchestratorOutput)
```

### 3.2 ReAct Loop Wiring

```python
graph.add_node("agent", agent_node)
graph.add_node("tools", ToolNode(ALL_TOOLS))
graph.set_entry_point("agent")
graph.add_conditional_edges("agent", tools_condition, {
    "tools": "tools",
    "done": "response_formatter",
})
graph.add_edge("tools", "agent")  # the loop
graph.add_edge("response_formatter", END)
```

### 3.3 Command: Cross-Graph State Updates from Tools

Tools return `Command` to write into the parent graph's state:

```python
@tool
async def call_sub_agent(task: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    result = await sub_graph.ainvoke({"task": task})
    return Command(update={
        "refs": {ref_id: ref_entry},        # writes to orchestrator state
        "messages": [ToolMessage(content=output, tool_call_id=tool_call_id)],
    })
```

### 3.4 Command with Routing (goto)

```python
def review_node(state) -> Command[Literal["approve", "reject"]]:
    decision = interrupt({"draft": state["draft"], "message": "Approve?"})
    if decision == "yes":
        return Command(update={"approved": True}, goto="approve")
    return Command(update={"approved": False}, goto="reject")
```

### 3.5 InjectedState & InjectedToolCallId

Hide parameters from the LLM tool schema while injecting them at runtime:

```python
@tool
def my_tool(
    query: str,                                          # visible to LLM
    state: Annotated[dict, InjectedState],               # hidden, full state
    prefs: Annotated[dict, InjectedState("preferences")], # hidden, specific field
    tool_call_id: Annotated[str, InjectedToolCallId],    # hidden, auto-injected
) -> str: ...
```

### 3.6 Structured Output with Pydantic

Replace manual JSON parsing with schema-enforced extraction:

```python
class Classification(BaseModel):
    request_type: Literal["diff", "rating", "docs"]
    metrics: list[str] = Field(default_factory=list)
    date: str | None = Field(default=None)

# with_structured_output (langchain standard)
structured_llm = llm.with_structured_output(Classification)
result: Classification = structured_llm.invoke(messages)

# with include_raw=True for error handling
result = llm.with_structured_output(Classification, include_raw=True).invoke(messages)
parsed = result["parsed"]       # Classification | None
error = result["parsing_error"]  # Exception | None
raw = result["raw"]             # raw AIMessage
```

Update prompts accordingly: remove explicit JSON format examples — the Pydantic schema is provided to the LLM via function calling. Keep semantic rules (field meanings, valid values, edge cases).

### 3.7 Map-Reduce with Send API

Fan out to parallel node executions, collect results with a reducer:

```python
class State(TypedDict):
    topics: list[str]
    summaries: Annotated[list[str], operator.add]

def fan_out(state: State) -> list[Send]:
    return [Send("process", {"topic": t}) for t in state["topics"]]

builder.add_conditional_edges(START, fan_out)
```

### 3.8 Human-in-the-Loop with interrupt()

```python
from langgraph.types import interrupt, Command
from langgraph.checkpoint.memory import InMemorySaver

def approval_node(state):
    answer = interrupt({"value": state["draft"], "message": "Approve?"})
    return {"approved": answer == "yes"}

graph = builder.compile(checkpointer=InMemorySaver())

# First invoke pauses at interrupt
result = graph.invoke(input, config={"configurable": {"thread_id": "t1"}})
print(result["__interrupt__"])  # interrupt payload

# Resume with user decision
result = graph.invoke(Command(resume="yes"), config)
```

**Key**: `interrupt()` requires a checkpointer. The `thread_id` is your resume pointer.

### 3.9 Checkpointing & Persistence

```python
# In-memory (dev/testing)
from langgraph.checkpoint.memory import InMemorySaver
graph = builder.compile(checkpointer=InMemorySaver())

# SQLite (single-process persistence)
from langgraph.checkpoint.sqlite import SqliteSaver
graph = builder.compile(checkpointer=SqliteSaver(conn))

# Postgres (production, multi-process)
from langgraph.checkpoint.postgres import PostgresSaver
graph = builder.compile(checkpointer=PostgresSaver(conn_string))
```

Every `invoke()` with a `thread_id` saves state. Resume any thread, even after process restart (with durable checkpointer).

### 3.10 Sub-Graph as Tool (Full Pattern)

```python
# 1. Define sub-agent state (isolated from orchestrator)
class SubAgentState(TypedDict):
    messages: Annotated[list, add_messages]
    task: str
    output: str

# 2. Build and compile sub-graph at module level
sub_graph = build_sub_graph().compile()

# 3. Wrap in a @tool that maps state boundaries
@tool(parse_docstring=True)
async def call_sub_agent(
    task: str,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    state: Annotated[dict, InjectedState] = None,
) -> Command:
    """Description visible to LLM.

    Args:
        task: What to do.
    """
    result = await sub_graph.ainvoke({
        "messages": [HumanMessage(content=task)],
        "task": task,
        "output": "",
    })
    return Command(update={
        "refs": {ref_id: make_ref(result)},
        "messages": [ToolMessage(content=result["output"], tool_call_id=tool_call_id)],
    })

# 4. Register in orchestrator
ALL_TOOLS = [call_sub_agent, ...]
graph.add_node("tools", ToolNode(ALL_TOOLS))
```

---

## 4. Prompt Engineering for Agents

### System Prompt Structure (Orchestrators)

```
1. Role & scope (1-2 sentences)
2. Available tools (name + when to use each)
3. Protocol (numbered steps: assess → plan → collect → analyze → respond)
4. Delegation principle ("you coordinate, agents do the work")
5. Dynamic state context (injected XML/markdown)
6. Output rules (language, format, what NOT to mention)
```

### Tool Description Design

- Docstring = the LLM's only guide. Be specific about **when** to use the tool, not just what it does.
- Use `parse_docstring=True` so `Args:` section becomes parameter descriptions.
- Keep parameter names semantic: `task` not `input`, `context` not `extra`.

### Structured Output Prompts

When using `with_structured_output` / Pydantic schemas:
- **Remove** JSON format examples from the prompt — the schema is provided via function calling
- **Keep** semantic rules: valid values, edge cases, field relationships, dictionaries/mappings
- **Keep** classification logic and examples that help the LLM decide field values

---

## 5. Production Patterns (from OpenClaw)

Patterns extracted from OpenClaw — a 628K-LOC production agent orchestration platform. These go beyond framework-level concerns into what real systems need at scale.

> See [OPENCLAW_ARCHITECTURE.md](./OPENCLAW_ARCHITECTURE.md) for full architecture documentation.
> See [code_snippets/](./code_snippets/) for TypeScript implementations.

### 5.1 Auth Profile Failover with Cooldown

Production agents need multiple LLM provider credentials. When one fails (rate limit, outage, auth error), rotate to the next.

**Pattern:**
- Maintain an ordered list of auth profiles (API keys / OAuth tokens)
- On failure, mark the profile with a cooldown timestamp and advance to the next
- Skip profiles still in cooldown during rotation
- Scale max retry iterations with profile count: `base + N * profiles`

```
Profile A (active) → Auth Error → Mark cooldown → Advance
Profile B (next)   → Timeout    → Mark cooldown → Advance
Profile C (next)   → Success    → Use this one
Profile A          → Cooldown expired → Available again
```

**Why it matters:** A single API key is a single point of failure. Round-robin without cooldown hammers a broken provider. The scaling formula (`24 + 8 * profiles`) gives more retries when more fallbacks exist.

> See: [code_snippets/auth_failover.ts](./code_snippets/auth_failover.ts)

### 5.2 Layered Tool Policy Pipeline

Don't use a flat allow/deny list for tool access. Use a composable pipeline where each layer independently constrains the toolset.

**Pipeline layers (evaluated in order):**

| # | Layer | Owner | Purpose |
|---|-------|-------|---------|
| 1 | Profile policy | Config profiles | Named presets ("minimal", "coding") |
| 2 | Provider profile | LLM provider | Per-provider restrictions |
| 3 | Global allow | System admin | System-wide allowlist |
| 4 | Global provider | System admin | Provider-specific global |
| 5 | Agent allow | Agent config | Per-agent restrictions |
| 6 | Agent provider | Agent config | Per-agent per-provider |
| 7 | Group policy | User group | Per-user-group restrictions |

**Key design decisions:**
- Each layer uses **glob patterns** for matching (e.g. `exec*`, `sessions_*`)
- Plugin tool groups are resolved separately from core tools
- Unknown allowlist entries trigger warnings, not failures
- `alsoAllow` provides additive overrides without replacing the base policy

**Why it matters:** Different stakeholders need different control planes. An admin restricts globally, an agent config restricts per-agent, a user group restricts per-team — all without conflicting.

> See: [code_snippets/tool_policy_pipeline.ts](./code_snippets/tool_policy_pipeline.ts)

### 5.3 Sub-Agent Depth-Aware Tool Restrictions

Don't just limit recursion depth — restrict *what sub-agents can do* based on their depth in the spawn tree.

**Depth model:**
```
Main Agent (depth 0) → All tools available
  └─ Orchestrator Sub-Agent (depth 1) → Deny: gateway, cron, memory
       └─ Leaf Sub-Agent (depth 2, max) → Also deny: spawn, session mgmt
```

**Rules:**
- **Always denied** for any sub-agent: system admin tools, memory access, direct session sends
- **Leaf-only denied** (at max depth): spawning, session list/history (they can't orchestrate)
- Explicit `alsoAllow` in config can override deny rules
- Cross-agent spawning requires explicit `allowAgents` allowlist
- `maxChildrenPerAgent` limits concurrent children per session

**Why it matters:** Without depth-aware restrictions, a sub-agent can spawn unlimited children, each with full capabilities. This creates recursion bombs and privilege escalation paths.

> See: [code_snippets/subagent_depth_policy.ts](./code_snippets/subagent_depth_policy.ts)

### 5.4 3-Tier Context Window Recovery

Context overflow is inevitable with long-running agents. Don't just fail — implement escalating recovery:

```
Tier 1: In-Attempt Auto-Compaction
  The agent SDK detects overflow during tool loop and compacts automatically.
  If overflow persists after compaction → retry (up to MAX attempts).

Tier 2: Explicit Overflow Compaction
  Gateway triggers external compaction (summarize older messages).
  If compacted → retry prompt.

Tier 3: Tool Result Truncation
  Identify oversized tool results (e.g. a 500KB file read).
  Truncate to fit within context window.
  If truncated → retry prompt.
```

**Key implementation details:**
- Detect overflow via error message pattern matching (`isLikelyContextOverflowError`)
- Track compaction attempts per run to avoid infinite compact-retry loops
- Measure per-message character counts to find the biggest contributors
- Estimate tokens to determine if truncation will actually help

**Why it matters:** A single large tool result (file read, API response) can fill the entire context window. Compaction alone won't help — you need targeted truncation of the oversized result.

> See: [code_snippets/context_overflow_recovery.ts](./code_snippets/context_overflow_recovery.ts)

### 5.5 Concurrency Lanes (Nested Queue Serialization)

Agent systems need concurrent execution but safe serialization. Use nested lane queues:

```
Session Lane (per-session serialization)
  └─ Global Lane (cross-session coordination)
       └─ Actual execution
```

**How it works:**
- Each session gets its own queue — messages for a session are serialized
- Global operations (auth profile rotation, config reload) go through a shared queue
- The session enqueue wraps the global enqueue: `sessionLane(() => globalLane(() => work()))`
- Subagents get their own lane: `AGENT_LANE_SUBAGENT`

**Why it matters:** Without session lanes, two concurrent messages to the same agent can corrupt shared state (file edits, memory writes). Without global lanes, auth profile rotation races with active requests.

### 5.6 Plugin Lifecycle Hooks (Typed, Priority-Ordered)

Design hooks as first-class, typed, priority-ordered extension points — not just "on event" callbacks.

**Two execution modes:**
- **Parallel (fire-and-forget):** For observing hooks (`llm_input`, `session_start`). All handlers run concurrently via `Promise.all`.
- **Sequential (modifying):** For hooks that transform data (`before_tool_call`, `message_sending`). Handlers run in priority order, each seeing the previous handler's output.

**Priority system:**
```
Higher priority number → runs first
Hook A (priority: 100) → Hook B (priority: 50) → Hook C (priority: 0)
```

**Critical: sync-only hooks for hot paths.** Two hooks (`tool_result_persist`, `before_message_write`) are synchronous-only. If a handler returns a Promise, it's detected and warned/ignored. This prevents async overhead on the message serialization path.

**Why it matters:** Generic event emitters don't support priority ordering or sequential transformation. Production systems need both observing and modifying hooks, and must protect hot paths from accidental async handlers.

> See: [code_snippets/lifecycle_hooks.ts](./code_snippets/lifecycle_hooks.ts)

### 5.7 Hybrid Memory Search (Vector + FTS + Decay)

Pure vector search misses exact keyword matches. Pure FTS misses semantics. Combine both with weighted merging and temporal decay.

**Search pipeline:**
```
Query
  ├─ extractKeywords() → FTS search (BM25 ranking)
  └─ embedQuery()      → Vector search (cosine similarity)
           │
           ▼
     Hybrid Merge
       ├─ vectorWeight (default ~0.7)
       ├─ textWeight (default ~0.3)
       ├─ MMR diversity (optional, lambda-controlled)
       └─ Temporal decay (half-life in days)
           │
           ▼
     Score threshold → Top K results
```

**Key design decisions:**
- **Graceful degradation:** If no embedding provider is configured, fall back to FTS-only mode
- **Multi-keyword FTS:** Extract keywords from query, search each independently, merge+deduplicate
- **Temporal decay:** Older memories weighted down via half-life function — recent context preferred
- **MMR (Maximal Marginal Relevance):** Penalize results too similar to already-selected ones
- **Sync-on-search:** If the memory index is dirty, trigger a background sync before searching

**Why it matters:** Agent memory that can't find exact names/terms (FTS strength) or understand paraphrased concepts (vector strength) is frustrating. Temporal decay prevents stale memories from dominating.

> See: [code_snippets/hybrid_memory_search.ts](./code_snippets/hybrid_memory_search.ts)

### 5.8 Safe-Bin Profiles (Command Sandboxing)

When agents execute shell commands, don't just whitelist binary names — profile each command's allowed flags, positional arguments, and input patterns.

**Profile structure:**
```
Binary name → {
  maxPositional: number,       // max positional args (0 = stdin-only)
  allowedValueFlags: string[], // flags that take values (--arg, -e)
  deniedFlags: string[],       // explicitly blocked flags
}
```

**Examples:**
- `grep` → stdin-only (maxPositional: 0), deny `--file`, `--recursive`
- `jq` → max 1 positional (the filter), deny `--argfile`, `--rawfile`
- `sort` → stdin-only, deny `--compress-program`, `--output`

**Universal blocks:** Path-like tokens (`/`, `~`, `../`), glob patterns (`*`, `?`), shell metacharacters.

**Why it matters:** Allowing `grep` without restrictions lets the agent read any file on disk via `grep -r pattern /etc/`. Allowing `jq --rawfile` lets it load arbitrary files. Profile-level restrictions close these paths while keeping the tools useful.

### 5.9 Defense-in-Depth Security Layering

No single security layer is sufficient. Stack them:

| Layer | Mechanism | Threat |
|-------|-----------|--------|
| Config validation | Zod schema + cross-field refinements | Misconfigurations |
| Dangerous flag detection | Explicit audit of known-dangerous combos | Accidental exposure |
| Tool policy pipeline | 7-layer allow/deny | Unauthorized tool access |
| Safe-bin profiles | Per-command flag/path restrictions | Shell injection |
| Workspace-only mode | File ops restricted to workspace | Path traversal |
| Docker sandbox | Read-only root, network=none, blocked host paths | Container escape |
| Bind mount validation | Symlink resolution + blocked path list | Mount escape |
| Audit logging | Usage recording, denial logging | Forensics |
| Sub-agent depth limits | Max depth + max children + tool deny lists | Recursion bombs |

**Key: validate at build time, enforce at runtime, audit always.** Config validation catches mistakes before the system starts. Tool policies enforce at call time. Audit logging records everything for post-incident analysis.

> See: [code_snippets/sandbox_security.ts](./code_snippets/sandbox_security.ts)

### 5.10 Channel Plugin Architecture (Modular Adapters)

When supporting multiple messaging channels (Slack, Discord, Telegram, etc.), use a modular adapter interface where each capability is optional:

```
ChannelPlugin = {
  id, meta, capabilities,

  config:     ChannelConfigAdapter,      // Required
  auth?:      ChannelAuthAdapter,        // Optional
  messaging?: ChannelMessagingAdapter,   // Optional
  threading?: ChannelThreadingAdapter,   // Optional
  outbound?:  ChannelOutboundAdapter,    // Optional
  security?:  ChannelSecurityAdapter,    // Optional
  streaming?: ChannelStreamingAdapter,   // Optional
  // ... 15+ optional adapters
}
```

**Unified session key format:** `channel:accountId:peerId:threadId`
- `telegram:123:456:789` (DM thread)
- `slack:ws123:ch456:ts789` (Slack thread reply)
- `discord:guild123:ch456` (Discord channel)

**Why it matters:** Forcing all channels to implement every adapter leads to stub methods and broken contracts. Optional adapters let simple channels (webhook-only) coexist with full-featured ones (Slack with threading, reactions, file uploads).

---

## 6. Anti-Patterns & Pitfalls

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| Putting all logic in one graph | Untestable, prompt bloat, can't tune sub-tasks independently | Break into sub-agents as tools |
| Passing full orchestrator state to sub-agents | State coupling, sub-agents see irrelevant fields | Map state at tool boundary |
| Manual JSON parsing of LLM output | Fragile, error-prone, prompt overhead for format examples | Use structured output with Pydantic |
| No recursion limit | Runaway ReAct loops burn tokens | Set `recursion_limit` on every graph |
| LLM-routing everything | Slow for predictable inputs | Add pre-processing shortcuts (buttons, exact matches) |
| Overloading message history | Context window fills up, LLM loses focus | Serialize state into system prompt, keep messages for conversation |
| Tool returns raw exception | LLM can't recover gracefully | Return structured error in ToolMessage, let LLM decide |
| Hardcoded routing in a graph that needs flexibility | Every new route = code change | Use ReAct with tool selection instead |
| Amending prompts for structured output format | Redundant with schema, can conflict | Let Pydantic model define the format |
| Stateless analysis across calls | Agent forgets prior work in multi-turn sessions | Add a scratchpad/memo persisted in parent state |
| Flat tool allow/deny lists | Can't express per-agent, per-provider, per-group policies | Use layered policy pipeline (see 5.2) |
| Uniform sub-agent capabilities | Sub-agents at any depth can spawn more children → recursion bombs | Depth-aware tool deny lists (see 5.3) |
| Single auth credential | One rate limit or outage kills the agent | Auth profile failover with cooldown (see 5.1) |
| Crash on context overflow | Long conversations just stop working | 3-tier recovery: compact → re-compact → truncate (see 5.4) |
| No session serialization | Concurrent messages to same agent corrupt state | Nested lane queues (see 5.5) |
| Async hooks on hot paths | Message serialization stalls on slow plugins | Enforce sync-only hooks where latency matters (see 5.6) |
| Pure vector OR pure keyword search | Misses exact names or semantic paraphrases | Hybrid search with weighted merge (see 5.7) |
| Whitelisting binaries without flag restrictions | `grep -r /etc/passwd` reads any file | Per-command flag profiles (see 5.8) |

---

## 7. References

### Docs
- [LangGraph Concepts](https://langchain-ai.github.io/langgraph/concepts/) — state, reducers, edges, persistence
- [LangGraph How-To Guides](https://langchain-ai.github.io/langgraph/how-tos/) — patterns with code
- [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) — mental model for graph design
- [LangGraph Workflows & Agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) — orchestrator-worker, map-reduce
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) — human-in-the-loop deep dive
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) — checkpointing, memory store

### Repos
- [langgraph](https://github.com/langchain-ai/langgraph) — source + examples
- [langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) — handoff pattern implementation
- [langchain-ai/langchain](https://github.com/langchain-ai/langchain) — tools, structured output, chat models

### Architecture Case Studies
- [OPENCLAW_ARCHITECTURE.md](./OPENCLAW_ARCHITECTURE.md) — deep-dive into OpenClaw's agentic architecture (gateway, tool policies, sub-agents, memory, security)
- [code_snippets/](./code_snippets/) — TypeScript implementations of production patterns from OpenClaw

### Key Papers & Posts
- [ReAct: Synergizing Reasoning and Acting](https://arxiv.org/abs/2210.03629) — the foundational pattern
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) — planning before execution
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production
