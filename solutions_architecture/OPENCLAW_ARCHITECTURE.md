# OpenClaw: Agentic Architecture & Flow

A deep-dive into the architecture of OpenClaw — a multi-channel, multi-model, self-hosted AI orchestration platform (~628K LOC TypeScript).

---

## 1. System Overview

OpenClaw is a **gateway-centric agent orchestration platform** that connects LLM agents to 50+ messaging channels (Slack, Discord, Telegram, Matrix, voice, etc.) with a unified tool system, plugin ecosystem, and security model.

**Key characteristics:**
- Single gateway process orchestrates all agents, channels, and plugins
- Agents run in-process via embedded PI agent SDK (not microservices)
- Tool access controlled by layered policy pipeline
- Sub-agents spawn within sessions with depth-limited recursion
- Memory persisted as workspace files with vector+FTS hybrid search
- Docker-based sandbox isolation for untrusted execution

```
┌─────────────────────────────────────────────────────────┐
│                      Gateway                             │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────┐ │
│  │ Channels │  │ Agent Runs│  │ Plugins  │  │ Config │ │
│  │ (50+)    │  │ (PI SDK)  │  │ (hooks)  │  │ (Zod)  │ │
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │              │             │      │
│  ┌────▼──────────────▼──────────────▼─────────────▼────┐ │
│  │              Unified Tool System                     │ │
│  │  (policy pipeline → hooks → execution → sandbox)    │ │
│  └─────────────────────┬───────────────────────────────┘ │
│                        │                                 │
│  ┌─────────────────────▼───────────────────────────────┐ │
│  │              Memory & Persistence                    │ │
│  │  (MEMORY.md → vector embeddings → FTS → sqlite-vec) │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Message Flow: End-to-End

```
Inbound Message (Slack/Discord/Telegram/...)
       │
       ▼
┌─────────────────────────┐
│  Channel Adapter Receive │  Channel-specific parsing, normalization
└────────┬────────────────┘
         │
         ▼
┌──────────────────────────┐
│  Route Resolution         │  Account ID → Agent ID mapping
│  - Role-based routing     │  DM allowlist enforcement
│  - Channel-specific rules │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│  Agent Scope Resolution   │  Load agent config, workspace dir
│  - Multi-agent config     │  Resolve auth profiles (failover order)
│  - Auth profile selection │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│  Tool Creation & Policy   │  Create all tools (coding, bash, channel, plugin)
│  - 7-layer policy pipeline│  Apply allow/deny lists per agent/group/provider
│  - Hook binding           │  Bind lifecycle hooks
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────────────────────────┐
│  PI Agent Execution Loop                      │
│  ┌────────────────────┐                       │
│  │ Run Single Attempt  │ ◄── Retry on failure │
│  │ - Stream response   │     (up to ~160 iter) │
│  │ - Parse tool calls  │     Auth profile      │
│  └─────────┬──────────┘     failover rotation  │
│            │                                   │
│            ▼                                   │
│  ┌────────────────────┐                       │
│  │ Tool Execution      │                       │
│  │ - Policy validation │                       │
│  │ - Pre-call hooks    │                       │
│  │ - Sandbox enforce   │                       │
│  │ - Post-call hooks   │                       │
│  └─────────┬──────────┘                       │
│            │                                   │
│            ▼                                   │
│  ┌────────────────────┐                       │
│  │ Continue or Done?   │                       │
│  │ tool_use → loop     │                       │
│  │ end_turn → extract  │                       │
│  └────────────────────┘                       │
│                                               │
│  Context Overflow? → Compaction (3-tier)       │
│  Auth Error? → Profile failover rotation       │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────┐
│  Response Formatting      │  Strip heartbeat tokens, apply channel prefix
│  - Channel-specific fmt   │  Thread routing
│  - Attachment handling    │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│  Memory Persistence       │  Embed in MEMORY.md, vector index
│  - Async indexing         │  Temporal decay for older entries
│  - Hybrid search update   │
└────────┬─────────────────┘
         │
         ▼
  Outbound Message Delivered
