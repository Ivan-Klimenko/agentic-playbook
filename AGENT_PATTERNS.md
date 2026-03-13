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
- Provide fallback paths: if a specialized approach fails (e.g., `create_react_tunnel`), fall back to a manual ReAct with `ToolNode`.
- Stub/circuit-breaker: check external service health before entering the main agent loop. Short-circuit with a canned response when the backend is down.
- **Error messages for LLM consumption**: design tool error strings with actionable information (valid options, what went wrong, how to retry). The LLM is the consumer, not a human.

### 2.5 Dynamic State Injection (Working Memory)

Give the LLM a structured "working memory" view of accumulated state (plan progress, references, intermediate results) without relying on it to parse long message histories.

**Where to inject:** into the **latest user message**, not the system prompt. The system prompt should stay static (role, instructions, tool docs, few-shot examples) so it remains cached across turns (see §3.7). Modifying the system prompt on every call invalidates the entire prompt cache — system and all messages — defeating prefix reuse.

```
System prompt (STATIC — cached once, reused every turn):
  Role definition, tool descriptions, instructions, few-shot examples

Latest user message (DYNAMIC — appended each turn, after cached prefix):
  <working_memory>
    <plan>
      1. [completed] Fetch CFR data for A
      2. [in_progress] Fetch CFR data for B
      3. [pending] Compare and analyze
    </plan>
    <active_references>
      metrics_a1b2: CFR data for A (metrics, diff)
    </active_references>
  </working_memory>

  [actual user query or tool results here]
```

Best format: structured text (XML tags, markdown sections). Keeps it parseable but doesn't waste tokens on JSON syntax.

**In framework code** (e.g., LangGraph), inject the working memory block by prepending it to the latest `HumanMessage` content before the LLM call, or as a separate content block within the same message. The prior conversation history remains untouched, preserving the cached prefix.

### 2.6 Agents-as-Config (No Agent Classes)

Instead of building agent classes with behavior (methods, inheritance, state machines), define agents as **named configuration objects**. The runtime is generic — it interprets configs to assemble prompts, select tools, and enforce permissions.

```typescript
// Agent is a pure config — no execute(), no run(), no behavior
AgentConfig = {
  name: string,
  mode: "primary" | "subagent" | "hidden",
  prompt: string,             // system prompt (or use provider default)
  permission: Ruleset,        // tool access rules (declarative)
  model: { provider, id },    // optional model override
  temperature: number,
  steps: number,              // max agentic iterations
}
```

**Built-in + custom parity:** Agents loaded from markdown frontmatter or JSON config use the same schema as built-in agents. Custom agents are first-class citizens, not second-class plugins.

```markdown
---
mode: subagent
temperature: 0.7
model: openai/gpt-4o
permission:
  bash: deny
  edit: { "*.test.ts": allow, "*": deny }
---
You are a code reviewer. Focus on test quality...
```

**Why configs, not classes:**
- **Adding a new agent = adding a config file**, not writing code. Non-engineers can create agents.
- **Runtime stays generic** — one loop handles all agents. Testing, debugging, and profiling apply uniformly.
- **Composition via merging** — agent permissions merge with defaults and user overrides. No inheritance hierarchies.
- **Hot-reloadable** — config changes take effect without restarting the runtime.

**Hidden agents:** System agents (compaction, title generation, summarization) use the same schema with `hidden: true`. The runtime calls them programmatically, but they're configs like everything else.

**When to use classes instead:** When agents need genuinely different execution strategies (graph topology, custom tool orchestration). But often what feels like "different behavior" is really "different config" — different tools, different prompts, different permissions.

### 2.7 Agent Mode Switching via Synthetic Messages

Switch between agents within the same session by injecting **synthetic user messages** with an agent field. The loop picks up the agent field on the next iteration and resolves the corresponding config. No graph rewiring, no state machine transitions.

```
Agent A (plan) working in session:
  │
  ├─ Agent calls mode_switch tool
  │   ├─ Tool asks user for confirmation (optional)
  │   └─ Creates synthetic user message:
  │       { role: "user", agent: "build", text: "Mode approved. Execute the plan." }
  │
  ├─ Loop picks up synthetic message on next iteration:
  │   agent = resolve(lastUserMessage.agent)  // "build"
  │   tools = resolve(agent.permissions)       // full tool access
  │   reminders = buildReminders(prevAgent → newAgent)
  │
  └─ Agent B (build) continues in same session with same history
```

