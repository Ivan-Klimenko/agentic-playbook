/**
 * OpenCode Tool System Patterns
 *
 * Tool definition, registry, permission checking, output truncation,
 * batch execution, and fuzzy edit matching.
 *
 * Source: packages/opencode/src/tool/
 */

import z from "zod"

// ============================================================
// 1. TOOL DEFINITION PATTERN
// ============================================================

namespace Tool {
  interface Context {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    messages: any[]
    metadata(input: { title?: string; metadata?: any }): void
    ask(input: { permission: string; patterns: string[]; always?: string[]; metadata?: any }): Promise<void>
  }

  interface Result {
    title: string
    output: string
    metadata: Record<string, any>
    attachments?: Array<{ type: "file"; mime: string; url: string }>
  }

  // Tool.define() wraps execute with validation + truncation
  function define<P extends z.ZodType>(
    id: string,
    init: () => Promise<{
      description: string
      parameters: P
      execute(args: z.infer<P>, ctx: Context): Promise<Result>
      formatValidationError?(error: z.ZodError): string
    }>,
  ) {
    return {
      id,
      init: async () => {
        const toolInfo = await init()
        const originalExecute = toolInfo.execute

        // WRAPPER: Validation + Truncation
        toolInfo.execute = async (args, ctx) => {
          // 1. Zod validation
          try {
            toolInfo.parameters.parse(args)
          } catch (error) {
            if (error instanceof z.ZodError && toolInfo.formatValidationError) {
              throw new Error(toolInfo.formatValidationError(error))
            }
            throw new Error(`Tool ${id} called with invalid arguments: ${error}. Please rewrite the input.`)
          }

          // 2. Execute
          const result = await originalExecute(args, ctx)

          // 3. Auto-truncation (2000 lines / 50KB)
          const truncated = truncateOutput(result.output)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }

        return toolInfo
      },
    }
  }
}

// ============================================================
// 2. OUTPUT TRUNCATION
// ============================================================

const MAX_LINES = 2000
const MAX_BYTES = 50 * 1024

function truncateOutput(text: string): { content: string; truncated: boolean; outputPath?: string } {
  const lines = text.split("\n")
  const bytes = new TextEncoder().encode(text).length

  if (lines.length <= MAX_LINES && bytes <= MAX_BYTES) {
    return { content: text, truncated: false }
  }

  // Save full output to file for later retrieval
  const filepath = `/tmp/tool-output/${generateId("tool")}`
  writeFile(filepath, text)

  const truncatedLines = lines.slice(0, MAX_LINES).join("\n")
  const hint = `\n\n[Output truncated. Full output saved to: ${filepath}]\nUse Grep to search or Read with offset/limit to paginate.`

  return {
    content: truncatedLines + hint,
    truncated: true,
    outputPath: filepath,
  }
}

// ============================================================
// 3. TOOL REGISTRY & FILTERING
// ============================================================

// Tools loaded from multiple sources
async function loadTools(model: { providerID: string; modelID: string }, agent?: any) {
  const builtIn = [
    BashTool,
    ReadTool,
    EditTool,
    WriteTool,
    GlobTool,
    GrepTool,
    TaskTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    CodeSearchTool,
    SkillTool,
    ApplyPatchTool,
  ]

  // Custom tools from project directories
  const customFromFiles = await loadCustomToolsFromDirs("{tool,tools}/*.{js,ts}")

  // Plugin-registered tools
  const customFromPlugins = await loadPluginTools()

  const all = [...builtIn, ...customFromFiles, ...customFromPlugins]

  // Model-specific filtering
  return all.filter((t) => {
    // GPT uses apply_patch instead of edit/write
    const usePatch = model.modelID.includes("gpt-") && !model.modelID.includes("gpt-4")
    if (t.id === "apply_patch") return usePatch
    if (t.id === "edit" || t.id === "write") return !usePatch

    // websearch/codesearch restricted to opencode provider
    if (t.id === "codesearch" || t.id === "websearch") {
      return model.providerID === "opencode"
    }

    return true
  })
}

// ============================================================
// 4. EDIT TOOL: 9-STAGE FUZZY MATCHING
// ============================================================

// The edit tool uses a fallback chain of replacement strategies
// to handle LLM imprecision with whitespace, indentation, escapes

type Replacer = (content: string, oldString: string) => Generator<string>

const REPLACERS: Replacer[] = [
  SimpleReplacer, // Exact string match
  LineTrimmedReplacer, // Line-by-line whitespace trim
  BlockAnchorReplacer, // First/last line anchors + similarity
  WhitespaceNormalizedReplacer, // All whitespace collapsed
  IndentationFlexibleReplacer, // Indentation-agnostic
  EscapeNormalizedReplacer, // Unescape sequences
  TrimmedBoundaryReplacer, // Trimmed content boundaries
  ContextAwareReplacer, // Context lines + >50% body similarity
  MultiOccurrenceReplacer, // All exact occurrences (for replace_all)
]

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): string | null {
  for (const replacer of REPLACERS) {
    for (const candidate of replacer(content, oldString)) {
      const index = content.indexOf(candidate)
      if (index === -1) continue

      if (replaceAll) {
        return content.replaceAll(candidate, newString)
      }

      // Ensure unique match for non-replace_all
      const secondIndex = content.indexOf(candidate, index + 1)
      if (secondIndex !== -1 && replacer !== MultiOccurrenceReplacer) {
        continue // Ambiguous — try next replacer
      }

      return content.slice(0, index) + newString + content.slice(index + candidate.length)
    }
  }

  return null // No match found
}

