# Anti-Patterns & Pitfalls

44 common mistakes when building LLM-powered agents, with fixes. Cross-referenced to the relevant pattern documents.

> **See also:** [AGENT_PATTERNS.md](./AGENT_PATTERNS.md) | [PRODUCTION_PATTERNS.md](./PRODUCTION_PATTERNS.md) | [INFRA_PATTERNS.md](./INFRA_PATTERNS.md) | [LANGGRAPH_PATTERNS.md](./LANGGRAPH_PATTERNS.md)

---

## Architecture & Composition

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 1 | Putting all logic in one graph | Untestable, prompt bloat, can't tune sub-tasks independently | Break into sub-agents as tools ([AGENT_PATTERNS §2.3](./AGENT_PATTERNS.md#23-sub-agent-composition)) |
| 2 | Passing full orchestrator state to sub-agents | State coupling, sub-agents see irrelevant fields | Map state at tool boundary ([AGENT_PATTERNS §2.2](./AGENT_PATTERNS.md#22-state-management-principles)) |
| 3 | No recursion limit | Runaway ReAct loops burn tokens | Set `recursion_limit` on every graph ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 4 | LLM-routing everything | Slow for predictable inputs | Add pre-processing shortcuts ([AGENT_PATTERNS §2.9](./AGENT_PATTERNS.md#29-pre-processing--shortcuts)) |
| 5 | Hardcoded routing in a graph that needs flexibility | Every new route = code change | Use ReAct with tool selection instead ([AGENT_PATTERNS §2.1](./AGENT_PATTERNS.md#21-orchestrator-types)) |
| 6 | Agent classes with behavior methods | Tight coupling, hard to compose, can't add agents without code | Agents-as-config: named config objects, generic runtime ([AGENT_PATTERNS §2.6](./AGENT_PATTERNS.md#26-agents-as-config-no-agent-classes)) |
| 7 | State machine for agent mode transitions | Over-engineered, hard to debug, special state management | Synthetic messages with agent field ([AGENT_PATTERNS §2.7](./AGENT_PATTERNS.md#27-agent-mode-switching-via-synthetic-messages)) |
| 8 | Sequential tool calls for independent operations | Unnecessary latency — N round-trips instead of 1 | Batch tool: parallel execution ([AGENT_PATTERNS §2.8](./AGENT_PATTERNS.md#28-parallel-multi-tool-execution-batch-tool)) |
| 9 | Formal plan-and-execute for every agent | Doubles latency for simple conversational tasks | No-plan architecture for short interactions; add TODO tool incrementally ([AGENT_PATTERNS §2.11](./AGENT_PATTERNS.md#211-no-plan-architecture-planning-via-system-prompt)) |
| 10 | Building a plan execution engine | Over-engineering for most cases; rigid step ordering limits LLM flexibility | Prompt-driven: agent reads plan file and follows it ([AGENT_PATTERNS §2.14](./AGENT_PATTERNS.md#214-prompt-driven-plan-execution-no-engine)) |
| 11 | Mixing retry/recovery logic with tool execution loop | Spaghetti error handling, hard to test and reason about | Dual-loop: outer for retry/failover, inner for tool execution ([PRODUCTION_PATTERNS §11](./PRODUCTION_PATTERNS.md#11-dual-loop-architecture-retry-vs-tool-execution)) |
| 12 | Storing derived/formatted data in graph state | State bloat, stale data, can't format differently per node | Store raw data, derive on read ([LANGGRAPH_PATTERNS §2](./LANGGRAPH_PATTERNS.md#2-state-design-principles)) |
| 13 | One fat node with mixed external calls | Single failure kills entire step, can't retry selectively, no mid-node checkpoint | Split by service/failure mode ([LANGGRAPH_PATTERNS §3](./LANGGRAPH_PATTERNS.md#3-node-granularity)) |
| 14 | No retry policy on nodes calling external services | Transient network/rate-limit errors crash the graph | Add `RetryPolicy` per node ([LANGGRAPH_PATTERNS §16](./LANGGRAPH_PATTERNS.md#16-error-handling-strategies)) |
| 15 | Side effects before `interrupt()` | Code before interrupt re-runs on every resume — duplicate notifications, double writes | Place `interrupt()` at top of node ([LANGGRAPH_PATTERNS §13](./LANGGRAPH_PATTERNS.md#13-human-in-the-loop-with-interrupt)) |

## Context Management

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 12 | Overloading message history | Context window fills up, LLM loses focus | Serialize state into system prompt, keep messages for conversation ([AGENT_PATTERNS §2.5](./AGENT_PATTERNS.md#25-dynamic-state-injection-working-memory)) |
| 13 | No context anchoring on long tasks | Agent drifts from objectives after ~50 tool calls (context rot) | TODO write-read-reflect cycle ([AGENT_PATTERNS §3.1](./AGENT_PATTERNS.md#31-todo-lists-as-context-anchors)) |
| 14 | Raw tool results in messages | Token-heavy content fills context, displaces reasoning | Context offloading: content → files, summaries → messages ([AGENT_PATTERNS §3.2](./AGENT_PATTERNS.md#32-virtual-filesystem-for-context-offloading)) |
| 15 | Sub-agents inherit parent context | Context clash, confusion, poisoning from irrelevant history | Replace messages with task-only context ([AGENT_PATTERNS §3.4](./AGENT_PATTERNS.md#34-context-isolation-via-sub-agents)) |
| 16 | No structured reflection checkpoints | Agent makes impulsive decisions on complex multi-step tasks | think_tool forces articulated reasoning ([AGENT_PATTERNS §3.6](./AGENT_PATTERNS.md#36-think-tool-no-op-forced-reflection)) |
| 17 | Editing/reordering earlier messages between turns | Invalidates prompt cache, re-processes entire context at full cost | Append-only context ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 18 | Using expensive model for context summarization | Wastes frontier-model capacity on a compression task | Summarize with cheap model, keep expensive model for reasoning ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 19 | Removing tools from schema as first reaction to limits | Invalidates entire prompt cache (tools sit at top of cache hierarchy) | Return error stub first (cache-safe); only remove tool if LLM ignores the error ([AGENT_PATTERNS §3.7](./AGENT_PATTERNS.md#37-prompt-caching-aware-context-design)) |
| 20 | Unbounded tool output in context | Large outputs flood context, displace reasoning | Auto-truncate at threshold + offload full output to temp file ([AGENT_PATTERNS §3.8](./AGENT_PATTERNS.md#38-tool-output-truncation-with-file-offloading)) |
| 21 | Agent stops after context compaction | User must manually say "continue" — breaks autonomous flow | Auto-continue: inject synthetic message ([AGENT_PATTERNS §3.9](./AGENT_PATTERNS.md#39-auto-continue-after-context-recovery)) |
| 22 | Keeping thinking blocks in history | Previous reasoning tokens waste context on re-send | Strip thinking blocks, preserve empty turns ([PRODUCTION_PATTERNS §5](./PRODUCTION_PATTERNS.md#5-thinking-block-management)) |
| 23 | Verbose tool results sent to LLM | Token waste, potential injection from external payloads | Strip details field, use semantic summaries ([PRODUCTION_PATTERNS §6](./PRODUCTION_PATTERNS.md#6-tool-result-sanitization-details-stripping)) |

## Tool Design

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 24 | Manual JSON parsing of LLM output | Fragile, error-prone, prompt overhead for format examples | Use structured output with Pydantic ([LANGGRAPH_PATTERNS §10](./LANGGRAPH_PATTERNS.md#10-structured-output-with-pydantic)) |
| 25 | Tool returns raw exception | LLM can't recover gracefully | Return structured error in ToolMessage ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 26 | Generic error strings from tools | LLM can't self-correct without knowing valid options | Include valid values and retry hints in error messages ([AGENT_PATTERNS §2.4](./AGENT_PATTERNS.md#24-error-boundaries--graceful-degradation)) |
| 27 | Stateless analysis across calls | Agent forgets prior work in multi-turn sessions | Add a scratchpad/memo persisted in parent state |
| 28 | Exact-match-only for tool inputs | LLM whitespace/indentation hallucinations cause ~20% failure rate | Fuzzy fallback chain: 9 strategies ([AGENT_PATTERNS §2.13](./AGENT_PATTERNS.md#213-fuzzy-tool-input-resilience-fallback-matching)) |
| 29 | Flat `max_tool_calls` as only loop protection | Kills legitimate long-running tasks alongside runaway loops | Pattern-based detection + corrective messages; hard cap as backstop ([PRODUCTION_PATTERNS §10](./PRODUCTION_PATTERNS.md#10-tool-loop-detection-pattern-based-not-hard-caps)) |
| 30 | Adding a tool recommender/router as first optimization | Over-engineering; usually tool descriptions or ordering are the real problem | Improve descriptions, reduce set via policy, fix ordering first ([AGENT_PATTERNS §2.12](./AGENT_PATTERNS.md#212-pure-llm-tool-selection-no-planner-no-router)) |

## Prompt Engineering

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 31 | Amending prompts for structured output format | Redundant with schema, can conflict | Let Pydantic model define the format ([LANGGRAPH_PATTERNS §10](./LANGGRAPH_PATTERNS.md#10-structured-output-with-pydantic)) |
| 32 | Same model for all cognitive loads | Expensive model wasted on summarization/formatting | Two-tier: cheap model for extraction, expensive for reasoning ([AGENT_PATTERNS §2.10](./AGENT_PATTERNS.md#210-two-tier-model-strategy)) |
| 33 | Monolithic system prompt | Sub-agents get irrelevant sections, wasted context | Conditional sections + prompt modes: full/minimal/none ([PRODUCTION_PATTERNS §2](./PRODUCTION_PATTERNS.md#2-dynamic-system-prompt-assembly-conditional-sections)) |
| 34 | Dumping all skills into prompt | Token bloat, LLM overwhelmed by 150+ skill descriptions | Token budget caps + on-demand reading via tool ([PRODUCTION_PATTERNS §3](./PRODUCTION_PATTERNS.md#3-skill-discovery-filtering--token-budget)) |
| 35 | Random tool ordering in prompt | Positional bias, LLM favors arbitrarily first-listed tools | Canonical core order + alphabetical extras ([PRODUCTION_PATTERNS §4](./PRODUCTION_PATTERNS.md#4-tool-visibility--ordering-in-prompts)) |
| 36 | Memory instructions without memory tools | LLM tries to call tools it doesn't have → error loop | Conditional prompt sections matched to tool availability ([PRODUCTION_PATTERNS §9](./PRODUCTION_PATTERNS.md#9-conditional-memory-instructions)) |

## Security & Permissions

| # | Anti-pattern | Why it's bad | Fix |
|---|---|---|---|
| 37 | No input sanitization from channels | Prompt injection via Unicode control chars, homoglyphs | Multi-layered defense: sanitize + detect + wrap + normalize ([PRODUCTION_PATTERNS §1](./PRODUCTION_PATTERNS.md#1-multi-layered-prompt-injection-defense)) |
| 38 | Hardcoded permission checks per agent | Every new agent or tool needs new permission code | Declarative rulesets with wildcard matching + three states ([PRODUCTION_PATTERNS §14](./PRODUCTION_PATTERNS.md#14-permission-as-data-declarative-tool-access-control)) |
| 39 | Whole-run approval gates for HITL | Agent loses reasoning continuity, adds latency to every run | Tool-level gates: approve only dangerous operations ([PRODUCTION_PATTERNS §12](./PRODUCTION_PATTERNS.md#12-hitl-as-tool-level-gate-not-whole-run-approval)) |
| 40 | Dropping or queuing messages arriving during active runs | Bad UX or agent misses relevant context | Message steering: inject into active run at tool boundaries ([PRODUCTION_PATTERNS §13](./PRODUCTION_PATTERNS.md#13-message-steering-real-time-context-injection)) |

> For infrastructure-level anti-patterns (auth, concurrency, security), see [INFRA_PATTERNS.md](./INFRA_PATTERNS.md).
