# Project Inspection Guide

A structured checklist for analyzing a new agentic codebase. Use this to reverse-engineer how an agent system works — its architecture, context flow, planning mechanics, and runtime behavior.

> **See also:** [Agent Patterns](./AGENT_PATTERNS.md) | [Orchestration Topologies](./ORCHESTRATION_PATTERNS.md) | [Production Patterns](./PRODUCTION_PATTERNS.md) | [Anti-Patterns](./ANTI_PATTERNS.md) | [Infrastructure](./INFRA_PATTERNS.md)

---

## 1. Architecture & Agent Topology

Analyze the agent/sub-agent architecture of the codebase.

- **Agent hierarchy** — What is the topology? (single agent, orchestrator + specialists, swarm, pipeline, hub-and-spoke)
- **Instantiation & composition** — How are agents instantiated and composed? Identify the key classes, factories, or config objects.
- **Communication** — How do agents communicate? (direct function calls, message passing, shared state, event bus, tool invocation)
- **Invocation lifecycle** — What is the lifecycle of an agent invocation? (init → plan → execute → respond — or different?)
- **Agent types & roles** — Are there different agent "types" or "roles"? How are they differentiated? (system prompt, tool set, model, permissions)
- **Delegation logic** — How does the orchestrator decide which sub-agent to delegate to? (LLM choice, rule-based routing, planner-driven)

### Key questions

```
- Draw the agent call graph (who calls whom).
- Is delegation explicit (tool call) or implicit (message routing)?
- Can sub-agents spawn further sub-agents? What's the max depth?
- Are agents stateless (fresh per invocation) or stateful (persistent across turns)?
```

---

## 2. Thinking & Reasoning

How the codebase implements thinking/reasoning mechanics.

- **Think step** — Is there a separate "think" step before acting? (chain-of-thought, scratchpad, inner monologue)
- **Implementation** — Is thinking implemented as a tool, a system prompt instruction, a dedicated node in the graph, or model-native (`extended_thinking`)?
- **Visibility** — Is the thinking output visible to the user, or internal-only?
- **Tool selection** — How does reasoning feed into tool selection and argument generation?
- **Post-execution reflection** — Is there reflection after tool execution? (checking results, deciding next step, self-correction)
- **Reasoning traces** — Are there explicit reasoning traces stored for debugging or re-use?

### Key questions

```
- Is thinking "free" (model-native) or costs an extra LLM call?
- Does the system strip thinking blocks before returning to the user?
- Is there a distinction between "planning thinking" and "execution thinking"?
- Can the agent reason about its own confidence or uncertainty?
```

---

## 3. Planning & Execution

Analyze the planning mechanics in detail.

- **Planning phase** — Is planning a distinct phase or embedded in the agent loop? Is it mandatory or conditional?
- **Plan generation** — Is the plan generated via a dedicated tool/function call, a separate LLM invocation, or inline reasoning?
- **Plan schema** — What does a plan object look like? (schema, fields, structure — find concrete examples)
- **Plan injection** — How is the plan injected into prompts? Which subsequent prompts see the plan?
- **Execution tracking** — How is plan execution tracked? (step index, status per step, checkpoints)
- **Re-planning** — Can the plan be revised mid-execution? What triggers re-planning?
- **Completion verification** — How is plan completion verified? Is there a reflection/validation step?

### Key questions

```
- Trace the core code path: plan creation → step execution → progress update → completion check.
- Is the plan stored in state, in a message, or as a tool result?
- Does the agent self-evaluate plan quality before executing?
- What happens if a plan step fails? (retry, skip, re-plan, abort)
```

---

## 4. Context Management

How the codebase manages context across agent interactions.

- **Context splitting** — What does each agent "see" vs what's hidden? How is context partitioned between parent and child agents?
- **Context isolation** — Is there shielding between agents? How do sub-agents avoid polluting the parent context?
- **Conversation history** — How is history stored, truncated, or summarized? What format? (raw messages, summaries, embeddings)
- **Shared vs private state** — Is there a shared memory/scratchpad vs per-agent private state? Who can read/write what?
- **Tool result injection** — How are tool results injected back into context? Verbatim, truncated, summarized, or offloaded to file?
- **Token budget strategy** — What's the context window budget approach? (token counting, sliding window, compression, tiered recovery)
- **Long-running flows** — How are long-running flows handled without blowing context limits? (compaction, checkpointing, context reset with summary)

### Key questions

```
- Where is the token counting / context limit logic?
- What happens when context overflows? (error, auto-compact, truncate oldest, summarize)
- Do sub-agents inherit parent context or start fresh?
- Is there a "memory" layer separate from conversation history?
```

---

## 5. Tool System

Analyze the tool/function calling infrastructure.

- **Definition & registration** — How are tools defined, registered, and discovered by agents? (decorators, config objects, schemas, dynamic discovery)
- **Tool selection** — How does the agent select which tool(s) to use? (LLM choice, rule-based, planner-driven)
- **Parallel execution** — How is multi-tool / parallel tool execution handled? (sequential, batch, concurrent with limits)
- **Result processing** — What does tool result processing look like? (parsing, validation, error handling, retries)
- **Error recovery** — How are tool errors surfaced back to the agent for recovery?
- **Meta-tools** — Are there "meta-tools"? (e.g., `create_plan`, `delegate_to_agent`, `ask_user`, `think`)
- **Output formatting** — How is tool output formatted before injection into the next prompt?

### Key questions

