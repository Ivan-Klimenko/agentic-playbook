# agentic-patterns

A practitioner's reference for building LLM-powered agents. Framework-agnostic principles, LangGraph snippets, context engineering techniques, and production infrastructure patterns — extracted from real projects.

## What's inside

### [AGENT_PATTERNS.md](./AGENT_PATTERNS.md)

Core agentic design patterns — framework-agnostic, applicable to any agent system.

- **Architecture selection** — decision tree for ReAct, Router, Plan-and-Execute, Orchestrator-Worker, Swarm
- **State management** — reducers, output schemas, minimal state surface
- **Agent design** — agents-as-config (no classes), mode switching via synthetic messages, parallel multi-tool (batch), two-tier model strategy, no-plan architecture, pure LLM tool selection, fuzzy input resilience, prompt-driven plan execution
- **Context engineering** — TODO anchoring, virtual filesystem, context offloading, sub-agent isolation, think tool, prompt caching, tool output truncation + file offloading, auto-continue after context recovery
- **Prompt engineering** — system prompt structure, tool descriptions, hard limits, scaling rules, composite assembly

### [LANGGRAPH_PATTERNS.md](./LANGGRAPH_PATTERNS.md)

LangGraph-specific implementation patterns and code snippets, organized from architecture to infrastructure.

- **Architecture & design** — pattern taxonomy (6 archetypes), state design principles, node granularity guidance
- **Graph construction & routing** — ReAct loop wiring, Command (cross-graph updates + goto routing), Map-Reduce with Send API, functional API (`@entrypoint`/`@task`)
- **Tools & structured output** — InjectedState/InjectedToolCallId/InjectedToolArg, Pydantic schemas with error handling
- **Multi-agent patterns** — sub-graph as tool, sub-agent registry factory
- **Infrastructure & operations** — human-in-the-loop (interrupt placement gotchas), checkpointing & persistence (durability modes), streaming with subgraph visibility, error handling strategies (RetryPolicy + LLM-recoverable loop), caching in nodes

### [PRODUCTION_PATTERNS.md](./PRODUCTION_PATTERNS.md)

Battle-tested agentic patterns for agents receiving untrusted input at scale.

- **Prompt injection defense** — 4-layer sanitize + detect + wrap + normalize
- **Dynamic system prompt assembly** — conditional sections, prompt modes (full/minimal/none)
- **Skill discovery & token budget** — multi-source discovery, configurable limits
- **Tool visibility & ordering** — canonical order, dynamic descriptions
- **Thinking block management** — strip, preserve empty turns, multi-level config
- **Tool result sanitization** — details stripping, semantic command summarization
- **Response output directives** — inline reply-to, media, silence
- **Untrusted context separation** — explicit labeling of external metadata
- **Conditional memory instructions** — matched to tool availability
- **Tool loop detection** — pattern-based (repeat, poll, ping-pong) + corrective messages
- **Dual-loop architecture** — retry/recovery outer loop + tool execution inner loop
- **HITL as tool-level gate** — per-call approval, not whole-run
- **Message steering** — real-time injection into active runs
- **Permission-as-data** — declarative rulesets with three states + wildcard matching

### [ANTI_PATTERNS.md](./ANTI_PATTERNS.md)

47 common pitfalls when building agents, organized by category with cross-references to fixes.

- **Architecture & composition** (13 pitfalls)
- **Context management** (14 pitfalls)
- **Tool design** (9 pitfalls)
- **Prompt engineering** (6 pitfalls)
- **Security & permissions** (4 pitfalls)
- **Provider & infrastructure** (1 pitfall)

### [ORCHESTRATION_PATTERNS.md](./ORCHESTRATION_PATTERNS.md)

