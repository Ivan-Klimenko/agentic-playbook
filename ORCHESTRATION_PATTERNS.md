# Multi-Agent Orchestration Patterns

A catalog of orchestration topologies for multi-agent systems — how agents are wired together, who talks to whom, and when control transfers. Adapted from [AG2's Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/).

> See [AGENT_PATTERNS.md](./AGENT_PATTERNS.md) for single-agent architecture, context engineering, and LangGraph implementation details.
> See [INFRA_PATTERNS.md](./INFRA_PATTERNS.md) for production infrastructure (auth, security, concurrency).

---

## Quick Reference: Choosing a Topology

```
Is the task a fixed sequence of stages (A → B → C)?
  YES → Pipeline (§1)
  NO ↓

Does the task need a central coordinator delegating to specialists?
  YES → Is the coordinator also a specialist?
    YES → Star / Hub-and-Spoke (§7)
    NO → Does it need multiple management layers?
      YES → Hierarchical / Tree (§4)
      NO → Star / Hub-and-Spoke (§7)
  NO ↓

Should agent selection happen dynamically based on content?
  YES → Is the routing rule-based (keywords, classification)?
    YES → Context-Aware Routing (§2)
    NO → Organic (§5) — LLM picks the next agent from descriptions
  NO ↓

Do you need multiple agents attempting the same task independently?
  YES → Redundant (§6)
  NO ↓

Should cheaper agents try first, escalating only if uncertain?
  YES → Escalation (§3)
  NO ↓

Does the task need iterative refinement cycles (create → review → revise)?
  YES → Feedback Loop (§8)
  NO ↓

Is the request complex enough to decompose into typed, dependent subtasks?
  YES → Triage with Tasks (§9)
  NO → Start with Pipeline or Star, refactor when the pattern emerges
```

**Rule of thumb**: Pipeline and Star cover ~70% of multi-agent needs. Add complexity only when the simpler topology demonstrably fails.

---

## 1. Pipeline (Sequential Processing)

A linear chain where each agent performs one transformation and passes the result forward. Data flows in one direction only.

```
User → [Validate] → [Enrich] → [Process] → [Format] → [Notify] → User
```

**When to use:**
- Fixed, known sequence of stages
- Each stage has clear input/output contracts
- No branching or conditional paths needed
- E-commerce orders, document processing, ETL workflows

**Agent roles:**
- Each agent owns exactly one transformation stage
- Agents don't communicate with each other — only forward output to the next stage
- An entry agent receives the initial input; a final agent delivers the result

**Key design decisions:**
- **Fail-fast**: if any stage fails validation, terminate the pipeline and return the error to the user. Don't pass garbage downstream.
- **Type-safe contracts**: use structured output (Pydantic models) at stage boundaries so each agent knows exactly what it receives and must produce.
- **No parallel tool calls**: enforce sequential tool execution within each stage to prevent race conditions on shared state.

**Tradeoffs:**
- Simple to reason about and debug (linear trace)
- No parallelism — total latency = sum of all stages
- Rigid — adding conditional branches means switching to a different topology

---

## 2. Context-Aware Routing

A dynamic dispatcher analyzes each incoming request and routes it to the most appropriate specialist based on content analysis (keywords, intent, domain classification).

```
User → [Router] → analyzes content → routes to best specialist
                ↗ [Tech Agent]
               ↗  [Finance Agent]
              ↗   [Health Agent]
             ↗    [General Agent]
```

**When to use:**
- Multi-domain systems where different queries need different expertise
- Routing rules can be expressed as classification logic (keyword matching, confidence scoring)
- Customer support, virtual assistants, knowledge management

**Agent roles:**
- **Router agent**: analyzes queries, extracts domain indicators, calculates confidence scores (1-10), routes to the best-matching specialist
- **Specialist agents**: domain experts that handle routed queries and return results to the router
- Router maintains conversation context to inform future routing decisions

**Key design decisions:**
- **Confidence scoring**: router assigns a confidence score per domain. Route to the highest-scoring specialist. Request clarification from the user when no domain scores above threshold.
- **Contextual memory**: track routing history in context variables (`domain_history`, `last_confidence`, `invocation_counts`). This helps the router adapt to multi-topic conversations.
- **Ambiguity handling**: when a query spans multiple domains, route to the primary domain and include cross-domain context in the handoff.

**Tradeoffs:**
- Adapts to shifting conversation topics without reconfiguration
- Routing quality depends on the router's classification ability — test with edge cases
- More complex than static routing but more resilient to new query types

**Differs from Organic (§5):** routing uses explicit rules and confidence scoring. Organic relies entirely on the LLM's judgment from agent descriptions.

---

## 3. Escalation (Tiered Processing)

Tasks start with the cheapest, simplest agent. If confidence is below threshold, escalate to a more capable (and expensive) agent. Repeat until confident or all tiers exhausted.

```
User → [Triage] → [Basic Agent] → confident? → YES → return answer
                                  → NO ↓
                   [Intermediate Agent] → confident? → YES → return answer
                                        → NO ↓
                   [Advanced Agent] → return answer (or escalate to human)
```

**When to use:**
- Query complexity varies widely (80% simple, 15% moderate, 5% hard)
- Cost optimization matters — don't use GPT-4 for "what's your return policy?"
- Tiered support, computational tasks, content moderation, healthcare triage

**Agent roles:**
- **Triage agent**: receives queries, resets context, routes to the first tier
- **Basic agent**: handles common knowledge, simple lookups. Cheap model (Haiku, GPT-4o-mini)
- **Intermediate agent**: nuanced analysis, domain-specific reasoning. Mid-tier model
- **Advanced agent**: complex reasoning, specialized problem-solving. Frontier model (Opus, GPT-4)

**Key design decisions:**
- **Structured confidence response**: every agent returns a `ConsideredResponse` with `answer`, `confidence` (1-10), `reasoning`, and `escalation_reason`. This makes escalation decisions deterministic, not vibes-based.
- **Threshold**: confidence < 8 triggers escalation. Tune this per domain — lower threshold = more escalation = higher quality but higher cost.
- **Context preservation**: all prior reasoning and escalation history passes to the next tier. The advanced agent sees what the basic agent tried and why it wasn't confident.
- **Human fallback**: if the advanced agent is still uncertain, escalate to a human rather than guessing.

**Tradeoffs:**
- Significant cost savings on easy queries (most traffic never leaves tier 1)
- Added latency on hard queries (multiple sequential LLM calls)
- Requires good confidence calibration — overconfident basic agents miss escalations

**Connects to [AGENT_PATTERNS.md §2.7](./AGENT_PATTERNS.md#27-two-tier-model-strategy):** the two-tier model strategy is the same principle applied within a single agent. Escalation extends it across multiple agents.

---

## 4. Hierarchical / Tree

A tree-structured organization with executive, manager, and specialist layers. Higher levels delegate and synthesize; lower levels execute focused tasks.

```
                    [Executive]
                   /     |      \
          [Manager A] [Manager B] [Manager C]
          /    \        |          /    \
    [Spec 1] [Spec 2] [Spec 3] [Spec 4] [Spec 5]
```

**When to use:**
- Complex tasks requiring synthesis across multiple knowledge domains
- Output must integrate diverse findings into a cohesive result
- Research reports, product development plans, multi-faceted analysis

**Agent roles (three levels):**
- **Executive** (top): breaks the problem into domains, delegates to managers, synthesizes the final output from all manager reports
- **Managers** (middle): decompose their assigned domain into subtasks, delegate to specialists, aggregate specialist findings into domain-level reports
- **Specialists** (bottom): deep expertise in narrow areas, execute well-defined tasks, report findings to their manager

**Information flow:**
- **Downstream**: tasks cascade from executive → managers → specialists, becoming increasingly specific at each level
- **Upstream**: results flow back specialists → managers → executive, being aggregated at each level

**Key design decisions:**
- **Explicit reporting lines**: each agent has a designated supervisor via `AfterWork` (or equivalent). Specialists always report to their manager, managers always report to the executive.
- **Context-based transitions**: use deterministic conditions (task completion flags in context variables) for handoffs, with LLM-based fallbacks for complex routing decisions.
- **Shared context variables**: track completion status per subtask so managers know when all their specialists have reported.

**Tradeoffs:**
- Handles genuinely complex, multi-domain tasks well
- High latency — many sequential LLM calls through the tree
- Significant coordination overhead — only justified for tasks that truly need this decomposition
- Over-engineering risk: don't use a 3-level tree when a flat Star (§7) would suffice

---

## 5. Organic (Description-Based Routing)

The simplest multi-agent topology. No explicit routing rules — the group chat manager selects the next agent based on agent descriptions and conversation context. The LLM decides who speaks next.

```
User → [Group Chat Manager] → reads descriptions → picks most relevant agent
         ↕          ↕          ↕          ↕
    [PM Agent] [Dev Agent] [QA Agent] [Writer]
```

**When to use:**
- Conversation flow is unpredictable
- Defining explicit routing rules would be overly complex or brittle
- Collaborative creative projects, brainstorming, consultative services
- Prototyping — start organic, add explicit routing when patterns emerge

**Agent roles:**
- Each agent has a detailed `description` field (separate from `system_message`) that defines its expertise
- The group chat manager (LLM-powered) selects the next speaker by matching descriptions to conversation needs
- No agent directly hands off to another — the manager mediates all transitions

**Implementation:**
```python
# Minimal setup — no handoff rules needed
agent_pattern = AutoPattern(
    initial_agent=project_manager,
    agents=[project_manager, developer, qa_engineer, designer, writer],
    group_manager_args={"llm_config": llm_config},
    user_agent=user,
)
```

**Key design decisions:**
- **Description quality is everything**: the manager's routing quality is only as good as the agent descriptions. Write descriptions that clearly delineate expertise boundaries.
- **No explicit handoffs**: transitions happen purely through the LLM's interpretation. This is both the strength (simplicity) and weakness (unpredictability).

**Tradeoffs:**
- Minimal configuration — fastest to set up
- Unpredictable agent selection — hard to guarantee specific workflows
- Not suitable for production workflows that need deterministic behavior
- Debugging is harder — "why did the manager pick agent X?" has no explicit answer

**When to graduate from Organic:** when you observe repeated routing mistakes or need guaranteed execution order, switch to Context-Aware Routing (§2) or Pipeline (§1).

---

## 6. Redundant (Parallel + Evaluate)

Multiple agents independently tackle the same task using different methodologies. An evaluator compares results and selects (or synthesizes) the best outcome.

```
                    [Taskmaster]
                   /      |      \
         [Agent A]   [Agent B]   [Agent C]
         analytical   creative   comprehensive
                   \      |      /
                    [Evaluator]
                        ↓
                   best result
```

**When to use:**
- Reliability outweighs efficiency (critical decisions, high-stakes output)
- Multiple valid approaches exist and the best isn't known upfront
- Creative tasks, complex problem-solving, medical diagnosis, security analysis

**Agent roles:**
- **Taskmaster**: distributes the identical task to all agents via isolated nested chats
- **Specialist agents** (3+): each uses a distinct approach (analytical, creative, comprehensive). Agents are isolated from each other — they don't see other agents' work.
- **Evaluator**: scores each solution (1-10) on domain-specific criteria, selects the best or synthesizes a composite result

**Key design decisions:**
- **Isolation via nested chat**: each agent receives only the task message, not the broader conversation. This prevents agents from anchoring on each other's approaches.
- **Diverse methodologies**: the value comes from approach diversity. If all agents use the same strategy, redundancy adds cost without improving quality. Differentiate via system prompts.
- **Evaluation criteria**: define scoring rubrics in the evaluator's prompt. Generic "pick the best" instructions produce inconsistent results.

**Tradeoffs:**
- Highest quality through diversity of approaches
- 3x+ the cost and latency of a single agent (all agents run in parallel, but you pay for all of them)
- Only justified when the cost of a wrong answer exceeds the cost of multiple agent runs
- Evaluator quality is the bottleneck — a bad evaluator wastes the diversity

---

## 7. Star / Hub-and-Spoke

A central coordinator delegates to specialist agents and synthesizes their outputs. Specialists report only to the coordinator — they don't communicate with each other.

```
              [Specialist A]
                    ↕
[Specialist B] ← [Coordinator] → [Specialist C]
                    ↕
              [Specialist D]
```

**When to use:**
- Clear division of expertise across domains
- Need centralized coordination and synthesis
- Customer support, research projects, travel planning, product recommendations

**Agent roles:**
- **Coordinator** (hub): analyzes user query, delegates specific sub-tasks to relevant specialists, synthesizes all specialist outputs into a coherent response
- **Specialists** (spokes): execute focused tasks in their domain, report results directly back to the coordinator

**Key design decisions:**
- **Coordinator controls all routing**: specialists never hand off to each other. This keeps the information flow predictable and the coordinator's context complete.
- **Selective delegation**: the coordinator doesn't always invoke all specialists. It analyzes the query and only delegates to relevant ones.
- **AfterWork return**: each specialist is configured to automatically return to the coordinator after completing its task.
- **Context variables**: track which specialists have been consulted, what content each returned, and overall query status.

**Tradeoffs:**
- Predictable, debuggable information flow
- Coordinator can become a bottleneck (all information passes through it)
- Scales well up to ~5-7 specialists; beyond that, consider Hierarchical (§4) with manager layers
- Simpler than Hierarchical — use this as the default multi-agent topology

**Differs from Hierarchical (§4):** Star is flat (one coordinator level), Hierarchical has multiple delegation layers. Start with Star, add hierarchy only when a single coordinator can't effectively manage all specialists.

---

## 8. Feedback Loop (Iterative Refinement)

Content cycles through create → review → revise stages repeatedly until quality criteria are met or iteration limits reached.

```
User → [Plan] → [Draft] → [Review] → [Revise] ─┐
                              ↑                   │
                              └───── iterate ──────┘
                                        ↓ (done)
                                   [Finalize] → User
```

**When to use:**
- Output quality improves with iteration (writing, design, code review)
- Quality gates can determine if additional passes are needed
- Document writing, iterative design, QA processes, learning systems

**Agent roles (6 stages):**
- **Entry agent**: receives request, initiates the loop
- **Planning agent**: creates structure, outline, and strategy
- **Drafting agent**: produces initial content following the plan
- **Review agent**: evaluates content, provides structured feedback with severity levels (minor/moderate/major/critical)
- **Revision agent**: implements feedback, documents changes made
- **Finalization agent**: applies finishing touches, delivers the result

**Key design decisions:**
- **Structured feedback**: the review agent returns typed feedback objects (`FeedbackCollection`) with severity levels, not free-text criticism. This makes revision targeted and measurable.
- **Iteration cap**: set a maximum iteration count (e.g., 3) to prevent infinite refinement loops. Track `current_iteration` and `max_iterations` in context variables.
- **Convergence detection**: if a revision pass produces only minor changes, exit the loop even if iterations remain. Diminishing returns are real.
- **Data models at every boundary**: use Pydantic models (`DocumentPlan`, `DocumentDraft`, `FeedbackCollection`, `RevisedDocument`, `FinalDocument`) to ensure structured data flows between agents.

**Tradeoffs:**
- Produces higher-quality output than single-pass generation
- Latency scales linearly with iteration count
- Expensive — each iteration is a full review + revision cycle
- Requires good review criteria — vague feedback causes aimless iteration

---

## 9. Triage with Tasks (Decompose → Route → Execute)

Complex requests are decomposed into typed, prioritized, dependency-respecting subtasks. A task manager routes each subtask to the appropriate specialist in the correct order.

```
User → [Triage] → decompose into tasks
                      ↓
       [Task Manager] → route by type & priority
          ↓                    ↓
   [Research Agent]     [Writing Agent]
   (all research first)  (then all writing)
          ↓                    ↓
       [Summary Agent] → compile results → User
```

**When to use:**
- Complex requests that contain multiple interdependent subtasks
- Research must complete before writing can begin
- Tasks have natural type categories (research, writing, analysis, code)
- Content creation pipelines, product development, academic workflows, report generation

**Agent roles:**
- **Triage agent**: decomposes requests into structured task lists (`ResearchTask[]`, `WritingTask[]`) with priorities using structured output
- **Task manager**: initializes tasks sorted by priority, routes to specialists, enforces execution order, tracks completion status
- **Research agent**: gathers information for assigned research tasks, delivers findings that inform downstream work
- **Writing agent**: creates content using research outputs, adapts style to task requirements
- **Summary agent**: consolidates all completed work into a cohesive final output
- **Error agent**: communicates failures with full context

**Key design decisions:**
- **Phase ordering**: all research tasks complete before any writing tasks begin. This ensures writing agents have all necessary information.
- **Priority sorting**: within each phase, tasks execute in priority order (high → medium → low).
- **Index validation**: tool functions validate that the agent's reported task index matches the expected current index, preventing out-of-order execution.
- **Dynamic prompt injection**: use `UpdateSystemMessage` callbacks to inject current task details into agent prompts before each reply. The agent always knows exactly what task it's working on.
- **Structured triage output**: the triage agent uses structured output (`response_format: TaskAssignment`) to guarantee valid task decomposition.

**Context variables tracked:**
```
CurrentResearchTaskIndex / CurrentWritingTaskIndex
ResearchTasks[] / WritingTasks[]
ResearchTasksCompleted / WritingTasksCompleted
ResearchTasksDone / WritingTasksDone (flags)
```

**Tradeoffs:**
- Handles genuinely complex multi-part requests well
- Significant setup complexity — many agents, context variables, and routing conditions
- Sequential execution within phases (research, then writing) adds latency
- Best for requests that naturally decompose into typed subtasks; overkill for single-domain tasks

---

## Pattern Comparison Matrix

| Pattern | Topology | Agent Communication | Parallelism | Complexity | Best For |
|---------|----------|-------------------|-------------|------------|----------|
| Pipeline | Linear chain | Forward only | None | Low | Fixed-stage workflows |
| Context-Aware Routing | Hub-spoke (dynamic) | Via router | None | Medium | Multi-domain dispatch |
| Escalation | Tiered chain | Forward + escalate | None | Medium | Cost-optimized variable complexity |
| Hierarchical | Tree | Up/down reporting lines | Per-level | High | Multi-domain synthesis |
| Organic | Fully connected (LLM-managed) | Via group manager | None | Low | Prototyping, unpredictable flows |
| Redundant | Fan-out + evaluate | Isolated (no cross-talk) | Full (all agents) | Medium | High-stakes decisions |
| Star | Hub-spoke (static) | Via coordinator | Potential | Medium | Most multi-agent tasks |
| Feedback Loop | Cyclic | Sequential stages | None | Medium | Iterative quality improvement |
| Triage with Tasks | Phased pipeline | Via task manager | Within phases | High | Complex decomposable requests |

---

## Combining Patterns

Real systems often combine topologies:

- **Star + Escalation**: coordinator delegates to specialists, but each specialist uses tiered escalation internally
- **Pipeline + Feedback Loop**: a pipeline stage contains an internal review-revise loop before passing output forward
- **Triage + Star**: triage decomposes the request, then a star coordinator manages specialist execution
- **Context-Aware Routing + Redundant**: router identifies the domain, then runs redundant specialists within that domain for critical queries

**Principle**: compose patterns at different levels of the agent hierarchy. The orchestration topology between agents can differ from the topology within a sub-agent.

---

## References

- [AG2 Pattern Cookbook](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/pattern-cookbook/overview/) — source for all patterns with AG2 implementations
- [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — practical patterns from production
- [AGENT_PATTERNS.md](./AGENT_PATTERNS.md) — single-agent architecture, context engineering, LangGraph snippets
- [INFRA_PATTERNS.md](./INFRA_PATTERNS.md) — production infrastructure patterns
