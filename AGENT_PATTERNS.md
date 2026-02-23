# Agentic Patterns & Best Practices

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

## 5. Anti-Patterns & Pitfalls

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

> For infrastructure-level anti-patterns (auth, concurrency, security), see [INFRA_PATTERNS.md](./INFRA_PATTERNS.md#5-anti-patterns--pitfalls).

---

## 6. References

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

### Key Papers & Posts
- [ReAct: Synergizing Reasoning and Acting](https://arxiv.org/abs/2210.03629) — the foundational pattern
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) — planning before execution
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production