Multi-agent orchestration topologies — how to wire agents together. Adapted from [AG2's Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/).

- **Topology decision tree** — choosing the right pattern for your task
- **9 patterns** — Pipeline, Context-Aware Routing, Escalation, Hierarchical, Organic, Redundant, Star/Hub-and-Spoke, Feedback Loop, Triage with Tasks
- **Comparison matrix** — topology, communication style, parallelism, complexity
- **Pattern composition** — combining topologies at different levels

### [PLANNING_PATTERNS.md](./PLANNING_PATTERNS.md)

Cross-project comparison of planning mechanisms — how agents decide what to do, track progress, and keep humans in the loop.

- **Three concerns** — planning vs tracking vs governance as separate abstractions
- **7 approaches** — TODO tools, task tools with dependencies, plan mode (file + approval), phased workflows, iterative self-improvement, no-planning (pure reactive), middleware-based (Clarify→Plan→Act)
- **Comparison matrix** — 13 criteria across all approaches
- **Decision guidance** — model-quality hedge, layered composition, when to use what

### [INFRA_PATTERNS.md](./INFRA_PATTERNS.md)

Production infrastructure for agent platforms — extracted from [OpenClaw](./inspections/openclaw.md) (628K-LOC TypeScript).

- **Auth profile failover** with cooldown rotation and transient probing
- **7-layer tool policy pipeline** (profile, provider, global, agent, group)
- **Depth-aware sub-agent restrictions** with role-based capabilities (main/orchestrator/leaf)
- **5-tier context window recovery** (compact, re-compact, truncate, downgrade thinking, rotate model)
- **Pluggable context engine** abstraction (ingest, assemble, compact lifecycle)
- **Concurrency lanes** (nested queue serialization)
- **Plugin lifecycle hooks** (25 typed hooks, priority-ordered, sync-only hot paths)
- **Hybrid memory search** (vector + FTS + temporal decay + MMR)
- **Subagent registry** with announce dispatch, orphan recovery, frozen result capture
- **Command sandboxing** (safe-bin profiles with flag restrictions, GNU abbreviation resolution)
- **Defense-in-depth security** (10-layer stack)
- **Session write locking** with PID recycling detection, watchdog, signal-safe cleanup
- **Channel plugin architecture** (modular adapters)

### [PROJECT_INSPECTION.md](./PROJECT_INSPECTION.md)

Structured checklist for reverse-engineering a new agentic codebase.

- **Architecture & Agent Topology** — hierarchy, instantiation, communication, lifecycle, delegation logic
- **Context Management** — splitting, isolation, history, shared vs private state, token budget, long-running flows
- **Planning & Execution** — planning phase, plan schema, injection, execution tracking, re-planning, completion verification
- **Thinking & Reasoning** — think step, implementation, visibility, tool selection, post-execution reflection
- **Tool System** — definition, registration, selection, parallel execution, error recovery, meta-tools
- **Flow Control & Error Handling** — core loop, iteration limits, termination, failure handling, HITL, cost tracking
- **State & Persistence** — state schema, mutability, memory tiers, state passing, checkpointing, result accumulation
- **Inspection workflow** — recommended analysis order with practical steps

### [inspections/](./inspections/)

Project-level architecture deep-dives and codebase inspections (following [PROJECT_INSPECTION.md](./PROJECT_INSPECTION.md) checklist):

- [openclaw.md](./inspections/openclaw.md) — production agent orchestration platform (628K-LOC TypeScript, 50+ messaging channels)
- [opencode.md](./inspections/opencode.md) — open-source AI coding agent (~100K-LOC TypeScript)
- [deer_flow.md](./inspections/deer_flow.md) — super agent harness with middleware chain, subagent executor, LLM-powered memory (Python, LangGraph)
- [ouroboros.md](./inspections/ouroboros.md) — self-modifying autonomous agent with background consciousness, multi-worker supervisor, constitutional governance (Python, OpenRouter)
- [claude_code.md](./inspections/claude_code.md) — Anthropic's agentic CLI with markdown-as-code plugin system, event-driven hooks, multi-agent review pipelines, hierarchical permissions (TypeScript core + Python/Markdown plugins)
- [nemoclaw.md](./inspections/nemoclaw.md) — NVIDIA's sandboxed agent deployment orchestrator with declarative security policies, snapshot-based state migration, multi-sandbox registry (JS/TS + Python)

### [code_snippets/](./code_snippets/)

Implementation patterns extracted from inspected projects:

```
code_snippets/openclaw/          (TypeScript)
  auth_failover.ts              — auth profile rotation with cooldown and transient probing
  tool_policy_pipeline.ts       — 7-layer composable tool access control
  subagent_depth_policy.ts      — role-based capabilities (main/orchestrator/leaf) with control scope
  subagent_registry.ts          — lifecycle registry with announce dispatch and orphan recovery
  context_overflow_recovery.ts  — 5-tier recovery (compact, truncate head+tail, downgrade, rotate)
  context_engine.ts             — pluggable context engine interface with registry
  compaction_algorithm.ts       — staged summarization with adaptive chunking and identifier preservation
  session_write_lock.ts         — file-based locking with PID recycling detection and watchdog
  tool_loop_detection.ts        — 4-layer pattern detection (repeat, poll, ping-pong, circuit breaker)
  tool_policy_pipeline.ts       — 7-layer tool access control with glob matching
  lifecycle_hooks.ts            — 25 typed hooks (void/modifying/claiming execution models)
  hybrid_memory_search.ts       — vector + FTS merge with temporal decay and MMR diversity
  sandbox_security.ts           — safe-bin profiles, Docker isolation, bind mount validation
  dynamic_system_prompt.ts      — conditional assembly with 3 prompt modes
  prompt_injection_defense.ts   — 4-layer defense (sanitize, detect, wrap, prevent spoofing)
  tool_result_sanitization.ts   — details stripping, semantic summarization
  thinking_block_management.ts  — strip from history, multi-level config, empty turn preservation
  response_directives.ts        — inline output routing ([[reply_to]], MEDIA:, silence)
  dual_loop_architecture.ts     — outer retry/recovery + inner tool execution loop

code_snippets/opencode/          (TypeScript)
  agent_definition.ts       — agent-as-config schema, permission merging, custom agent loading
  subagent_invocation.ts    — Task tool gateway, child session isolation, resumable tasks
  context_compaction.ts     — 3-stage context recovery (prune, summarize, auto-continue)
  session_processor.ts      — core AI loop, stream event handling, doom loop detection, retries
  tool_system.ts            — tool definition, registry, 9-stage fuzzy edit, batch execution
  instance_context.ts       — AsyncLocalStorage isolation, per-directory state, monotonic IDs
  snapshot_revert.ts        — git-based filesystem snapshots, per-file revert, full restore
  event_bus_sse.ts          — typed event bus, global cross-instance streaming, SSE + 16ms batching

code_snippets/deer_flow/         (Python)
  agent_factory.py           — dynamic agent creation, ThreadState schema, middleware composition
  subagent_executor.py       — two-pool background execution, polling bridge, SSE events
  middleware_chain.py        — error→ToolMessage, clarification interrupt, concurrency truncation
  memory_system.py           — LLM-powered persistent memory, confidence-scored facts, token budgeting
  tool_system.py             — multi-source tool composition (config + built-in + MCP), caching
  prompt_engineering.py      — dynamic prompt assembly, CLARIFY→PLAN→ACT, progressive skill loading

code_snippets/ouroboros/         (Python)
  llm_tool_loop.py          — core ReAct loop with budget guards, self-check, model fallback
  context_assembly.py       — 3-block prompt caching, soft-cap trimming, two-tier compaction
  tool_registry.py          — plugin auto-discovery, two-tier visibility, thread-sticky executor
  supervisor_lifecycle.py   — worker pool, crash storm detection, timeouts, event dispatch
  consciousness_loop.py     — background daemon, budget isolation, LLM-controlled wakeup
  owner_injection.py        — per-task mailbox, mid-run message steering via Drive
  budget_tracking.py        — cost estimation, atomic state, drift detection, category breakdown

code_snippets/claude_code/       (Python/Markdown/Bash)
  hook_rule_engine.py       — declarative rule engine with hot-reload, fail-safe hooks, cached regex
  pretool_hook.py           — PreToolUse hook pattern with exit code protocol (0/1/2)
  security_hook.py          — session-scoped security warnings with show-once semantics, probabilistic cleanup
  self_referential_loop.sh  — Stop hook loop: same prompt re-fed until completion promise fulfilled
  plugin_system.md          — plugin manifest, command/agent/skill/hook schemas, composition patterns
  permission_model.json     — three-tier settings hierarchy, allow/ask/deny, sandbox isolation
  multi_agent_review.md     — parallel review agents + per-issue validation + confidence filtering
  stop_hook_quality_gate.md — Stop hooks as quality enforcement (test/build/completion gates)

code_snippets/nemoclaw/          (JS/TS/Python/YAML)
  blueprint_orchestrator.py — cross-language orchestration via structured stdout protocol
  sandbox_registry.js       — file-based multi-sandbox registry with default cascade
  declarative_policy.yaml   — Landlock + network policy with binary restrictions and split RO/RW
  snapshot_migration.ts     — state snapshot with external root tracking and path traversal prevention (C-4)
  policy_merge.js           — YAML-level policy preset merge with path traversal guard
  plugin_registration.ts    — minimal plugin pattern (1 command + 1 provider) for agent runtime
```

## Sources

Patterns are drawn from:

- Production work on [OpenClaw](./inspections/openclaw.md) (multi-channel agent platform)
- Architecture analysis of [OpenCode](./inspections/opencode.md) (open-source AI coding agent)
- Architecture analysis of [DeerFlow](./inspections/deer_flow.md) (super agent harness, LangGraph middleware chain)
- Architecture analysis of [Ouroboros](./inspections/ouroboros.md) (self-modifying autonomous agent with background consciousness)
- Architecture analysis of [Claude Code](./inspections/claude_code.md) (Anthropic's agentic CLI with plugin ecosystem)
- Architecture analysis of [NemoClaw](./inspections/nemoclaw.md) (NVIDIA sandboxed agent deployment orchestrator)
- [deep-agents-from-scratch](https://github.com/) tutorials (TODO anchoring, virtual FS, context offloading, sub-agents)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [LangGraph](https://github.com/langchain-ai/langgraph) docs and patterns
- [AG2 Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/) (orchestration topologies)
- [ReAct](https://arxiv.org/abs/2210.03629), [Plan-and-Solve](https://arxiv.org/abs/2305.04091) papers

## License

Personal reference. Not open-sourced yet.