```
- How many tools does a typical agent have access to? Is the set static or dynamic?
- Are tool descriptions optimized for token efficiency?
- Is there tool-level permission / approval gating?
- How does the system handle tool timeouts and partial results?
- Are tools validated at registration time (schema checks)?
```

---

## 6. Flow Control & Error Handling

How the codebase manages long-running and complex flows.

- **Core loop** — What is the core agent loop? (while loop, graph traversal, state machine, recursive calls — find the code)
- **Iteration limits** — How are iteration limits / max-steps enforced? What happens when hit?
- **Termination** — How does the agent decide it's "done"? (explicit stop tool, LLM signal, condition check, output schema match)
- **Failure handling** — What happens on failure? (retry logic, fallback strategies, graceful degradation)
- **Human-in-the-loop** — Is there HITL support? How is it triggered? (interrupt, approval gate, confirmation tool)
- **Cost tracking** — How are costs/tokens tracked and budgeted across the flow?

### Key questions

```
- Find the main loop and trace one complete execution cycle.
- What prevents infinite loops? (max iterations, doom loop detection, cost ceiling)
- Is there a distinction between recoverable and fatal errors?
- Can execution be paused and resumed? (checkpointing)
- How are partial results preserved on failure?
```

---

## 7. State & Persistence

How state is managed throughout the agent's lifecycle.

- **State schema** — What is the state schema/object? (find the key data structure / TypedDict / interface)
- **Mutability** — Is state mutable during execution? Who can write to it? (any node, only specific writers, reducer-controlled)
- **Memory tiers** — Is there a distinction between "working memory" (current turn) and "long-term memory" (cross-session)?
- **State passing** — How is state passed between nodes/steps/agents? (function args, global store, context injection)
- **Persistence** — Is state persisted for resumability? (checkpoints, serialization, database)
- **Result accumulation** — How are intermediate results accumulated? (append to list, update dict, scratchpad, structured output)

### Key questions

```
- Show the core state type definition.
- Is state immutable-by-convention or enforced? (frozen objects, copy-on-write, reducers)
- What state survives a context window reset?
- How is state serialized for checkpointing? (JSON, protobuf, pickle)
- Is there state versioning or migration logic?
```

---

## 8. Saving Code Snippets

As you inspect each section, extract key implementation patterns into `code_snippets/<project_name>/`.

### What to save

For each of the 7 inspection areas, save a snippet when you find a **non-trivial, reusable pattern**:

| Inspection area | Typical snippet | Example filename |
|-----------------|-----------------|------------------|
| Architecture & Topology | Agent definition schema, factory, registry | `agent_definition.ts` |
| Thinking & Reasoning | Think tool, reflection step, reasoning trace | `think_tool.ts` |
| Planning & Execution | Plan schema, plan-execute loop, re-planning logic | `plan_execute_loop.ts` |
| Context Management | Context compaction, token budgeting, memory layer | `context_compaction.ts` |
| Tool System | Tool registry, batch execution, fuzzy matching | `tool_system.ts` |
| Flow Control | Core agent loop, doom loop detection, retry logic | `session_processor.ts` |
| State & Persistence | State schema, checkpoint/restore, snapshot revert | `state_checkpoint.ts` |

Also save cross-cutting patterns that don't fit one section:
- Sub-agent invocation & isolation
- Event bus / streaming infrastructure
- Security & sandboxing
- Auth & permission pipelines

### Snippet format

Every snippet file must follow this structure:

```typescript
/**
 * <Project Name> <Pattern Name>
 *
 * <1-3 sentence description of what this pattern does and why it matters.>
 *
 * Source: <relative path to the original file(s) in the inspected project>
 */

// --- <Section Label> ---
// <Brief comment explaining this block>

<extracted code — simplified, self-contained, with inline comments>
```

**Rules:**
- **Simplify** — strip framework boilerplate, logging, and irrelevant branches. Keep only the pattern's essence.
- **Self-contained** — each file should be readable on its own. Re-declare minimal types inline rather than importing from the inspected project.
- **Inline comments** — annotate non-obvious decisions. Explain *why*, not *what*.
- **Source reference** — always include the original file path(s) so the pattern can be traced back.
- **One pattern per file** — don't combine unrelated patterns. If a file has two interesting patterns, make two snippet files.

### Naming conventions

```
code_snippets/
  <project_name>/           # lowercase, underscored (e.g., openclaw, opencode)
    <pattern_name>.ts       # descriptive, underscored (e.g., context_compaction.ts)
```

- Use the project's primary language extension (`.ts`, `.py`, `.go`, etc.)
- Name by *what the pattern does*, not the source filename
- Keep names concise — 2-3 words max

### When NOT to save

- Trivial wrappers or pass-through code
- Standard library usage with no agentic insight
- Configuration files with no logic
- Code that only makes sense with full project context and can't be simplified

---

## Inspection Workflow

Recommended order when analyzing a new codebase:

```
1. Architecture & Topology  — get the big picture first
2. Thinking & Reasoning     — understand the decision-making mechanics
3. Planning & Execution     — understand how complex tasks are decomposed
4. Context Management       — understand what the LLM sees
5. Tool System              — understand what the agents CAN do
6. Flow Control             — trace one complete execution
7. State & Persistence      — understand what flows between steps
```

For each section:
1. **Find the code** — locate the key files, classes, and functions
2. **Read the tests** — tests often reveal intended behavior better than source
3. **Trace a request** — follow one real invocation from entry to response
4. **Save snippets** — extract reusable patterns into `code_snippets/<project_name>/` (see §8)
5. **Document gaps** — note what's missing or unclear for follow-up