**Why synthetic messages, not state transitions:**
- **Conversation history preserved** — Agent B sees everything Agent A did (exploration, Q&A, reasoning)
- **No special state machine** — the main loop already processes user messages; synthetic messages are just messages
- **Auditable** — the mode switch appears in message history as a regular turn
- **Prompt-injectable** — `insertReminders()` detects agent transitions and injects context-specific instructions (e.g., "you switched from plan to build, a plan file exists at X")

**Common mode transitions:**
- Plan → Build (read-only exploration → full edit access)
- Build → Plan (user wants to step back and redesign)
- Primary → Subagent (delegation via task tool — creates child session instead)

### 2.8 Parallel Multi-Tool Execution (Batch Tool)

Let the LLM request multiple independent tool calls in a single response, executed in parallel via `Promise.all()`. This cuts wall-clock time for parallel-safe operations (reading multiple files, searching multiple patterns).

```
Without batch:                        With batch:
  LLM → read(a.ts)  → result          LLM → batch([
  LLM → read(b.ts)  → result                  read(a.ts),
  LLM → grep("TODO") → result                 read(b.ts),
  3 sequential round-trips                     grep("TODO")
                                             ]) → all results
                                       1 round-trip, parallel execution
```

**Design decisions:**
- **Disallow nesting** — batch inside batch is blocked (prevents exponential fan-out)
- **Per-call permission checks** — each call within the batch gets independent permission evaluation
- **Per-call state tracking** — each sub-call has its own lifecycle (running → completed/error) for UI streaming
- **Aggregated result** — `"Batch execution (N/M successful)"` with per-call outputs concatenated

**When to use:** Any agent with tools that are frequently called in parallel-safe sequences. Particularly effective for: file reading, code search, web fetching, API calls to independent endpoints.

**When NOT to use:** When tool calls have dependencies (read result informs next edit) or when tools have side effects that could conflict (two edits to the same file).

### 2.9 Pre-processing & Shortcuts

Not every request needs the full agent loop. Add a lightweight pre-processing node before the LLM:
- **Button/command detection**: exact text match → skip LLM entirely, call the right API directly
- **Stub/maintenance check**: query backend health → return canned response if down
- **Classification cache**: if the same query type was just classified, reuse the result

This saves latency and tokens for predictable inputs.

### 2.10 Two-Tier Model Strategy

Use different models for different cognitive loads within the same agent pipeline:

- **Expensive model** (Claude Sonnet/Opus) — reasoning, planning, orchestration, tool selection
- **Cheap model** (GPT-4o-mini, Haiku) — summarization, extraction, classification, formatting

Typical application: a search tool fetches web content, a cheap model summarizes it into a structured result (Pydantic schema), and the expensive model reasons over the summaries.

**Why it works:** Summarization doesn't need frontier-model reasoning — it's a compression task. Routing it to a cheap model saves tokens on the main agent's context window while keeping the pipeline fast.

### 2.11 No-Plan Architecture (Planning via System Prompt)

Not every agent needs a formal plan-and-execute phase. You can delegate planning entirely to the LLM via the system prompt — no plan object, no plan tool, no plan state machine.

**When this works:**
- Conversational agents where most interactions are 1-5 tool calls
- Diverse, unpredictable task types (messaging channels with open-ended queries)
- Latency-sensitive environments where a planning call doubles response time

**When you need explicit planning:**
- Complex multi-step tasks requiring 20+ tool calls
- Tasks where plan visibility matters (user wants to approve the approach)
- Tasks requiring parallel fan-out to sub-agents (need a plan to know what to fan out)

**The tradeoff:** Without explicit planning, the agent can lose coherence on long runs. Mitigate through TODO anchoring (§3.1), think tool (§3.6), and context recovery (§3.10) — not through plan-and-execute.

**Practical implication:** If you start with a no-plan architecture and find the agent drifting on long tasks, add a TODO/plan tool (§3.1) rather than redesigning the entire loop. Planning can be incremental.

### 2.12 Pure LLM Tool Selection (No Planner, No Router)

Use no tool routing logic — the LLM selects tools purely from its available tool set. No planner scores tool relevance. No rule-based router pre-filters. No tool recommendation engine suggests options.

**Why this works at scale (30+ tools, 50+ skills):**
1. **Policy filtering** — a tool policy pipeline removes tools the agent shouldn't use, so the LLM only sees relevant tools
2. **Canonical ordering** — core tools listed first in a fixed order prevents positional bias
3. **Dynamic descriptions** — tool descriptions extracted from tool objects, not hardcoded, so they stay accurate
4. **Skill budget** — skills listed as a scannable catalog, not inlined, preventing prompt bloat

