# OpenCode — Agent Architecture Deep-Dive

Full architecture analysis of [OpenCode](https://github.com/anomalyco/opencode) (open-source AI coding agent). TypeScript monorepo, Bun runtime, ~100K LOC.

---

## 1. High-Level Architecture

```
                   ┌───────────────────────────────────────┐
                   │              Frontends                 │
                   │   TUI (SolidJS+opentui)  │  Web SPA   │
                   │   Desktop (Tauri)        │  Mobile    │
                   └─────────────┬─────────────────────────┘
                                 │ SSE + HTTP
                   ┌─────────────▼─────────────────────────┐
                   │         Hono HTTP Server               │
                   │  ┌─────┐ ┌──────┐ ┌────────┐ ┌─────┐ │
                   │  │Route│ │Route │ │ Route  │ │ SSE │ │
                   │  │/sess│ │/conf │ │/provdr │ │/evnt│ │
                   │  └──┬──┘ └──┬───┘ └───┬────┘ └──┬──┘ │
                   │     │       │         │         │     │
                   │  ┌──▼───────▼─────────▼─────────▼──┐  │
                   │  │    Instance.provide(directory)   │  │
                   │  │    (AsyncLocalStorage per-dir)   │  │
                   │  └──┬───────┬─────────┬─────────┬──┘  │
                   │     │       │         │         │     │
                   │  ┌──▼──┐ ┌─▼──┐ ┌───▼──┐ ┌───▼───┐ │
                   │  │Sess │ │Tool│ │Agent │ │Config │ │
                   │  │ ion │ │Reg │ │Defns │ │Loader │ │
                   │  └──┬──┘ └─┬──┘ └───┬──┘ └───────┘ │
                   │     │      │        │               │
                   │  ┌──▼──────▼────────▼──┐            │
                   │  │   Bus (EventEmitter) ├──► GlobalBus──► SSE
                   │  └──┬──────────────────┘            │
                   │     │                               │
                   │  ┌──▼──────────────────┐            │
                   │  │  SQLite (Drizzle)   │            │
                   │  │  + Snapshot (Git)   │            │
                   │  └─────────────────────┘            │
                   └───────────────────────────────────────┘
```

**Key design choices:**
- **Client/server split** — server runs locally, any frontend can connect (TUI, web, desktop, mobile)
- **Per-directory isolation** — single server process handles multiple project directories via AsyncLocalStorage
- **Event-driven** — internal Bus publishes events, SSE streams them to all connected clients
- **Provider-agnostic** — Vercel AI SDK abstracts 30+ LLM providers behind a unified interface

---

## 2. Agent/Subagent Architecture

### 2.1 Agent Definition Schema

Agents are **named configurations** (not classes or objects with behavior). The runtime interprets these configs to assemble prompts, select tools, and enforce permissions.

```typescript
Agent.Info = z.object({
  name: z.string(),                    // Unique identifier
  description: z.string().optional(),  // Shown in @mention and tool descriptions
  mode: z.enum(["subagent", "primary", "all"]),
  native: z.boolean().optional(),      // Built-in vs custom
  hidden: z.boolean().optional(),      // Hidden from @mention autocomplete
  topP: z.number().optional(),
  temperature: z.number().optional(),
  color: z.string().optional(),
  permission: PermissionNext.Ruleset,  // Per-agent tool access rules
  model: z.object({                    // Optional model override
    modelID: z.string(),
    providerID: z.string(),
  }).optional(),
  variant: z.string().optional(),      // Model variant (e.g. thinking level)
  prompt: z.string().optional(),       // Custom system prompt (overrides provider default)
  options: z.record(z.string(), z.any()),  // Provider-specific LLM options
  steps: z.number().int().positive().optional(),  // Max agentic iterations
})
```

### 2.2 Built-in Agent Hierarchy

```
  Primary Agents (user-facing, switchable with Tab key)
  ├── build     — Default. Full tool access. No custom prompt (uses provider default).
  ├── plan      — Read-only. Blocks all edit tools except .opencode/plans/*.md
  │
  Hidden Primary Agents (auto-invoked by framework, never user-facing)
  ├── compaction — Summarizes conversation when context overflows. No tools.
  ├── title      — Generates session titles. temp=0.5. No tools.
  └── summary    — PR-style summaries. No tools.

  Subagents (invoked via @mention or Task tool)
  ├── general    — Full tool access minus todo read/write. Parallel task execution.
  └── explore    — Read-only specialist. grep/glob/read/bash/web only. Custom prompt.
```

**Design insight:** Hidden agents are invisible to the user but share the same Agent.Info schema — they're just configs with `hidden: true` and `mode: "primary"`. The framework calls them programmatically (compaction after overflow, title after first reply, summary on session end).

### 2.3 Custom Agent System

Custom agents are **first-class citizens** defined via:

1. **Markdown files** in `.opencode/agents/*.md` or `agents/*.md`:
   ```markdown
   ---
   mode: subagent
   temperature: 0.7
   model: openai/gpt-4o
   permission:
     bash: deny
     edit: { "*.test.ts": allow, "*": deny }
   ---
   You are a code reviewer. Focus on test quality...
   ```

2. **JSON config** in `opencode.json`:
   ```json
   { "agent": { "reviewer": { "mode": "subagent", "temperature": 0.7 } } }
   ```

Frontmatter → agent config. Body → system prompt. Unknown properties → `options`. Custom agents merge with built-ins at load time with full parity.

### 2.4 Subagent Invocation Mechanism

The **Task tool** is the gateway for all subagent invocations:

```
Parent Session (build agent)
  │
  ├─ LLM decides to use Task tool
  │   params: { subagent_type: "explore", prompt: "find auth files" }
  │
  ├─ Task tool creates CHILD SESSION:
  │   Session.create({ parentID: parent.id, title: "find auth files (@explore)" })
  │
  ├─ Applies permission restrictions:
  │   - Block todowrite/todoread (prevents subagent from modifying parent's task list)
  │   - Optionally block nested task invocations (prevents recursion)
  │
  ├─ Calls SessionPrompt.prompt() with child session + agent config
  │   → Child runs its own LLM loop with its own tools/permissions
  │
  └─ Returns aggregated text result to parent:
     { output: "task_id: ses_xxx\n<task_result>\n...\n</task_result>" }
```

**Key patterns:**
- **Isolation via child sessions** — separate message history, separate abort signal
- **Permission merging** — agent permissions + session-level overrides
- **Resumable** — pass `task_id` to continue an existing child session
- **Access-controlled** — parent agent's permission ruleset gates which subagents it can invoke

---

## 3. Session & Context Management

### 3.1 Session Lifecycle

```
create → chat loop → [compaction] → completion → [summarize]
           ↑    ↓
         continue/retry
```

Sessions are the fundamental unit of conversation. Each session has:
- A unique ID (descending for newest-first sort)
- A project/directory binding
- Optional parent session ID (for subagent isolation)
- Permission ruleset (merged from agent + user config)
- Revert state (for undoing code changes)

### 3.2 The Core AI Loop

```
SessionPrompt.loop(sessionID)
  │
  while (true):
  │  ├─ Fetch all messages (filtered for compaction)
  │  ├─ Find last user, last assistant, last finished
  │  │
  │  ├─ EXIT CHECK: if assistant finished and reason ∉ {"tool-calls", "unknown"} → break
  │  │
  │  ├─ Create new assistant message
  │  ├─ Resolve tools (registry + permissions + model-specific filtering)
  │  ├─ Create SessionProcessor
  │  │
  │  ├─ processor.process():
  │  │   ├─ LLM.stream() → Vercel AI SDK streamText()
  │  │   ├─ Iterate stream events:
  │  │   │   ├─ reasoning-start/delta/end  → ReasoningPart (thinking tokens)
  │  │   │   ├─ tool-input-start/delta/end → ToolPart (pending → running)
  │  │   │   ├─ tool-call                  → Execute tool, doom loop check
  │  │   │   ├─ tool-result                → ToolPart (completed)
  │  │   │   ├─ tool-error                 → ToolPart (error), permission check
  │  │   │   ├─ text-start/delta/end       → TextPart
  │  │   │   └─ step-finish                → Token counting, cost, compaction check
  │  │   │
  │  │   └─ Returns: "stop" | "compact" | "continue"
  │  │
  │  ├─ if "stop" → break
  │  ├─ if "compact" → trigger compaction, then auto-continue
  │  └─ if "continue" → next iteration
  │
  └─ Prune old tool outputs, return final assistant message
```

### 3.3 Message & Part Structure

Messages use a **parts-based model** (not flat text):

```
Message (User or Assistant)
  ├─ TextPart         — Streamed text response
  ├─ ReasoningPart    — Model thinking/reasoning tokens (o1, claude-thinking)
  ├─ ToolPart         — Tool invocation with state machine:
  │   pending → running → completed | error
  ├─ FilePart         — Attached file (image, PDF, etc.)
  ├─ StepStartPart    — Filesystem snapshot before LLM step
  ├─ StepFinishPart   — Token counts, cost, snapshot after step
  ├─ PatchPart        — Computed file diff
  ├─ SnapshotPart     — Filesystem snapshot reference
  ├─ SubtaskPart      — Delegated to subagent
  ├─ AgentPart        — Agent switch marker
  ├─ RetryPart        — Retry attempt metadata
  └─ CompactionPart   — Compaction boundary marker
```

Each part is persisted individually to SQLite and streamed as delta events via Bus → SSE.

### 3.4 Context Split & Isolation

**Between parent and subagent:**
- Child sessions get **separate message histories** (different sessionID)
- Parent passes prompt as tool input; child runs independently
- Child result returns as a single tool output string to parent
- Child **cannot access parent's todo list** (todowrite/todoread denied)
- Child **cannot recursively spawn subagents** (unless parent allows it)

**Between primary agents (build ↔ plan):**
- Same session, agent switch via synthetic user message
- Plan agent's edits restricted to `.opencode/plans/*.md`
- Build agent gets full access back when plan exits

### 3.5 Per-Directory Context Isolation

```typescript
// AsyncLocalStorage-based context
const context = Context.create<{ directory, worktree, project }>("instance")

// Each HTTP request provides directory
Instance.provide({ directory: "/path/to/project", fn: () => {
  // All code in this async scope sees Instance.directory, Instance.worktree, etc.
  // State.create() binds to this directory
  // Database queries scope to this project
}})
```

`Instance.state()` creates **lazy-initialized, per-directory singletons** with disposal:

```typescript
const toolRegistry = Instance.state(
  async () => { /* load tools once per directory */ },
  async (state) => { /* cleanup on dispose */ }
)
// Calling toolRegistry() returns the same value within the same directory context
```

---

## 4. Context Window Management (Compaction)

### 4.1 Overflow Detection

```typescript
// Triggers when total tokens >= usable context
const usable = model.limit.input
  ? model.limit.input - reserved
  : context - maxOutputTokens

return totalTokens >= usable
```

`reserved` defaults to `min(COMPACTION_BUFFER, maxOutputTokens)`.

### 4.2 Three-Stage Context Recovery

**Stage 1: Prune old tool outputs**

Goes backwards through message history, skipping last 2 turns. Erases tool call outputs older than the `PRUNE_PROTECT` threshold (40K tokens), replacing them with `"[Old tool result content cleared]"`. Protected tools (e.g., `skill`) are never pruned. Marks pruned parts with `time.compacted` timestamp.

**Stage 2: Compaction (summarization)**

When overflow detected mid-stream:
1. Processor returns `"compact"` signal
2. Loop creates a **compaction message** using the `compaction` agent
3. Compaction agent receives full conversation + prompt:
   > "Provide a detailed prompt for continuing our conversation. Focus on what we did, what we're doing, which files we're working on, and what we're going to do next."
4. Agent produces summary → stored as assistant message with `summary: true`
5. Future `MessageV2.filterCompacted()` uses this summary as context boundary

**Stage 3: Auto-continue after compaction**

If compaction was triggered automatically (not user-initiated), the system injects a synthetic user message:
> "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."

This keeps the agent working without manual intervention after context was compacted.

### 4.3 Message Filtering for Compacted History

```typescript
// filterCompacted() returns only messages after the latest compaction summary
// Earlier messages are discarded — the summary replaces them
for await (const item of MessageV2.stream(sessionID)) {
  if (item.info.role === "assistant" && item.info.summary) {
    // Found summary boundary — discard everything before it
    result = [item]
    continue
  }
  result.push(item)
}
```

---

## 5. Thinking / Reasoning Tokens

OpenCode handles extended thinking (Claude, o1, o3) as first-class **ReasoningPart** objects:

```
Stream events:
  reasoning-start  → Create ReasoningPart, persist to DB
  reasoning-delta  → Accumulate reasoning text, publish delta
  reasoning-end    → Mark reasoning complete

Storage:
  ReasoningPart = {
    type: "reasoning",
    text: string,        // Full reasoning text
    signature?: string,  // Provider-specific (Anthropic redacted thinking)
    time: { start, end }
  }
```

**Provider-specific handling:**
- Anthropic: `anthropic-beta: interleaved-thinking-2025-05-14` header enables thinking
- OpenAI o1/o3: reasoning tokens counted separately in `tokens.reasoning`
- Gemini: thinking budget via `thinkingConfig` in provider options
- Copilot: passes `anthropic-beta` header for thinking models

Reasoning parts are:
- Stored in DB alongside text/tool parts
- Streamed to frontend for real-time display
- Included in token cost calculations
- **Preserved across compaction** (not pruned)

---

## 6. Tool System

### 6.1 Tool Definition Pattern

```typescript
export const MyTool = Tool.define("my_tool", async (initCtx) => {
  // initCtx.agent — the agent requesting this tool (for filtering)
  return {
    description: "...",
    parameters: z.object({ /* Zod schema */ }),
    async execute(params, ctx) {
      // ctx.sessionID, ctx.abort, ctx.ask(), ctx.metadata()
      return { title: "...", output: "...", metadata: {} }
    }
  }
})
```

**Automatic wrappers applied by `Tool.define()`:**
1. **Zod validation** — params parsed before execute, custom error formatting
2. **Output truncation** — 2000 lines / 50KB max, full output saved to file with hint
3. **Metadata streaming** — `ctx.metadata({ title: "..." })` updates tool card mid-execution

### 6.2 Tool Registry & Filtering

```
Tool loading:
  Built-in tools (bash, read, edit, write, glob, grep, etc.)
  + Custom tools from {tool,tools}/*.{js,ts} in project/config dirs
  + Plugin-registered tools
  + MCP server tools (prefixed: mcp_serverName_toolName)

Filtering per request:
  - Feature flags (experimental tools behind flags)
  - Model-specific (GPT uses apply_patch instead of edit/write)
  - Agent permissions (explore agent: only search tools)
  - Provider restrictions (websearch/codesearch: opencode provider only)
```

### 6.3 Edit Tool: 9-Stage Fuzzy Matching

The edit tool's `old_string` matching uses a **fallback chain of 9 replacement strategies**:

```
1. SimpleReplacer              — Exact string match
2. LineTrimmedReplacer         — Line-by-line whitespace-trimmed
3. BlockAnchorReplacer         — First/last line anchors + similarity
4. WhitespaceNormalizedReplacer — Whitespace-insensitive
5. IndentationFlexibleReplacer — Indentation-agnostic
6. EscapeNormalizedReplacer    — Unescape sequence matching
7. TrimmedBoundaryReplacer     — Trimmed content boundaries
8. ContextAwareReplacer        — Context lines + >50% body similarity
9. MultiOccurrenceReplacer     — All exact occurrences (for replace_all)
```

Each replacer is a **generator function** yielding candidate match strings. First successful unique match wins. This makes the edit tool resilient to LLM hallucinations about whitespace, indentation, and escape characters.

### 6.4 Batch Tool (Parallel Multi-Tool)

```typescript
BatchTool.execute({ tool_calls: [
  { tool: "read", parameters: { file_path: "/a.ts" } },
  { tool: "grep", parameters: { pattern: "TODO" } },
  // ... up to 25 parallel calls
]})
```

- `Promise.all()` for parallel execution
- Per-call state tracking (each gets its own PartID and running→completed lifecycle)
- Disallowed: `batch` (no nesting), `patch`, `invalid`
- Each call gets independent permission checks
- Results aggregated: `"Batch execution (N/M successful)"`

### 6.5 Doom Loop Detection

```typescript
// Last 3 tool calls with identical tool + identical input → ask permission
const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)
if (lastThree.every(p =>
  p.type === "tool" &&
  p.tool === currentToolName &&
  JSON.stringify(p.state.input) === JSON.stringify(currentInput)
)) {
  await PermissionNext.ask({ permission: "doom_loop", patterns: [toolName] })
}
```

Protects against infinite loops where the model repeatedly calls the same tool with the same arguments. Triggers a user permission prompt to continue or abort.

---

## 7. Permission System

### 7.1 Three-State Permissions

```
Actions: "allow" | "deny" | "ask"
Rules:  { permission: string, pattern: string, action: Action }
```

Evaluated via **last-match-wins** with wildcard support:

```typescript
// Evaluate a permission request against a ruleset
function evaluate(permission, pattern, ruleset) {
  let result = { action: "ask" }  // default
  for (const rule of ruleset) {
    if (Wildcard.match(rule.permission, permission) &&
        Wildcard.match(rule.pattern, pattern)) {
      result = rule  // last match wins
    }
  }
  return result
}
```

### 7.2 Permission Merging Hierarchy

```
defaults (built-in)
  + agent-specific rules
    + user config overrides
      = final ruleset
```

```typescript
permission: PermissionNext.merge(
  defaults,                    // all allowed, .env files ask
  PermissionNext.fromConfig({  // agent-specific
    edit: { "*": "deny" },     // plan agent: no edits
  }),
  user,                        // user overrides from config
)
```

### 7.3 Default Permission Rules

```typescript
defaults = {
  "*": "allow",                        // Everything allowed by default
  doom_loop: "ask",                    // Ask on infinite loops
  external_directory: { "*": "ask" },  // Ask for files outside worktree
  question: "deny",                    // Asking user questions blocked
  plan_enter: "deny",                  // Can't enter plan mode
  plan_exit: "deny",                   // Can't exit plan mode
  read: {
    "*": "allow",
    "*.env": "ask",                    // Sensitive files need permission
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
}
```

### 7.4 Permission Request/Reply Flow

```
Tool calls ctx.ask({ permission: "edit", patterns: ["src/foo.ts"] })
  │
  ├─ evaluate() against merged ruleset
  │   ├─ "allow" → return immediately
  │   ├─ "deny"  → throw DeniedError
  │   └─ "ask"   → create pending Promise, publish Bus event
  │
  ├─ Frontend shows permission dialog
  │
  └─ User replies:
      ├─ "once"   → resolve this single request
      ├─ "always" → add to approved ruleset, resolve all matching pending
      └─ "reject" → reject all pending for this session
```

---

## 8. Plan Mode & Plan Execution

### 8.0 Is Planning Mandatory?

**No.** Planning is entirely optional. The default agent is `build` (full edit access). Users can work without ever entering plan mode. It is an opt-in workflow triggered by the user.

### 8.1 How Plan Mode is Triggered

**User presses Tab** in the TUI — cycles between `build` and `plan` agents. The next user message is sent with `agent: "plan"`. No tool call needed, purely a client-side agent switch.

**LLM-initiated (experimental, currently commented out):** `PlanEnterTool` would let the build agent proactively suggest planning for complex tasks. Gated behind `OPENCODE_EXPERIMENTAL_PLAN_MODE` flag. Would ask user confirmation via Question tool, then inject synthetic message with `agent: "plan"`.

### 8.2 What Happens When Plan Mode Activates

The `insertReminders()` function in `prompt.ts` detects agent transitions on each loop iteration. When the current agent is `"plan"` but the previous assistant was not `"plan"`:

```
1. Compute plan file path:
   - Git repos:  .opencode/plans/{timestamp}-{slug}.md
   - Non-git:    ~/.opencode/data/plans/{timestamp}-{slug}.md
   Each session gets a unique plan file (slug + creation timestamp).

2. Create plan directory if needed

3. Inject synthetic <system-reminder> into last user message:
   - READ-ONLY constraint (all edits denied except plan file)
   - Plan file location and state (exists → edit, missing → create)
   - Full 5-phase workflow instructions
```

### 8.3 The 5-Phase Plan Workflow (Prompt-Driven)

The workflow is NOT hardcoded logic — it's instructions injected into the user message as a `<system-reminder>`. The LLM follows it by convention.

| Phase | Goal | What the LLM does |
|-------|------|--------------------|
| **1. Understanding** | Comprehend the request | Launch up to 3 `explore` subagents in parallel to search codebase. Ask user questions via Question tool. |
| **2. Design** | Design implementation | Launch `general` subagent(s) to draft implementation approach based on Phase 1 findings. |
| **3. Review** | Validate alignment | Read critical files. Verify designs match user intent. Ask remaining questions. |
| **4. Final Plan** | Write the plan file | Write/edit the plan `.md` — the ONLY file editable in plan mode. Include file paths, approach, verification steps. |
| **5. Exit** | Signal completion | Call `plan_exit` tool → asks user "Switch to build agent?" The prompt enforces: "your turn should only end with either asking the user a question or calling plan_exit." |

### 8.4 Permission Enforcement During Planning

The plan agent's permission ruleset blocks everything except reading and the plan file:

```typescript
plan.permission = merge(defaults, fromConfig({
  question: "allow",                        // Can ask user questions
  plan_exit: "allow",                       // Can signal done
  edit: {
    "*": "deny",                            // Block ALL edits
    ".opencode/plans/*.md": "allow",        // Except plan files
  },
}))
```

Even if the LLM hallucinates a write to a source file, the permission system blocks it at the tool layer.

### 8.5 Plan → Build Transition (plan_exit)

```
Plan agent calls plan_exit tool (zero parameters):
  │
  ├─ PlanExitTool asks user via Question tool:
  │   "Plan at .opencode/plans/xxx.md is complete.
  │    Switch to build agent and start implementing?"
  │
  ├─ User says "Yes":
  │   ├─ Creates synthetic user message:
  │   │   { role: "user", agent: "build" }
  │   └─ Injects synthetic text part:
  │       "The plan at {path} has been approved, you can now edit files. Execute the plan"
  │
  └─ User says "No":
      └─ Throws RejectedError → plan agent continues refining
```

Alternatively, the user can press Tab again. The `insertReminders()` function detects the transition (`previousAssistant.agent === "plan"` → `currentAgent !== "plan"`) and injects:
```
BUILD_SWITCH reminder + "A plan file exists at {path}. You should execute on the plan defined within it"
```

### 8.6 How Plan Execution Works (Build Agent)

**There is no execution engine, step tracker, or plan parser.** Plan execution is entirely prompt-driven and LLM-managed. Here's the exact flow:

```
plan_exit creates synthetic user message:
  { agent: "build", text: "The plan at {path} has been approved...Execute the plan" }
      │
      ▼
Loop iteration picks up the new user message:
  lastUser.agent = "build"  ← read from synthetic message (line 306 in prompt.ts)
  agent = Agent.get("build") ← full tool access restored (line 557)
  insertReminders() injects BUILD_SWITCH reminder if plan file exists
      │
      ▼
Build agent's LLM receives in its context:
  1. Full conversation history (including plan agent's exploration, Q&A)
  2. BUILD_SWITCH: "Your mode changed from plan to build. You can edit files now."
  3. "A plan file exists at {path}. You should execute on the plan defined within it"
      │
      ▼
Build agent reads the plan file and executes it using standard tools:
  - read (reads the plan .md)
  - edit/write/apply_patch (modifies code)
  - bash (runs commands, tests)
  - grep/glob (searches code)
  - task (delegates to subagents)
```

**The plan file is just a markdown file.** The build agent reads it with the `read` tool and follows its instructions. There is no structured schema, no step parsing, no automatic verification — the LLM interprets the markdown and acts on it.

### 8.7 Plan Execution Tracking (TodoWrite)

While planning itself doesn't use TodoWrite (the plan agent has it available but the workflow doesn't prescribe it), **plan execution by the build agent** is tracked via the TodoWrite system. The build agent's system prompts heavily emphasize it:

