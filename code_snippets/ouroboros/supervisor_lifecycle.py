"""
Ouroboros Supervisor Lifecycle

Worker pool management with crash storm detection, task timeout enforcement,
auto-resume after restart, and event-driven dispatch. Demonstrates how to
manage agent processes with health monitoring and graceful degradation.

Source: supervisor/workers.py, supervisor/queue.py, supervisor/events.py
"""

import multiprocessing as mp
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


# --- Worker Process ---

@dataclass
class Worker:
    wid: int
    proc: mp.Process
    in_q: Any                          # Per-worker input queue
    busy_task_id: Optional[str] = None

WORKERS: Dict[int, Worker] = {}
CRASH_TS: List[float] = []            # Timestamps of recent crashes
EVENT_Q = mp.Queue()                  # Shared output queue for all workers


def worker_main(wid, in_q, out_q, repo_dir, drive_root):
    """Worker process entry point. Loops until shutdown sentinel."""
    from ouroboros.agent import make_agent
    agent = make_agent(repo_dir=repo_dir, drive_root=drive_root, event_queue=out_q)

    while True:
        task = in_q.get()
        if task is None or task.get("type") == "shutdown":
            break
        events = agent.handle_task(task)
        for e in events:
            e["worker_id"] = wid
            out_q.put(e)


# --- Crash Storm Detection ---
# 3+ crashes in 60s → kill all workers, switch to direct-chat mode.
# This prevents infinite crash-restart loops.

SPAWN_GRACE_SEC = 90.0  # Workers need time to init on Colab

def ensure_workers_healthy():
    # Grace period: skip right after spawn
    if (time.time() - last_spawn_time) < SPAWN_GRACE_SEC:
        return

    now = time.time()
    busy_crashes = 0
    for wid, w in list(WORKERS.items()):
        if not w.proc.is_alive():
            if w.busy_task_id is not None:
                busy_crashes += 1
                # Re-queue the task it was working on
                if w.busy_task_id in RUNNING:
                    task = RUNNING.pop(w.busy_task_id)["task"]
                    enqueue_task(task, front=True)
            respawn_worker(wid)

    # Only count meaningful failures (task crashes or total wipeout)
    alive = sum(1 for w in WORKERS.values() if w.proc.is_alive())
    if busy_crashes > 0 or alive == 0:
        CRASH_TS.extend([now] * max(1, busy_crashes))
    else:
        CRASH_TS.clear()  # Idle deaths are not a storm

    # Remove old timestamps
    CRASH_TS[:] = [t for t in CRASH_TS if (now - t) < 60.0]

    if len(CRASH_TS) >= 3:
        # CRASH STORM: don't restart — that causes infinite loops.
        # Kill workers, notify owner, continue with direct-chat threading.
        notify_owner("⚠️ Frequent worker crashes. Switching to direct-chat mode.")
        kill_workers()
        CRASH_TS.clear()


# --- Task Timeout Enforcement ---

SOFT_TIMEOUT_SEC = 600    # Notify owner
HARD_TIMEOUT_SEC = 1800   # Kill worker, retry once
QUEUE_MAX_RETRIES = 1

def enforce_task_timeouts():
    now = time.time()
    for task_id, meta in list(RUNNING.items()):
        runtime = now - meta["started_at"]

        # Soft timeout: notification only
        if runtime >= SOFT_TIMEOUT_SEC and not meta.get("soft_sent"):
            meta["soft_sent"] = True
            notify_owner(f"⏱️ Task {task_id} running for {int(runtime)}s")

        # Hard timeout: kill + retry
        if runtime >= HARD_TIMEOUT_SEC:
            RUNNING.pop(task_id)
            worker = WORKERS.get(meta["worker_id"])
            if worker and worker.proc.is_alive():
                worker.proc.terminate()
            respawn_worker(meta["worker_id"])

            # Retry once with new task ID (preserves lineage)
            if meta["attempt"] <= QUEUE_MAX_RETRIES:
                retry_task = dict(meta["task"])
                retry_task["id"] = generate_id()
                retry_task["_attempt"] = meta["attempt"] + 1
                retry_task["timeout_retry_from"] = task_id
                enqueue_task(retry_task, front=True)


# --- Auto-Resume After Restart ---
# If scratchpad has content and recent restart detected,
# inject synthetic message to continue work.

def auto_resume_after_restart():
    if not recent_restart_detected():
        return
    scratchpad = read_file("memory/scratchpad.md")
    if not has_meaningful_content(scratchpad):
        return

    time.sleep(2)  # Let everything initialize
    threading.Thread(
        target=handle_chat_direct,
        args=(owner_chat_id,
              "[auto-resume after restart] Continue your work. "
              "Read scratchpad and identity.",
              None),
        daemon=True,
    ).start()


# --- Event Dispatch Table ---
# Clean, extensible pattern: event type → handler function.

EVENT_HANDLERS = {
    "llm_usage":           handle_llm_usage,
    "task_heartbeat":      handle_task_heartbeat,
    "typing_start":        handle_typing_start,
    "send_message":        handle_send_message,
    "task_done":           handle_task_done,
    "task_metrics":        handle_task_metrics,
    "restart_request":     handle_restart_request,
    "schedule_task":       handle_schedule_task,
    "cancel_task":         handle_cancel_task,
    "promote_to_stable":   handle_promote_to_stable,
    "toggle_evolution":    handle_toggle_evolution,
    "toggle_consciousness": handle_toggle_consciousness,
}

def dispatch_event(evt, ctx):
    handler = EVENT_HANDLERS.get(evt.get("type"))
    if handler is None:
        log_unknown_event(evt)
        return
    handler(evt, ctx)


# --- Evolution Circuit Breaker ---
# Auto-disable evolution after 3 consecutive failures.
# Prevents burning budget on broken evolution cycles.

def handle_task_done_evolution(evt, state):
    cost = float(evt.get("cost_usd", 0))
    rounds = int(evt.get("total_rounds", 0))

    if cost > 0.10 and rounds >= 1:
        # Success: reset failure counter
        state["evolution_consecutive_failures"] = 0
    else:
        # Failure: increment counter
        failures = state.get("evolution_consecutive_failures", 0) + 1
        state["evolution_consecutive_failures"] = failures

def enqueue_evolution_if_needed():
    if state["evolution_consecutive_failures"] >= 3:
        state["evolution_mode_enabled"] = False
        notify_owner("🧬⚠️ Evolution paused: 3 consecutive failures.")
        return
    # ... enqueue evolution task