**When you need a planner/router:**
- When tool selection accuracy drops below acceptable thresholds with pure LLM choice
- When you have 100+ tools and the LLM can't reliably pick the right one
- When tool selection needs deterministic guarantees (compliance, safety-critical)

**Anti-pattern to avoid:** Don't add a tool recommender as a first optimization. Instead, improve tool descriptions, reduce the tool set via policy filtering, and fix ordering. These are cheaper and often sufficient.

### 2.13 Fuzzy Tool Input Resilience (Fallback Matching)

LLMs are imprecise about whitespace, indentation, escape characters, and exact string reproduction. When a tool requires exact matching (e.g., find-and-replace in a file), don't fail on the first mismatch — use a **fallback chain of increasingly fuzzy matchers**.

**Pattern — generator-based fallback chain:**
```
Tool receives (old_string, new_string, file_content):
  │
  ├─ Strategy 1: Exact string match
  ├─ Strategy 2: Line-by-line whitespace-trimmed
  ├─ Strategy 3: First/last line anchors + body similarity
  ├─ Strategy 4: Whitespace-normalized
  ├─ Strategy 5: Indentation-agnostic
  ├─ Strategy 6: Escape sequence normalization
  ├─ Strategy 7: Trimmed content boundaries
  ├─ Strategy 8: Context-aware (context lines + >50% body similarity)
  └─ Strategy 9: Multi-occurrence (for replace-all operations)

  First strategy that produces exactly ONE unique match wins.
  Multiple matches → try next strategy (ambiguity is worse than no match).
```

**Why generators:**
```typescript
// Each strategy is a generator yielding candidate match strings
function* whitespaceNormalized(needle, haystack) {
  const normalized = normalize(needle)
  for (const candidate of findCandidates(haystack)) {
    if (normalize(candidate) === normalized) yield candidate
  }
}

// First unique match from any strategy wins
for (const strategy of strategies) {
  const matches = [...strategy(oldString, fileContent)]
  if (matches.length === 1) return applyEdit(matches[0], newString)
}
```

- Lazy evaluation — expensive strategies only run if cheap ones fail
- Each strategy independently validates uniqueness (single match)
- New strategies can be added to the chain without modifying existing ones

**Impact:** In practice, this takes edit tool success rate from ~80% (exact match only) to ~98% (with fuzzy chain). The LLM hallucinates whitespace frequently, but the semantic intent is usually correct.

**When to apply this pattern:** Any tool where the LLM must reproduce exact content from memory (find-and-replace, patch application, code insertion at specific locations). Less relevant for tools with structured parameters (API calls, file paths).

### 2.14 Post-Model Guardrails (Belt-and-Suspenders Enforcement)

Prompt-level instructions ("max 3 task calls per response") are best-effort — the LLM can and will violate them. `recursion_limit` catches infinite loops but not per-turn overcommitment. Add a third enforcement layer: **post-model output processing** that silently corrects violations before tool execution.

**Pattern — `after_model` hook:**
```python
class SubagentLimitMiddleware:
    def __init__(self, max_concurrent: int = 3):
        self.max_concurrent = clamp(max_concurrent, 2, 4)

    def after_model(self, state):
        last_msg = state["messages"][-1]
        tool_calls = last_msg.tool_calls

        # Find task tool calls that exceed the limit
        task_indices = [i for i, tc in enumerate(tool_calls) if tc["name"] == "task"]
        if len(task_indices) <= self.max_concurrent:
            return None  # no correction needed

        # Silently drop excess task calls
        indices_to_drop = set(task_indices[self.max_concurrent:])
        truncated = [tc for i, tc in enumerate(tool_calls) if i not in indices_to_drop]
        return {"messages": [last_msg.copy(update={"tool_calls": truncated})]}
```

**Three enforcement layers (use all three):**

| Layer | When | Mechanism | Failure mode |
|-------|------|-----------|--------------|
| Prompt instructions | Before generation | "Max N task calls per response" | LLM ignores it (~10-20% of the time) |
| Post-model guardrail | After generation, before execution | `after_model` hook truncates excess | Silent, deterministic, no token cost |
| Recursion limit | Across turns | `recursion_limit=100` | Stops infinite loops but not per-turn excess |

**Why silent truncation, not error feedback:** Returning an error ("you called too many tools") wastes a turn — the LLM retries with fewer calls, costing tokens and latency. Silent truncation achieves the same result in zero extra turns. The system prompt warns "excess calls are silently discarded" so the LLM learns to self-limit.

**When to apply:** Any constraint the LLM frequently violates despite clear prompt instructions. Common cases: max parallel tool calls, forbidden tool combinations, output format requirements that can be mechanically verified.

