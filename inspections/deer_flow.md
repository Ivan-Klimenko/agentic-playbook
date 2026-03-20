# DeerFlow 2.0 — Project Inspection

> **Project**: [bytedance/deer-flow](https://github.com/bytedance/deer-flow) (v2.0, ground-up rewrite)
> **Stack**: Python, LangGraph, LangChain, Docker sandboxes
> **Category**: Super agent harness — orchestrator + specialist subagents
> **Last updated**: 2026-03-20

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

**Package structure** (split in Feb 2026):
```
backend/
├── packages/harness/deerflow/   # Core agent harness (model, tools, middleware, memory)
│   ├── agents/                  # Agent factory, middlewares, checkpointer, memory
│   ├── tools/                   # Tool composition and builtins
│   ├── mcp/                     # MCP server integration + caching
│   ├── subagents/               # Subagent registry, executor, configs
│   ├── skills/                  # Skill loader, parser, validation
│   ├── models/                  # Model factory with thinking support
│   └── config/                  # App/model/tool/skills/summarization config
├── app/                         # Gateway API, channels (IM), database
│   ├── channels/                # Feishu, Slack, Telegram integrations
│   └── ...                      # REST endpoints, artifacts, auth
└── langgraph.json               # LangGraph entry point registration
```

**Agent types**:
- **Lead agent**: Full tools + memory + skills + subagent delegation. Created per-request via `make_lead_agent(config)`.
- **Custom agents**: Same lead agent code, different config (`agents/{name}/config.yaml` + `SOUL.md`).
- **general-purpose subagent**: All tools minus task/clarification. Max 50 turns. For complex multi-step tasks.
- **bash subagent**: Only bash/file tools. Max 30 turns. For command execution.

**No nesting**: Subagents cannot spawn further subagents — `task` tool excluded from their tool set via `disallowed_tools` config and `subagent_enabled=False`.

**Communication**: Tool invocation only. Parent passes `sandbox_state` + `thread_data` but NOT messages or memory. Subagent results returned as ToolMessage text.

**Multi-channel deployment**: Gateway API serves chat via REST + SSE. Channel integrations for Feishu (streaming cards), Slack, Telegram — each with capability-based streaming support.

**Key files**:
- `backend/packages/harness/deerflow/agents/lead_agent/agent.py` — agent factory
- `backend/packages/harness/deerflow/subagents/executor.py` — background execution engine
- `backend/packages/harness/deerflow/subagents/builtins/` — subagent configs (general_purpose, bash)
- `backend/langgraph.json` — LangGraph entry point registration

---

## 2. Thinking & Reasoning

**Implementation**: Model-native + system prompt guidance (no separate think tool or node).

- **Thinking style** injected via system prompt `<thinking_style>` block
- Teaches: think strategically → identify ambiguities → ask clarification FIRST → then act
- When `thinking_enabled=True`, model's native extended thinking is activated (Claude, o1, etc.)
- Configured per model: `supports_thinking`, `supports_reasoning_effort` in config.yaml
- **Visibility**: Internal only — "Never write full answer in thinking, only outline"

**Model factory thinking logic** (`models/factory.py`):
- If `thinking_enabled=True` and model supports it:
  - Merges `when_thinking_enabled` settings into model initialization
  - `thinking` dict is a shortcut for `when_thinking_enabled["thinking"]`
- If `thinking_enabled=False` but thinking settings exist:
  - Disables via `{"type": "disabled"}` for OpenAI-compatible gateways
  - Sets `reasoning_effort: "minimal"` as fallback
  - Native langchain_anthropic: Sets `thinking: {"type": "disabled"}`

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
- `backend/packages/harness/deerflow/agents/lead_agent/prompt.py` — system prompt with planning sections
- `backend/packages/harness/deerflow/agents/middlewares/todo_middleware.py` — TodoList with context-loss detection
- `backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py` — execution interrupt

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

### Tool Schema Context (Deferred Tool Loading)
- **Problem**: MCP servers may expose 30-50+ tools, bloating context
- **Solution**: `DeferredToolRegistry` stores tool names + descriptions only
- `DeferredToolFilterMiddleware` strips deferred tool schemas from LLM binding
- `tool_search` tool lets agent discover and load specific tool schemas on-demand
- Three query syntaxes: `select:name1,name2`, `+keyword search`, regex pattern
- Returns up to 5 tools per search call
- Enabled via `tool_search.enabled` in config.yaml

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
1. **Config-based**: Loaded from `config.yaml` via reflection (`resolve_variable("deerflow.sandbox.tools:bash_tool")`)
2. **Built-in**: `present_file`, `ask_clarification`, `task` (conditional), `view_image` (conditional), `tool_search` (conditional), `setup_agent` (bootstrap)
3. **MCP servers**: Cached globally with staleness detection via config file mtime

### Tool Filtering
- **Per-agent**: `tool_groups` in agent config filters config-based tools
- **Per-model**: `view_image_tool` only if `supports_vision=True`
- **Per-runtime**: `task` tool only if `subagent_enabled=True`; `tool_search` only if `tool_search.enabled=True`
- **Per-subagent**: Allowlist + denylist from SubagentConfig
- **Deferred**: `DeferredToolFilterMiddleware` hides deferred MCP tool schemas from model binding until `tool_search` loads them

### Meta-Tools
- `task` — delegates to subagent (flow control)
- `ask_clarification` — interrupts execution for user input (HITL)
- `write_todos` — manages task tracking (plan mode only)
- `view_image` — processes images for vision models
- `present_file` — registers output artifacts
- `tool_search` — discovers deferred MCP tools at runtime (context-saving)
- `setup_agent` — bootstraps custom agent creation with SOUL.md

### MCP Integration
- `langchain-mcp-adapters` for MCP server communication
- Transports: `stdio`, `sse`, `http`
- OAuth token flows supported for SSE/HTTP
- Global cache with `asyncio.Lock` for thread-safe lazy initialization
- Config-mtime-based staleness detection for auto-invalidation

**Key files**:
- `backend/packages/harness/deerflow/tools/tools.py` — tool composition
- `backend/packages/harness/deerflow/tools/builtins/tool_search.py` — deferred tool registry + search
- `backend/packages/harness/deerflow/mcp/cache.py` — MCP caching
- `backend/packages/harness/deerflow/tools/builtins/` — built-in tool implementations

---

## 6. Flow Control & Error Handling

### Core Loop
- LangGraph agent compiled from `create_agent()` — model generates response, tools execute, loop until no more tool_calls
- Middleware chain runs on every turn (13 middlewares in strict order)

### Middleware Chain (Ordered)

```
 1. ThreadDataMiddleware        → Sets thread_id, creates workspace/uploads/outputs paths
 2. UploadsMiddleware           → Injects uploaded file metadata into messages
 3. SandboxMiddleware           → Manages sandbox environment
 4. SummarizationMiddleware     → Token-aware context trimming (optional)
 5. TodoMiddleware              → Plan mode task tracking (optional, if is_plan_mode)
 6. TitleMiddleware             → Auto-generates conversation title
 7. MemoryMiddleware            → Queues conversation for async memory updates
 8. ViewImageMiddleware         → Injects viewed image data (vision models only)
 9. DeferredToolFilterMiddleware → Hides deferred MCP tool schemas (if tool_search enabled)
10. SubagentLimitMiddleware     → Truncates excess task calls (if subagent_enabled)
11. LoopDetectionMiddleware     → Detects and breaks repetitive tool call loops
12. ToolErrorHandlingMiddleware → Converts exceptions to error ToolMessages
13. ClarificationMiddleware     → Intercepts ask_clarification, interrupts execution (LAST)
```

### Iteration Limits
- `recursion_limit`: 100 (lead), 50 (general-purpose sub), 30 (bash sub)
- Subagent timeout: 900s (15 min) enforced via `Future.result(timeout=...)`
- Polling safety: max_poll_count = (timeout + 60) / 5

### Termination
- **Natural**: Model generates no tool_calls
- **Interrupt**: `ClarificationMiddleware` returns `Command(goto=END)`
- **Limit**: Recursion limit or timeout reached
- **Loop break**: `LoopDetectionMiddleware` strips tool_calls after hard limit

### Loop Detection (New)
- **Hash-based detection**: Hashes tool call multisets (name + args), tracks in sliding window
- **Thresholds** (configurable):
  - `warn_threshold=3`: Inject SystemMessage warning after 3 identical call patterns
  - `hard_limit=5`: Strip tool_calls from AIMessage, force text output
  - `window_size=20`: Sliding window of recent calls
- **Per-thread tracking**: Thread-safe with LRU eviction (max 100 threads)
- **Two-phase response**: Warning first ("stop calling tools"), then hard stop

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
- Channel-based streaming capability check: Feishu supports streaming (card updates), Slack/Telegram do not

---

## 7. User Interruption & Interference

### Interrupt Primitive
- `ask_clarification` tool — intercepted by `ClarificationMiddleware` before execution
- Returns `Command(update={messages}, goto=END)` — interrupts the LangGraph agent loop
- Formatted question presented to user with context + options
- Five types: `missing_info`, `ambiguous_requirement`, `approach_choice`, `risk_confirmation`, `suggestion`

### Permission-as-Data
- Tool availability controlled via config (tool_groups, subagent_enabled, supports_vision)
- Subagent concurrency clamped [2-4] by `SubagentLimitMiddleware` — hard enforcement
- No per-tool user approval gates (all tool calls proceed without user confirmation)

### Cancellation Propagation
- Subagent timeout via `Future.result(timeout=...)` — execution pool cancel
- No explicit cancel signal from user → subagent runs to completion or timeout
- Background task cleanup after terminal status

### Checkpointing for Resume
- State checkpointed by LangGraph at every step (memory, SQLite, or PostgreSQL)
- After clarification interrupt: next user message resumes from checkpoint
- No explicit resume API — continuation is automatic on next message

### Message Steering
- User messages arrive as next turn in checkpointed thread
- No mid-run message injection — clarification is the only pause mechanism
- New user message after completion starts new agent turn

### Clarification-First Workflow (System Prompt Enforcement)
- **CLARIFY → PLAN → ACT** mandatory order
- System prompt: "If anything is unclear → MUST ask for clarification FIRST"
- ❌ DO NOT start working and clarify mid-execution
- ❌ DO NOT skip for "efficiency"
- ✅ Analyze → Identify → Ask BEFORE action

### Key questions answered
- **Interrupt granularity**: Per-tool (clarification only)
- **Cancel vs redirect**: No distinction — clarification pauses, user can redirect via response
- **Side effect idempotency**: Not addressed — clarification always before action by design
- **Sub-agent teardown**: Via timeout only, not graceful cancellation

---

## 8. State & Persistence

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
- Checkpointer selected via config, singleton pattern with lifecycle management

### Working Memory vs Long-Term Memory
- **Working**: Message history in checkpointer (per thread), todos, uploaded files, viewed images
- **Long-term**: Memory JSON file with user context, history timeline, confidence-scored facts
  - Updated asynchronously via debounced queue (configurable window)
  - LLM extracts facts/summaries from conversation
  - Upload mentions stripped to prevent ghost file references
  - Max 100 facts, pruned by lowest confidence
  - Per-agent memory isolation supported via `agent_name`

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

## 9. Skills System

### Skill Discovery & Validation
- Skills stored in `skills/public/` (built-in) and `skills/custom/` (user-created)
- Each skill has a `SKILL.md` file with YAML frontmatter:
  ```yaml
  ---
  name: skill-name        # hyphen-case, max 64 chars
  description: ...        # max 1024 chars, no angle brackets
  license: MIT            # optional
  allowed-tools: [...]    # optional tool restrictions
  ---
  ```
- Validation: name format, description length, no XSS-risky characters

### Built-in Skills
- `bootstrap` — personalized SOUL.md onboarding (5-8 rounds, multi-phase)
- `chart-visualization` — 26 chart types (line, bar, pie, sankey, network, etc.)
- `deep-research` — research with citations
- `image-generation` — image creation
- `podcast-generation` — audio generation
- `skill-creator` — create and evaluate new skills
- `video-generation` — video creation
- `data-analysis` — data analysis workflows

### Progressive Loading Pattern
- Skills listed in system prompt as `<skill>` blocks (name + description + path)
- Full skill file NOT loaded until task matches description
- Agent reads `SKILL.md` via `read_file` only when needed → saves context tokens
- Enabled/disabled state managed via `extensions_config.json`

---

## 10. Configuration System

### Config Resolution
1. `DEER_FLOW_CONFIG_PATH` env var → explicit path
2. `./config.yaml` → current directory
3. `../config.yaml` → parent directory
4. Raise `FileNotFoundError`

### Config Versioning
- `version` field in config.yaml (current: 2)
- Alerts users when config is outdated

### Model Configuration
- Per-model settings: `supports_thinking`, `supports_vision`, `supports_reasoning_effort`
- `when_thinking_enabled` for model-specific thinking parameters
- `thinking` shortcut for `when_thinking_enabled["thinking"]`
- Environment variable resolution: values starting with `$` resolved from env
- Supported providers: OpenAI, Anthropic, Google Gemini, DeepSeek, MiniMax, Kimi K2.5, Doubao (Volcengine), OpenRouter

### Extensions Config
- Separate `extensions_config.json` for MCP servers and skills state
- Enables/disables MCP servers and skills independently

### Runtime Overrides (via RunnableConfig.configurable)
- `thinking_enabled` (boolean)
- `reasoning_effort` (string)
- `model_name` / `model` (string)
- `is_plan_mode` (boolean)
- `subagent_enabled` (boolean)
- `max_concurrent_subagents` (int, clamped [2, 4])
- `agent_name` (for per-agent config/memory)
- `is_bootstrap` (for custom agent creation)

---

## 11. Code Snippets

| Pattern | File | Description |
|---------|------|-------------|
| Agent Factory | `code_snippets/deer_flow/agent_factory.py` | Dynamic agent creation with middleware composition |
| Subagent Executor | `code_snippets/deer_flow/subagent_executor.py` | Background thread pool execution with polling |
| Middleware Chain | `code_snippets/deer_flow/middleware_chain.py` | Error handling, clarification interrupt, loop detection, concurrency limit |
| Memory System | `code_snippets/deer_flow/memory_system.py` | LLM-powered memory with token-budgeted injection |
| Tool System | `code_snippets/deer_flow/tool_system.py` | Multi-source tool composition with MCP caching and deferred loading |
| Prompt Engineering | `code_snippets/deer_flow/prompt_engineering.py` | Dynamic prompt assembly with skills & subagent guide |

---

## Key Design Patterns

1. **Middleware-as-Architecture**: 13-middleware chain replaces traditional graph nodes for cross-cutting concerns. Ordering is critical (ClarificationMiddleware must be last).

2. **Two-Pool Background Execution**: Scheduler pool + execution pool enables timeout enforcement via `Future.result(timeout=...)` without blocking the main agent.

3. **Post-Model Truncation**: `SubagentLimitMiddleware.after_model()` silently drops excess task calls — more reliable than prompt-only limits.

4. **Tool-as-Flow-Control**: `ask_clarification` and `task` are "meta-tools" that control execution flow rather than performing external operations. Clarification interrupts via `Command(goto=END)`.

5. **Progressive Skill Loading**: Skills listed in system prompt but loaded on-demand via `read_file`. Keeps context window lean for token-sensitive models.

6. **Memory Upload Scrubbing**: Regex strips upload-event sentences from memory before saving — prevents ghost file references in future sessions.

7. **Config-Driven Personality**: Same agent codebase serves multiple "personalities" via `agents/{name}/config.yaml` (model, tool_groups) + `SOUL.md` (behavioral guardrails).

8. **Context-Loss Detection**: TodoMiddleware detects when plan has scrolled out of context window and re-injects reminder — prevents the model from "forgetting" its plan.

9. **Deferred Tool Loading**: `tool_search` + `DeferredToolFilterMiddleware` hide MCP tool schemas until agent explicitly searches for them — prevents context bloat when dozens of MCP tools are available.

10. **Loop Detection & Breaking**: Hash-based detection of repetitive tool call patterns with two-phase response (warning → hard stop) — prevents doom loops and runaway costs.

11. **Harness/App Split**: Core agent logic (harness) separated from deployment concerns (app) — enables same agent to be deployed as LangGraph server, REST API, or IM channel bot.

12. **Channel-Aware Streaming**: Streaming capabilities checked per channel (Feishu supports streaming cards, Slack/Telegram do not) — adapts output format to integration constraints.
