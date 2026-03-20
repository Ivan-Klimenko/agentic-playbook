"""
Ouroboros Context Assembly

3-block prompt caching strategy for Anthropic models, with soft-cap
token trimming and two-tier context compaction (automatic + LLM-driven).
Demonstrates how to structure system prompts for optimal cache hit rates.

Source: ouroboros/context.py
"""

# --- 3-Block Prompt Caching ---
# Block 1: Static (system prompt + constitution) — cached 1h, rarely changes
# Block 2: Semi-stable (identity + scratchpad + knowledge) — cached, changes ~once per task
# Block 3: Dynamic (state + runtime + recent logs) — uncached, changes every round

def build_llm_messages(env, memory, task, review_context_builder=None):
    task_type = str(task.get("type") or "user")

    # Block 1: Static content (cached with long TTL)
    static_text = (
        read_file("prompts/SYSTEM.md")
        + "\n\n## BIBLE.md\n\n" + clip_text(read_file("BIBLE.md"), 180000)
    )
    # README only for evolution/review tasks (saves ~180K tokens for regular tasks)
    if task_type in ("evolution", "review", "scheduled"):
        static_text += "\n\n## README.md\n\n" + clip_text(read_file("README.md"), 180000)

    # Block 2: Semi-stable content (cached with default TTL)
    semi_stable_parts = []
    semi_stable_parts.append("## Scratchpad\n\n" + clip_text(memory.load_scratchpad(), 90000))
    semi_stable_parts.append("## Identity\n\n" + clip_text(memory.load_identity(), 80000))
    if knowledge_index_exists():
        semi_stable_parts.append("## Knowledge base\n\n" + clip_text(knowledge_index, 50000))
    semi_stable_text = "\n\n".join(semi_stable_parts)

    # Block 3: Dynamic content (uncached — changes every round)
    dynamic_parts = [
        "## Drive state\n\n" + clip_text(state_json, 90000),
        build_runtime_section(env, task),  # UTC, git, budget, task info
        build_health_invariants(env),       # Version sync, budget drift, duplicates
    ]
    dynamic_parts.extend(build_recent_sections(memory, env))  # Chat, progress, tools, events
    dynamic_text = "\n\n".join(dynamic_parts)

    # Assemble as multipart system message for optimal caching
    messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": static_text,
                    "cache_control": {"type": "ephemeral", "ttl": "1h"},  # Long cache
                },
                {
                    "type": "text",
                    "text": semi_stable_text,
                    "cache_control": {"type": "ephemeral"},  # Default cache
                },
                {
                    "type": "text",
                    "text": dynamic_text,
                    # No cache_control → uncached, changes every round
                },
            ],
        },
        {"role": "user", "content": build_user_content(task)},
    ]

    # Soft-cap token trimming
    messages, cap_info = apply_message_token_soft_cap(messages, soft_cap_tokens=200000)
    return messages, cap_info


# --- Soft-Cap Token Trimming ---
# Prunes log-summary sections from the dynamic block when total exceeds soft cap.
# Order matters: least important first.

PRUNABLE_SECTIONS = [
    "## Recent chat", "## Recent progress", "## Recent tools",
    "## Recent events", "## Supervisor"
]

def apply_message_token_soft_cap(messages, soft_cap_tokens):
    estimated = sum(estimate_message_tokens(m) for m in messages)
    if estimated <= soft_cap_tokens:
        return messages, {"trimmed_sections": []}

    pruned = deep_copy(messages)
    for prefix in PRUNABLE_SECTIONS:
        if estimated <= soft_cap_tokens:
            break
        # Find the dynamic text block (the one without cache_control)
        for msg in pruned:
            if msg["role"] == "system" and isinstance(msg["content"], list):
                for block in msg["content"]:
                    if block.get("type") == "text" and "cache_control" not in block:
                        block["text"] = remove_section(block["text"], prefix)
                        estimated = recalculate_tokens(pruned)
                        break
    return pruned, {"trimmed_sections": [...]}


# --- Two-Tier Context Compaction ---

# Tier 1: Automatic (simple truncation of old tool results)
def compact_tool_history(messages, keep_recent=6):
    """Compress old tool call/result pairs into 1-line summaries.
    Keeps last N tool rounds intact. Error details preserved."""

    tool_round_starts = [i for i, m in enumerate(messages)
                         if m.get("role") == "assistant" and m.get("tool_calls")]

    if len(tool_round_starts) <= keep_recent:
        return messages  # Nothing to compact

    rounds_to_compact = set(tool_round_starts[:-keep_recent])
    result = []
    for i, msg in enumerate(messages):
        if msg.get("role") == "tool" and belongs_to_compacted_round(i, rounds_to_compact):
            content = str(msg.get("content", ""))
            is_error = content.startswith("⚠️")
            summary = content[:200] if is_error else content.split('\n')[0][:80]
            result.append({**msg, "content": summary})
        elif i in rounds_to_compact and msg.get("role") == "assistant":
            result.append(compact_assistant_msg(msg))  # Trim content + tool_call args
        else:
            result.append(msg)
    return result


# Tier 2: LLM-driven (light model summarizes old results)
def compact_tool_history_llm(messages, keep_recent=6):
    """Agent calls compact_context tool → triggers this.
    Uses a light/cheap model to summarize old tool results into key facts."""

    old_results = collect_old_results(messages, keep_recent)
    if not old_results:
        return compact_tool_history(messages, keep_recent)

    prompt = (
        "Summarize each tool result below into 1-2 lines of key facts. "
        "Preserve errors, file paths, and important values.\n\n"
        + format_results(old_results[:20])
    )

    try:
        summary = call_light_model(prompt, max_tokens=1024)
        return apply_summaries(messages, parse_summaries(summary), old_results)
    except Exception:
        # Fallback to simple truncation on any error
        return compact_tool_history(messages, keep_recent)
