"""
Ouroboros LLM Tool Loop

Core agent loop with budget guards, self-check reminders, model fallback,
parallel read-only execution, and LLM-driven context compaction.
Demonstrates "LLM-first" philosophy: code enforces resource limits,
LLM makes all cognitive decisions.

Source: ouroboros/loop.py
"""

# --- Constants ---

# Tools safe for parallel execution (no side effects)
READ_ONLY_PARALLEL_TOOLS = frozenset({
    "repo_read", "repo_list", "drive_read", "drive_list",
    "web_search", "codebase_digest", "chat_history",
})

MAX_ROUNDS = 200  # env-configurable via OUROBOROS_MAX_ROUNDS


# --- Self-Check Injection ---
# Every 50 rounds, the agent gets a reflection prompt.
# This is a COGNITIVE feature — the agent decides whether to act on it.

def _maybe_inject_self_check(round_idx, max_rounds, messages, usage, emit_progress):
    REMINDER_INTERVAL = 50
    if round_idx <= 1 or round_idx % REMINDER_INTERVAL != 0:
        return
    task_cost = usage.get("cost", 0)
    checkpoint_num = round_idx // REMINDER_INTERVAL

    # System message — not a hard limit, agent decides what to do
    reminder = (
        f"[CHECKPOINT {checkpoint_num} — round {round_idx}/{max_rounds}]\n"
        f"⏸️ PAUSE AND REFLECT before continuing:\n"
        f"1. Am I making real progress, or repeating the same actions?\n"
        f"2. Is my current strategy working? Should I try something different?\n"
        f"3. Is my context bloated with old tool results I no longer need?\n"
        f"   → If yes, call `compact_context` to summarize them selectively.\n"
        f"4. Should I just STOP and return my best result so far?\n\n"
        f"This is not a hard limit — you decide. But be honest with yourself."
    )
    messages.append({"role": "system", "content": reminder})


# --- Budget Guard ---
# Hard stop at 50% of remaining budget. Soft nudge at 30%.

def _check_budget_limits(budget_remaining_usd, usage, round_idx, messages, ...):
    if budget_remaining_usd is None:
        return None

    task_cost = usage.get("cost", 0)
    budget_pct = task_cost / budget_remaining_usd if budget_remaining_usd > 0 else 1.0

    if budget_pct > 0.5:
        # Hard stop — one more call to get final response
        messages.append({
            "role": "system",
            "content": f"[BUDGET LIMIT] Task spent ${task_cost:.3f} "
                       f"(>50% of remaining ${budget_remaining_usd:.2f}). "
                       f"Give your final response now."
        })
        final_msg = call_llm(messages, tools=None)  # No tools = force text response
        return final_msg.get("content")

    elif budget_pct > 0.3 and round_idx % 10 == 0:
        # Soft nudge — no forced stop
        messages.append({
            "role": "system",
            "content": f"[INFO] Task spent ${task_cost:.3f} of "
                       f"${budget_remaining_usd:.2f}. Wrap up if possible."
        })
    return None


# --- Core Loop ---

def run_llm_loop(messages, tools, llm, budget_remaining_usd=None, ...):
    active_model = llm.default_model()
    active_effort = "medium"
    usage = {}

    for round_idx in range(1, MAX_ROUNDS + 1):
        # 1. Round limit
        if round_idx > MAX_ROUNDS:
            messages.append({"role": "system", "content": "[ROUND_LIMIT] exceeded."})
            return force_final_response(messages)

        # 2. Self-check reminder every 50 rounds
        _maybe_inject_self_check(round_idx, MAX_ROUNDS, messages, usage, ...)

        # 3. Apply model/effort switch (from switch_model tool)
        if ctx.active_model_override:
            active_model = ctx.active_model_override
            ctx.active_model_override = None

        # 4. Drain owner messages injected during task
        drain_incoming_messages(messages, incoming_queue, drive_mailbox)

        # 5. Context compaction
        if ctx._pending_compaction is not None:
            # LLM-driven: agent called compact_context tool
            messages = compact_tool_history_llm(messages, keep_recent=ctx._pending_compaction)
            ctx._pending_compaction = None
        elif round_idx > 8:
            # Automatic: simple truncation of old tool results
            messages = compact_tool_history(messages, keep_recent=6)

        # 6. LLM call with retry (3 attempts, exponential backoff)
        msg, cost = call_llm_with_retry(llm, messages, active_model, tool_schemas, ...)

        # 7. Fallback to another model on empty response
        if msg is None:
            fallback_model = pick_fallback(active_model)
            msg, cost = call_llm_with_retry(llm, messages, fallback_model, ...)
            if msg is None:
                return "Failed after retries + fallback."

        # 8. No tool calls = final response
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            return msg.get("content", "")

        # 9. Execute tool calls
        messages.append({"role": "assistant", "content": msg.get("content"), "tool_calls": tool_calls})

        # Parallel execution only for read-only tools
        can_parallel = (
            len(tool_calls) > 1
            and all(tc["function"]["name"] in READ_ONLY_PARALLEL_TOOLS for tc in tool_calls)
        )
        if can_parallel:
            results = execute_parallel(tool_calls, max_workers=8)
        else:
            results = execute_sequential(tool_calls)

        for result in results:
            messages.append({"role": "tool", "tool_call_id": result["id"], "content": result["text"]})

        # 10. Budget guard
        budget_result = _check_budget_limits(budget_remaining_usd, usage, round_idx, messages)
        if budget_result:
            return budget_result