### 2.15 Prompt-Driven Plan Execution (No Engine)

An alternative to formal plan-and-execute architectures: use **prompt injection and convention** to drive plan execution, with no plan parser, step tracker, or execution engine.

```
Plan phase:
  Plan agent explores codebase, writes plan to a markdown file
  Plan agent calls plan_exit → synthetic message switches to build agent

Execution phase:
  Build agent receives: "A plan file exists at {path}. Execute it."
  Build agent reads the plan file with the read tool
  Build agent follows the plan using standard tools
  Build agent tracks progress via TodoWrite (optional, prompt-guided)
```

**What makes this work:**
1. **The plan is a regular file** — markdown, no schema, no structured format. The LLM writes natural language.
2. **Execution is just "read file, follow instructions"** — the build agent already knows how to use tools. The plan file is just context.
3. **TodoWrite provides progress tracking** — the agent creates a task list from plan steps and marks items complete as it works. This is prompt-guided, not enforced.
4. **The user sees the plan** — it's a readable markdown file, not an internal data structure.

**Tradeoffs vs. structured plan-and-execute:**
| | Prompt-driven | Structured engine |
|---|---|---|
| Plan format | Free-form markdown | Schema-enforced steps |
| Step tracking | Optional (TodoWrite) | Built-in state machine |
| Verification | Prompt-guided | Programmatic assertions |
| Flexibility | Agent adapts freely | Steps execute in order |
| Debuggability | Read the plan file | Inspect step execution state |

**When prompt-driven works:** When the LLM is capable enough to follow a written plan reliably (frontier models). When plans need human readability. When rigid step ordering would be too constraining.

**When you need a structured engine:** When plans must execute in exact order. When step failures need programmatic fallbacks. When plan compliance must be verified mechanically (audit requirements).

---

## 3. Context Engineering

As agent tasks grow longer (~50+ tool calls), **context rot** becomes the primary failure mode: the LLM's attention degrades with distance from the current position, causing mission drift, forgotten objectives, and information loss across multi-agent handoffs ("game of telephone"). These patterns address context management as a first-class concern.

### 3.1 TODO Lists as Context Anchors

A TODO tool that the agent continuously rewrites to combat context rot. Inspired by Claude Code's `TodoWrite` and Manus.

**Core insight**: forcing the LLM to rewrite the full TODO list acts as self-prompting — it recites its objectives at the end of the context, re-anchoring attention.

**Design decisions:**
- **Full overwrite, not append**: the LLM rewrites the entire list each time, allowing it to reprioritize and prune. No custom reducer — each update replaces the list.
- **One `in_progress` at a time**: prevents the agent from losing focus across concurrent tasks.
- **Write-read-reflect cycle**: after completing a task, read the TODO back, reflect on progress, then update.

```python
class Todo(TypedDict):
    content: str
    status: Literal["pending", "in_progress", "completed"]

class DeepAgentState(AgentState):
    todos: NotRequired[list[Todo]]  # absent in initial state, no mandatory init

@tool(description=WRITE_TODOS_DESCRIPTION, parse_docstring=True)
def write_todos(
    todos: list[Todo],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    """Create or update the full TODO list.

    Args:
        todos: Complete list of all tasks with their statuses.
    """
    return Command(update={
        "todos": todos,
        "messages": [ToolMessage(f"Updated todo list to {todos}", tool_call_id=tool_call_id)],
    })
```

**Prompt workflow** (instruct the agent):
1. Create TODO at the start of every task
2. After completing a TODO, call `read_todos` to remind yourself
3. Reflect on what you've done and what's next
4. Mark task completed, set next task to `in_progress`
5. Batch research tasks into a single TODO to reduce overhead

### 3.2 Virtual Filesystem for Context Offloading

A `dict[str, str]` backed virtual filesystem stored in agent state. Agents write token-heavy content (search results, analysis drafts, collected data) to files and keep only lightweight summaries in messages.

**Why virtual, not real files:**
- Enables backtracking and restoring via checkpointing — impossible with real disk I/O
- Thread-scoped persistence: files live for the duration of a conversation, not beyond
- No filesystem permissions, sandboxing, or cleanup concerns

```python
def file_reducer(left: dict | None, right: dict | None) -> dict:
    """Merge-dict reducer: new values overwrite existing keys, other keys preserved."""
    if left is None: return right
    if right is None: return left
    return {**left, **right}

class DeepAgentState(AgentState):
    files: Annotated[NotRequired[dict[str, str]], file_reducer]
```

