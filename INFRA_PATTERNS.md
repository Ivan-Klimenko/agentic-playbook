# Infrastructure & Production Patterns

Production patterns for agent platforms — auth, security, concurrency, memory, and plugin systems. Extracted from OpenClaw (628K-LOC agent orchestration platform).

> See [OPENCLAW_ARCHITECTURE.md](./OPENCLAW_ARCHITECTURE.md) for full architecture documentation.
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

Don't just limit recursion depth — restrict *what sub-agents can do* based on their depth in the spawn tree.

**Depth model:**
```
Main Agent (depth 0) → All tools available
  └─ Orchestrator Sub-Agent (depth 1) → Deny: gateway, cron, memory
       └─ Leaf Sub-Agent (depth 2, max) → Also deny: spawn, session mgmt
```

**Rules:**
- **Always denied** for any sub-agent: system admin tools, memory access, direct session sends
- **Leaf-only denied** (at max depth): spawning, session list/history (they can't orchestrate)
- Explicit `alsoAllow` in config can override deny rules
- Cross-agent spawning requires explicit `allowAgents` allowlist
- `maxChildrenPerAgent` limits concurrent children per session

**Why it matters:** Without depth-aware restrictions, a sub-agent can spawn unlimited children, each with full capabilities. This creates recursion bombs and privilege escalation paths.

> See: [code_snippets/subagent_depth_policy.ts](./code_snippets/subagent_depth_policy.ts)

---

## 4. 3-Tier Context Window Recovery

Context overflow is inevitable with long-running agents. Don't just fail — implement escalating recovery:

```
Tier 1: In-Attempt Auto-Compaction
  The agent SDK detects overflow during tool loop and compacts automatically.
  If overflow persists after compaction → retry (up to MAX attempts).

Tier 2: Explicit Overflow Compaction
  Gateway triggers external compaction (summarize older messages).
  If compacted → retry prompt.

Tier 3: Tool Result Truncation
  Identify oversized tool results (e.g. a 500KB file read).
  Truncate to fit within context window.
  If truncated → retry prompt.
```

**Key implementation details:**
- Detect overflow via error message pattern matching (`isLikelyContextOverflowError`)
- Track compaction attempts per run to avoid infinite compact-retry loops
- Measure per-message character counts to find the biggest contributors
- Estimate tokens to determine if truncation will actually help

**Why it matters:** A single large tool result (file read, API response) can fill the entire context window. Compaction alone won't help — you need targeted truncation of the oversized result.

> See: [code_snippets/context_overflow_recovery.ts](./code_snippets/context_overflow_recovery.ts)

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

> See: [code_snippets/sandbox_security.ts](./code_snippets/sandbox_security.ts)

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

## 5. Anti-Patterns & Pitfalls

| Anti-pattern | Why it's bad | Fix |
|---|---|---|
| Flat tool allow/deny lists | Can't express per-agent, per-provider, per-group policies | Use layered policy pipeline (see §2) |
| Uniform sub-agent capabilities | Sub-agents at any depth can spawn more children → recursion bombs | Depth-aware tool deny lists (see §3) |
| Single auth credential | One rate limit or outage kills the agent | Auth profile failover with cooldown (see §1) |
| Crash on context overflow | Long conversations just stop working | 3-tier recovery: compact → re-compact → truncate (see §4) |
| No session serialization | Concurrent messages to same agent corrupt state | Nested lane queues (see §5) |
| Async hooks on hot paths | Message serialization stalls on slow plugins | Enforce sync-only hooks where latency matters (see §6) |
| Pure vector OR pure keyword search | Misses exact names or semantic paraphrases | Hybrid search with weighted merge (see §7) |
| Whitelisting binaries without flag restrictions | `grep -r /etc/passwd` reads any file | Per-command flag profiles (see §8) |

> For agentic-level anti-patterns (state management, prompts, graph design), see [AGENT_PATTERNS.md](./AGENT_PATTERNS.md#5-anti-patterns--pitfalls).

---

## 12. References

### Architecture Case Studies
- [OPENCLAW_ARCHITECTURE.md](./solutions_architecture/OPENCLAW_ARCHITECTURE.md) — deep-dive into OpenClaw's agentic architecture (gateway, tool policies, sub-agents, memory, security)
- [code_snippets/](./code_snippets/openclaw/) — TypeScript implementations of production patterns from OpenClaw
