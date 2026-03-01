/**
 * OpenCode Context Compaction Pattern
 *
 * Three-stage context window management:
 * 1. Prune old tool outputs (remove verbose results)
 * 2. Compaction (LLM summarization of conversation)
 * 3. Auto-continue after compaction
 *
 * Source: packages/opencode/src/session/compaction.ts
 */

// --- Stage 0: Overflow Detection ---

const COMPACTION_BUFFER = 8192

async function isOverflow(input: { tokens: TokenCounts; model: ModelInfo }): Promise<boolean> {
  const config = await getConfig()
  if (config.compaction?.auto === false) return false

  const context = input.model.limit.context
  if (context === 0) return false

  const count = input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

  const reserved = config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(input.model))

  const usable = input.model.limit.input
    ? input.model.limit.input - reserved
    : context - maxOutputTokens(input.model)

  return count >= usable
}

// --- Stage 1: Prune Old Tool Outputs ---

const PRUNE_MINIMUM = 20_000 // Only prune if savings > 20K tokens
const PRUNE_PROTECT = 40_000 // Keep last 40K tokens of tool output
const PRUNE_PROTECTED_TOOLS = ["skill"] // Never prune these

async function prune(input: { sessionID: string }) {
  const config = await getConfig()
  if (config.compaction?.prune === false) return

  const msgs = await getMessages(input.sessionID)
  let total = 0
  let pruned = 0
  const toPrune: ToolPart[] = []
  let turns = 0

  // Walk backwards through history
  loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
    const msg = msgs[msgIndex]
    if (msg.info.role === "user") turns++
    if (turns < 2) continue // Don't prune last 2 turns
    if (msg.info.role === "assistant" && msg.info.summary) break // Stop at compaction boundary

    for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
      const part = msg.parts[partIndex]
      if (part.type === "tool" && part.state.status === "completed") {
        if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
        if (part.state.time.compacted) break loop // Already pruned

        const estimate = estimateTokens(part.state.output)
        total += estimate
        if (total > PRUNE_PROTECT) {
          // Beyond the protection threshold — mark for pruning
          pruned += estimate
          toPrune.push(part)
        }
      }
    }
  }

  // Only prune if savings are substantial
  if (pruned > PRUNE_MINIMUM) {
    for (const part of toPrune) {
      part.state.time.compacted = Date.now() // Mark as pruned
      await updatePart(part)
      // Output becomes: "[Old tool result content cleared]"
    }
  }
}

// --- Stage 2: Compaction (LLM Summarization) ---

async function compact(input: {
  parentID: string
  messages: MessageWithParts[]
  sessionID: string
  abort: AbortSignal
  auto: boolean
}): Promise<"stop" | "continue"> {
  const compactionAgent = await getAgent("compaction")
  const model = compactionAgent.model ?? await getDefaultModel()

  // Create compaction assistant message
  const msg = await updateMessage({
    id: generateId("message"),
    role: "assistant",
    parentID: input.parentID,
    sessionID: input.sessionID,
    agent: "compaction",
    summary: true, // Marks this as a compaction boundary
  })

  // Allow plugins to inject context or replace prompt
  const pluginResult = await triggerPlugin("experimental.session.compacting", {
    sessionID: input.sessionID,
  }, { context: [], prompt: undefined })

  const defaultPrompt = [
    "Provide a detailed prompt for continuing our conversation above.",
    "Focus on information that would be helpful for continuing the conversation,",
    "including what we did, what we're doing, which files we're working on,",
    "and what we're going to do next.",
    "Be specific about file paths, function names, and implementation details.",
    "Format the summary as a continuation prompt that another instance could use",
    "to seamlessly pick up the work.",
  ].join("\n")

  const promptText = pluginResult.prompt ?? [defaultPrompt, ...pluginResult.context].join("\n\n")

  // Run compaction agent (no tools — pure summarization)
  const result = await processWithAgent({
    agent: compactionAgent,
    abort: input.abort,
    sessionID: input.sessionID,
    tools: {}, // No tools for compaction
    messages: [
      ...convertToModelMessages(input.messages, model),
      { role: "user", content: [{ type: "text", text: promptText }] },
    ],
    model,
  })

  // --- Stage 3: Auto-Continue After Compaction ---
  if (result === "continue" && input.auto) {
    // Inject synthetic user message to keep the agent working
    const continueMsg = await updateMessage({
      id: generateId("message"),
      role: "user",
      sessionID: input.sessionID,
    })
    await updatePart({
      id: generateId("part"),
      messageID: continueMsg.id,
      sessionID: input.sessionID,
      type: "text",
      synthetic: true,
      text: "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    })
  }

  return result === "continue" ? "continue" : "stop"
}

// --- Message Filtering for Compacted History ---
// When building LLM input, only include messages AFTER the latest summary

async function filterCompacted(messages: AsyncIterable<MessageWithParts>): Promise<MessageWithParts[]> {
  let result: MessageWithParts[] = []
  for await (const item of messages) {
    if (item.info.role === "assistant" && item.info.summary) {
      // Found compaction boundary — everything before is replaced by this summary
      result = [item]
      continue
    }
    result.push(item)
  }
  return result
}

// --- Placeholder types ---
type TokenCounts = { total?: number; input: number; output: number; cache: { read: number; write: number } }
type ModelInfo = { limit: { context: number; input?: number } }
type ToolPart = { type: string; tool: string; state: any }
type MessageWithParts = { info: any; parts: any[] }

function getConfig(): Promise<any> { return Promise.resolve({}) }
function maxOutputTokens(_model: any): number { return 4096 }
function getMessages(_sessionID: string): Promise<any[]> { return Promise.resolve([]) }
function estimateTokens(_text: string): number { return 0 }
function updatePart(_part: any): Promise<void> { return Promise.resolve() }
function updateMessage(_msg: any): Promise<any> { return Promise.resolve({}) }
function getAgent(_name: string): Promise<any> { return Promise.resolve({}) }
function getDefaultModel(): Promise<any> { return Promise.resolve({}) }
function generateId(_prefix: string): string { return "" }
function triggerPlugin(_name: string, _input: any, _output: any): Promise<any> { return Promise.resolve({}) }
function processWithAgent(_input: any): Promise<string> { return Promise.resolve("continue") }
function convertToModelMessages(_msgs: any[], _model: any): any[] { return [] }