**Tool suite**: `ls`, `read_file` (with offset/limit pagination, `cat -n` line numbers, 2000-char line truncation), `write_file`, `edit_file` (exact string matching).

**Key**: `write_file` returns only a confirmation in the `ToolMessage`, NOT the file content. Heavy content goes to state; lightweight acknowledgment goes to messages:

```python
@tool
def write_file(
    file_path: str, content: str,
    state: Annotated[DeepAgentState, InjectedState],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    files = state.get("files", {})
    files[file_path] = content
    return Command(update={
        "files": files,
        "messages": [ToolMessage(f"Updated file {file_path}", tool_call_id=tool_call_id)],
    })
```

### 3.3 The Orient-Save-Read Workflow

A concrete workflow pattern for agents that need to gather, store, and process information:

1. **Orient**: call `ls()` to see what files already exist before starting work
2. **Save**: write collected content (user request, search results, intermediate analysis) to files immediately — before context compression can eliminate it
3. **Read**: when ready to produce output, `read_file` the stored content for precise reference

**Why save early**: for long-running agents, context content can be compressed or dropped by the runtime. Storing information in files before this happens and retrieving when needed is proactive context engineering.

### 3.4 Context Isolation via Sub-Agents

Sub-agents receive a **completely fresh context** containing only their task description. This prevents context clash, confusion, and poisoning from the parent's conversation history.

**The critical line**: replace messages entirely before invoking the sub-agent:

```python
@tool
def task(
    description: str,
    subagent_type: str,
    state: Annotated[DeepAgentState, InjectedState],
    tool_call_id: Annotated[str, InjectedToolCallId],
):
    sub_agent = agents[subagent_type]
    # Fresh context — sub-agent sees ONLY the task description
    state["messages"] = [{"role": "user", "content": description}]
    result = sub_agent.invoke(state)
    return Command(update={
        "files": result.get("files", {}),  # Merge file changes back
        "messages": [ToolMessage(result["messages"][-1].content, tool_call_id=tool_call_id)],
    })
```

**Shared state, isolated messages**: the `files` dict is shared (merged back via `file_reducer`), enabling file-based inter-agent communication. But `messages` are replaced, so each sub-agent starts with a clean context. Sub-agents can't see each other's work — provide complete standalone instructions.

### 3.5 Content Summarization Pipeline

When a tool fetches external content (web search, API call), summarize it before it enters the agent's context:

```
Search query → HTTP fetch → HTML-to-markdown → Structured summarize (cheap model)
  → UUID filename → Write to virtual file → Return minimal summary to agent
```

```python
class Summary(BaseModel):
    filename: str = Field(description="Name of the file to store.")
    summary: str = Field(description="Key learnings from the webpage.")

@tool
def tavily_search(
    query: str,
    state: Annotated[DeepAgentState, InjectedState],
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_results: Annotated[int, InjectedToolArg] = 1,  # hidden from LLM
) -> Command:
    results = run_tavily_search(query, max_results=max_results)
    files = state.get("files", {})
    summaries = []
    for result in results:
        summary_obj = summarize_webpage_content(result["content"])  # cheap model
        uid = base64.urlsafe_b64encode(uuid.uuid4().bytes).rstrip(b"=").decode("ascii")[:8]
        name, ext = os.path.splitext(summary_obj.filename)
        filename = f"{name}_{uid}{ext}"
        files[filename] = result["content"]  # full content → file
        summaries.append(f"- {filename}: {summary_obj.summary}")  # summary → message
    return Command(update={
        "files": files,
        "messages": [ToolMessage("\n".join(summaries), tool_call_id=tool_call_id)],
    })
```

**Key details:**
- UUID suffix on filenames prevents collisions across searches
- `InjectedToolArg` hides config params (not state) from the LLM schema — distinct from `InjectedState`
- The summarization model is cheap (GPT-4o-mini), not the main reasoning model

### 3.6 Think Tool (No-Op Forced Reflection)

A tool that does nothing computationally — it returns its input unchanged. Its purpose is to force the LLM to produce a structured reasoning step that stays in context as a `ToolMessage`.

```python
@tool(parse_docstring=True)
def think_tool(reflection: str) -> str:
    """Tool for strategic reflection on research progress and decision-making.

    Reflection should address:
    1. Analysis of current findings
    2. Gap assessment — what's missing
    3. Quality evaluation — is the evidence sufficient
    4. Strategic decision — what to do next

    Args:
        reflection: Your structured reflection.
    """
    return f"Reflection recorded: {reflection}"
```

