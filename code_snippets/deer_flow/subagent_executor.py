"""
DeerFlow Subagent Executor

Background execution engine for subagents. The lead agent delegates via
the `task` tool, which creates a SubagentExecutor, spawns it in a thread pool,
and polls for completion via SSE events. Key design decisions:
- Subagents cannot nest (task tool excluded from their tool set)
- Max 3 concurrent subagents enforced by middleware + thread pool
- Parent shares sandbox/thread_data but NOT messages or memory
- Two-pool architecture: scheduler pool + execution pool for timeout support

Source: backend/src/subagents/executor.py, backend/src/tools/builtins/task_tool.py
"""

# --- Subagent Result ---
# Tracks lifecycle from PENDING → RUNNING → COMPLETED|FAILED|TIMED_OUT

@dataclass
class SubagentResult:
    task_id: str
    trace_id: str
    status: SubagentStatus  # PENDING | RUNNING | COMPLETED | FAILED | TIMED_OUT
    result: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    ai_messages: list[dict] | None = None  # collected in real-time during streaming


# --- Thread Pools ---
# Two separate pools: scheduler orchestrates, execution does actual work.
# This separation enables timeout enforcement via Future.result(timeout=...).

_scheduler_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-scheduler-")
_execution_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-exec-")

# Global storage with thread-safe access
_background_tasks: dict[str, SubagentResult] = {}
_background_tasks_lock = threading.Lock()


# --- Executor ---
class SubagentExecutor:
    def __init__(self, config, tools, parent_model, sandbox_state, thread_data, thread_id, trace_id):
        # Filter tools: apply allowlist then denylist from subagent config
        # task, ask_clarification, present_files are always denied → no nesting
        self.tools = _filter_tools(tools, config.tools, config.disallowed_tools)

    def execute_async(self, task: str, task_id: str | None = None) -> str:
        """Non-blocking: submits to scheduler pool, returns task_id immediately."""
        result = SubagentResult(task_id=task_id, trace_id=self.trace_id, status=SubagentStatus.PENDING)
        _background_tasks[task_id] = result

        def run_task():
            result.status = SubagentStatus.RUNNING
            result.started_at = datetime.now()
            # Submit to execution pool WITH timeout
            future = _execution_pool.submit(self.execute, task, result)
            try:
                future.result(timeout=self.config.timeout_seconds)  # blocks scheduler thread
            except FuturesTimeoutError:
                result.status = SubagentStatus.TIMED_OUT
                result.error = f"Timed out after {self.config.timeout_seconds}s"
                future.cancel()

        _scheduler_pool.submit(run_task)
        return task_id

    async def _aexecute(self, task: str, result_holder: SubagentResult) -> SubagentResult:
        """Core execution: creates agent, streams, collects AI messages."""
        agent = self._create_agent()
        state = {"messages": [HumanMessage(content=task)]}
        if self.sandbox_state: state["sandbox"] = self.sandbox_state
        if self.thread_data: state["thread_data"] = self.thread_data

        # Stream to collect AI messages in real-time
        async for chunk in agent.astream(state, config=run_config, stream_mode="values"):
            last_msg = chunk["messages"][-1]
            if isinstance(last_msg, AIMessage):
                result_holder.ai_messages.append(last_msg.model_dump())

        # Extract final text result from last AIMessage
        result_holder.result = extract_text_from_last_ai_message(final_state)
        result_holder.status = SubagentStatus.COMPLETED
        return result_holder


# --- Task Tool (Polling Bridge) ---
# The task tool bridges lead agent ↔ background subagent via polling loop.

@tool("task")
def task_tool(runtime, description, prompt, subagent_type, tool_call_id, max_turns=None):
    """Delegate a task to a subagent running in background thread pool."""
    # Get tools WITHOUT task tool → prevents nesting
    tools = get_available_tools(model_name=parent_model, subagent_enabled=False)

    executor = SubagentExecutor(
        config=get_subagent_config(subagent_type),
        tools=tools,
        parent_model=runtime.config["metadata"]["model_name"],
        sandbox_state=runtime.state.get("sandbox"),
        thread_data=runtime.state.get("thread_data"),
    )

    task_id = executor.execute_async(prompt, task_id=tool_call_id)

    writer = get_stream_writer()
    writer({"type": "task_started", "task_id": task_id, "description": description})

    # Poll every 5s, streaming AI messages as task_running events
    while True:
        result = get_background_task_result(task_id)

        # Forward new AI messages as SSE events
        for new_msg in result.ai_messages[last_seen:]:
            writer({"type": "task_running", "task_id": task_id, "message": new_msg})

        if result.status == SubagentStatus.COMPLETED:
            writer({"type": "task_completed", "task_id": task_id})
            cleanup_background_task(task_id)
            return f"Task Succeeded. Result: {result.result}"
        elif result.status in (SubagentStatus.FAILED, SubagentStatus.TIMED_OUT):
            cleanup_background_task(task_id)
            return f"Task failed: {result.error}"

        time.sleep(5)