```

---

## 3. Core Architectural Patterns

### 3.1 Embedded Agent Loop with Retry & Failover

The agent doesn't run as a separate process — it's embedded in the gateway via the PI agent SDK. A bounded retry loop wraps each run with auth profile failover.

**Key design decisions:**
- Max retry iterations scale with number of auth profiles: `24 base + 8 per profile`
- Auth profiles rotate on failure with cooldown tracking (prevent hammering a failing provider)
- Context overflow triggers 3-tier recovery before giving up
- Tool calls stream through subscription-based event system

```
┌─────────────────────────────────────┐
│  Retry Loop (max ~160 iterations)   │
│                                     │
│  for each attempt:                  │
│    1. Select auth profile           │
│    2. Run PI agent attempt          │
│    3. On auth error → rotate        │
│    4. On overflow → compact         │
│    5. On success → return           │
│    6. On timeout → mark + rotate    │
└─────────────────────────────────────┘
```

See: `src/agents/pi-embedded-runner/run.ts`

### 3.2 Tool Policy Pipeline (7-Layer)

Tool access is controlled by a layered pipeline — each layer can filter the available toolset. This replaces simple allow/deny lists with a composable, priority-ordered system.

**Layers (evaluated in order):**

| # | Layer | Source | Purpose |
|---|-------|--------|---------|
| 1 | Profile policy | `tools.profile` | Named config profiles (e.g. "minimal") |
| 2 | Provider profile | `tools.byProvider.profile` | Per-LLM-provider restrictions |
| 3 | Global allow | `tools.allow` | System-wide tool allowlist |
| 4 | Global provider | `tools.byProvider.allow` | Provider-specific global list |
| 5 | Agent allow | `agents.{id}.tools.allow` | Per-agent tool restrictions |
| 6 | Agent provider | `agents.{id}.tools.byProvider.allow` | Per-agent per-provider |
| 7 | Group policy | Group `tools.allow` | Per-user-group restrictions |

**Each layer** uses glob patterns for matching (`exec*`, `sessions_*`), supports allow and deny lists, and handles plugin tool groups separately from core tools.

See: `src/agents/tool-policy-pipeline.ts`

### 3.3 Sub-Agent Spawning with Depth Control

Sub-agents are first-class: spawned within parent sessions, tracked in a registry, with depth-limited recursion and per-depth tool restrictions.

**Key constraints:**
- `maxSpawnDepth` (default: configurable) prevents infinite recursion
- `maxChildrenPerAgent` limits concurrent children per session
- Leaf agents (at max depth) lose spawning and session management tools
- Orchestrator sub-agents (depth < max) keep spawn capability
- Cross-agent spawning requires explicit `allowAgents` config
- Each sub-agent gets its own session key: `agent:{agentId}:subagent:{uuid}`

**Tool deny rules by depth:**
```
Always denied (all sub-agents):
  gateway, agents_list, whatsapp_login, session_status,
  cron, memory_search, memory_get, sessions_send

Additionally denied (leaf sub-agents, depth >= max):
  sessions_list, sessions_history, sessions_spawn
```

See: `src/agents/subagent-spawn.ts`, `src/agents/pi-tools.policy.ts`

### 3.4 Context Window Overflow: 3-Tier Recovery

When the context window fills up, the system doesn't just fail — it has three escalating recovery strategies:

```
Tier 1: In-Attempt Auto-Compaction
  └─ SDK detects overflow during tool loop, compacts automatically
  └─ If overflow persists → retry without extra compaction (up to MAX attempts)

Tier 2: Explicit Overflow Compaction
  └─ Gateway triggers external compaction (summarize older messages)
  └─ Increments compaction counter
  └─ If compacted → retry prompt

Tier 3: Tool Result Truncation
  └─ Identify oversized tool results (e.g. a huge file read)
  └─ Truncate them to fit within context window
  └─ If truncated → retry prompt