**Why it works**: the LLM produces better decisions when forced to articulate reasoning as a tool call. The detailed docstring guides what to reflect about. The reflection persists in message history as an explicit reasoning checkpoint.

### 3.7 Prompt Caching-Aware Context Design

Most LLM providers (Anthropic, OpenAI, Google) support **prompt caching** — reusing the KV-cache of a previously seen prefix to skip recomputation. Cache hits are ~10x cheaper and significantly faster than reprocessing. Agents that make many sequential LLM calls (ReAct loops, multi-turn conversations) benefit enormously, but only if the context is structured to maximize prefix reuse.

**How it works (provider-agnostic):** The provider caches the computed representation of a prompt prefix. On subsequent requests, if the prefix matches byte-for-byte, the cached computation is reused. Any change in the prefix invalidates downstream cache.

**Cache hierarchy (Anthropic-specific but conceptually universal):**
```
tools → system prompt → messages (in order)
```
Changes at any level invalidate that level and all subsequent levels. Changing a tool definition invalidates everything. Changing the system prompt invalidates system + messages. Appending a new message preserves the cache for everything before it.

**Core principle — append-only context:**

Never modify or reorder earlier messages. Only append new messages at the end. This maximizes prefix reuse across turns:

```
Turn 1: [system] + [user:A]                         → cache miss, write
Turn 2: [system] + [user:A] + [asst:B] + [user:C]   → cache hit on [system]+[user:A], write new
Turn 3: [system] + [user:A] + [asst:B] + [user:C] + [asst:D] + [user:E]  → cache hit through [user:C]
```

If turn 2 had reformulated `[user:A]` instead of appending, the entire cache would be invalidated.

**Practical rules for agent builders:**

1. **Static content first, dynamic content last.** Place tool definitions, system instructions, few-shot examples, and reference documents at the beginning. Put the evolving conversation at the end. The static prefix gets cached once and reused across all turns.

2. **Don't rewrite history.** Never modify the system prompt or earlier messages between turns. For dynamic state injection (§2.5), put working memory into the latest user message — the system prompt stays static and cached.

3. **Summarize-and-append, don't summarize-and-replace.** When context grows too large, summarize older messages with a cheap model and append the summary as a new message. Don't delete the old messages mid-conversation (that invalidates cache). Instead, start a new conversation branch with: `[system] + [summary of prior context] + [recent messages]`.

4. **Use explicit cache breakpoints at stability boundaries.** Mark the end of your static system prompt and tool definitions with a cache breakpoint. This ensures the stable prefix is cached independently from the volatile conversation:

```python
# Anthropic example — explicit breakpoint on system prompt
response = client.messages.create(
    model="claude-sonnet-4-6",
    system=[{
        "type": "text",
        "text": SYSTEM_PROMPT + TOOL_INSTRUCTIONS + FEW_SHOT_EXAMPLES,
        "cache_control": {"type": "ephemeral"},  # breakpoint: cache this independently
    }],
    cache_control={"type": "ephemeral"},  # auto-cache conversation tail
    messages=conversation_history,  # append-only
)
```

5. **Progressive summarization with cheap models.** When context exceeds a threshold (e.g., 80% of window), summarize the oldest N messages using a cheap model (Haiku, GPT-4o-mini). The summarization prompt should preserve: key decisions made, facts discovered, current plan state, and any file/artifact references. Inject the summary as the first user message in a fresh conversation:

```python
def maybe_compress_context(messages, max_tokens=100_000):
    token_count = estimate_tokens(messages)
    if token_count < max_tokens * 0.8:
        return messages  # no compression needed

    # Split: old messages to summarize, recent messages to keep verbatim
    split_point = len(messages) // 2
    old_messages = messages[:split_point]
    recent_messages = messages[split_point:]

    summary = cheap_model.invoke(
        f"Summarize this conversation preserving: decisions made, "
        f"facts discovered, current plan, and artifact references.\n\n"
        f"{format_messages(old_messages)}"
    )

    return [
        {"role": "user", "content": f"<context_summary>\n{summary}\n</context_summary>"},
        {"role": "assistant", "content": "Understood. I have the context from our prior conversation."},
        *recent_messages,
    ]
```

6. **Keep tool definitions static — disable tools via error responses, not schema removal.** Tools sit at the top of the cache hierarchy (`tools → system → messages`). Removing a tool from the `tools` array invalidates the entire prompt cache. Use a two-step escalation instead:

**Step 1 — error stub (cache-safe, handles ~99% of cases):** The tool remains in the schema but returns a structured error when called after a budget/limit is reached. The LLM learns from the error and stops calling it. Reinforce by injecting a "do NOT call tool X" reminder into the latest user message via §2.5 working memory.

