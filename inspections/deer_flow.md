# DeerFlow 2.0 — Project Inspection

> **Project**: [bytedance/deer-flow](https://github.com/bytedance/deer-flow) (v2.0, ground-up rewrite)
> **Stack**: Python, LangGraph, LangChain, Docker sandboxes
> **Category**: Super agent harness — orchestrator + specialist subagents

---

## 1. Architecture & Agent Topology

**Topology**: Orchestrator + Specialist Subagents (Hub-and-Spoke, single level)

```
┌──────────────────────────────────────────┐
│           LEAD AGENT (Orchestrator)      │
│         make_lead_agent(config)          │
│                                          │
│  Decides: subagents vs direct tools      │
│  Max 3 concurrent task() calls per turn  │
└────────────┬─────────────────────────────┘
             │ task tool (background threads)
    ┌────────┼────────┐
    ▼        ▼        ▼
 ┌──────┐ ┌──────┐ ┌──────┐
 │sub 1 │ │sub 2 │ │sub 3 │   (parallel, isolated context)
 └──────┘ └──────┘ └──────┘
```

**Agent types**:
- **Lead agent**: Full tools + memory + skills + subagent delegation. Created per-request via `make_lead_agent(config)`.
- **Custom agents**: Same lead agent code, different config (`agents/{name}/config.yaml` + `SOUL.md`).
- **general-purpose subagent**: All tools minus task/clarification. Max 50 turns. For complex multi-step tasks.
- **bash subagent**: Only bash/file tools. Max 30 turns. For command execution.

**No nesting**: Subagents cannot spawn further subagents — `task` tool excluded from their tool set via `disallowed_tools` config and `subagent_enabled=False`.

**Communication**: Tool invocation only. Parent passes `sandbox_state` + `thread_data` but NOT messages or memory. Subagent results returned as ToolMessage text.

**Key files**:
- `backend/src/agents/lead_agent/agent.py` — agent factory
- `backend/src/subagents/executor.py` — background execution engine
- `backend/src/subagents/builtins/` — subagent configs (general_purpose, bash)
- `backend/langgraph.json` — LangGraph entry point registration

---

## 2. Thinking & Reasoning

**Implementation**: Model-native + system prompt guidance (no separate think tool or node).

- **Thinking style** injected via system prompt `<thinking_style>` block
- Teaches: think strategically → identify ambiguities → ask clarification FIRST → then act
- When `thinking_enabled=True`, model's native extended thinking is activated (Claude, o1, etc.)
- Configured per model: `supports_thinking`, `supports_reasoning_effort` in config.yaml
- **Visibility**: Internal only — "Never write full answer in thinking, only outline"

**Post-execution reflection**: Limited. No explicit reflection node. Implicit via:
- TodoMiddleware tracking task completion
- MemoryMiddleware extracting lessons for long-term memory
- Subagent result synthesis by lead agent

**Key insight**: Thinking is "free" when using model-native thinking. System prompt guidance ensures structured thinking even with models that don't support native thinking.

---

## 3. Planning & Execution

**Planning is embedded in the agent loop**, not a separate phase. Three planning modes:

### Mode 1: System Prompt Guidance (Always Active)
- **CLARIFY → PLAN → ACT** workflow enforced in system prompt
- Agent must identify ambiguities and ask for clarification before starting work
- Five clarification types: `missing_info`, `ambiguous_requirement`, `approach_choice`, `risk_confirmation`, `suggestion`

### Mode 2: TodoList Middleware (Opt-in via `is_plan_mode`)
- Uses LangChain's `TodoListMiddleware` with custom prompts
- `write_todos` tool creates/updates structured task list
- Task states: `pending` → `in_progress` → `completed`
- Context-loss detection: if `write_todos` scrolls out of context window, middleware injects reminder
- Rules: only for 3+ step tasks, real-time updates, exactly one `in_progress` at a time

### Mode 3: Subagent Batching (When `subagent_enabled`)
- **DECOMPOSE → DELEGATE → SYNTHESIZE** pattern
- System prompt enforces explicit counting and batch planning:
  1. COUNT sub-tasks in thinking
  2. PLAN BATCHES of ≤N (max_concurrent, default 3)
  3. EXECUTE current batch only
  4. REPEAT until all batches done
  5. SYNTHESIZE all results

**Plan revision**: Supported at all levels — todos can be updated/removed, subagent batches adapt based on prior results, clarification pauses execution.

**Key files**:
- `backend/src/agents/lead_agent/prompt.py` — system prompt with planning sections
- `backend/src/agents/middlewares/todo_middleware.py` — TodoList with context-loss detection
- `backend/src/agents/middlewares/clarification_middleware.py` — execution interrupt

---

## 4. Context Management

### Context Isolation
- **Subagents get clean context**: Only task prompt as HumanMessage, inherited sandbox/thread_data
- **No message history, no memory** passed to subagents — prevents context pollution
- Subagent results returned as text in ToolMessage to parent

### Token Budget Strategy (Multi-Level)

| Level | Component | Default | Strategy |
|-------|-----------|---------|----------|
| Memory injection | `memory_config.max_injection_tokens` | 2000 | Facts ranked by confidence, truncated to fit |
| Summarization | `SummarizationMiddleware` | Optional | Triggers on token/message thresholds |
| Model limit | `model_config.max_input_tokens` | Varies | Hard limit by LLM API |
| Recursion | `recursion_limit` | 100 (lead), 50 (sub) | Prevents infinite loops |

### Context-Loss Detection
- `TodoMiddleware` detects when `write_todos` has left context window
- Injects reminder HumanMessage so model stays aware of task list

### Tool Result Injection
- Standard LangGraph: `AIMessage(tool_calls)` → tool execution → `ToolMessage(result)` → next turn
- Special injections:
  - `ViewImageMiddleware`: HumanMessage with base64 image data
  - `UploadsMiddleware`: Prepends `<uploaded_files>` block to last HumanMessage
  - `TodoMiddleware`: HumanMessage reminder on context loss
  - `DanglingToolCallMiddleware`: Patches missing ToolMessages for interrupted calls

---

## 5. Tool System

### Three Tool Sources
1. **Config-based**: Loaded from `config.yaml` via reflection (`resolve_variable("src.sandbox.tools:bash_tool")`)
2. **Built-in**: `present_file`, `ask_clarification`, `task` (conditional), `view_image` (conditional)
3. **MCP servers**: Cached globally with staleness detection via config file mtime

### Tool Filtering
- **Per-agent**: `tool_groups` in agent config filters config-based tools
- **Per-model**: `view_image_tool` only if `supports_vision=True`
- **Per-runtime**: `task` tool only if `subagent_enabled=True`
- **Per-subagent**: Allowlist + denylist from SubagentConfig

### Meta-Tools
- `task` — delegates to subagent (flow control)
- `ask_clarification` — interrupts execution for user input (HITL)
- `write_todos` — manages task tracking (plan mode only)
- `view_image` — processes images for vision models
- `present_file` — registers output artifacts

### MCP Integration
- `langchain-mcp-adapters` for MCP server communication
- Transports: `stdio`, `sse`, `http`
- OAuth token flows supported for SSE/HTTP
- Global cache with `asyncio.Lock` for thread-safe lazy initialization

**Key files**:
- `backend/src/tools/tools.py` — tool composition
- `backend/src/mcp/cache.py` — MCP caching
- `backend/src/tools/builtins/` — built-in tool implementations

---

## 6. Flow Control & Error Handling

### Core Loop
- LangGraph agent compiled from `create_agent()` — model generates response, tools execute, loop until no more tool_calls
- Middleware chain runs on every turn (12 middlewares in strict order)

### Iteration Limits
- `recursion_limit`: 100 (lead), 50 (general-purpose sub), 30 (bash sub)
- Subagent timeout: 900s (15 min) enforced via `Future.result(timeout=...)`
- Polling safety: max_poll_count = (timeout + 60) / 5

### Termination
- **Natural**: Model generates no tool_calls
- **Interrupt**: `ClarificationMiddleware` returns `Command(goto=END)`
- **Limit**: Recursion limit or timeout reached

### Error Handling
- **ToolErrorHandlingMiddleware**: Catches all exceptions (except `GraphBubbleUp`), converts to `ToolMessage(status="error")` — agent loop continues
- **DanglingToolCallMiddleware**: Patches missing ToolMessages from interrupted calls
- **Subagent failures**: `SubagentStatus.FAILED` with error message returned to lead agent
- Error detail truncated to 500 chars to avoid context pollution

### Human-in-the-Loop
- `ask_clarification` tool → `ClarificationMiddleware` intercepts → `Command(goto=END)` → execution pauses
- State checkpointed; next user message resumes from interruption point
- No general-purpose pause/resume API beyond clarification

### Streaming Events
- `task_started` → `task_running` (per AI message) → `task_completed` / `task_failed` / `task_timed_out`
- SSE via `get_stream_writer()` from LangGraph

---

## 7. State & Persistence

### State Schema
```python
class ThreadState(AgentState):
    messages: list[BaseMessage]                              # append-only (inherited)
    sandbox: NotRequired[SandboxState | None]                # sandbox connection
    thread_data: NotRequired[ThreadDataState | None]         # workspace/uploads/outputs paths
    title: NotRequired[str | None]                           # auto-generated
    artifacts: Annotated[list[str], merge_artifacts]          # deduplicating reducer
    todos: NotRequired[list | None]                          # plan mode tasks
    uploaded_files: NotRequired[list[dict] | None]           # session-scoped
    viewed_images: Annotated[dict, merge_viewed_images]      # transient, cleared after use
```

### Custom Reducers
- `merge_artifacts`: Deduplicates while preserving insertion order
- `merge_viewed_images`: Merges dicts; empty dict `{}` clears all (reset signal)

### Persistence Backends
- **Memory** (in-process) — lost on restart
- **SQLite** (file-based) — persistent, single-node
- **PostgreSQL** — persistent, production-grade

### Working Memory vs Long-Term Memory
- **Working**: Message history in checkpointer (per thread), todos, uploaded files, viewed images
- **Long-term**: Memory JSON file with user context, history timeline, confidence-scored facts
  - Updated asynchronously via debounced queue (30s window)
  - LLM extracts facts/summaries from conversation
  - Upload mentions stripped to prevent ghost file references
  - Max 100 facts, pruned by lowest confidence

### What Survives What
| Data | Thread Resumption | Session Restart | Cross-Session |
|------|:-:|:-:|:-:|
| Messages | ✓ | ✓ (sqlite/pg) | ✗ |
| Artifacts | ✓ | ✓ (sqlite/pg) | ✗ |
| Todos | ✓ | ✓ (sqlite/pg) | ✗ |
| Memory (facts) | n/a | n/a | ✓ |
| Uploaded files | ✗ | ✗ | ✗ |
| Viewed images | ✗ | ✗ | ✗ |

---

## 8. Code Snippets

| Pattern | File | Description |
|---------|------|-------------|
| Agent Factory | `code_snippets/deer_flow/agent_factory.py` | Dynamic agent creation with middleware composition |
| Subagent Executor | `code_snippets/deer_flow/subagent_executor.py` | Background thread pool execution with polling |
| Middleware Chain | `code_snippets/deer_flow/middleware_chain.py` | Error handling, clarification interrupt, concurrency limit |
| Memory System | `code_snippets/deer_flow/memory_system.py` | LLM-powered memory with token-budgeted injection |
| Tool System | `code_snippets/deer_flow/tool_system.py` | Multi-source tool composition with MCP caching |
| Prompt Engineering | `code_snippets/deer_flow/prompt_engineering.py` | Dynamic prompt assembly with skills & subagent guide |

---

## Key Design Patterns

1. **Middleware-as-Architecture**: 12-middleware chain replaces traditional graph nodes for cross-cutting concerns. Ordering is critical (ClarificationMiddleware must be last).

2. **Two-Pool Background Execution**: Scheduler pool + execution pool enables timeout enforcement via `Future.result(timeout=...)` without blocking the main agent.

3. **Post-Model Truncation**: `SubagentLimitMiddleware.after_model()` silently drops excess task calls — more reliable than prompt-only limits.

4. **Tool-as-Flow-Control**: `ask_clarification` and `task` are "meta-tools" that control execution flow rather than performing external operations. Clarification interrupts via `Command(goto=END)`.

5. **Progressive Skill Loading**: Skills listed in system prompt but loaded on-demand via `read_file`. Keeps context window lean for token-sensitive models.

6. **Memory Upload Scrubbing**: Regex strips upload-event sentences from memory before saving — prevents ghost file references in future sessions.

7. **Config-Driven Personality**: Same agent codebase serves multiple "personalities" via `agents/{name}/config.yaml` (model, tool_groups) + `SOUL.md` (behavioral guardrails).

8. **Context-Loss Detection**: TodoMiddleware detects when plan has scrolled out of context window and re-injects reminder — prevents the model from "forgetting" its plan.