```

See: `src/agents/pi-embedded-runner/run.ts`, `compact.ts`

### 3.5 Plugin Lifecycle Hook System

25+ typed lifecycle hooks with priority-ordered execution. Hooks are either fire-and-forget (parallel) or sequential (modifying). Two hooks are synchronous-only for hot-path performance.

**Hook categories:**

| Phase | Hooks | Execution |
|-------|-------|-----------|
| Agent lifecycle | `before_model_resolve`, `before_prompt_build`, `agent_end` | Sequential (modifying) |
| LLM I/O | `llm_input`, `llm_output` | Parallel (observing) |
| Tool calls | `before_tool_call`, `after_tool_call`, `tool_result_persist` | Sequential / **Sync** |
| Messages | `message_received`, `message_sending`, `message_sent` | Sequential (modifying) |
| Sessions | `session_start`, `session_end`, `before_reset` | Parallel |
| Sub-agents | `subagent_spawning`, `subagent_spawned`, `subagent_ended` | Sequential |
| Gateway | `gateway_start`, `gateway_stop` | Parallel |

**Key design:** `tool_result_persist` and `before_message_write` are **synchronous-only** — returning a Promise is detected and warned. This prevents blocking the hot path.

See: `src/plugins/hooks.ts`, `src/plugins/types.ts`

### 3.6 Channel Plugin Architecture

Each messaging channel (Slack, Discord, Telegram, etc.) implements a modular adapter interface with optional capabilities:

```typescript
ChannelPlugin = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  // Required
  config: ChannelConfigAdapter;

  // Optional adapters (implement what you need)
  setup?: ChannelSetupAdapter;
  auth?: ChannelAuthAdapter;
  messaging?: ChannelMessagingAdapter;
  threading?: ChannelThreadingAdapter;
  outbound?: ChannelOutboundAdapter;
  security?: ChannelSecurityAdapter;
  streaming?: ChannelStreamingAdapter;
  // ... 15+ adapter interfaces
}
```

**Unified session key format:** `channel:accountId:peerId:threadId`
Examples: `telegram:123:456:789`, `slack:ws123:ch456:ts789`

See: `src/channels/plugins/types.plugin.ts`

### 3.7 Hybrid Memory Search

Memory is stored as workspace files (MEMORY.md + memory/*.md), indexed asynchronously with vector embeddings and full-text search.

**Search pipeline:**
```
Query → Keyword Extraction → Parallel Search
                                ├─ Vector Search (sqlite-vec)
                                └─ FTS Keyword Search (BM25)
                                         │
                                         ▼
                              Hybrid Merge (weighted)
                                ├─ Vector weight
                                ├─ Text weight
                                ├─ MMR diversity
                                └─ Temporal decay (half-life)
                                         │
                                         ▼
                              Score threshold → Top K results
```

See: `src/memory/manager.ts`

### 3.8 Concurrency Lanes

Commands are serialized through nested lane queues to prevent race conditions:

```
Session Lane (per-session serialization)
  └─ Global Lane (cross-session coordination)
       └─ Actual execution
```

This ensures: (a) a session can't process two messages concurrently, and (b) global resources (like auth profile rotation) are safely shared.

See: `src/agents/pi-embedded-runner/lanes.ts`

---

## 4. Security Model

### 4.1 Trust Boundaries

```
┌─────────────────────────────────────────────┐
│  Trusted: Local Host                         │
│  - ~/.openclaw state files                   │
│  - Gateway process (loopback by default)     │
│  - Plugin code (in-process, full privileges) │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  Constrained: Agent Execution            │ │
│  │  - Tool policy pipeline (7-layer)        │ │
│  │  - Safe-bin profiles (command allowlists) │ │
│  │  - Workspace-only file ops               │ │
│  │  - Docker sandbox (optional)             │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  Untrusted: External Input               │ │
│  │  - Channel messages (Slack, Discord...)   │ │
│  │  - LLM outputs (tool calls)              │ │
│  │  - Sub-agent outputs                     │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### 4.2 Defense-in-Depth Layers

| Layer | Mechanism | What it protects |
|-------|-----------|------------------|
| **Config validation** | Zod schema with `.strict()`, cross-field refinements | Misconfigurations |
| **Dangerous flag detection** | Explicit audit of known-dangerous config combos | Accidental exposure |
| **Tool policy pipeline** | 7-layer allow/deny with glob matching | Unauthorized tool access |
| **Safe-bin profiles** | Per-command flag allowlists, path blocking, positional limits | Shell injection |
| **Workspace-only mode** | File ops restricted to workspace directory | Path traversal |
| **Docker sandbox** | Read-only root, blocked host paths, network=none, no seccomp bypass | Container escape |
| **Bind mount validation** | Symlink resolution, blocked path list, traversal prevention | Mount escape |
| **Audit logging** | Command usage recording, denial logging, event emission | Forensics |
| **Sub-agent depth limits** | Max spawn depth, max children, tool deny lists per depth | Recursion bombs |
| **Auth rate limiting** | Max attempts, window, lockout, loopback exemption | Brute force |

### 4.3 Safe-Bin Profiles

Shell commands are sandboxed via profile-specific flag allowlists:

```
git   → maxPositional: unlimited, allowed flags for common operations
jq    → maxPositional: 1, denied: --argfile, --rawfile (file access)
grep  → maxPositional: 0 (stdin-only), denied: --recursive, --file
sort  → maxPositional: 0, denied: --compress-program, --output
cut   → maxPositional: 0, specific flag allowlist only
```