**Step 2 — remove tool (cache-breaking fallback):** If the LLM calls the tool *again* despite the error, remove it from the `tools` array on the next turn. This invalidates the cache but prevents an infinite loop. This is a safety net that should rarely trigger.

```python
@tool
def web_search(query: str, state: Annotated[dict, InjectedState],
               tool_call_id: Annotated[str, InjectedToolCallId]):
    remaining = state.get("search_budget", 3)
    if remaining <= 0:
        # Step 1: error stub (cache-safe). Track that we returned an error.
        return Command(update={
            "search_exhausted": True,
            "messages": [ToolMessage(
                "Search limit reached (3/3 used). You MUST use already collected information.",
                tool_call_id=tool_call_id,
            )],
        })
    # ... actual search logic ...
    return Command(update={"search_budget": remaining - 1, ...})

# In the agent node — step 2: remove tool only if LLM ignored the error
def agent_node(state):
    tools = ALL_TOOLS
    if state.get("search_exhausted"):
        tools = [t for t in tools if t.name != "web_search"]  # cache cost, but prevents loop
    return model.bind_tools(tools).invoke(state["messages"])
```

**Provider-specific notes:**
- **Anthropic**: Min cacheable prefix is 1024-4096 tokens (model-dependent). Up to 4 explicit breakpoints. 5-min TTL (refreshed on hit), optional 1-hour TTL at 2x cost. Cache reads = 10% of base input price.
- **OpenAI**: Automatic prompt caching on all requests ≥1024 tokens. No explicit breakpoints — caching is fully automatic and prefix-based. No additional cost for cache writes.
- **Google (Gemini)**: Supports explicit "cached content" objects that persist across requests with configurable TTL.

### 3.8 Tool Output Truncation with File Offloading

Tool outputs (file reads, search results, command output) can be arbitrarily large. Sending them verbatim into the conversation floods the context window. Truncate automatically and offload the full output to a retrievable location.

**Pattern:**
```
Tool returns output (any size)
  │
  ├─ output ≤ threshold (e.g., 2000 lines / 50KB)?
  │   YES → return as-is
  │   NO  → truncate to threshold
  │         save full output to temp file
  │         append hint: "[Output truncated. Full output: /tmp/tool_output_abc123.txt]"
  │         return truncated output + hint
```

**Key decisions:**
- **Automatic, not opt-in** — applied by the `Tool.define()` wrapper so every tool gets truncation for free. Tool authors don't think about it.
- **Dual threshold** — line count AND byte count. Prevents both "10K short lines" and "one 5MB line" from flooding context.
- **Retrievable full output** — the LLM can read the temp file if it needs more. The hint tells it where to look.
- **Temp file cleanup** — files expire after a TTL (e.g., 7 days) to prevent disk bloat.

**Why not just summarize?** Summarization loses precision. For code search results, grep output, or error logs, the LLM often needs exact content — just not all of it at once. Truncation + file offloading preserves precision while protecting context.

**Difference from §3.2 (virtual filesystem):** Virtual FS is agent-driven (the agent decides to save). Output truncation is framework-driven (happens automatically at the tool boundary). Both serve context protection, but truncation is a safety net while virtual FS is a strategy.

### 3.9 Context-Loss Detection & Re-injection

When the agent writes state to a tool call (TODO list, plan, configuration), that state exists in the message history. As the conversation grows, the original tool call scrolls out of the effective attention window — the LLM "forgets" its plan even though the data is technically still in messages.

**Pattern — middleware-based detection:**
```python
class TodoMiddleware:
    def before_model(self, state):
        todos = state.get("todos")
        if not todos:
            return None  # no todos to track

        # Check if the original write_todos call is still in recent context
        messages = state["messages"]
        has_recent_write = any(
            getattr(msg, "name", None) == "write_todos"
            for msg in messages[-20:]  # check last N messages
        )

        if has_recent_write:
            return None  # still visible, no action needed

        # Re-inject reminder as a HumanMessage so the LLM re-reads its plan
        reminder = format_todos_as_reminder(todos)
        return {"messages": [HumanMessage(content=reminder)]}
```

**Why this matters:** TODO anchoring (§3.1) works by having the agent rewrite its plan. But if the agent doesn't know it has a plan (because the original `write_todos` call is 50 messages ago), it won't rewrite it. Detection + re-injection closes this gap.

