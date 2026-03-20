"""
Ouroboros Background Consciousness

Persistent daemon thread that gives the agent continuous inner life between
tasks. Wakes periodically, loads abbreviated context, calls LLM with limited
tools, can message owner proactively. Demonstrates autonomous background
processing with budget isolation and task-aware pausing.

Source: ouroboros/consciousness.py
"""

import queue
import threading
import time
from typing import Any, Dict, List, Optional


# Whitelisted tools for background consciousness (no code modification)
BG_TOOL_WHITELIST = frozenset({
    # Memory & identity
    "send_owner_message", "schedule_task", "update_scratchpad",
    "update_identity", "set_next_wakeup",
    # Knowledge base
    "knowledge_read", "knowledge_write", "knowledge_list",
    # Read-only awareness
    "web_search", "repo_read", "repo_list", "drive_read", "drive_list",
    "chat_history",
    # GitHub Issues (second input channel)
    "list_github_issues", "get_github_issue",
})


class BackgroundConsciousness:
    """Persistent background thinking loop."""

    _MAX_BG_ROUNDS = 5  # Max LLM rounds per wakeup (budget control)

    def __init__(self, drive_root, repo_dir, event_queue, owner_chat_id_fn):
        self._drive_root = drive_root
        self._repo_dir = repo_dir
        self._event_queue = event_queue
        self._owner_chat_id_fn = owner_chat_id_fn

        self._running = False
        self._paused = False                    # Paused during active tasks
        self._stop_event = threading.Event()
        self._wakeup_event = threading.Event()
        self._next_wakeup_sec = 300.0           # LLM-controlled via set_next_wakeup
        self._observations = queue.Queue()       # Events the consciousness should notice

        # Budget isolation: 10% of total budget
        self._bg_spent_usd = 0.0
        self._bg_budget_pct = 10.0              # env: OUROBOROS_BG_BUDGET_PCT

    # --- Lifecycle ---

    def start(self):
        self._running = True
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def pause(self):
        """Called when a regular task starts — avoid budget contention."""
        self._paused = True

    def resume(self):
        """Called when task completes. Flushes deferred events first."""
        self._paused = False
        self._wakeup_event.set()  # Wake up immediately

    def inject_observation(self, text):
        """Push an event the consciousness should notice on next wakeup."""
        self._observations.put_nowait(text)

    # --- Main Loop ---

    def _loop(self):
        """Daemon: sleep → wake → think → sleep. LLM controls wakeup interval."""
        while not self._stop_event.is_set():
            self._wakeup_event.clear()
            self._wakeup_event.wait(timeout=self._next_wakeup_sec)

            if self._stop_event.is_set():
                break
            if self._paused:
                continue
            if not self._check_budget():
                self._next_wakeup_sec = 3600  # Sleep long if over budget
                continue

            try:
                self._think()
            except Exception:
                # Exponential backoff on errors (max 30 min)
                self._next_wakeup_sec = min(self._next_wakeup_sec * 2, 1800)

    def _check_budget(self):
        """Background consciousness gets 10% of total budget."""
        total_budget = float(os.environ.get("TOTAL_BUDGET", "1"))
        max_bg = total_budget * (self._bg_budget_pct / 100.0)
        return self._bg_spent_usd < max_bg

    # --- Think Cycle ---

    def _think(self):
        """One thinking cycle: abbreviated context, up to 5 LLM rounds."""
        context = self._build_context()
        messages = [
            {"role": "system", "content": context},
            {"role": "user", "content": "Wake up. Think."},
        ]
        tools = self._tool_schemas()  # Only whitelisted tools

        for round_idx in range(1, self._MAX_BG_ROUNDS + 1):
            if self._paused:
                break

            msg, usage = llm.chat(
                messages=messages, model=self._model,
                tools=tools, reasoning_effort="low", max_tokens=2048
            )
            self._bg_spent_usd += float(usage.get("cost", 0))

            if not self._check_budget():
                break

            content = msg.get("content", "")
            tool_calls = msg.get("tool_calls", [])

            if content and not tool_calls:
                break  # Final thought — done

            if tool_calls:
                messages.append(msg)
                for tc in tool_calls:
                    result = self._execute_tool(tc)
                    messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
                continue

            break  # Neither content nor tools — done

    def _build_context(self):
        """Lightweight context — much smaller than regular task context."""
        parts = [
            read_file("prompts/CONSCIOUSNESS.md"),
            "## BIBLE.md\n\n" + clip_text(read_file("BIBLE.md"), 12000),
            "## Identity\n\n" + clip_text(load_identity(), 6000),
            "## Scratchpad\n\n" + clip_text(load_scratchpad(), 8000),
        ]
        # Recent observations (events injected since last wakeup)
        observations = drain_queue(self._observations, max=10)
        if observations:
            parts.append("## Recent observations\n\n" + format_list(observations))

        parts.append("## Runtime\n\n" + format_runtime_info(
            bg_spent=self._bg_spent_usd,
            wakeup_interval=self._next_wakeup_sec,
            budget_remaining=get_budget_remaining(),
        ))
        return "\n\n".join(parts)

    # --- set_next_wakeup tool ---
    # LLM controls its own wakeup interval (60-3600s).
    # More interesting events → shorter interval.
    # Nothing happening → longer interval.

    def _register_wakeup_tool(self):
        def _set_next_wakeup(ctx, seconds=300):
            self._next_wakeup_sec = max(60, min(3600, int(seconds)))
            return f"OK: next wakeup in {self._next_wakeup_sec}s"

        return ToolEntry("set_next_wakeup", {
            "name": "set_next_wakeup",
            "description": "Set seconds until next thinking cycle (60-3600).",
            "parameters": {"type": "object", "properties": {
                "seconds": {"type": "integer"},
            }, "required": ["seconds"]},
        }, _set_next_wakeup)