**Anthropic prompt:**
> "You have access to the TodoWrite tools to help you manage and plan tasks. Use these tools VERY frequently... These tools are EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps."

**BEAST prompt (GPT):**
> "Break down the fix into manageable, incremental steps. Display those steps in a simple todo list using emoji's... You MUST keep working until all items in the todo list are checked off."

The TodoWrite tool manages per-session task lists:

```typescript
Todo.Info = {
  content: string,   // Brief description
  status: string,    // pending | in_progress | completed | cancelled
  priority: string,  // high | medium | low
}
```

- `todowrite`: Replace the entire todo list (full overwrite semantics)
- `todoread`: Read current todos
- State stored in SQLite per session, events published for UI sync
- Prompt enforces: "Mark tasks complete IMMEDIATELY. Only ONE task in_progress at a time."

So the typical execution flow is:
1. Build agent reads plan file
2. Build agent creates todo list (from plan steps) via `todowrite`
3. Build agent works through items one by one, marking `in_progress` → `completed`
4. User sees progress in real-time via todo UI

### 8.8 Legacy vs Experimental Plan Mode

Two code paths, selected by `OPENCODE_EXPERIMENTAL_PLAN_MODE`:

| | Legacy (flag off) | Experimental (flag on) |
|---|---|---|
| **Plan reminder** | Short `PROMPT_PLAN` (generic read-only warning) | Full 5-phase workflow (70+ line inline prompt) |
| **Build switch** | Simple `BUILD_SWITCH` reminder | `BUILD_SWITCH` + plan file reference + "execute on the plan" |
| **plan_exit tool** | Not registered | Available in tool registry |
| **Trigger** | Tab key only | Tab key + potential LLM-initiated via `plan_enter` |
| **Plan file awareness** | No plan file reference | Explicit plan file path in both enter and exit prompts |

