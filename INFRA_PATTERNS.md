# Infrastructure & Production Patterns

Production patterns for agent platforms — auth, security, concurrency, memory, and plugin systems. Extracted from OpenClaw (628K-LOC agent orchestration platform).

> See [openclaw.md](./inspections/openclaw.md) for full architecture documentation.
> See [code_snippets/](./code_snippets/) for TypeScript implementations.
> See [AGENT_PATTERNS.md](./AGENT_PATTERNS.md) for agentic design patterns (architecture, state, prompts, LangGraph).

---

## 1. Auth Profile Failover with Cooldown

Production agents need multiple LLM provider credentials. When one fails (rate limit, outage, auth error), rotate to the next.

**Pattern:**
- Maintain an ordered list of auth profiles (API keys / OAuth tokens)
- On failure, mark the profile with a cooldown timestamp and advance to the next
- Skip profiles still in cooldown during rotation
- Scale max retry iterations with profile count: `base + N * profiles`

```
Profile A (active) → Auth Error → Mark cooldown → Advance
Profile B (next)   → Timeout    → Mark cooldown → Advance
Profile C (next)   → Success    → Use this one
Profile A          → Cooldown expired → Available again
```

**Why it matters:** A single API key is a single point of failure. Round-robin without cooldown hammers a broken provider. The scaling formula (`24 + 8 * profiles`) gives more retries when more fallbacks exist.

> See: [code_snippets/auth_failover.ts](./code_snippets/auth_failover.ts)

---

## 2. Layered Tool Policy Pipeline

Don't use a flat allow/deny list for tool access. Use a composable pipeline where each layer independently constrains the toolset.

**Pipeline layers (evaluated in order):**

| # | Layer | Owner | Purpose |
|---|-------|-------|---------|
| 1 | Profile policy | Config profiles | Named presets ("minimal", "coding") |
| 2 | Provider profile | LLM provider | Per-provider restrictions |
| 3 | Global allow | System admin | System-wide allowlist |
| 4 | Global provider | System admin | Provider-specific global |
| 5 | Agent allow | Agent config | Per-agent restrictions |
| 6 | Agent provider | Agent config | Per-agent per-provider |
| 7 | Group policy | User group | Per-user-group restrictions |

**Key design decisions:**
- Each layer uses **glob patterns** for matching (e.g. `exec*`, `sessions_*`)
- Plugin tool groups are resolved separately from core tools
- Unknown allowlist entries trigger warnings, not failures
- `alsoAllow` provides additive overrides without replacing the base policy

**Why it matters:** Different stakeholders need different control planes. An admin restricts globally, an agent config restricts per-agent, a user group restricts per-team — all without conflicting.

> See: [code_snippets/tool_policy_pipeline.ts](./code_snippets/tool_policy_pipeline.ts)

---

## 3. Sub-Agent Depth-Aware Tool Restrictions

Don't just limit recursion depth — restrict *what sub-agents can do* based on their depth in the spawn tree, using role-based capabilities.

**Depth model with roles:**
```
Main Agent (depth 0, role=main) → All tools, can spawn, can control children
  └─ Orchestrator (depth 1, role=orchestrator) → Deny: gateway, cron, memory; can spawn + control
       └─ Leaf (depth 2, role=leaf) → Also deny: spawn, session mgmt; no control scope
```

**Role resolution:** `resolveSubagentRoleForDepth()` maps depth to one of three roles:
- `main` (depth 0): full capabilities
- `orchestrator` (0 < depth < maxSpawnDepth): can spawn, can control children
- `leaf` (depth ≥ maxSpawnDepth): cannot spawn, cannot control

**Control scope:** Each role has a control scope (`"children"` or `"none"`) that determines whether the agent can kill/steer/message its sub-agents. Only the controller that spawned a run can control it.

