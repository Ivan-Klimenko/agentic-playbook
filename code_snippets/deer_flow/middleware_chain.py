"""
DeerFlow Middleware Chain Patterns

Four critical middleware patterns that control agent flow:
1. ToolErrorHandlingMiddleware -- converts exceptions to ToolMessages (agent loop continues)
2. ClarificationMiddleware -- intercepts ask_clarification and interrupts execution
3. SubagentLimitMiddleware -- truncates excess parallel task calls from model response
4. LoopDetectionMiddleware -- detects and breaks repetitive tool call patterns

Source: backend/packages/harness/deerflow/agents/middlewares/
"""

# --- Pattern 1: Tool Error -> ToolMessage (Non-Crashing Loop) ---
# Wraps every tool call. On failure, returns an error ToolMessage instead of
# raising, so the agent can inspect the error and try alternatives.

class ToolErrorHandlingMiddleware(AgentMiddleware):
    def wrap_tool_call(self, request, handler):
        try:
            return handler(request)
        except GraphBubbleUp:
            raise  # preserve LangGraph control-flow signals (interrupt/pause)
        except Exception as exc:
            detail = str(exc)[:500]
            return ToolMessage(
                content=f"Error: Tool '{request.tool_call['name']}' failed: {detail}. "
                        "Continue with available context, or choose an alternative tool.",
                tool_call_id=request.tool_call["id"],
                status="error",
            )


# --- Pattern 2: Clarification Interrupt ---
# When model calls ask_clarification, execution is interrupted (goto=END).
# The formatted question is added to message history as a ToolMessage.
# User's response triggers next invocation with same thread_id.

class ClarificationMiddleware(AgentMiddleware):
    def wrap_tool_call(self, request, handler):
        if request.tool_call.get("name") != "ask_clarification":
            return handler(request)  # pass through non-clarification calls

        args = request.tool_call.get("args", {})
        formatted_message = self._format_clarification_message(args)

        tool_message = ToolMessage(
            content=formatted_message,
            tool_call_id=request.tool_call["id"],
            name="ask_clarification",
        )
        # Command(goto=END) interrupts the agent loop.
        # State is checkpointed; next message resumes from here.
        return Command(
            update={"messages": [tool_message]},
            goto=END,
        )


# --- Pattern 3: Subagent Concurrency Limit (Post-Model Truncation) ---
# Runs AFTER model generates response. If the model emitted more than N
# task tool calls, silently drops the excess. More reliable than prompt-only limits.

class SubagentLimitMiddleware(AgentMiddleware):
    def __init__(self, max_concurrent: int = 3):
        self.max_concurrent = clamp(max_concurrent, 2, 4)

    def after_model(self, state, runtime):
        last_msg = state["messages"][-1]
        tool_calls = getattr(last_msg, "tool_calls", [])

        task_indices = [i for i, tc in enumerate(tool_calls) if tc["name"] == "task"]
        if len(task_indices) <= self.max_concurrent:
            return None  # no truncation needed

        # Keep first N task calls, drop the rest
        indices_to_drop = set(task_indices[self.max_concurrent:])
        truncated = [tc for i, tc in enumerate(tool_calls) if i not in indices_to_drop]

        updated_msg = last_msg.model_copy(update={"tool_calls": truncated})
        return {"messages": [updated_msg]}


# --- Pattern 4: Loop Detection & Breaking ---
# Hash-based detection of repetitive tool call patterns. Two-phase response:
# 1. Warning (after warn_threshold identical patterns): inject system message
# 2. Hard stop (after hard_limit): strip tool_calls, force text output
# Prevents doom loops and runaway costs.

class LoopDetectionMiddleware(AgentMiddleware):
    def __init__(self, warn_threshold=3, hard_limit=5, window_size=20):
        self.warn_threshold = warn_threshold
        self.hard_limit = hard_limit
        self.window_size = window_size
        # Per-thread tracking with LRU eviction (max 100 threads)
        self._thread_histories: dict[str, list[int]] = {}
        self._lock = threading.Lock()

    def _hash_tool_calls(self, tool_calls: list[dict]) -> int:
        """Hash the multiset of (name, args) tuples for order-independent matching."""
        items = sorted((tc["name"], json.dumps(tc["args"], sort_keys=True)) for tc in tool_calls)
        return hash(tuple(items))

    def after_model(self, state, runtime):
        last_msg = state["messages"][-1]
        tool_calls = getattr(last_msg, "tool_calls", [])
        if not tool_calls:
            return None

        thread_id = runtime.config.get("configurable", {}).get("thread_id", "default")
        call_hash = self._hash_tool_calls(tool_calls)

        with self._lock:
            history = self._thread_histories.setdefault(thread_id, [])
            history.append(call_hash)
            # Sliding window: keep only last N
            if len(history) > self.window_size:
                history[:] = history[-self.window_size:]
            repeat_count = history.count(call_hash)

        if repeat_count >= self.hard_limit:
            # Hard stop: strip tool_calls, force text output
            updated_msg = last_msg.model_copy(update={"tool_calls": []})
            return {"messages": [updated_msg]}

        if repeat_count >= self.warn_threshold:
            # Warning: inject system message asking agent to stop
            warning = SystemMessage(
                content="[LOOP DETECTED] You are repeating the same tool calls. "
                        "Stop calling tools and produce your final answer."
            )
            return {"messages": [warning]}

        return None
