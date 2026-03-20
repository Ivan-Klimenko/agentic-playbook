"""
DeerFlow Agent Factory & Middleware Composition

The lead agent is created dynamically per-request via make_lead_agent().
It resolves model, tools, middlewares, and system prompt from runtime config,
agent-specific config files, and global defaults. This pattern enables
a single agent codebase to serve as multiple "personalities" via config.

Source: backend/packages/harness/deerflow/agents/lead_agent/agent.py
"""

# --- State Schema ---
# ThreadState extends LangChain's AgentState with domain-specific fields.
# Custom reducers control how concurrent state updates merge.

class ThreadState(AgentState):
    messages: list[BaseMessage]  # inherited from AgentState, append-only
    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]
    title: NotRequired[str | None]
    artifacts: Annotated[list[str], merge_artifacts]  # deduplicating merge
    todos: NotRequired[list | None]
    uploaded_files: NotRequired[list[dict] | None]
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]


def merge_artifacts(existing, new) -> list[str]:
    """Deduplicate while preserving insertion order."""
    if existing is None: return new or []
    if new is None: return existing
    return list(dict.fromkeys(existing + new))


# --- Agent Factory ---
# Single entry point registered in langgraph.json as "lead_agent".

def make_lead_agent(config: RunnableConfig):
    cfg = config.get("configurable", {})

    # 1. Resolve model (request -> agent config -> global default)
    model_name = cfg.get("model_name") or agent_config.model or default_model
    model = create_chat_model(
        name=model_name,
        thinking_enabled=cfg.get("thinking_enabled", True),
        reasoning_effort=cfg.get("reasoning_effort"),
    )

    # 2. Get tools (sandbox + config-based + MCP + builtins)
    tools = get_available_tools(
        model_name=model_name,
        groups=agent_config.tool_groups if agent_config else None,
        subagent_enabled=cfg.get("subagent_enabled", False),
    )

    # 3. Build ordered middleware chain (13 middlewares)
    middlewares = _build_middlewares(config, model_name, agent_name)

    # 4. Generate system prompt (memory + skills + subagent guide)
    system_prompt = apply_prompt_template(
        subagent_enabled=cfg.get("subagent_enabled", False),
        max_concurrent_subagents=cfg.get("max_concurrent_subagents", 3),
        agent_name=agent_name,
    )

    return create_agent(
        model=model,
        tools=tools,
        middleware=middlewares,
        system_prompt=system_prompt,
        state_schema=ThreadState,
    )


# --- Middleware Chain ---
# Strict ordering matters. Each middleware has specific hooks:
# before_model(), after_model(), wrap_tool_call(), before_agent(), after_agent()

def _build_middlewares(config, model_name, agent_name=None):
    middlewares = [
        ThreadDataMiddleware(),        # 1. sets workspace/uploads/outputs paths
        UploadsMiddleware(),           # 2. injects uploaded file list into messages
        SandboxMiddleware(),           # 3. acquires sandbox environment
        DanglingToolCallMiddleware(),  # 4. patches missing ToolMessages
        ToolErrorHandlingMiddleware(), # 5. converts exceptions -> error ToolMessages
    ]

    # Optional middlewares based on runtime config
    if summarization_enabled:
        middlewares.append(SummarizationMiddleware(model=..., trigger=..., keep=...))

    if is_plan_mode:
        middlewares.append(TodoMiddleware(system_prompt=..., tool_description=...))

    middlewares.append(TitleMiddleware())       # auto-generates thread title
    middlewares.append(MemoryMiddleware())      # queues conversation for async memory update

    if model_supports_vision:
        middlewares.append(ViewImageMiddleware())

    if tool_search_enabled:
        middlewares.append(DeferredToolFilterMiddleware())  # hides deferred MCP tool schemas

    if subagent_enabled:
        middlewares.append(SubagentLimitMiddleware(max_concurrent=3))

    # Loop detection: breaks repetitive tool call patterns
    middlewares.append(LoopDetectionMiddleware(warn_threshold=3, hard_limit=5, window_size=20))

    # ClarificationMiddleware MUST be last -- it can interrupt execution
    middlewares.append(ClarificationMiddleware())
    return middlewares
