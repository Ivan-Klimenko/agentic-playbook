"""
Ouroboros Owner Message Injection

Per-task mailbox system for injecting owner messages into running agent tasks.
Each task gets its own JSONL file on Drive. Messages have unique IDs for dedup.
Drained every LLM round — owner can steer a running task without restarting it.

Source: ouroboros/owner_inject.py, ouroboros/loop.py
"""

import json
import pathlib
import queue
import uuid
from typing import List, Optional, Set


MAILBOX_DIR = "memory/owner_mailbox"


# --- Per-Task Mailbox (Drive-backed) ---

def write_owner_message(drive_root: pathlib.Path, text: str, task_id: str,
                        msg_id: Optional[str] = None):
    """Write an owner message to a specific task's mailbox on Drive."""
    path = drive_root / MAILBOX_DIR / f"{task_id}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    entry = json.dumps({
        "msg_id": msg_id or uuid.uuid4().hex,
        "ts": utc_now_iso(),
        "text": text,
    })
    with path.open("a", encoding="utf-8") as f:
        f.write(entry + "\n")


def drain_owner_messages(drive_root: pathlib.Path, task_id: str,
                         seen_ids: Optional[Set[str]] = None) -> List[str]:
    """Read new messages for a task. Dedup via seen_ids set.

    Caller keeps seen_ids across rounds — no file mutation needed.
    Append-only JSONL means no races with writer."""
    path = drive_root / MAILBOX_DIR / f"{task_id}.jsonl"
    if not path.exists():
        return []
    if seen_ids is None:
        seen_ids = set()

    messages = []
    for line in path.read_text().strip().splitlines():
        entry = json.loads(line)
        mid = entry.get("msg_id", "")
        if mid and mid in seen_ids:
            continue  # Already processed
        if mid:
            seen_ids.add(mid)
        text = entry.get("text", "")
        if text:
            messages.append(text)
    return messages


def cleanup_task_mailbox(drive_root: pathlib.Path, task_id: str):
    """Delete mailbox file after task completes."""
    path = drive_root / MAILBOX_DIR / f"{task_id}.jsonl"
    if path.exists():
        path.unlink()


# --- Message Injection into LLM Context ---
# Called every LLM round in the tool loop.
# Two sources: in-process queue (thread-safe) + Drive mailbox (cross-process).

def drain_incoming_messages(
    messages: list,                    # LLM conversation history (mutated)
    incoming_queue: queue.Queue,       # In-process queue from supervisor
    drive_root: pathlib.Path,
    task_id: str,
    seen_ids: set,                     # Dedup set, kept across rounds
):
    """Inject owner messages received during task execution."""

    # Source 1: In-process queue (thread-safe, from supervisor thread)
    while not incoming_queue.empty():
        try:
            text = incoming_queue.get_nowait()
            messages.append({"role": "user", "content": text})
        except queue.Empty:
            break

    # Source 2: Drive mailbox (cross-process, from forward_to_worker tool)
    if drive_root and task_id:
        drive_msgs = drain_owner_messages(drive_root, task_id, seen_ids=seen_ids)
        for msg_text in drive_msgs:
            messages.append({
                "role": "user",
                "content": f"[Owner message during task]: {msg_text}",
            })


# --- Integration in the LLM Tool Loop ---
# Called at the top of every loop iteration, before the LLM call.
#
# def run_llm_loop(...):
#     _owner_msg_seen = set()  # Dedup across rounds
#     while True:
#         ...
#         drain_incoming_messages(messages, incoming_queue, drive_root,
#                                task_id, event_queue, _owner_msg_seen)
#         msg = llm.chat(messages, tools=...)
#         ...