**Rules:**
- **Always denied** for any sub-agent: system admin tools, memory access, direct session sends
- **Leaf-only denied** (at max depth): spawning, session list/history (they can't orchestrate)
- Explicit `alsoAllow` in config can override deny rules
- Cross-agent spawning requires explicit `allowAgents` allowlist
- `maxChildrenPerAgent` limits concurrent children per session
- Capabilities are persisted in session store and survive gateway restarts

**Why it matters:** Without depth-aware restrictions, a sub-agent can spawn unlimited children, each with full capabilities. This creates recursion bombs and privilege escalation paths.

> See: [code_snippets/openclaw/subagent_depth_policy.ts](./code_snippets/openclaw/subagent_depth_policy.ts)

---

## 4. 5-Tier Context Window Recovery

Context overflow is inevitable with long-running agents. Don't just fail — implement escalating recovery:

```
Tier 1: In-Attempt Auto-Compaction
  The agent SDK detects overflow during tool loop and compacts automatically.
  If overflow persists after compaction → retry (up to 3 attempts).

Tier 2: Explicit Overflow Compaction
  Gateway triggers compaction via pluggable context engine.
  Staged summarization: split into N parts, summarize each, merge.
  Adaptive chunk ratio shrinks when messages are large relative to context.
  Identifier preservation (UUIDs, URLs, hashes) survives summarization.
  If compacted → retry prompt.

Tier 3: Tool Result Truncation
  Identify oversized tool results (>30% of context window).
  Smart head+tail strategy: if tail contains errors/diagnostics, preserve both ends.
  Hard limit: 400KB per result, minimum 2K chars always kept.
  If truncated → retry prompt.

Tier 4: Thinking Level Downgrade
  Reduce extended thinking budget to free token space.
  Frees token budget for actual content.

Tier 5: Auth Profile Rotation
  Switch to a different model/provider that may have a larger context window.
```

**Key implementation details:**
- Detect overflow via error message pattern matching (`isLikelyContextOverflowError`)
- Extract observed token count from error message for precise budget adjustment
- Track compaction attempts per run to avoid infinite compact-retry loops (max 3)
- Pre-compaction memory flush: optional agentic turn to store notes before compacting
- Post-compaction section re-injection: preserve critical sections ("Session Startup", "Red Lines")
- Compaction safety timeout: 15 minutes default with abort signal
- Orphaned tool_result repair after chunk drops

**Why it matters:** A single large tool result (file read, API response) can fill the entire context window. Compaction alone won't help — you need targeted truncation of the oversized result, plus fallback strategies when compaction isn't enough.

> See: [code_snippets/openclaw/context_overflow_recovery.ts](./code_snippets/openclaw/context_overflow_recovery.ts), [code_snippets/openclaw/compaction_algorithm.ts](./code_snippets/openclaw/compaction_algorithm.ts)

---

## 5. Concurrency Lanes (Nested Queue Serialization)

Agent systems need concurrent execution but safe serialization. Use nested lane queues:

```
Session Lane (per-session serialization)
  └─ Global Lane (cross-session coordination)
       └─ Actual execution
```

**How it works:**
- Each session gets its own queue — messages for a session are serialized
- Global operations (auth profile rotation, config reload) go through a shared queue
- The session enqueue wraps the global enqueue: `sessionLane(() => globalLane(() => work()))`
- Subagents get their own lane: `AGENT_LANE_SUBAGENT`

**Why it matters:** Without session lanes, two concurrent messages to the same agent can corrupt shared state (file edits, memory writes). Without global lanes, auth profile rotation races with active requests.

---

## 6. Plugin Lifecycle Hooks (Typed, Priority-Ordered)

Design hooks as first-class, typed, priority-ordered extension points — not just "on event" callbacks.

**Two execution modes:**
- **Parallel (fire-and-forget):** For observing hooks (`llm_input`, `session_start`). All handlers run concurrently via `Promise.all`.
- **Sequential (modifying):** For hooks that transform data (`before_tool_call`, `message_sending`). Handlers run in priority order, each seeing the previous handler's output.

**Priority system:**
```
Higher priority number → runs first
Hook A (priority: 100) → Hook B (priority: 50) → Hook C (priority: 0)
```

**Critical: sync-only hooks for hot paths.** Two hooks (`tool_result_persist`, `before_message_write`) are synchronous-only. If a handler returns a Promise, it's detected and warned/ignored. This prevents async overhead on the message serialization path.

**Why it matters:** Generic event emitters don't support priority ordering or sequential transformation. Production systems need both observing and modifying hooks, and must protect hot paths from accidental async handlers.

> See: [code_snippets/lifecycle_hooks.ts](./code_snippets/lifecycle_hooks.ts)

---

## 7. Hybrid Memory Search (Vector + FTS + Decay)

Pure vector search misses exact keyword matches. Pure FTS misses semantics. Combine both with weighted merging and temporal decay.

**Search pipeline:**
```
Query
  ├─ extractKeywords() → FTS search (BM25 ranking)
  └─ embedQuery()      → Vector search (cosine similarity)
           │
           ▼
     Hybrid Merge
       ├─ vectorWeight (default ~0.7)
       ├─ textWeight (default ~0.3)
       ├─ MMR diversity (optional, lambda-controlled)
       └─ Temporal decay (half-life in days)
           │
           ▼
     Score threshold → Top K results
```

**Key design decisions:**
- **Graceful degradation:** If no embedding provider is configured, fall back to FTS-only mode
- **Multi-keyword FTS:** Extract keywords from query, search each independently, merge+deduplicate
- **Temporal decay:** Older memories weighted down via half-life function — recent context preferred
- **MMR (Maximal Marginal Relevance):** Penalize results too similar to already-selected ones
- **Sync-on-search:** If the memory index is dirty, trigger a background sync before searching

**Why it matters:** Agent memory that can't find exact names/terms (FTS strength) or understand paraphrased concepts (vector strength) is frustrating. Temporal decay prevents stale memories from dominating.

> See: [code_snippets/hybrid_memory_search.ts](./code_snippets/hybrid_memory_search.ts)

---

## 8. Safe-Bin Profiles (Command Sandboxing)

When agents execute shell commands, don't just whitelist binary names — profile each command's allowed flags, positional arguments, and input patterns.

**Profile structure:**
```
Binary name → {
  maxPositional: number,       // max positional args (0 = stdin-only)
  allowedValueFlags: string[], // flags that take values (--arg, -e)
  deniedFlags: string[],       // explicitly blocked flags
}
```

**Examples:**
- `grep` → stdin-only (maxPositional: 0), deny `--file`, `--recursive`
- `jq` → max 1 positional (the filter), deny `--argfile`, `--rawfile`
- `sort` → stdin-only, deny `--compress-program`, `--output`

**Universal blocks:** Path-like tokens (`/`, `~`, `../`), glob patterns (`*`, `?`), shell metacharacters.

**Why it matters:** Allowing `grep` without restrictions lets the agent read any file on disk via `grep -r pattern /etc/`. Allowing `jq --rawfile` lets it load arbitrary files. Profile-level restrictions close these paths while keeping the tools useful.

---

## 9. Defense-in-Depth Security Layering

No single security layer is sufficient. Stack them:

| Layer | Mechanism | Threat |
|-------|-----------|--------|
| Config validation | Zod schema + cross-field refinements | Misconfigurations |
| Dangerous flag detection | Explicit audit of known-dangerous combos | Accidental exposure |
| Tool policy pipeline | 7-layer allow/deny | Unauthorized tool access |
| Safe-bin profiles | Per-command flag/path restrictions | Shell injection |
| Workspace-only mode | File ops restricted to workspace | Path traversal |
| Docker sandbox | Read-only root, network=none, blocked host paths | Container escape |
| Bind mount validation | Symlink resolution + blocked path list | Mount escape |
| Audit logging | Usage recording, denial logging | Forensics |
| Sub-agent depth limits | Max depth + max children + tool deny lists | Recursion bombs |

**Key: validate at build time, enforce at runtime, audit always.** Config validation catches mistakes before the system starts. Tool policies enforce at call time. Audit logging records everything for post-incident analysis.

**OS-level enforcement (NemoClaw approach):** For stronger isolation, enforce security at the kernel level via Landlock (filesystem), seccomp (syscalls), and network namespaces. Declare policies as YAML; the sandbox runtime enforces them. Agent code never sees the enforcement layer — it gets "permission denied" from the OS. Key patterns: split read-only config (auth tokens) from read-write agent state via symlinks; restrict network egress per-binary (only `claude` can reach the API, only `git` can reach GitHub); hot-reload network policies without sandbox restart.

> See: [code_snippets/openclaw/sandbox_security.ts](./code_snippets/openclaw/sandbox_security.ts), [code_snippets/nemoclaw/declarative_policy.yaml](./code_snippets/nemoclaw/declarative_policy.yaml), [inspections/nemoclaw.md](./inspections/nemoclaw.md)

---

## 10. Channel Plugin Architecture (Modular Adapters)

When supporting multiple messaging channels (Slack, Discord, Telegram, etc.), use a modular adapter interface where each capability is optional:

```
ChannelPlugin = {
  id, meta, capabilities,

  config:     ChannelConfigAdapter,      // Required
  auth?:      ChannelAuthAdapter,        // Optional
  messaging?: ChannelMessagingAdapter,   // Optional
  threading?: ChannelThreadingAdapter,   // Optional
  outbound?:  ChannelOutboundAdapter,    // Optional
  security?:  ChannelSecurityAdapter,    // Optional
  streaming?: ChannelStreamingAdapter,   // Optional
  // ... 15+ optional adapters
}
```

**Unified session key format:** `channel:accountId:peerId:threadId`
- `telegram:123:456:789` (DM thread)
- `slack:ws123:ch456:ts789` (Slack thread reply)
- `discord:guild123:ch456` (Discord channel)

**Why it matters:** Forcing all channels to implement every adapter leads to stub methods and broken contracts. Optional adapters let simple channels (webhook-only) coexist with full-featured ones (Slack with threading, reactions, file uploads).

---

## 11. Crash Storm Detection with Graceful Degradation

When agent workers run as separate processes (multiprocessing, containers, pods), crashes are inevitable. The key is distinguishing normal failures from cascading crash storms, and degrading gracefully instead of restart-looping.

**Pattern — crash counting with time window:**

```python
CRASH_TS: List[float] = []     # Timestamps of recent crashes
SPAWN_GRACE_SEC = 90.0         # Don't count crashes right after spawn (init takes time)
CRASH_STORM_THRESHOLD = 3      # Crashes in window
CRASH_WINDOW_SEC = 60.0        # Time window

def ensure_workers_healthy():
    # Grace period: workers need time to initialize (pip, Drive FUSE, model loading)
    if (time.time() - last_spawn_time) < SPAWN_GRACE_SEC:
        return

    now = time.time()
    busy_crashes = 0
    for wid, w in list(WORKERS.items()):
        if not w.proc.is_alive():
            if w.busy_task_id is not None:
                busy_crashes += 1
                # Re-queue the task to front of pending
                requeue_task(w.busy_task_id, front=True)
            respawn_worker(wid)

    # Only count MEANINGFUL failures — not idle worker deaths
    alive = sum(1 for w in WORKERS.values() if w.proc.is_alive())
    if busy_crashes > 0 or alive == 0:
        CRASH_TS.extend([now] * max(1, busy_crashes))
    else:
        CRASH_TS.clear()  # Idle deaths with healthy workers = not a storm

    # Expire old timestamps
    CRASH_TS[:] = [t for t in CRASH_TS if (now - t) < CRASH_WINDOW_SEC]

    if len(CRASH_TS) >= CRASH_STORM_THRESHOLD:
        handle_crash_storm()
```

**Graceful degradation — don't restart, downgrade:**

```python
def handle_crash_storm():
    """DON'T os.execv restart — that creates infinite loops.
    Instead: kill workers, switch to single-threaded mode."""
    notify_owner("⚠️ Crash storm detected. Switching to direct-chat mode.")
    kill_workers()          # Clean up all multiprocessing workers
    CRASH_TS.clear()        # Reset counter
    # Agent continues working in the main thread via handle_chat_direct()
    # (threading instead of multiprocessing — less throughput, but stable)
```

**Why this matters:**
- **execv restart on crash** is the most common mistake — if the crash is caused by the code itself (e.g. self-modification gone wrong), restarting loads the same broken code, creating an infinite loop
- **Idle worker deaths** should not trigger crash storm — on resource-constrained environments (Colab), idle workers may be killed by the OS. Only count failures that affect active tasks.
- **Spawn grace period** prevents false positives — workers may take 60-90s to initialize (especially on Colab with Drive FUSE mount). Counting initialization failures as crashes triggers false storm detection.
- **Task re-queuing** ensures work isn't lost — the task that was being processed by the crashed worker goes back to the front of the queue for the next healthy worker.

**Combine with:** Stable branch fallback ([PRODUCTION_PATTERNS §17](./PRODUCTION_PATTERNS.md#17-self-modification-lifecycle-safety)) for agents that modify their own code — on crash storm, checkout the last known-good branch before restarting.

> See: [code_snippets/ouroboros/supervisor_lifecycle.py](./code_snippets/ouroboros/supervisor_lifecycle.py) | Source: [Ouroboros](./inspections/ouroboros.md)

---

## 12. Pluggable Context Engine

Abstract compaction and context assembly behind a pluggable interface so custom strategies can be swapped without touching the core agent loop.

**Interface lifecycle:**
```
bootstrap() → ingest(msg) → afterTurn() → assemble(budget) → compact() → dispose()
                                              │
                                    prepareSubagentSpawn() → onSubagentEnded()
```

**Key design decisions:**
- Engines own *how* context is stored and retrieved; the runtime owns transcript I/O
- `CompactResult` carries token counts (before/after) so the caller can track savings
- Transcript rewrites via runtime callback — engines request rewrites through `runtimeContext.rewriteTranscriptEntries()`, keeping engine logic decoupled from session DAG implementation
- Process-global registry using `Symbol.for()` so duplicated bundles share state
- Two registration paths: core (trusted, can refresh) vs public SDK (unprivileged)
- Legacy compatibility proxy: auto-strips unrecognized params for older engines

**Why it matters:** Different use cases need different compaction strategies (aggressive summarization for chatbots, careful preservation for coding agents). A pluggable interface lets plugins provide custom engines without forking the core.

> See: [code_snippets/openclaw/context_engine.ts](./code_snippets/openclaw/context_engine.ts) | Source: [OpenClaw](./inspections/openclaw.md)

---

## 13. Subagent Registry with Announce Dispatch

When sub-agents complete, their results must reliably reach the parent — even across gateway restarts. A centralized registry with push-based delivery solves this.

**Pattern:**
```
Subagent completes → Freeze result text (up to 100KB)
  → Announce dispatch (3-phase):
      1. Try queue-primary (debounced, batched)
      2. Try direct delivery (immediate, for completion messages)
      3. Fallback queue (if primary fails)
  → Exponential backoff retry (1s → 2s → 4s, max 3 attempts)
  → Expiry: 5 min (non-completion), 30 min (completion flow)
```

**Orphan recovery (after gateway restart):**
- Scan registry for runs with `abortedLastRun = true`
- Build resume message with original task + last human message
- Retry with exponential backoff (5s initial, 3 max retries, 2x multiplier)

**Key design decisions:**
- Push-based announce: explicit instruction to agents "do NOT poll — wait for completion events"
- Frozen result capture: latest assistant text preserved so delayed delivery still carries content
- Registry persisted to disk (`subagents/runs.json`, V2 format) for restart survival
- `SubagentRunRecord` tracks 30+ lifecycle fields (created → started → ended → cleaned up)
- Lifecycle error grace period: defers terminal cleanup 15s to tolerate transient provider errors

**Why it matters:** Without reliable result delivery, subagent work gets lost on timeouts or restarts. Polling wastes tool calls and clutters context.

> See: [code_snippets/openclaw/subagent_registry.ts](./code_snippets/openclaw/subagent_registry.ts) | Source: [OpenClaw](./inspections/openclaw.md)

---

## 14. Session Write Locking with Staleness Detection

JSONL session files need exclusive write access. File-based locking with PID recycling detection prevents corruption from concurrent writers and stale locks from crashed processes.

**Pattern:**
```
Lock file: { pid, createdAt (ISO), starttime (clock ticks from /proc/pid/stat) }

Acquire:
  1. Try O_EXCL atomic create → success
  2. Lock exists? → inspect for staleness:
     - Dead PID → stale, reclaim
     - Alive PID, different starttime → recycled PID, stale, reclaim
     - Alive PID, same starttime, age > threshold → stale, reclaim
     - Alive PID, same starttime, fresh → contended, retry with backoff
  3. Reentrant: same process → increment ref count

Release:
  - Decrement ref count → if 0, unlink lock file
  - Signal handlers (SIGINT/SIGTERM/SIGQUIT/SIGABRT) → synchronous cleanup
  - Watchdog timer (60s interval) → force-release locks held > 5 minutes
```

**Why it matters:** PID-only locking is broken on long-running servers — PIDs recycle after process death. Start time comparison catches this. Watchdog cleanup prevents deadlocks from killed processes that couldn't run signal handlers.

> See: [code_snippets/openclaw/session_write_lock.ts](./code_snippets/openclaw/session_write_lock.ts) | Source: [OpenClaw](./inspections/openclaw.md)

---

## 5. Anti-Patterns & Pitfalls

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| Flat tool allow/deny lists | Can't express per-agent, per-provider, per-group policies | Use layered policy pipeline (see §2) |
| Uniform sub-agent capabilities | Sub-agents at any depth can spawn more children → recursion bombs | Depth-aware tool deny lists (see §3) |
| Single auth credential | One rate limit or outage kills the agent | Auth profile failover with cooldown (see §1) |
| Crash on context overflow | Long conversations just stop working | 5-tier recovery: compact → re-compact → truncate → downgrade thinking → rotate model (see §4) |
| Hardcoded compaction strategy | Different use cases need different approaches | Pluggable context engine interface (see §12) |
| Polling for subagent results | Wastes tool calls, clutters parent context | Push-based announce dispatch with frozen result capture (see §13) |
| PID-only file locking | PID recycling → two processes think they hold the lock | PID + starttime staleness detection with watchdog (see §14) |
| No session serialization | Concurrent messages to same agent corrupt state | Nested lane queues (see §5) |
| Async hooks on hot paths | Message serialization stalls on slow plugins | Enforce sync-only hooks where latency matters (see §6) |
| Pure vector OR pure keyword search | Misses exact names or semantic paraphrases | Hybrid search with weighted merge (see §7) |
| Whitelisting binaries without flag restrictions | `grep -r /etc/passwd` reads any file | Per-command flag profiles (see §8) |
| Restarting on crash storm | Self-modifying agents restart into broken code → infinite loop | Degrade to single-threaded mode + stable branch fallback (see §11) |

> For agentic-level anti-patterns (state management, prompts, graph design), see [AGENT_PATTERNS.md](./AGENT_PATTERNS.md#5-anti-patterns--pitfalls).

---

## 12. References

### Architecture Case Studies
- [openclaw.md](./inspections/openclaw.md) — deep-dive into OpenClaw's agentic architecture (gateway, tool policies, sub-agents, memory, security)
- [code_snippets/](./code_snippets/openclaw/) — TypeScript implementations of production patterns from OpenClaw
- [ouroboros.md](./inspections/ouroboros.md) — self-modifying agent with crash storm detection, worker pool management, file-based persistence on cloud storage