**Blocked universally:** path-like tokens (`/`, `~`, `../`), glob patterns (`*`, `?`, `[]`), shell metacharacters.

See: `src/infra/exec-safe-bin-policy.ts`

---

## 5. Configuration System

### 5.1 Config Hierarchy

```
~/.openclaw/openclaw.json (primary, JSON5)
  │
  ├─ gateway.*          → Port, bind, auth, TLS, control UI
  ├─ agents.defaults.*  → Default model, thinking, memory
  ├─ agents.list[]*     → Per-agent: workspace, model, tools, sandbox
  ├─ channels.*         → Per-channel: tokens, routing, DM policy
  ├─ providers.models[] → LLM provider configs
  ├─ tools.*            → Global tool policies, safe-bin profiles
  ├─ hooks.*            → Hook modules
  └─ plugins.*          → Plugin-specific config
```

### 5.2 Agent Override Chain

```
agents.defaults (base)
  └─ agents.list[id] (agent-specific override)
       └─ agents.list[id].tools.byProvider (provider-specific)
            └─ Runtime overrides (CLI flags, env vars)
```

### 5.3 Hot Reload

Config is file-watched with atomic updates:
1. Detect file change
2. Parse and validate new config (Zod)
3. On validation failure → rollback, log error
4. On success → atomic swap, graceful component restart

See: `src/config/config.ts`, `src/config/zod-schema.ts`

---

## 6. Plugin Ecosystem

### 6.1 Plugin Capabilities

A single plugin can register any combination of:

| Capability | Registration | Use case |
|-----------|-------------|----------|
| **Tools** | `api.registerTool(tool, opts)` | Custom agent tools |
| **Hooks** | `api.on(hookName, handler, {priority})` | Lifecycle interception |
| **HTTP routes** | `api.registerHttpRoute({path, handler})` | Webhook endpoints |
| **Channels** | `api.registerChannel(plugin)` | New messaging channels |
| **Providers** | `api.registerProvider(provider)` | Custom LLM backends |
| **CLI commands** | `api.registerCommand(def)` | Custom CLI subcommands |
| **Services** | `api.registerService(service)` | Long-lived background services |
| **Gateway methods** | `api.registerGatewayMethod(name, handler)` | Custom RPC methods |

### 6.2 Plugin API

```typescript
export default definePlugin({
  id: "my-plugin",
  version: "1.0.0",

  initialize: async (api: OpenClawPluginApi) => {
    // Register a tool
    api.registerTool(myToolFactory, { name: "my_tool" });

    // Register a typed hook (compile-time safe)
    api.on("before_tool_call", async (event, ctx) => {
      if (event.toolName === "exec" && event.input.command.includes("rm -rf")) {
        throw new Error("Blocked dangerous command");
      }
    }, { priority: 100 });

    // Register an HTTP webhook
    api.registerHttpRoute({
      path: "/webhooks/my-service",
      handler: async (req, res) => { /* ... */ },
    });
  },
});
```

See: `src/plugins/registry.ts`, `src/plugin-sdk/index.ts`

---

## 7. Key Takeaways for Agent Builders

1. **Embedded > microservice for agent loops** — running agents in-process eliminates network overhead and simplifies tool access. Retry/failover wraps the execution, not the deployment.

2. **Layered policies > flat allow/deny** — a 7-layer pipeline lets different stakeholders (admin, agent config, user group) independently constrain tools without conflicting.

3. **Depth-aware sub-agents** — don't just limit recursion count; restrict *capabilities* at each depth. Leaf agents shouldn't be able to spawn more children.

4. **3-tier context recovery** — compaction alone isn't enough. You need fallbacks: auto-compact → explicit compact → truncate oversized tool results.

5. **Sync hooks for hot paths** — not every hook can be async. Identify your hot paths (tool result persistence, message serialization) and enforce synchronous execution.

6. **Session lanes for concurrency** — don't rely on "it probably won't happen." Serialize per-session, coordinate globally.

7. **Hybrid memory search** — pure vector search misses exact matches; pure keyword search misses semantics. Combine both with weighted merging and temporal decay.

8. **Defense-in-depth for agent security** — no single layer is sufficient. Config validation, tool policies, command sandboxing, container isolation, and audit logging all serve different threat vectors.
