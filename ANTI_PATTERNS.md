# Anti-Patterns & Pitfalls

42 common mistakes when building LLM-powered agents, with fixes. Cross-referenced to the relevant pattern documents.

> **See also:** [AGENT_PATTERNS.md](./AGENT_PATTERNS.md) | [PRODUCTION_PATTERNS.md](./PRODUCTION_PATTERNS.md) | [INFRA_PATTERNS.md](./INFRA_PATTERNS.md) | [LANGGRAPH_PATTERNS.md](./LANGGRAPH_PATTERNS.md)

---

## Architecture & Composition

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 1 | Putting all logic in one graph | Untestable, prompt bloat, can't tune sub-tasks independently | Break into sub-agents as tools ([AGENT_PATTERNS §2.3](./AGENT_PATTERNS.md#23-sub-agent-composition)) |
| 2 | Passing full orchestrator state to sub-agents | State coupling, sub-agents see irrelevant fields | Map state at tool boundary ([AGENT_PATTERNS §2.2](./AGENT_PATTERNS.md#22-state-management-principles)) |
| 3 | No recursion limit | Runaway ReAct loops burn tokens | Set `recursion_limit` on every graph ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 4 | Using only LLM-routing or only hardcoded routing | Pure LLM-routing is slow for predictable inputs; pure hardcoded routing is rigid when categories evolve | Hybrid: pre-processing shortcuts for known patterns, LLM for the rest ([AGENT_PATTERNS §2.9](./AGENT_PATTERNS.md#29-pre-processing--shortcuts), [§2.1](./AGENT_PATTERNS.md#21-orchestrator-types)) |
| 5 | Agent classes with behavior methods | Tight coupling, hard to compose, can't add agents without code | Agents-as-config: named config objects, generic runtime ([AGENT_PATTERNS §2.6](./AGENT_PATTERNS.md#26-agents-as-config-no-agent-classes)) |
| 6 | State machine for agent mode transitions | Over-engineered, hard to debug, special state management | Synthetic messages with agent field ([AGENT_PATTERNS §2.7](./AGENT_PATTERNS.md#27-agent-mode-switching-via-synthetic-messages)) |
| 7 | Sequential tool calls for independent operations | Unnecessary latency — N round-trips instead of 1 | Batch tool: parallel execution ([AGENT_PATTERNS §2.8](./AGENT_PATTERNS.md#28-parallel-multi-tool-execution-batch-tool)) |
| 8 | Over-engineering planning (formal plan-and-execute everywhere, or building a plan execution engine) | Doubles latency for simple tasks; rigid step ordering limits LLM flexibility | No-plan for short interactions; prompt-driven plan execution for complex ones ([AGENT_PATTERNS §2.11](./AGENT_PATTERNS.md#211-no-plan-architecture-planning-via-system-prompt), [§2.15](./AGENT_PATTERNS.md#215-prompt-driven-plan-execution-no-engine)) |
| 9 | Mixing retry/recovery logic with tool execution loop | Spaghetti error handling, hard to test and reason about | Dual-loop: outer for retry/failover, inner for tool execution ([PRODUCTION_PATTERNS §11](./PRODUCTION_PATTERNS.md#11-dual-loop-architecture-retry-vs-tool-execution)) |
| 10 | Storing cheaply-derivable or formatted data in graph state | State bloat, stale data, can't format differently per node. (Note: caching *expensive* derivations like API results or embeddings in state is fine.) | Store raw data, derive on read ([LANGGRAPH_PATTERNS §2](./LANGGRAPH_PATTERNS.md#2-state-design-principles)) |
| 11 | One fat node mixing different external services (graph-level) | Single failure kills entire step, can't retry selectively, no mid-node checkpoint. (Distinct from #1 which is about splitting across sub-graphs; this is about splitting nodes *within* a graph.) | Split by service/failure mode ([LANGGRAPH_PATTERNS §3](./LANGGRAPH_PATTERNS.md#3-node-granularity)) |
| 12 | No retry policy on nodes calling external services | Transient network/rate-limit errors crash the graph | Add `RetryPolicy` per node ([LANGGRAPH_PATTERNS §16](./LANGGRAPH_PATTERNS.md#16-error-handling-strategies)) |
| 13 | Side effects before `interrupt()` | Code before interrupt re-runs on every resume — duplicate notifications, double writes | Place `interrupt()` at top of node ([LANGGRAPH_PATTERNS §13](./LANGGRAPH_PATTERNS.md#13-human-in-the-loop-with-interrupt)) |

## Context Management

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 14 | Overloading message history | Context window fills up, LLM loses focus | Serialize state into system prompt, keep messages for conversation ([AGENT_PATTERNS §2.5](./AGENT_PATTERNS.md#25-dynamic-state-injection-working-memory)) |
| 15 | No context anchoring on long tasks | Agent drifts from objectives after ~50 tool calls (context rot) | TODO write-read-reflect cycle ([AGENT_PATTERNS §3.1](./AGENT_PATTERNS.md#31-todo-lists-as-context-anchors)) |
| 16 | Raw tool results in messages | Token-heavy content fills context, displaces reasoning | Context offloading: content → files, summaries → messages ([AGENT_PATTERNS §3.2](./AGENT_PATTERNS.md#32-virtual-filesystem-for-context-offloading)) |
| 17 | Sub-agents inherit parent context | Context clash, confusion, poisoning from irrelevant history | Replace messages with task-only context ([AGENT_PATTERNS §3.4](./AGENT_PATTERNS.md#34-context-isolation-via-sub-agents)) |
| 18 | No structured reflection checkpoints | Agent makes impulsive decisions on complex multi-step tasks | think_tool forces articulated reasoning ([AGENT_PATTERNS §3.6](./AGENT_PATTERNS.md#36-think-tool-no-op-forced-reflection)) |
| 19 | Editing/reordering earlier messages between turns | Invalidates prompt cache, re-processes entire context at full cost | Append-only context ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 20 | Using expensive model for context summarization | Wastes frontier-model capacity on a compression task | Summarize with cheap model, keep expensive model for reasoning ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 21 | Removing tools from schema as first reaction to limits | Invalidates entire prompt cache (tools sit at top of cache hierarchy) | Return error stub first (cache-safe); only remove tool if LLM ignores the error ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 22 | Unbounded tool output in context | Large outputs flood context, displace reasoning | Auto-truncate at threshold + offload full output to temp file ([AGENT_PATTERNS §3.8](./AGENT_PATTERNS.md#38-tool-output-truncation-with-file-offloading)) |
| 23 | Agent stops after context compaction | User must manually say "continue" — breaks autonomous flow | Auto-continue: inject synthetic message ([AGENT_PATTERNS §3.9](./AGENT_PATTERNS.md#39-auto-continue-after-context-recovery)) |
| 24 | Keeping thinking blocks in history | Previous reasoning tokens waste context on re-send | Strip thinking blocks, preserve empty turns ([PRODUCTION_PATTERNS §5](./PRODUCTION_PATTERNS.md#5-thinking-block-management)) |
| 25 | Verbose tool results sent to LLM | Token waste, potential injection from external payloads | Strip details field, use semantic summaries ([PRODUCTION_PATTERNS §6](./PRODUCTION_PATTERNS.md#6-tool-result-sanitization-details-stripping)) |

## Tool Design

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 26 | Manual JSON parsing of LLM output | Fragile, error-prone, prompt overhead for format examples | Use structured output with Pydantic ([LANGGRAPH_PATTERNS §10](./LANGGRAPH_PATTERNS.md#10-structured-output-with-pydantic)) |
| 27 | Tool returns raw exception | LLM can't recover gracefully | Return structured error in ToolMessage ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 28 | Generic error strings from tools | LLM can't self-correct without knowing valid options | Include valid values and retry hints in error messages ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 29 | Stateless analysis across calls | Agent forgets prior work in multi-turn sessions | Add a scratchpad/memo persisted in parent state |
| 30 | Exact-match-only for tool inputs | LLM whitespace/indentation hallucinations cause ~20% failure rate | Fuzzy fallback chain: 9 strategies ([AGENT_PATTERNS §2.13](./AGENT_PATTERNS.md#213-fuzzy-tool-input-resilience-fallback-matching)) |
| 31 | Flat `max_tool_calls` as only loop protection | Kills legitimate long-running tasks alongside runaway loops | Pattern-based detection + corrective messages; hard cap as backstop ([PRODUCTION_PATTERNS §10](./PRODUCTION_PATTERNS.md#10-tool-loop-detection-pattern-based-not-hard-caps)) |
| 32 | Adding a tool recommender/router as first optimization | Over-engineering; usually tool descriptions or ordering are the real problem | Improve descriptions, reduce set via policy, fix ordering first ([AGENT_PATTERNS §2.12](./AGENT_PATTERNS.md#212-pure-llm-tool-selection-no-planner-no-router)) |

## Prompt Engineering

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 33 | Amending prompts for structured output format | Redundant with schema, can conflict | Let Pydantic model define the format ([LANGGRAPH_PATTERNS §10](./LANGGRAPH_PATTERNS.md#10-structured-output-with-pydantic)) |
| 34 | Same model for all cognitive loads | Expensive model wasted on summarization/formatting | Two-tier: cheap model for extraction, expensive for reasoning ([AGENT_PATTERNS §2.10](./AGENT_PATTERNS.md#210-two-tier-model-strategy)) |
| 35 | Monolithic system prompt | Sub-agents get irrelevant sections, wasted context | Conditional sections + prompt modes: full/minimal/none ([PRODUCTION_PATTERNS §2](./PRODUCTION_PATTERNS.md#2-dynamic-system-prompt-assembly-conditional-sections)) |
| 36 | Dumping all skills into prompt | Token bloat, LLM overwhelmed by 150+ skill descriptions | Token budget caps + on-demand reading via tool ([PRODUCTION_PATTERNS §3](./PRODUCTION_PATTERNS.md#3-skill-discovery-filtering--token-budget)) |
| 37 | Random tool ordering in prompt | Positional bias, LLM favors arbitrarily first-listed tools | Canonical core order + alphabetical extras ([PRODUCTION_PATTERNS §4](./PRODUCTION_PATTERNS.md#4-tool-visibility--ordering-in-prompts)) |
| 38 | Memory instructions without memory tools | LLM tries to call tools it doesn't have → error loop | Conditional prompt sections matched to tool availability ([PRODUCTION_PATTERNS §9](./PRODUCTION_PATTERNS.md#9-conditional-memory-instructions)) |

## Security & Permissions

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 39 | No input sanitization from channels | Prompt injection via Unicode control chars, homoglyphs | Multi-layered defense: sanitize + detect + wrap + normalize ([PRODUCTION_PATTERNS §1](./PRODUCTION_PATTERNS.md#1-multi-layered-prompt-injection-defense)) |
| 40 | Hardcoded permission checks per agent | Every new agent or tool needs new permission code | Declarative rulesets with wildcard matching + three states ([PRODUCTION_PATTERNS §14](./PRODUCTION_PATTERNS.md#14-permission-as-data-declarative-tool-access-control)) |
| 41 | Whole-run approval gates for HITL | Agent loses reasoning continuity, adds latency to every run | Tool-level gates: approve only dangerous operations ([PRODUCTION_PATTERNS §12](./PRODUCTION_PATTERNS.md#12-hitl-as-tool-level-gate-not-whole-run-approval)) |
| 42 | Dropping or queuing messages arriving during active runs | Bad UX or agent misses relevant context | Message steering: inject into active run at tool boundaries ([PRODUCTION_PATTERNS §13](./PRODUCTION_PATTERNS.md#13-message-steering-real-time-context-injection)) |

> For infrastructure-level anti-patterns (auth, concurrency, security), see [INFRA_PATTERNS.md](./INFRA_PATTERNS.md).
