/**
 * OpenCode Session Processor Pattern
 *
 * The core AI loop: stream LLM response, handle tool calls,
 * manage reasoning tokens, detect doom loops, handle retries.
 *
 * Source: packages/opencode/src/session/processor.ts
 */

import z from "zod"

// --- Stream Event Types ---
type StreamEvent =
  | { type: "start" }
  | { type: "reasoning-start"; reasoningId: string }
  | { type: "reasoning-delta"; reasoningId: string; textDelta: string }
  | { type: "reasoning-end"; reasoningId: string; signature?: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; argsTextDelta: string }
  | { type: "tool-input-end"; toolCallId: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: any }
  | { type: "tool-result"; toolCallId: string; result: any }
  | { type: "tool-error"; toolCallId: string; error: Error }
  | { type: "text-start" }
  | { type: "text-delta"; textDelta: string }
  | { type: "text-end" }
  | { type: "step-finish"; usage: { inputTokens: number; outputTokens: number } }

// --- Processor Creation ---

function createProcessor(input: {
  assistantMessage: AssistantMessage
  sessionID: string
  model: ModelInfo
  abort: AbortSignal
}) {
  const toolcalls: Record<string, ToolPart> = {}
  let snapshot: string | undefined
  let blocked = false
  let attempt = 0
  let needsCompaction = false

  return {
    get message() {
      return input.assistantMessage
    },

    partFromToolCall(toolCallID: string) {
      return toolcalls[toolCallID]
    },

    async process(streamInput: StreamInput): Promise<"stop" | "compact" | "continue"> {
      needsCompaction = false

      while (true) {
        // --- RETRY LOOP ---
        try {
          let currentText: TextPart | undefined
          const reasoningMap: Record<string, ReasoningPart> = {}

          // Get streaming response from LLM
          const stream = await callLLM(streamInput)

          // --- ITERATE OVER STREAM EVENTS ---
          for await (const value of stream.fullStream) {
            input.abort.throwIfAborted()

            switch (value.type) {
              case "start":
                setStatus(input.sessionID, { type: "busy" })
                break

              // --- REASONING/THINKING TOKENS ---
              case "reasoning-start": {
                const part: ReasoningPart = {
                  id: generateId("part"),
                  type: "reasoning",
                  text: "",
                  time: { start: Date.now() },
                }
                reasoningMap[value.reasoningId] = part
                await updatePart(part)
                break
              }
              case "reasoning-delta": {
                const part = reasoningMap[value.reasoningId]
                if (part) {
                  part.text += value.textDelta
                  await updatePartDelta(part) // Stream delta to frontend
                }
                break
              }
              case "reasoning-end": {
                const part = reasoningMap[value.reasoningId]
                if (part) {
                  part.time.end = Date.now()
                  part.signature = value.signature
                  await updatePart(part)
                }
                break
              }

              // --- TOOL CALLS ---
              case "tool-input-start": {
                const part: ToolPart = {
                  id: generateId("part"),
                  type: "tool",
                  tool: value.toolName,
                  callID: value.toolCallId,
                  state: { status: "pending", input: {}, raw: "" },
                }
                toolcalls[value.toolCallId] = part
                await updatePart(part)
                break
              }
              case "tool-input-delta": {
                const part = toolcalls[value.toolCallId]
                if (part && part.state.status === "pending") {
                  part.state.raw += value.argsTextDelta
                }
                break
              }
              case "tool-call": {
                const part = toolcalls[value.toolCallId]
                if (part) {
                  part.state = {
                    status: "running",
                    input: value.input,
                    time: { start: Date.now() },
                  }
                  await updatePart(part)

                  // --- DOOM LOOP DETECTION ---
                  await checkDoomLoop(input.assistantMessage.id, value.toolName, value.input)

                  // Take filesystem snapshot before tool execution
                  if (!snapshot) {
                    snapshot = await takeSnapshot()
                    await updatePart({
                      type: "step-start",
                      snapshot,
                    })
                  }
                }
                break
              }
              case "tool-result": {
                const part = toolcalls[value.toolCallId]
                if (part) {
                  part.state = {
                    status: "completed",
                    input: part.state.input,
                    output: value.result.output,
                    title: value.result.title,
                    metadata: value.result.metadata,
                    time: { start: part.state.time.start, end: Date.now() },
                  }
                  await updatePart(part)
                }
                break
              }
              case "tool-error": {
                const part = toolcalls[value.toolCallId]
                if (part) {
                  part.state = {
                    status: "error",
                    input: part.state.input,
                    error: value.error.message,
                    time: { start: part.state.time.start, end: Date.now() },
                  }
                  await updatePart(part)

                  // Check if error was a permission rejection
                  if (isPermissionRejection(value.error)) {
                    blocked = true
                  }
                }
                break
              }

              // --- TEXT OUTPUT ---
              case "text-start": {
                currentText = {
                  id: generateId("part"),
                  type: "text",
                  text: "",
                  time: { start: Date.now() },
                }
                await updatePart(currentText)
                break
              }
              case "text-delta": {
                if (currentText) {
                  currentText.text += value.textDelta
                  await updatePartDelta(currentText)
                }
                break
              }
              case "text-end": {
                if (currentText) {
                  currentText.time.end = Date.now()
                  // Apply plugin hooks to text output
                  await triggerPlugin("chat.message", currentText)
                  await updatePart(currentText)
                }
                break
              }

              // --- STEP COMPLETION ---
              case "step-finish": {
                // Update token counts
                input.assistantMessage.tokens.input += value.usage.inputTokens
                input.assistantMessage.tokens.output += value.usage.outputTokens

                // Check if compaction needed
                if (await isOverflow(input.assistantMessage.tokens, input.model)) {
                  needsCompaction = true
                }

                // Record step-finish snapshot
                if (snapshot) {
                  const newSnapshot = await takeSnapshot()
                  await updatePart({
                    type: "step-finish",
                    snapshot: newSnapshot,
                    tokens: input.assistantMessage.tokens,
                  })
                }

                // Trigger message summarization (async, non-blocking)
                summarizeMessage(input.sessionID, input.assistantMessage.id)
                break
              }
            }

            // Break on compaction needed
            if (needsCompaction) break
          }

          // --- POST-STREAM CLEANUP ---

          // Mark incomplete tools as aborted
          for (const part of Object.values(toolcalls)) {
            if (part.state.status !== "completed" && part.state.status !== "error") {
              part.state = { status: "error", error: "Tool execution aborted" }
              await updatePart(part)
            }
          }

          input.assistantMessage.time.completed = Date.now()
          await updateAssistantMessage(input.assistantMessage)

          // Return loop control signal
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        } catch (e: any) {
          // --- ERROR HANDLING WITH RETRIES ---
          const retryMessage = isRetryable(e)
          if (retryMessage !== undefined) {
            attempt++
            const delay = retryDelay(attempt, e)
            setStatus(input.sessionID, {
              type: "retry",
              attempt,
              message: retryMessage,
              next: Date.now() + delay,
            })
            await sleep(delay, input.abort)
            continue // Retry the loop
          }

          // Fatal error
          input.assistantMessage.error = e
          return "stop"
        }
      }
    },
  }
}

