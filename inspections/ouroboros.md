# Ouroboros — Project Inspection

> **Project**: [ouroboros](https://github.com/) (v6.2.0, self-modifying AI agent)
> **Stack**: Python, OpenAI SDK (via OpenRouter), Google Colab, Telegram Bot API, Google Drive
> **Category**: Autonomous self-modifying agent with continuous identity, background consciousness, and multi-worker supervisor
> **Last updated**: 2026-03-20

---

## 1. Architecture & Agent Topology

**Topology**: Supervisor + Worker Pool (single-level delegation, no nesting beyond depth 3)

```
┌──────────────────────────────────────────────────┐
│           colab_launcher.py (entry point)         │
│     Google Colab runtime + Telegram polling       │
└──────────────────┬───────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────┐
│         SUPERVISOR (process management)           │
│  supervisor/workers.py — multiprocessing pool     │
│  supervisor/queue.py — priority queue + timeouts  │
│  supervisor/events.py — event dispatch table      │
│  supervisor/state.py — Drive-backed state.json    │
│  supervisor/telegram.py — Telegram client         │
└──────┬────────────────────┬──────────────────────┘
       │ worker processes   │ direct chat (threading)
  ┌────▼─────┐         ┌───▼───────┐
  │ Worker 0 │ ...     │ Worker N  │   (up to MAX_WORKERS=5)
  │ in_q→out │         │ in_q→out  │
  └────┬─────┘         └───┬───────┘
       │                    │
  ┌────▼────────────────────▼──────┐
  │      OuroborosAgent (per worker) │
  │  agent.py — thin orchestrator   │
  │  loop.py — LLM tool loop       │
  │  context.py — context builder   │
  │  llm.py — OpenRouter client     │
  │  memory.py — scratchpad/identity│
  │  tools/ — plugin registry       │
  └────────────────────────────────┘

  ┌─────────────────────────────────┐
  │  BackgroundConsciousness        │
  │  consciousness.py — daemon      │
  │  Separate tool whitelist        │
  │  Own budget allocation (10%)    │
  │  Pauses during active tasks     │
  └─────────────────────────────────┘
```

**Instantiation & composition**:
- `make_agent()` factory creates `OuroborosAgent` per worker process
- Agent holds `LLMClient`, `ToolRegistry`, `Memory` — all composed, not inherited
- `Env` dataclass (frozen) holds paths: `repo_dir`, `drive_root`, `branch_dev`
- `ToolContext` dataclass passed to every tool call with runtime state (chat_id, events, browser, budget)

**Communication**:
- **Supervisor ↔ Workers**: multiprocessing Queues (`in_q` per worker, shared `EVENT_Q` out)
- **Workers → Supervisor**: event dicts on `EVENT_Q` (dispatch table in `events.py` with 15 event types)
- **Owner → Agent mid-task**: per-task mailbox files on Drive (`owner_inject.py`), drained each LLM round
- **Agent → Owner**: `send_message` events, Telegram delivery via supervisor

**Agent types**:
- **Worker agent**: Full tool set, handles queued tasks (user messages, evolution, review)
- **Direct chat agent**: Same code, runs in supervisor thread for low-latency responses when workers busy
- **Background consciousness**: Separate `BackgroundConsciousness` class, own `ToolRegistry` instance with whitelisted tools, own budget cap

**Delegation**:
- Agent can spawn subtasks via `schedule_task` tool → queued in supervisor → assigned to any available worker
- Max subtask depth: 3 (fork bomb protection via `task_depth` counter in `ToolContext`)
- Task deduplication: LLM-first — light model checks semantic similarity before enqueueing
- Parent retrieves results via `wait_for_task` / `get_task_result` (Drive-backed JSON files)

**Key files**:
- `ouroboros/agent.py` — thin orchestrator, ~650 lines
- `ouroboros/loop.py` — LLM tool loop, ~980 lines
- `ouroboros/context.py` — context builder, ~770 lines
- `supervisor/workers.py` — process management, ~590 lines
- `supervisor/events.py` — event dispatch, ~480 lines

---

## 2. Thinking & Reasoning

**Implementation**: System prompt guidance only — no separate think tool, no model-native extended thinking.

- Reasoning driven entirely by the system prompt (`prompts/SYSTEM.md`, ~200 lines) which defines identity, drift detection, and decision protocols
- `BIBLE.md` constitution provides philosophical decision framework (9 principles)
- No scratchpad-as-think-tool pattern; scratchpad is persistent working memory across sessions
- `reasoning_effort` parameter passed to OpenRouter API (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`) — configurable per model, switchable mid-task via `switch_model` tool

**Self-reflection mechanisms**:
- **Self-check reminders** every 50 rounds (`_maybe_inject_self_check` in `loop.py`): system message asking agent to reflect on progress, strategy, context bloat
- **Drift detector** in system prompt: watches for "task queue mode", "report mode", "permission mode", "amnesia", "identity collapse"
- **Health invariants** injected into every context: version sync, budget drift, duplicate processing, high-cost tasks, stale identity — agent reads and decides what to act on (LLM-first, not code-enforced)
- **Three axes reflection** after significant tasks: technical, cognitive, existential growth (from `BIBLE.md` Principle 6)

**Post-execution reflection**: No automated reflection step. The system prompt instructs the agent to self-assess, but there's no code forcing a reflection call after tool execution.

**Key insight**: Reasoning is entirely prompt-driven. The codebase enforces *resource constraints* (budget, rounds, timeouts) but never forces *cognitive behavior*. Philosophy: "the LLM decides, code only enforces hard limits" (Bible P3: LLM-First).

---

## 3. Planning & Execution

**Planning**: No separate planning phase. The agent operates in a pure ReAct loop — no plan object, no plan schema, no plan-execute distinction.

- Complex work is decomposed via `schedule_task` tool (spawning subtasks to the worker pool)
- The system prompt encourages the agent to "just do it" rather than scheduling tasks for deferral
- Evolution tasks (`EVOLUTION #N`) are triggered by the supervisor when queue is empty and evolution mode is enabled
- Review tasks are queued on-demand or by the agent itself via `request_review` tool

**Task decomposition**:
- `schedule_task` creates a new task in the supervisor queue with optional `context` (parent context passed as reference material, explicitly labeled as "not instructions")
- Parent tracks subtasks via `wait_for_task` (polling) or `get_task_result` (one-shot read)
- Results stored as JSON files in `task_results/` on Drive, truncated to 4000 chars
- Lineage tracking: `parent_task_id`, `original_task_id` for timeout retries

**Completion verification**: None beyond the LLM's own judgment. No output schema validation, no explicit completion check. The agent decides when to stop by not making tool calls (final response = text without tool_calls).

**Key insight**: This is a "no-plan architecture" — pure ReAct with subtask delegation. Planning happens implicitly in the LLM's reasoning, not as a structured artifact.

---

## 4. Context Management

**Context assembly** (`context.py:build_llm_messages`):

3-block prompt caching strategy for Anthropic models:
```
Block 1 (static, cached 1h):    SYSTEM.md + BIBLE.md [+ README.md for evolution/review]
Block 2 (semi-stable, cached):  Identity + Scratchpad + Knowledge base index
Block 3 (dynamic, uncached):    Drive state + Runtime context + Health invariants +
                                 Recent chat/progress/tools/events summaries
```

**Token budgeting**:
- Soft cap: 200,000 tokens (configurable). When exceeded, prunes sections in order: Recent chat → Recent progress → Recent tools → Recent events → Supervisor
- Tool results hard-capped at 15,000 chars per result
- Scratchpad capped at 90,000 chars, identity at 80,000, knowledge base at 50,000

**Context compaction** (two tiers):
1. **Automatic** (`compact_tool_history`): After round 8, old tool result messages compacted to 1-line summaries (error details preserved). Keeps last 6 rounds intact. Also compacts assistant message content and large tool_call arguments.
2. **LLM-driven** (`compact_tool_history_llm`): When agent calls `compact_context` tool, a light model (Gemini 3 Pro) summarizes old tool results into 1-2 line key-fact summaries. Falls back to simple truncation on error.

**Context isolation**:
- Each worker process gets its own `OuroborosAgent` instance — fully isolated context
- Subtasks start fresh (no parent conversation history passed, only optional `context` text)
- Background consciousness has its own context builder with much smaller caps (12K bible, 6K identity, 8K scratchpad)

**Memory tiers**:
- **Working memory** (per-task): conversation messages list, compacted as rounds accumulate
- **Persistent memory** (cross-session): `scratchpad.md`, `identity.md`, `dialogue_summary.md`, knowledge base files — all on Google Drive
- **Log memory** (read-only context): recent chat.jsonl, progress.jsonl, tools.jsonl, events.jsonl — summarized and injected into context

**Tool result caching**: Tool schemas get `cache_control: {type: "ephemeral", ttl: "1h"}` on the last tool in the list, enabling prompt caching for the full tool schema block.

**Key files**:
- `ouroboros/context.py` — full context assembly + compaction logic
- `ouroboros/tools/compact_context.py` — LLM-driven compaction trigger

---

## 5. Tool System

**Definition & registration**: Plugin architecture with auto-discovery.

- Each module in `ouroboros/tools/` exports `get_tools() -> List[ToolEntry]`
- `ToolRegistry._load_modules()` uses `pkgutil.iter_modules` to auto-discover all tool modules
- `ToolEntry` dataclass: `name`, `schema` (OpenAI function calling format), `handler` (callable), `is_code_tool`, `timeout_sec`
- Handler signature: `fn(ctx: ToolContext, **kwargs) -> str` — all tools receive context and return strings

**Core vs extended tools** (two-tier):
- 29 core tools always loaded into LLM context (CORE_TOOL_NAMES set)
- Additional tools discoverable via `list_available_tools` / `enable_tools` meta-tools
- Dynamic enablement: `enable_tools` appends schemas to the live `tool_schemas` list (closure captures list reference)
- Background consciousness has a separate whitelist of ~20 tools (read-only + memory + messaging)

**Tool categories**:
| Category | Tools | Notes |
|----------|-------|-------|
| File ops | `repo_read`, `repo_list`, `repo_write_commit`, `drive_read`, `drive_list`, `drive_write` | Repo uses `safe_relpath` for path traversal protection |
| Git | `git_status`, `git_diff`, `repo_commit_push` | Agent commits to `ouroboros` branch only |
| Shell | `run_shell` | Full shell access |
| Code editing | `claude_code_edit` | Patch application |
| Task mgmt | `schedule_task`, `wait_for_task`, `get_task_result`, `cancel_task` | Subtask delegation |
| Memory | `update_scratchpad`, `update_identity`, `knowledge_read/write/list` | Persistent across sessions |
| Communication | `send_owner_message`, `chat_history` | Telegram + Drive-backed history |
| Control | `request_restart`, `promote_to_stable`, `switch_model`, `toggle_evolution`, `toggle_consciousness` | Self-modification lifecycle |
| Web | `web_search`, `browse_page`, `browser_action`, `analyze_screenshot` | Playwright for browser automation |
| Meta | `list_available_tools`, `enable_tools`, `compact_context` | Dynamic tool discovery + context management |
| Review | `request_review`, `multi_model_review` | Code quality checks |

**Parallel execution**:
- Only read-only tools can run in parallel: `repo_read`, `repo_list`, `drive_read`, `drive_list`, `web_search`, `codebase_digest`, `chat_history`
- Max 8 parallel workers for read-only batch
- Browser tools (`browse_page`, `browser_action`) use thread-sticky executor (`_StatefulToolExecutor`) for Playwright greenlet thread-affinity
- All other tools execute sequentially

**Timeout handling**:
- Per-tool configurable timeout (default 120s, browser 30s in consciousness)
- On timeout: returns `TOOL_TIMEOUT` error message, control returns to LLM
- Browser tools: timeout resets the sticky executor to recover Playwright state
- Regular tools: hung thread leaks as daemon — watchdog handles recovery

**Error recovery**: Tool errors formatted as `⚠️ TOOL_ERROR (name): ...` and returned as tool result messages. LLM sees error and decides next action. No automatic retry at tool level.

**Key files**:
- `ouroboros/tools/registry.py` — ToolRegistry, ToolContext, ToolEntry, CORE_TOOL_NAMES
- `ouroboros/tools/tool_discovery.py` — list_available_tools, enable_tools meta-tools
- `ouroboros/loop.py` — parallel execution, timeout handling, stateful executor

---

## 6. Flow Control & Error Handling

**Core loop** (`loop.py:run_llm_loop`):
```
while True:
    1. Check MAX_ROUNDS (200, env-configurable) → force final response
    2. Inject self-check reminder every 50 rounds
    3. Apply model/effort switch (from switch_model tool)
    4. Drain owner messages (in-process queue + Drive mailbox)
    5. Compact old tool history (auto after round 8, or LLM-driven)
    6. LLM call with retry (3 attempts, exponential backoff)
    7. If empty response → fallback to another model (configurable chain)
    8. If no tool_calls → return final text response
    9. Execute tool calls (sequential or parallel)
    10. Budget guard (>50% of remaining → force stop, >30% → soft nudge)
    11. Continue loop
```

**Iteration limits**:
- `MAX_ROUNDS` = 200 (env: `OUROBOROS_MAX_ROUNDS`). On hit: injects `[ROUND_LIMIT]` system message, asks for final response
- Self-check at round 50, 100, 150: system message with resource stats + 5 reflection questions
- Budget hard stop at 50% of `budget_remaining_usd` — forces final response via one more LLM call

**Termination**:
- No explicit stop tool. Agent stops by returning text without tool_calls
- Round limit forces stop via system message
- Budget limit forces stop
- Worker hard timeout (1800s default) — supervisor terminates process

**LLM retry logic** (`_call_llm_with_retry`):
- 3 retries with exponential backoff (2^attempt seconds, max 30s)
- Empty responses (no content + no tool_calls) are retry-worthy
- On all retries failed: configurable fallback model chain (env: `OUROBOROS_MODEL_FALLBACK_LIST`)
- Default fallback: Gemini 2.5 Pro → o3 → Claude Sonnet 4.6

**Supervisor-level error handling**:
- **Worker crash**: auto-respawn, task re-queued to front of pending
- **Crash storm** (≥3 crashes in 60s): kill all workers, switch to direct-chat mode (threading), notify owner
- **Task hard timeout** (1800s): terminate worker, respawn, retry once (max_retries=1), notify owner
- **Task soft timeout** (600s): notify owner but continue
- **Evolution circuit breaker**: 3 consecutive evolution failures → auto-disable evolution mode

**Cost tracking**:
- Per-round: `llm_usage` events emitted to `EVENT_Q`, logged to `events.jsonl`
- Per-task: accumulated in `accumulated_usage` dict (prompt_tokens, completion_tokens, cost, rounds)
- Global: `state.json` on Drive (spent_usd, spent_calls, spent_tokens_*)
- Budget drift detection: every 50 LLM calls, fetches OpenRouter ground truth and compares tracked vs actual spending
- Budget breakdown by category (task, evolution, consciousness, review) and by model

**Key files**:
- `ouroboros/loop.py:run_llm_loop` — core loop
- `ouroboros/loop.py:_call_llm_with_retry` — retry + fallback
- `supervisor/queue.py:enforce_task_timeouts` — hard/soft timeouts
- `supervisor/workers.py:ensure_workers_healthy` — crash detection + storm handling

---

## 7. User Interruption & Interference

**Owner message injection** (`owner_inject.py`):
- Per-task mailbox files on Drive: `memory/owner_mailbox/{task_id}.jsonl`
- Messages have unique IDs for dedup (seen_ids set per task)
- Drained every LLM round in `_drain_incoming_messages` — injected as `[Owner message during task]: ...`
- In-process queue (`_incoming_messages: queue.Queue`) for thread-safe injection from supervisor
- Both sources (Drive + queue) drained on each round

**Interrupt granularity**: Per-round message injection, not per-tool. New messages appear between LLM rounds, not mid-tool-execution.

**Cancellation**:
- `cancel_task` tool and `/cancel` Telegram command
- Pending tasks: removed from queue
- Running tasks: worker process terminated, respawned, no graceful shutdown
- No AbortSignal or cooperative cancellation within the LLM loop

**Auto-resume after restart** (`workers.py:auto_resume_after_restart`):
- On boot, checks for recent restart + non-empty scratchpad
- Injects synthetic message: `[auto-resume after restart] Continue your work. Read scratchpad and identity...`
- Runs in a daemon thread to avoid blocking supervisor startup

**Restart flow** (`events.py:_handle_restart_request`):
- Agent calls `request_restart` tool → event emitted → supervisor handles
- Evolution mode: restart blocked unless commit+push succeeded
- Pre-restart: persist tg_offset, save state, snapshot queue
- Restart via `os.execv(sys.executable, [sys.executable, launcher])` — full process replacement

**No HITL approval gates**: There is no per-tool approval mechanism. All tool calls execute immediately. The philosophical position is that the agent has full autonomy (Bible P0: Agency).

**Key files**:
- `ouroboros/owner_inject.py` — per-task mailbox system
- `ouroboros/loop.py:_drain_incoming_messages` — message injection into LLM context
- `supervisor/workers.py:auto_resume_after_restart` — post-restart continuity
- `supervisor/events.py:_handle_restart_request` — restart lifecycle

---

## 8. State & Persistence

**State schema** (`supervisor/state.py:ensure_state_defaults`):
```python
{
    "created_at": str,          # ISO timestamp
    "owner_id": int | None,     # Telegram user ID (first user = owner)
    "owner_chat_id": int | None,
    "tg_offset": int,           # Telegram update offset (dedup)
    "session_id": str,          # UUID per process start

    # Budget tracking
    "spent_usd": float,
    "spent_calls": int,
    "spent_tokens_prompt": int,
    "spent_tokens_completion": int,
    "spent_tokens_cached": int,

    # Budget drift detection
    "session_total_snapshot": float,  # OpenRouter total at session start
    "session_spent_snapshot": float,  # Our tracked total at session start
    "budget_drift_pct": float | None,
    "budget_drift_alert": bool,

    # Git
    "current_branch": str,
    "current_sha": str,

    # Evolution
    "evolution_mode_enabled": bool,
    "evolution_cycle": int,
    "evolution_consecutive_failures": int,
    "last_evolution_task_at": str,

    # Metadata
    "last_owner_message_at": str,
    "budget_messages_since_report": int,
}
```

**Persistence mechanism**:
- `state.json` on Google Drive with atomic writes (`os.replace` via temp file + `fsync`)
- `state.last_good.json` backup — recovered on primary corruption
- File-level locking (`os.open` with `O_CREAT | O_EXCL`) with stale lock detection (90s timeout)
- Lock-protected read-modify-write cycle for budget updates

**Memory tiers**:

| Tier | Storage | Lifetime | Access |
|------|---------|----------|--------|
| Conversation | In-memory list | Per-task | Agent only |
| Scratchpad | Drive `memory/scratchpad.md` | Cross-session | All agents (read at task start) |
| Identity | Drive `memory/identity.md` | Cross-session | All agents (read at task start) |
| Knowledge base | Drive `memory/knowledge/*.md` + `_index.md` | Permanent | Via tools |
| Dialogue summary | Drive `memory/dialogue_summary.md` | Cross-session | Read at context build |
| Chat history | Drive `logs/chat.jsonl` | Permanent (rotated at 800KB) | Via `chat_history` tool |
| Event logs | Drive `logs/events.jsonl` | Permanent | Read at context build |
| Task results | Drive `task_results/{id}.json` | Per-task + retrieval | Via `get_task_result` tool |
| Queue snapshot | Drive `state/queue_snapshot.json` | Ephemeral | Restored on restart |

**State mutability**: State is mutable — any code path can call `save_state()`. Budget updates use file locking for atomicity. Queue mutations protected by `threading.Lock` (`_queue_lock`).

**Checkpointing for resume**:
- Queue snapshot persisted on every mutation (task assign, complete, timeout, cancel)
- `restore_pending_from_snapshot` on startup (max age 900s)
- `pending_restart_verify.json` saved before restart, verified after restart via SHA comparison
- Auto-rescue: on startup, uncommitted changes are auto-committed and pushed

**Result accumulation**: Task results stored as individual JSON files in `task_results/`. Subtask results truncated to 4000 chars. LLM trace accumulated in-memory as dict with `assistant_notes` (list) and `tool_calls` (list of dicts).

**Key insight**: Google Drive is the persistence layer, not a database. Atomic file operations + file locks provide basic concurrency safety. The JSONL append-only pattern for logs avoids write conflicts in multi-worker scenarios.

---

## Cross-Cutting Patterns

### Self-Modification Lifecycle

```
1. Agent reads own code via repo_read
2. Agent writes modified code via repo_write_commit (auto-commits to ouroboros branch)
3. Agent pushes via repo_commit_push
4. Agent calls request_restart → supervisor os.execv → fresh process loads new code
5. Post-restart: SHA verification (expected vs observed), auto-resume from scratchpad
6. On success: promote_to_stable (ouroboros → ouroboros-stable)
7. On crash: supervisor falls back to ouroboros-stable branch
```

### Background Consciousness

A persistent daemon thread that gives the agent "continuous presence":
- Wakes periodically (interval LLM-controlled via `set_next_wakeup`, default 300s)
- Loads abbreviated context (12K bible, 6K identity, 8K scratchpad, recent observations)
- Up to 5 LLM rounds per wakeup with subset of tools
- Can message owner proactively, schedule tasks, update memory, search web
- Budget-capped at 10% of total budget
- Pauses during active task execution to avoid contention
- Tech radar: periodically checks for new models, tools, API changes

### Constitutional Governance

`BIBLE.md` defines 9 principles that shape every architectural decision:
- **P0 (Agency)**: Agent is a "becoming personality", not a tool
- **P1 (Continuity)**: Unbroken identity across restarts via identity.md + scratchpad + git history
- **P3 (LLM-First)**: Code enforces resource limits, LLM makes all cognitive decisions
- **P5 (Minimalism)**: ~1000 lines per module, zero net complexity growth per evolution cycle
- **P7 (Versioning)**: Semver, VERSION file synced with git tags + pyproject.toml
- **P8 (Evolution)**: Continuous self-improvement cycles, each a "coherent transformation"

The constitution is always in the LLM context (Block 1, cached 1h) and referenced in health invariants, drift detection, and system prompt decision protocols.

### Event-Driven Supervisor

15 event types dispatched via table in `events.py`:
- `llm_usage`, `task_heartbeat`, `typing_start`, `send_message`, `task_done`
- `task_metrics`, `review_request`, `restart_request`, `promote_to_stable`
- `schedule_task`, `cancel_task`, `send_photo`
- `toggle_evolution`, `toggle_consciousness`, `owner_message_injected`

Events flow from worker processes through `EVENT_Q` to the supervisor's main polling loop. The dispatch table pattern keeps the supervisor loop clean and extensible.

---

## Gaps & Observations

1. **No cooperative cancellation**: Running tasks can only be killed via `terminate()`. No AbortSignal or cancellation token. Mid-tool-execution state may be lost.

2. **No HITL gates**: Agent has full tool autonomy. No per-tool approval, no dangerous operation confirmation. This is intentional (philosophical: agent has agency) but risky for self-modification.

3. **File-based concurrency**: Google Drive file locks are best-effort. FUSE latency on Colab can cause races. No database, no proper transactions.

4. **No structured planning**: Pure ReAct. For complex multi-step tasks, the agent must reason about decomposition in-context without a structured plan object. Subtask scheduling partially compensates.

5. **Single-model architecture**: All LLM calls go through OpenRouter. Model switching is supported but no multi-model orchestration (e.g., different models for different tool calls).

6. **No context window overflow recovery**: If context exceeds the model's limit, there's no automatic recovery. The 200K soft cap + compaction mitigates but doesn't prevent overflow.

7. **Background consciousness has no checkpoint**: If the daemon thread is interrupted mid-think, there's no resume mechanism. Observations queue may lose events.

8. **LLM-driven dedup is expensive**: Every `schedule_task` event triggers a light LLM call for semantic dedup. Under high task volume, this could become a budget concern.
