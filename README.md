# agentic-patterns

A practitioner's reference for building LLM-powered agents. Framework-agnostic principles, LangGraph snippets, context engineering techniques, and production infrastructure patterns — extracted from real projects.

## What's inside

### [AGENT_PATTERNS.md](./AGENT_PATTERNS.md)

Agentic design patterns — how to structure, compose, and prompt agents.

- **Architecture selection** — decision tree for ReAct, Router, Plan-and-Execute, Orchestrator-Worker, Swarm
- **State management** — reducers, output schemas, minimal state surface
- **Context engineering** — TODO anchoring, virtual filesystem, context offloading, sub-agent isolation, think tool, two-tier model strategy
- **LangGraph snippets** — Command, InjectedState/InjectedToolArg, structured output, map-reduce, HITL, checkpointing, sub-agent registry factory, streaming
- **Prompt engineering** — system prompt structure, tool descriptions, hard limits, scaling rules, composite assembly
- **Anti-patterns** — 16 common pitfalls with fixes

### [ORCHESTRATION_PATTERNS.md](./ORCHESTRATION_PATTERNS.md)

Multi-agent orchestration topologies — how to wire agents together. Adapted from [AG2's Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/).

- **Topology decision tree** — choosing the right pattern for your task
- **9 patterns** — Pipeline, Context-Aware Routing, Escalation, Hierarchical, Organic, Redundant, Star/Hub-and-Spoke, Feedback Loop, Triage with Tasks
- **Comparison matrix** — topology, communication style, parallelism, complexity
- **Pattern composition** — combining topologies at different levels

### [INFRA_PATTERNS.md](./INFRA_PATTERNS.md)

Production infrastructure for agent platforms — extracted from [OpenClaw](./solutions_architecture/OPENCLAW_ARCHITECTURE.md) (628K-LOC TypeScript).

- **Auth profile failover** with cooldown rotation
- **7-layer tool policy pipeline** (profile, provider, global, agent, group)
- **Depth-aware sub-agent restrictions**
- **3-tier context window recovery** (compact, re-compact, truncate)
- **Concurrency lanes** (nested queue serialization)
- **Plugin lifecycle hooks** (typed, priority-ordered, sync-only hot paths)
- **Hybrid memory search** (vector + FTS + temporal decay + MMR)
- **Command sandboxing** (safe-bin profiles with flag restrictions)
- **Defense-in-depth security** (9-layer stack)
- **Channel plugin architecture** (modular adapters)

### [solutions_architecture/](./solutions_architecture/)

- [OPENCLAW_ARCHITECTURE.md](./solutions_architecture/OPENCLAW_ARCHITECTURE.md) — full architecture deep-dive of a production agent orchestration platform
- [OPENCODE_ARCHITECTURE.md](./solutions_architecture/OPENCODE_ARCHITECTURE.md) — full architecture deep-dive of OpenCode (open-source AI coding agent, ~100K-LOC TypeScript)

### [code_snippets/](./code_snippets/)

TypeScript implementations of the infrastructure patterns:

```
code_snippets/OpenClaw/
  auth_failover.ts
  tool_policy_pipeline.ts
  subagent_depth_policy.ts
  context_overflow_recovery.ts
  lifecycle_hooks.ts
  hybrid_memory_search.ts
  sandbox_security.ts

code_snippets/OpenCode/
  agent_definition.ts       — agent-as-config schema, permission merging, custom agent loading
  subagent_invocation.ts    — Task tool gateway, child session isolation, resumable tasks
  context_compaction.ts     — 3-stage context recovery (prune, summarize, auto-continue)
  session_processor.ts      — core AI loop, stream event handling, doom loop detection, retries
  tool_system.ts            — tool definition, registry, 9-stage fuzzy edit, batch execution
  instance_context.ts       — AsyncLocalStorage isolation, per-directory state, monotonic IDs
  snapshot_revert.ts        — git-based filesystem snapshots, per-file revert, full restore
  event_bus_sse.ts          — typed event bus, global cross-instance streaming, SSE + 16ms batching
```

## Sources

Patterns are drawn from:

- Production work on [OpenClaw](./solutions_architecture/OPENCLAW_ARCHITECTURE.md) (multi-channel agent platform)
- Architecture analysis of [OpenCode](./solutions_architecture/OPENCODE_ARCHITECTURE.md) (open-source AI coding agent)
- [deep-agents-from-scratch](https://github.com/) tutorials (TODO anchoring, virtual FS, context offloading, sub-agents)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
- [LangGraph](https://github.com/langchain-ai/langgraph) docs and patterns
- [AG2 Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/) (orchestration topologies)
- [ReAct](https://arxiv.org/abs/2210.03629), [Plan-and-Solve](https://arxiv.org/abs/2305.04091) papers

## License

Personal reference. Not open-sourced yet.
