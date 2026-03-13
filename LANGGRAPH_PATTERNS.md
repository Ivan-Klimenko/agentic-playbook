# LangGraph Patterns (Snippets)

LangGraph-specific implementation patterns and code examples. For framework-agnostic principles, see [AGENT_PATTERNS.md](./AGENT_PATTERNS.md).

> **Docs:** [Concepts](https://langchain-ai.github.io/langgraph/concepts/) | [How-To Guides](https://langchain-ai.github.io/langgraph/how-tos/) | [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) | [Workflows & Agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

---

## 1. State Design Principles

**Store raw data, not formatted text.** Format prompts inside nodes when you need them — different nodes can format the same data differently, and templates can change without breaking state.

**Only persist what can't be derived.** Ask two questions before adding a field:
- *Does it need to persist across multiple steps?* If not, compute it locally in the node.
- *Can I derive it from other state fields?* If yes, compute it on-demand instead of storing.

```python
# Good: raw data, each field has a clear reason to persist
class OrchestratorState(TypedDict):
    messages: Annotated[list, add_messages]          # append reducer
    refs: Annotated[dict[str, Ref], refs_reducer]    # merge-dict reducer
    analyses: Annotated[list[Summary], operator.add]  # list append
    plan: Annotated[list[PlanItem], plan_reducer]     # replace-all reducer
    output: str

# Bad: storing derived/formatted data
class BadState(TypedDict):
    messages: list
    formatted_prompt: str      # derived — format in the node instead
    message_count: int         # derived — use len(messages) instead
    last_response_upper: str   # derived — transform on read instead
```

Use `output_schema` to limit what's returned to the caller:

```python
class OrchestratorOutput(TypedDict):  # only these fields returned to caller
    output: str

graph = StateGraph(OrchestratorState, output_schema=OrchestratorOutput)
```

## 2. ReAct Loop Wiring

```python
from langgraph.prebuilt import tools_condition, ToolNode

graph.add_node("agent", agent_node)
graph.add_node("tools", ToolNode(ALL_TOOLS))
graph.add_edge(START, "agent")
graph.add_conditional_edges("agent", tools_condition, {
    "tools": "tools",
    "done": "response_formatter",
})
graph.add_edge("tools", "agent")  # the loop
graph.add_edge("response_formatter", END)
```

> **When to use `add_conditional_edges` vs `Command`:** Use `add_conditional_edges` for pure routing that doesn't need to update state (like this ReAct check). Use `Command(update=..., goto=...)` when you need to **update state and route in a single atomic step** (see §4). Don't mix both on the same node — `Command` adds dynamic edges, but any static edges from `add_edge` on that node **still fire alongside** the `Command` route.

## 3. Command: Cross-Graph State Updates from Tools

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

## 4. Command with Routing (goto)

`Command` combines state update + routing in one atomic step, eliminating the need for `add_conditional_edges` on that node:

```python
def review_node(state) -> Command[Literal["approve", "reject"]]:
    decision = interrupt({"draft": state["draft"], "message": "Approve?"})
    if decision == "yes":
        return Command(update={"approved": True}, goto="approve")
    return Command(update={"approved": False}, goto="reject")
```

> **Caveat:** The `Command[Literal[...]]` return type annotation is **required** — LangGraph uses it to discover possible destinations for graph rendering. Also note that `Command` only adds *dynamic* edges; any `add_edge` calls on the same source node will still execute, potentially causing duplicate transitions.

## 5. InjectedState, InjectedToolCallId & InjectedToolArg

Hide parameters from the LLM tool schema while injecting them at runtime:

```python
@tool
def my_tool(
    query: str,                                          # visible to LLM
    state: Annotated[dict, InjectedState],               # hidden, full state
    prefs: Annotated[dict, InjectedState("preferences")], # hidden, specific field
    tool_call_id: Annotated[str, InjectedToolCallId],    # hidden, auto-injected
    max_results: Annotated[int, InjectedToolArg] = 5,    # hidden, programmatic config
) -> str: ...
```

Three injection types:
- `InjectedState` — injects the full state (or a specific field) at runtime
- `InjectedToolCallId` — auto-injects the tool_call_id for constructing `ToolMessage` responses
- `InjectedToolArg` — hides programmatic configuration parameters (not state) from the LLM schema. Use for knobs the orchestrator controls (e.g., `max_results`, `topic`, `timeout`)

## 6. Structured Output with Pydantic

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

## 7. Map-Reduce with Send API

Fan out to parallel node executions, collect results with a reducer:

```python
class State(TypedDict):
    topics: list[str]
    summaries: Annotated[list[str], operator.add]

def fan_out(state: State) -> list[Send]:
    return [Send("process", {"topic": t}) for t in state["topics"]]

# Note: add_conditional_edges is reused here for fan-out (not routing).
# When the function returns list[Send], it spawns parallel node instances
# instead of choosing a single destination.
builder.add_conditional_edges(START, fan_out)
```

## 8. Human-in-the-Loop with interrupt()

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

**Key rules:**
- `interrupt()` requires a checkpointer. The `thread_id` is your resume pointer.
- **Place `interrupt()` at the top of the node.** Any code *before* `interrupt()` will re-execute on resume — the checkpoint saves state at the node boundary, not at the `interrupt()` call.

```python
# Good: interrupt first, then act on the result
def approval_node(state):
    answer = interrupt({"draft": state["draft"]})
    return {"approved": answer == "yes"}

# Bad: side effect before interrupt re-runs on every resume
def approval_node(state):
    send_notification(state["draft"])  # ⚠️ sends again on resume!
    answer = interrupt({"draft": state["draft"]})
    return {"approved": answer == "yes"}
```

## 9. Checkpointing & Persistence

```python
# In-memory (dev/testing) — built into langgraph
from langgraph.checkpoint.memory import InMemorySaver
graph = builder.compile(checkpointer=InMemorySaver())

# SQLite (single-process persistence) — pip install langgraph-checkpoint-sqlite
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
async with AsyncSqliteSaver.from_conn_string("checkpoints.db") as saver:
    graph = builder.compile(checkpointer=saver)

# Postgres (production, multi-process) — pip install langgraph-checkpoint-postgres
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
async with AsyncPostgresSaver.from_conn_string(conn_string) as saver:
    await saver.setup()  # create tables on first run
    graph = builder.compile(checkpointer=saver)
```

> **Note:** SQLite and Postgres checkpointers live in separate packages (`langgraph-checkpoint-sqlite`, `langgraph-checkpoint-postgres`), not in the core `langgraph` package.

Every `invoke()` with a `thread_id` saves state. Resume any thread, even after process restart (with durable checkpointer).

### Durability modes

Control when checkpoints are written for performance tuning:

```python
# Default: background checkpointing — minimal latency, async writes
graph = builder.compile(checkpointer=saver)

# "sync": block execution until checkpoint is written (strongest durability)
graph = builder.compile(checkpointer=saver, durability_mode="sync")

# "exit": checkpoint only at graph completion (fastest, no mid-run recovery)
graph = builder.compile(checkpointer=saver, durability_mode="exit")
```

## 10. Error Handling Strategies

Match error handling to the failure type:

| Error type | Handler | Strategy |
|---|---|---|
| Transient (network, rate limits) | System | `RetryPolicy` with backoff |
| LLM-recoverable (tool failure, bad parse) | LLM | Store error in state, loop back to agent |
| User-fixable (missing info, ambiguous input) | Human | `interrupt()` to collect input |
| Unexpected | Developer | Let it bubble up for debugging |

### RetryPolicy for transient errors

```python
from langgraph.types import RetryPolicy

builder.add_node(
    "call_api",
    call_api_node,
    retry_policy=RetryPolicy(max_attempts=5),  # exponential backoff by default
)

# Retry only on specific exceptions
builder.add_node(
    "query_db",
    query_db_node,
    retry_policy=RetryPolicy(retry_on=sqlite3.OperationalError),
)
```

### LLM-recoverable errors — loop back with error context

```python
def execute_tool(state: State) -> Command[Literal["agent", "execute_tool"]]:
    try:
        result = run_tool(state["tool_call"])
        return Command(update={"tool_result": result}, goto="agent")
    except ToolError as e:
        # Feed error back to the LLM so it can adjust
        return Command(
            update={"tool_result": f"Tool error: {str(e)}"},
            goto="agent",
        )
```

## 11. Node Granularity

Split nodes when they differ in **failure modes**, **external services**, or **retry strategies**. Smaller nodes checkpoint more frequently, reducing rework on failure.

```python
# Bad: one fat node with mixed concerns
def do_everything(state):
    data = fetch_from_api(state["query"])    # can fail (network)
    parsed = llm.invoke(format(data))        # can fail (LLM error)
    db.write(parsed)                         # can fail (DB error)
    return {"result": parsed}

# Good: separate nodes — each can retry/fail independently
builder.add_node("fetch", fetch_node, retry_policy=RetryPolicy(max_attempts=3))
builder.add_node("analyze", analyze_node)
builder.add_node("persist", persist_node, retry_policy=RetryPolicy(retry_on=DBError))
builder.add_edge("fetch", "analyze")
builder.add_edge("analyze", "persist")
```

> **Rule of thumb:** If two operations hit different external services or have different retry needs, they belong in separate nodes.

## 12. Sub-Graph as Tool (Full Pattern)


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

## 13. Sub-Agent Registry Factory

Pre-compile sub-agents into a registry and generate a `task` tool with dynamic description. Each sub-agent gets a targeted tool subset from a shared pool.

```python
class SubAgent(TypedDict):
    name: str
    description: str
    prompt: str
    tools: NotRequired[list[str]]  # tool names from shared pool

def _create_task_tool(tools, subagents: list[SubAgent], model, state_schema):
    # Build tool lookup
    tools_by_name = {}
    for t in tools:
        if not isinstance(t, BaseTool):
            t = tool(t)
        tools_by_name[t.name] = t

    # Pre-compile sub-agents with selective tool assignment
    agents = {}
    for sa in subagents:
        sa_tools = [tools_by_name[n] for n in sa["tools"]] if "tools" in sa else tools
        agents[sa["name"]] = create_agent(
            model, system_prompt=sa["prompt"], tools=sa_tools, state_schema=state_schema
        )

    # Inject available agents into tool description
    agents_desc = "\n".join(f"- {sa['name']}: {sa['description']}" for sa in subagents)

    @tool(description=f"Delegate a task to a sub-agent.\n\nAvailable agents:\n{agents_desc}")
    def task(description: str, subagent_type: str, ...):
        if subagent_type not in agents:
            return f"Error: unknown agent '{subagent_type}'. Valid: {list(agents.keys())}"
        ...

    return task
```

**Key decisions:**
- `tools_by_name` lookup lets each sub-agent pick specific tools from the shared pool
- Available agent types are injected into the tool description at registration time — the LLM knows its options
- Validation returns actionable error messages (valid agent names) so the LLM can self-correct

## 14. Streaming with Subgraph Visibility

Debug multi-agent systems by streaming updates from all levels:

```python
async for graph_name, stream_mode, event in agent.astream(
    query,
    stream_mode=["updates", "values"],  # incremental + complete state
    subgraphs=True,                      # see inside sub-agents
    config=config,
):
    if stream_mode == "updates":
        node, result = list(event.items())[0]
        if "messages" in result:
            display(result["messages"])
    elif stream_mode == "values":
        current_state = event
```

## 15. Functional API (`@entrypoint` / `@task`)

An alternative to `StateGraph` for simpler workflows that feel more like regular Python:

```python
from langgraph.func import entrypoint, task
from langgraph.checkpoint.memory import InMemorySaver

@task
def fetch_data(query: str) -> dict:
    return call_api(query)

@task
def analyze(data: dict) -> str:
    return llm.invoke(format_prompt(data)).content

@entrypoint(checkpointer=InMemorySaver())
def my_workflow(query: str) -> str:
    data = fetch_data(query).result()
    return analyze(data).result()

# Usage — same invoke/stream interface as StateGraph
result = my_workflow.invoke(
    "summarize recent sales",
    config={"configurable": {"thread_id": "t1"}},
)
```

> **When to use:** Prefer `@entrypoint`/`@task` for linear or lightly-branching workflows where explicit graph topology adds complexity without value. Use `StateGraph` when you need complex routing, cycles, or visual graph inspection.

## 16. Architectural Pattern Taxonomy

LangGraph supports several high-level patterns. Choose based on task structure:

| Pattern | When to use | LangGraph mechanism |
|---|---|---|
| **Prompt chaining** | Sequential steps where each transforms the previous output | `add_edge` chain |
| **Parallelization** | Independent subtasks that can run concurrently | `Send` API (§7) |
| **Routing** | Input determines which specialized branch to follow | `add_conditional_edges` or `Command` |
| **Orchestrator-worker** | Tasks that can't be predefined — orchestrator delegates dynamically | `Send` API or sub-graph tools (§12) |
| **Evaluator-optimizer** | Iterative refinement with a separate evaluator judging quality | Cycle between generator and evaluator nodes |
| **ReAct agent** | Open-ended tool use in a loop | Prebuilt `tools_condition` loop (§2) |

> **Workflows vs agents:** Workflows have predetermined code paths and are designed to operate in a fixed order. Agents dynamically decide their own process and tool usage. Use workflows when steps are known ahead of time; use agents when the problem requires autonomous exploration.

## 17. Caching in Nodes

LangGraph doesn't prescribe a caching strategy — implement it inside nodes based on your needs:

```python
from functools import lru_cache
from cachetools import TTLCache

# Simple in-memory cache for deterministic lookups
@lru_cache(maxsize=128)
def get_user_profile(user_id: str) -> dict:
    return db.query(user_id)

# TTL cache for data that goes stale
_api_cache = TTLCache(maxsize=256, ttl=300)  # 5-minute TTL

def fetch_node(state: State) -> dict:
    key = state["query"]
    if key not in _api_cache:
        _api_cache[key] = call_external_api(key)
    return {"data": _api_cache[key]}
```

> **Rule of thumb:** Cache at the node level, not the graph level. Use TTL for external API data, LRU for deterministic lookups. Don't cache LLM calls unless you're sure identical inputs should produce identical outputs.

---

## References

- [LangGraph Concepts](https://langchain-ai.github.io/langgraph/concepts/) — state, reducers, edges, persistence
- [LangGraph How-To Guides](https://langchain-ai.github.io/langgraph/how-tos/) — patterns with code
- [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) — mental model for graph design
- [LangGraph Workflows & Agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) — orchestrator-worker, map-reduce
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) — human-in-the-loop deep dive
- [LangGraph Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) — checkpointing, memory store
- [langgraph](https://github.com/langchain-ai/langgraph) — source + examples
- [langgraph-swarm-py](https://github.com/langchain-ai/langgraph-swarm-py) — handoff pattern implementation
- [langchain-ai/langchain](https://github.com/langchain-ai/langchain) — tools, structured output, chat models
