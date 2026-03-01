# LangGraph Patterns (Snippets)

LangGraph-specific implementation patterns and code examples. For framework-agnostic principles, see [AGENT_PATTERNS.md](./AGENT_PATTERNS.md).

> **Docs:** [Concepts](https://langchain-ai.github.io/langgraph/concepts/) | [How-To Guides](https://langchain-ai.github.io/langgraph/how-tos/) | [Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph) | [Workflows & Agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents) | [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) | [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence)

---

## 1. State with Reducers and Output Schema

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

## 2. ReAct Loop Wiring

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

```python
def review_node(state) -> Command[Literal["approve", "reject"]]:
    decision = interrupt({"draft": state["draft"], "message": "Approve?"})
    if decision == "yes":
        return Command(update={"approved": True}, goto="approve")
    return Command(update={"approved": False}, goto="reject")
```

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

**Key**: `interrupt()` requires a checkpointer. The `thread_id` is your resume pointer.

## 9. Checkpointing & Persistence

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

## 10. Sub-Graph as Tool (Full Pattern)

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

## 11. Sub-Agent Registry Factory

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

## 12. Streaming with Subgraph Visibility

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