// Example replacers (simplified)

function* SimpleReplacer(content: string, oldString: string) {
  yield oldString
}

function* LineTrimmedReplacer(_content: string, oldString: string) {
  yield oldString
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
}

function* WhitespaceNormalizedReplacer(content: string, oldString: string) {
  // Normalize whitespace in both content and search string
  const normalized = oldString.replace(/\s+/g, " ")
  const contentNormalized = content.replace(/\s+/g, " ")
  const index = contentNormalized.indexOf(normalized)
  if (index !== -1) {
    // Map back to original content positions
    yield content.slice(index, index + normalized.length) // simplified
  }
}

function* BlockAnchorReplacer(content: string, oldString: string) {
  // Match first and last lines as anchors, check similarity of middle
  const lines = oldString.split("\n")
  if (lines.length < 3) return
  const first = lines[0].trim()
  const last = lines[lines.length - 1].trim()
  const contentLines = content.split("\n")
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() === first) {
      for (let j = i + 1; j < contentLines.length; j++) {
        if (contentLines[j].trim() === last) {
          const candidate = contentLines.slice(i, j + 1).join("\n")
          if (similarity(candidate, oldString) > 0.5) {
            yield candidate
          }
        }
      }
    }
  }
}

function* IndentationFlexibleReplacer(_content: string, _oldString: string) {
  // Re-indent oldString to match content's indentation level
  // ... (simplified)
}
function* EscapeNormalizedReplacer(_content: string, _oldString: string) {}
function* TrimmedBoundaryReplacer(_content: string, _oldString: string) {}
function* ContextAwareReplacer(_content: string, _oldString: string) {}
function* MultiOccurrenceReplacer(_content: string, _oldString: string) {}

function similarity(a: string, b: string): number {
  // Simple character-level similarity
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.length === 0) return 1.0
  return (longer.length - editDistance(longer, shorter)) / longer.length
}

function editDistance(_a: string, _b: string): number {
  return 0 // placeholder
}

// ============================================================
// 5. BATCH TOOL (PARALLEL MULTI-TOOL)
// ============================================================

const BATCH_MAX_CALLS = 25
const BATCH_DISALLOWED = new Set(["batch", "patch", "invalid"])

async function executeBatch(
  params: { tool_calls: Array<{ tool: string; parameters: any }> },
  ctx: any,
  toolMap: Map<string, any>,
) {
  const calls = params.tool_calls.slice(0, BATCH_MAX_CALLS)

  const executeCall = async (call: { tool: string; parameters: any }) => {
    if (BATCH_DISALLOWED.has(call.tool)) {
      return { success: false, tool: call.tool, error: `Tool '${call.tool}' not allowed in batch` }
    }

    const tool = toolMap.get(call.tool)
    if (!tool) {
      return { success: false, tool: call.tool, error: `Tool '${call.tool}' not found` }
    }

    const partID = generateId("part")

    // Track running state
    await updateToolState(partID, { status: "running", input: call.parameters })

    try {
      const result = await tool.execute(call.parameters, { ...ctx, callID: partID })
      await updateToolState(partID, { status: "completed", output: result.output })
      return { success: true, tool: call.tool, result }
    } catch (error: any) {
      await updateToolState(partID, { status: "error", error: error.message })
      return { success: false, tool: call.tool, error }
    }
  }

  // Execute ALL calls in parallel
  const results = await Promise.all(calls.map(executeCall))

  const successful = results.filter((r) => r.success).length
  return {
    title: `Batch execution (${successful}/${results.length} successful)`,
    output: formatBatchResults(results),
    metadata: { totalCalls: results.length, successful },
  }
}

// ============================================================
// 6. PERMISSION PATTERN (Used by all tools)
// ============================================================

// Every tool that accesses files/system calls ctx.ask()
async function exampleToolWithPermission(filePath: string, ctx: any) {
  await ctx.ask({
    permission: "edit",
    patterns: [relativePath(filePath)], // Glob patterns for scoping
    always: ["*"], // Patterns that trigger "always allow"
    metadata: {
      filepath: filePath,
      diff: "...", // Context for UI display
    },
  })

  // Permission granted — proceed with operation
  await writeFile(filePath, "new content")
}

// --- Placeholder functions ---
function generateId(_prefix: string): string { return "" }
function writeFile(_path: string, _content: string) {}
function relativePath(_path: string): string { return "" }
function loadCustomToolsFromDirs(_pattern: string): Promise<any[]> { return Promise.resolve([]) }
function loadPluginTools(): Promise<any[]> { return Promise.resolve([]) }
function updateToolState(_partID: string, _state: any): Promise<void> { return Promise.resolve() }
function formatBatchResults(_results: any[]): string { return "" }

const BashTool = { id: "bash" }
const ReadTool = { id: "read" }
const EditTool = { id: "edit" }
const WriteTool = { id: "write" }
const GlobTool = { id: "glob" }
const GrepTool = { id: "grep" }
const TaskTool = { id: "task" }
const WebFetchTool = { id: "webfetch" }
const TodoWriteTool = { id: "todowrite" }
const WebSearchTool = { id: "websearch" }
const CodeSearchTool = { id: "codesearch" }
const SkillTool = { id: "skill" }
const ApplyPatchTool = { id: "apply_patch" }