**When to apply:** Any state that the agent manages via tool calls and needs to remember across long conversations — TODO lists, configuration settings, accumulated context. The pattern generalizes beyond TODOs to any "important state that can scroll away."

**Design choice — reminder, not full re-injection:** Inject a concise reminder ("You have an active TODO list: ...") rather than replaying the full tool call. This uses fewer tokens and gives the agent a nudge rather than a verbose replay.

### 3.10 Auto-Continue After Context Recovery

When context compaction is triggered automatically (not by the user), inject a synthetic continuation message so the agent keeps working without manual intervention.

```
Agent working on multi-step task:
  ... tool calls, reasoning, progress ...
  │
  ├─ Context overflow detected mid-stream
  ├─ Compaction triggered → LLM summarizes conversation → summary replaces old messages
  │
  ├─ WITHOUT auto-continue:
  │   Agent stops. User must manually say "continue."
  │   Breaks flow. User may not notice for minutes.
  │
  └─ WITH auto-continue:
      Inject synthetic user message:
        "Continue if you have next steps, or stop and ask for
         clarification if you are unsure how to proceed."
      Agent resumes work seamlessly.
```

**Why it matters:** Context compaction is an infrastructure concern — the user shouldn't need to babysit it. The synthetic message gives the agent permission to continue while also providing an escape hatch ("stop if unsure") to prevent runaway behavior after context loss.

**When NOT to auto-continue:** When compaction was user-initiated (they explicitly asked to reset/summarize). In that case, the user likely wants to steer the conversation, not have the agent barrel ahead.

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
- **Override pattern**: `@tool(description=CONSTANT)` separates the LLM-facing description from the code docstring. The `description` parameter replaces the docstring for the LLM, letting you keep app-specific instructions in a prompts module.

### Structured Output Prompts

When using `with_structured_output` / Pydantic schemas:
- **Remove** JSON format examples from the prompt — the schema is provided via function calling
- **Keep** semantic rules: valid values, edge cases, field relationships, dictionaries/mappings
- **Keep** classification logic and examples that help the LLM decide field values

### Composite Prompt Assembly

Build system prompts from modular constants, not monolithic strings:

```python
INSTRUCTIONS = (
    "# TODO MANAGEMENT\n" + TODO_USAGE_INSTRUCTIONS
    + "\n\n" + "=" * 80 + "\n\n"
    + "# FILE SYSTEM USAGE\n" + FILE_USAGE_INSTRUCTIONS
    + "\n\n" + "=" * 80 + "\n\n"
    + "# SUB-AGENT DELEGATION\n" + SUBAGENT_INSTRUCTIONS
)
```

Each module owns its prompt section. Separator lines (`===`) visually delineate sections for the LLM. Use XML tags (`<Task>`, `<Instructions>`, `<Hard Limits>`) within sections for further structure.

### Hard Limits in Delegation Prompts

Prevent runaway research loops at the prompt level (complementing `recursion_limit` at the graph level):

```
<Hard Limits>
- Simple queries: 1-2 tool calls max
- Normal research: 2-3 tool calls max
- Complex multi-faceted: up to 5 tool calls max
- STOP when 3+ relevant sources found
- STOP when last 2 searches return similar information
</Hard Limits>
```

### Scaling Rules for Sub-Agent Delegation

Give the orchestrator concrete guidance on how many sub-agents to spawn:

```
- Simple fact-finding: 1 sub-agent
- A-vs-B comparison: 1 sub-agent per element
- Multi-faceted research: parallel agents for different aspects
- Each sub-agent stores findings in separate files
- Max N parallel agents per iteration (to limit cost)
```

Instruct parallel execution explicitly: *"When you identify multiple independent research directions, make multiple task tool calls in a single response to enable parallel execution."*

---

## 5. References

### Key Papers & Posts
- [ReAct: Synergizing Reasoning and Acting](https://arxiv.org/abs/2210.03629) — the foundational pattern
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) — planning before execution
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production

### Architecture Deep-Dives
- [OpenCode Architecture](./inspections/opencode.md) — agents-as-config, fuzzy edit matching, permission-as-data, prompt-driven planning, batch tool, snapshot/revert
- [OpenClaw Architecture](./inspections/openclaw.md) — multi-channel agent platform, tool policy pipeline, auth failover, dual-loop, HITL
- [DeerFlow Inspection](./inspections/deer_flow.md) — middleware chain architecture, subagent executor with background pools, memory system with upload scrubbing, post-model guardrails

### Tutorials
- [deep-agents-from-scratch](../deep-agents-from-scratch/) — progressive tutorial: TODO anchoring → virtual filesystem → sub-agents → full research agent
