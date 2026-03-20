"""
Ouroboros Budget Tracking

Multi-layer budget management: per-round cost estimation with model pricing,
atomic state updates with file locking, OpenRouter ground-truth drift detection,
and category/model breakdowns. Demonstrates budget safety for autonomous agents.

Source: ouroboros/loop.py, supervisor/state.py
"""

import json
import os
import pathlib
import threading
from typing import Any, Dict, Optional, Tuple

# --- Model Pricing ---
# Static fallback, periodically refreshed from OpenRouter API.
# Format: {model_id: (input_per_1M, cached_per_1M, output_per_1M)}

_MODEL_PRICING = {
    "anthropic/claude-sonnet-4.6": (3.0, 0.30, 15.0),
    "openai/o3": (2.0, 0.50, 8.0),
    "google/gemini-3-pro-preview": (2.0, 0.20, 12.0),
}

def estimate_cost(model, prompt_tokens, completion_tokens, cached_tokens=0):
    """Estimate cost when API doesn't return it. Uses longest prefix match."""
    pricing = _MODEL_PRICING.get(model)
    if not pricing:
        # Longest prefix match for versioned model IDs
        for key, val in _MODEL_PRICING.items():
            if model.startswith(key):
                pricing = val
                break
    if not pricing:
        return 0.0

    input_price, cached_price, output_price = pricing
    regular_input = max(0, prompt_tokens - cached_tokens)
    return (
        regular_input * input_price / 1_000_000
        + cached_tokens * cached_price / 1_000_000
        + completion_tokens * output_price / 1_000_000
    )


# --- Atomic State Updates with File Locking ---
# Google Drive FUSE can have latency. File locks prevent concurrent writes.

def update_budget_from_usage(usage):
    """Read-modify-write under file lock. HTTP check outside lock."""
    # Step 1: Fast update under lock (no network I/O)
    lock_fd = acquire_file_lock("state.lock")
    try:
        st = load_state()
        cost = float(usage.get("cost", 0))
        st["spent_usd"] += cost
        st["spent_calls"] += int(usage.get("rounds", 1))
        st["spent_tokens_prompt"] += int(usage.get("prompt_tokens", 0))
        st["spent_tokens_completion"] += int(usage.get("completion_tokens", 0))
        st["spent_tokens_cached"] += int(usage.get("cached_tokens", 0))
        should_check = (st["spent_calls"] % 50 == 0)
        save_state(st)
    finally:
        release_file_lock(lock_fd)

    # Step 2: Ground truth check OUTSIDE the lock (can take 10s)
    if should_check:
        ground_truth = fetch_openrouter_ground_truth()
        if ground_truth:
            lock_fd = acquire_file_lock("state.lock")
            try:
                st = load_state()
                _apply_drift_detection(st, ground_truth)
                save_state(st)
            finally:
                release_file_lock(lock_fd)


# --- Budget Drift Detection ---
# Compares our tracked spending with OpenRouter's ground truth.
# Alerts when drift > 50% AND absolute difference > $5.

def _apply_drift_detection(st, ground_truth):
    """Called every 50 LLM calls. Uses session snapshots for relative comparison."""
    session_total_snap = st.get("session_total_snapshot")  # OR total at session start
    session_spent_snap = st.get("session_spent_snapshot")  # Our total at session start

    if session_total_snap is None or session_spent_snap is None:
        return

    # Deltas since session start
    or_delta = ground_truth["total_usd"] - session_total_snap
    our_delta = st["spent_usd"] - session_spent_snap

    if or_delta > 0.001:
        drift_pct = abs(or_delta - our_delta) / max(abs(or_delta), 0.01) * 100.0
        abs_diff = abs(or_delta - our_delta)

        st["budget_drift_pct"] = drift_pct
        # Alert only on significant drift (both relative AND absolute)
        st["budget_drift_alert"] = (drift_pct > 50.0 and abs_diff > 5.0)


# --- Per-Round Usage Events ---
# Every LLM call emits a usage event with category for budget breakdown.

def emit_llm_usage_event(event_queue, task_id, model, usage, cost, category="task"):
    """Emit real-time usage event. Categories: task, evolution, consciousness, review."""
    if not event_queue:
        return
    event_queue.put_nowait({
        "type": "llm_usage",
        "ts": utc_now_iso(),
        "task_id": task_id,
        "model": model,
        "prompt_tokens": int(usage.get("prompt_tokens", 0)),
        "completion_tokens": int(usage.get("completion_tokens", 0)),
        "cached_tokens": int(usage.get("cached_tokens", 0)),
        "cost": cost,
        "cost_estimated": not bool(usage.get("cost")),  # True if we estimated
        "category": category,
    })


# --- Budget Breakdown ---
# Aggregates cost by category and model from events.jsonl.

def budget_breakdown() -> Dict[str, float]:
    """Returns {category: total_cost}. E.g., {"task": 12.5, "evolution": 45.2}."""
    breakdown = {}
    for event in read_events("llm_usage"):
        category = event.get("category", "other")
        cost = float(event.get("cost", 0))
        breakdown[category] = breakdown.get(category, 0.0) + cost
    return breakdown

def model_breakdown() -> Dict[str, Dict[str, float]]:
    """Returns {model: {cost, calls, prompt_tokens, completion_tokens}}."""
    breakdown = {}
    for event in read_events("llm_usage"):
        model = event.get("model", "unknown")
        if model not in breakdown:
            breakdown[model] = {"cost": 0, "calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
        breakdown[model]["cost"] += float(event.get("cost", 0))
        breakdown[model]["calls"] += 1
        breakdown[model]["prompt_tokens"] += int(event.get("prompt_tokens", 0))
        breakdown[model]["completion_tokens"] += int(event.get("completion_tokens", 0))
    return breakdown