### 8.9 Key Design Insight

Planning in OpenCode is **not a subsystem** — it's a **different agent configuration** running within the same session loop:

- Same `SessionPrompt.loop()` code path
- Same tool resolution, same processor, same streaming
- Different agent → different permissions → different prompt injections
- Agent switch via synthetic messages that the loop picks up on next iteration
- Plan file is a regular markdown file, not a structured artifact
- Execution tracking delegated to TodoWrite (prompt-guided, not enforced)

---

## 9. System Prompt Architecture

### 9.1 Prompt Assembly Order

```
1. Agent custom prompt (if agent has prompt field) ← HIGHEST PRIORITY
   OR Provider default prompt (BEAST for GPT, ANTHROPIC for Claude, GEMINI, etc.)
2. Session-level system prompts (environment info, config instructions, skills, etc.)
3. User message system prompt (if user.system is set)

Plugin hook: experimental.chat.system.transform — can modify the assembled system
```

**Cache optimization:** System prompt is split into 2 parts max. If it grows beyond 2 parts, parts 2+ are joined. This preserves Anthropic/OpenAI prompt caching (the first system message stays stable).

### 9.2 Provider-Specific Prompts

```typescript
function provider(model) {
  if (model.includes("gpt-5"))     → PROMPT_CODEX
  if (model.includes("gpt-") || "o1" || "o3") → PROMPT_BEAST
  if (model.includes("gemini-"))   → PROMPT_GEMINI
  if (model.includes("claude"))    → PROMPT_ANTHROPIC
  if (model.includes("trinity"))   → PROMPT_TRINITY
  default                          → PROMPT_ANTHROPIC_WITHOUT_TODO
}
```

