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
      1. [✅ completed] Fetch CFR data for УОР
      2. [🔄 in_progress] Fetch CFR data for УРТВБ
      3. [⏳ pending] Compare and analyze
    </plan>
    <active_references>
      metrics_a1b2: CFR data for УОР (metrics, diff)
    </active_references>
  </working_memory>

  [actual user query or tool results here]
```

Best format: structured text (XML tags, markdown sections). Keeps it parseable but doesn't waste tokens on JSON syntax.

**In framework code** (e.g., LangGraph), inject the working memory block by prepending it to the latest `HumanMessage` content before the LLM call, or as a separate content block within the same message. The prior conversation history remains untouched, preserving the cached prefix.

### 2.6 Pre-processing & Shortcuts

Not every request needs the full agent loop. Add a lightweight pre-processing node before the LLM:
- **Button/command detection**: exact text match → skip LLM entirely, call the right API directly
- **Stub/maintenance check**: query backend health → return canned response if down
- **Classification cache**: if the same query type was just classified, reuse the result

This saves latency and tokens for predictable inputs.

### 2.7 Two-Tier Model Strategy

Use different models for different cognitive loads within the same agent pipeline:

- **Expensive model** (Claude Sonnet/Opus) — reasoning, planning, orchestration, tool selection
- **Cheap model** (GPT-4o-mini, Haiku) — summarization, extraction, classification, formatting

Typical application: a search tool fetches web content, a cheap model summarizes it into a structured result (Pydantic schema), and the expensive model reasons over the summaries.

**Why it works:** Summarization doesn't need frontier-model reasoning — it's a compression task. Routing it to a cheap model saves tokens on the main agent's context window while keeping the pipeline fast.

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

**Provider-specific notes:**
- **Anthropic**: Min cacheable prefix is 1024-4096 tokens (model-dependent). Up to 4 explicit breakpoints. 5-min TTL (refreshed on hit), optional 1-hour TTL at 2x cost. Cache reads = 10% of base input price.
- **OpenAI**: Automatic prompt caching on all requests ≥1024 tokens. No explicit breakpoints — caching is fully automatic and prefix-based. No additional cost for cache writes.
- **Google (Gemini)**: Supports explicit "cached content" objects that persist across requests with configurable TTL.

---

## 4. LangGraph Patterns (Snippets)

### 4.1 State with Reducers and Output Schema

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

### 4.2 ReAct Loop Wiring

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

### 4.3 Command: Cross-Graph State Updates from Tools

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

### 4.4 Command with Routing (goto)

```python
def review_node(state) -> Command[Literal["approve", "reject"]]:
    decision = interrupt({"draft": state["draft"], "message": "Approve?"})
    if decision == "yes":
        return Command(update={"approved": True}, goto="approve")
    return Command(update={"approved": False}, goto="reject")
```

### 4.5 InjectedState, InjectedToolCallId & InjectedToolArg

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

### 4.6 Structured Output with Pydantic

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

### 4.7 Map-Reduce with Send API

Fan out to parallel node executions, collect results with a reducer:

```python
class State(TypedDict):
    topics: list[str]
    summaries: Annotated[list[str], operator.add]

def fan_out(state: State) -> list[Send]:
    return [Send("process", {"topic": t}) for t in state["topics"]]

builder.add_conditional_edges(START, fan_out)
```

### 4.8 Human-in-the-Loop with interrupt()

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

### 4.9 Checkpointing & Persistence

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

### 4.10 Sub-Graph as Tool (Full Pattern)

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

### 4.11 Sub-Agent Registry Factory

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

### 4.12 Streaming with Subgraph Visibility

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

## 5. Prompt Engineering for Agents

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
| No context anchoring on long tasks | Agent drifts from objectives after ~50 tool calls (context rot) | TODO write-read-reflect cycle (§3.1) |
| Raw tool results in messages | Token-heavy content fills context, displaces reasoning | Context offloading: content → files, summaries → messages (§3.2) |
| Sub-agents inherit parent context | Context clash, confusion, poisoning from irrelevant history | Replace messages with task-only context (§3.4) |
| Same model for all cognitive loads | Expensive model wasted on summarization/formatting | Two-tier: cheap model for extraction, expensive for reasoning (§2.7) |
| No structured reflection checkpoints | Agent makes impulsive decisions on complex multi-step tasks | think_tool forces articulated reasoning (§3.6) |
| Generic error strings from tools | LLM can't self-correct without knowing valid options | Include valid values and retry hints in error messages (§2.4) |
| Editing/reordering earlier messages between turns | Invalidates prompt cache, re-processes entire context at full cost | Append-only context: add new messages, never modify old ones (§3.7) |
| Using expensive model for context summarization | Wastes frontier-model capacity on a compression task | Summarize with cheap model (Haiku/GPT-4o-mini), keep expensive model for reasoning (§3.7) |

> For infrastructure-level anti-patterns (auth, concurrency, security), see [INFRA_PATTERNS.md](./INFRA_PATTERNS.md#5-anti-patterns--pitfalls).

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

### Key Papers & Posts
- [ReAct: Synergizing Reasoning and Acting](https://arxiv.org/abs/2210.03629) — the foundational pattern
- [Plan-and-Solve Prompting](https://arxiv.org/abs/2305.04091) — planning before execution
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production

### Tutorials
- [deep-agents-from-scratch](../deep-agents-from-scratch/) — progressive tutorial: TODO anchoring → virtual filesystem → sub-agents → full research agent