// --- Doom Loop Detection ---
const DOOM_LOOP_THRESHOLD = 3

async function checkDoomLoop(messageID: string, toolName: string, input: any) {
  const parts = await getToolParts(messageID)
  const lastN = parts.slice(-DOOM_LOOP_THRESHOLD)

  if (
    lastN.length === DOOM_LOOP_THRESHOLD &&
    lastN.every(
      (p) =>
        p.type === "tool" &&
        p.tool === toolName &&
        p.state.status !== "pending" &&
        JSON.stringify(p.state.input) === JSON.stringify(input),
    )
  ) {
    // Same tool, same input, N times in a row → ask user
    await askPermission({ permission: "doom_loop", patterns: [toolName] })
  }
}

// --- Retry Strategy ---
const RETRY_INITIAL_DELAY = 2000
const RETRY_BACKOFF_FACTOR = 2
const RETRY_MAX_DELAY_NO_HEADERS = 30_000

function retryDelay(attempt: number, error?: any): number {
  if (error?.responseHeaders) {
    const retryAfterMs = error.responseHeaders["retry-after-ms"]
    if (retryAfterMs) return parseFloat(retryAfterMs)

    const retryAfter = error.responseHeaders["retry-after"]
    if (retryAfter) {
      const seconds = parseFloat(retryAfter)
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000)
      const date = Date.parse(retryAfter) - Date.now()
      if (!isNaN(date) && date > 0) return Math.ceil(date)
    }

    return RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  }

  return Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS)
}

function isRetryable(error: any): string | undefined {
  if (error.isContextOverflow) return undefined // Not retryable — triggers compaction
  if (error.isRetryable) return error.message
  if (error.message?.includes("too_many_requests")) return "Too Many Requests"
  if (error.message?.includes("rate_limit")) return "Rate Limited"
  return undefined
}

// --- Placeholder types ---
type AssistantMessage = { id: string; tokens: any; time: any; error?: any }
type ModelInfo = { limit: { context: number; input?: number } }
type StreamInput = any
type ToolPart = { id: string; type: string; tool: string; callID: string; state: any }
type TextPart = { id: string; type: string; text: string; time: any }
type ReasoningPart = { id: string; type: string; text: string; time: any; signature?: string }

function generateId(_prefix: string): string { return "" }
function callLLM(_input: any): Promise<any> { return Promise.resolve({ fullStream: [] }) }
function setStatus(_sessionID: string, _status: any) {}
function updatePart(_part: any): Promise<void> { return Promise.resolve() }
function updatePartDelta(_part: any): Promise<void> { return Promise.resolve() }
function updateAssistantMessage(_msg: any): Promise<void> { return Promise.resolve() }
function takeSnapshot(): Promise<string> { return Promise.resolve("") }
function isOverflow(_tokens: any, _model: any): Promise<boolean> { return Promise.resolve(false) }
function summarizeMessage(_sessionID: string, _messageID: string) {}
function isPermissionRejection(_error: any): boolean { return false }
function triggerPlugin(_name: string, _input: any): Promise<void> { return Promise.resolve() }
function getToolParts(_messageID: string): Promise<any[]> { return Promise.resolve([]) }
function askPermission(_req: any): Promise<void> { return Promise.resolve() }
function sleep(_ms: number, _signal: AbortSignal): Promise<void> { return Promise.resolve() }