Each prompt is heavily optimized for its model family:
- **BEAST** (GPT): Emphasizes thorough thinking, internet research via webfetch, incremental implementation, explicit memory system
- **ANTHROPIC** (Claude): "Best coding agent on the planet", professional objectivity, TodoWrite task tracking, detailed final answer structure
- **GEMINI**: Core mandates (conventions, verify libs, mimic style), primary workflows, concise CLI-suitable responses
- **CODEX** (GPT-5): Compact header with instructions API support

### 9.3 Environment Context Injection

Every agent gets:
```xml
You are powered by the model named <id>. The exact model ID is <provider>/<id>
<env>
  Working directory: /path/to/project
  Is directory a git repo: yes/no
  Platform: darwin/linux/win32
  Today's date: Mon Feb 24 2025
</env>
```

---

## 10. Event Bus & Real-Time Streaming

### 10.1 Bus Architecture

```
Instance-scoped Bus (per directory)
  ├─ publish(EventDef, properties)
  │   ├─ Notify specific subscribers (by event type)
  │   ├─ Notify wildcard subscribers ("*")
  │   └─ Emit to GlobalBus (cross-instance)
  │
  └─ subscribe(EventDef, callback) → unsubscribe function

GlobalBus (singleton EventEmitter)
  └─ "event" → { directory, payload }
       └─ SSE endpoint streams to all connected clients
```

