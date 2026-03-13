"""
DeerFlow Middleware Chain Patterns

Three critical middleware patterns that control agent flow:
1. ToolErrorHandlingMiddleware — converts exceptions to ToolMessages (agent loop continues)
2. ClarificationMiddleware — intercepts ask_clarification and interrupts execution
3. SubagentLimitMiddleware — truncates excess parallel task calls from model response

Source: backend/src/agents/middlewares/
"""

# --- Pattern 1: Tool Error → ToolMessage (Non-Crashing Loop) ---
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


# --- Middleware for Subagent vs Lead ---
# Lead and subagent share base middlewares but differ in optional ones.

def build_lead_runtime_middlewares():
    return [
        ThreadDataMiddleware(),
        UploadsMiddleware(),          # lead only: handles file uploads
        SandboxMiddleware(),
        DanglingToolCallMiddleware(), # lead only: patches interrupted tool calls
        ToolErrorHandlingMiddleware(),
    ]

def build_subagent_runtime_middlewares():
    return [
        ThreadDataMiddleware(),
        SandboxMiddleware(),
        # no UploadsMiddleware (subagents don't handle uploads)
        # no DanglingToolCallMiddleware (subagents start fresh)
        ToolErrorHandlingMiddleware(),
    ]