### 10.2 Event Types (Partial)

```
session.created, session.updated, session.error
session.compacted, session.diff
message.updated, message.removed
message.part.updated, message.part.delta, message.part.removed
todo.updated
permission.asked, permission.replied
status (busy/idle/retry)
server.instance.disposed
```

### 10.3 Frontend Event Consumption

```typescript
// global-sdk.tsx — SSE with 16ms batched coalescing
const eventSource = new EventSource("/event?directory=/path")
// Events are batched in 16ms frames, then flushed to SolidJS reactive stores
```

---

## 11. Snapshot & Revert System

### 11.1 Filesystem Snapshots via Git

Uses a **separate git repository** (not the project's `.git`) stored at `~/.opencode/data/snapshot/<project-id>`:

```
Track:   git write-tree → hash (captures filesystem state without commit)
Diff:    git diff --name-only <hash1> <hash2>
Revert:  git checkout <hash> -- <file> (per-file revert)
Restore: git read-tree <hash> && git checkout-index -a -f (full restore)
```

### 11.2 StepStart/StepFinish Snapshots

Every LLM step captures before/after filesystem state:
```
StepStartPart  { snapshot: "abc123" }   // git tree hash before step
  ... tool calls modify files ...
StepFinishPart { snapshot: "def456" }   // git tree hash after step
```

### 11.3 Revert Flow

```
User triggers revert to message/part:
  │
  ├─ Walk message history, collect PatchParts after revert point
  ├─ Snapshot.revert(patches) — restores files from pre-change hashes
  ├─ Compute diffs for UI display
  ├─ Store revert state on session
  │
  └─ Session enters "reverted" state:
      ├─ Can unrevert (restore snapshot) to get changes back
      └─ On next chat, cleanup() removes reverted messages/parts from DB
```

---

## 12. Retry & Error Recovery

### 12.1 Retryable Errors

```typescript
retryable(error):
  - APIError with isRetryable flag → retry with message
  - "Overloaded" → "Provider is overloaded"
  - "FreeUsageLimitError" → link to credits page
  - too_many_requests → "Too Many Requests"
  - rate_limit → "Rate Limited"
  - exhausted/unavailable → "Provider is overloaded"
  - ContextOverflowError → NOT retryable (triggers compaction instead)
```

### 12.2 Retry Delay Strategy

```
Priority order:
  1. retry-after-ms header (from provider)
  2. retry-after header (seconds or HTTP date)
  3. Exponential backoff: 2s × 2^(attempt-1)
     Max without headers: 30s
     Max with headers: ~24 days (int32 max for setTimeout)
```

### 12.3 LLM Tool Call Repair

```typescript
// Auto-fix case-insensitive tool names
experimental_repairToolCall(failed) {
  const lower = failed.toolCall.toolName.toLowerCase()
  if (lower !== failed.toolCall.toolName && tools[lower]) {
    return { ...failed.toolCall, toolName: lower }  // Fix casing
  }
  return { ...failed.toolCall, toolName: "invalid" }  // Route to InvalidTool
}
```

---

## 13. Plugin System

### 13.1 Plugin Hooks

```typescript
Hooks = {
  auth:                // Authentication (OAuth, API key)
  event:               // Bus event subscription
  tool:                // Custom tool registration
  config:              // Config change reaction
  "chat.message":      // Intercept incoming messages
  "chat.params":       // Modify LLM request parameters
  "chat.headers":      // Inject HTTP headers for LLM calls
  "shell.env":         // Inject env vars into bash tool
  "tool.execute.before/after":  // Tool call interceptors
  "tool.definition":   // Modify tool schema at load time
  "permission.ask":    // Intercept permission prompts
  "experimental.chat.system.transform":  // Modify system prompt
  "experimental.session.compacting":     // Custom compaction prompt
}
```

### 13.2 Plugin Initialization

```typescript
// Plugins receive a PluginInput with:
{
  client,    // SDK client for API calls
  project,   // Project metadata
  worktree,  // Git root
  directory, // Working directory
  serverUrl, // HTTP server URL
  $: Bun.$,  // Shell access
}
```

### 13.3 Auth Plugins (Production Examples)

**Codex (OpenAI):**
- PKCE OAuth flow with local server on port 17425
- Device code flow fallback for headless environments
- Token refresh with automatic retry
- Rewrites fetch URLs to Codex endpoint
- Adds Bearer token + ChatGPT-Account-Id header

**Copilot (GitHub):**
- GitHub device code OAuth flow
- Supports GitHub Enterprise Server (GHES)
- Detects vision + agent status from request body
- Sets `x-initiator: agent` for subagent sessions
- Passes `anthropic-beta` header for thinking models

---

## 14. MCP (Model Context Protocol) Integration

### 14.1 Server Types

```
Local (stdio):  StdioClientTransport → spawns subprocess
Remote (HTTP):  StreamableHTTPClientTransport → SSE fallback
```

### 14.2 OAuth for Remote MCP Servers

```
authenticate(mcpName):
  ├─ Start OAuth callback server (port 17422)
  ├─ Generate state parameter (CSRF protection)
  ├─ Try StreamableHTTP → SSE transport
  │   ├─ UnauthorizedError → capture redirect URL
  │   └─ Open browser with auth URL
  ├─ Wait for callback (5-minute timeout)
  ├─ Validate state (CSRF check)
  └─ finishAuth → reconnect transport
```

### 14.3 Tool Namespacing

MCP tools are namespaced: `{sanitized_server_name}_{sanitized_tool_name}`. This prevents collisions between servers and built-in tools.

---

## 15. ID Generation

```typescript
// Monotonic IDs with embedded timestamps
// Format: {prefix}_{6-byte-time-hex}{14-char-random-base62}
// Example: msg_01936a2b3c00KxR7pQ4mNwYzAb

// Ascending: newest IDs sort last (for messages within a session)
// Descending: newest IDs sort first (for session listing)

// Counter per millisecond prevents collisions in burst operations
if (currentTimestamp !== lastTimestamp) {
  lastTimestamp = currentTimestamp
  counter = 0
}
counter++
```

---

## 16. Todo/Task Tracking

Simple per-session task list stored in SQLite:

```typescript
Todo.Info = {
  content: string,   // Brief description
  status: string,    // pending | in_progress | completed | cancelled
  priority: string,  // high | medium | low
}
```

- `TodoWrite` tool: LLM updates the full task list (replace semantics)
- `TodoRead` tool: LLM reads current tasks
- **Subagents cannot access parent's todos** (todowrite/todoread denied in child sessions)
- Events published on update for real-time UI sync

---

## 17. Summary / Diff Computation

### 17.1 Session Summary

After each step-finish event:
```
1. Find earliest StepStartPart snapshot hash (from)
2. Find latest StepFinishPart snapshot hash (to)
3. git diff --numstat from..to → additions, deletions, file list
4. git show from:file / to:file → before/after content
5. Store as session summary: { additions, deletions, files, diffs[] }
```

### 17.2 Per-Message Summary

Each user message gets its own diff scope:
```
User message → assistant response → tool calls → file changes
  → computeDiff(messages for this exchange)
  → store on userMessage.summary.diffs
```

This enables the UI to show "what changed" per conversation turn.

---

## Key Architectural Insights

1. **Agents are configs, not code** — A map from name → { prompt, permissions, model, temperature }. The runtime is generic.

2. **Session = message DB + event stream** — No in-memory conversation state. Everything persisted to SQLite. Processor re-reads from DB each iteration.

3. **Compaction is a separate agent call** — Not token counting/truncation, but actual LLM summarization with a specialized prompt.

4. **Snapshot uses git internally** — Separate `.git` repo per project, `write-tree` for O(1) snapshots, `checkout` for per-file revert.

5. **Permissions are data, not code** — Wildcard pattern matching, last-match-wins, three states. Same system for agents, users, and plugins.

6. **Edit resilience via fuzzy matching** — 9 fallback strategies handle LLM imprecision with whitespace, indentation, escapes.

7. **Provider-specific prompts** — Each model family gets a heavily optimized system prompt rather than a generic one.

8. **Cache-aware prompt structure** — System prompt split into exactly 2 parts to maximize Anthropic/OpenAI prompt caching.

9. **Event-driven reactivity** — Bus events → SSE → SolidJS reactive stores. No polling. 16ms batched frame flush.

10. **Plugin hooks at every layer** — Auth, tools, permissions, system prompt, chat params, tool execution before/after. Full extensibility.
