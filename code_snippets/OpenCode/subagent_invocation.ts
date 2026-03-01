/**
 * OpenCode Subagent Invocation Pattern
 *
 * The Task tool is the gateway for ALL subagent invocations.
 * Creates isolated child sessions with restricted permissions.
 *
 * Source: packages/opencode/src/tool/task.ts
 */

import z from "zod"

// --- Task Tool Definition ---

const TaskTool = {
  id: "task",
  async init(ctx?: { agent?: AgentInfo }) {
    // Filter available subagents by parent agent's permissions
    const agents = await listAgents().then((x) => x.filter((a) => a.mode !== "primary"))
    const accessible = ctx?.agent
      ? agents.filter((a) => evaluate("task", a.name, ctx.agent!.permission).action !== "deny")
      : agents

    return {
      description: `Launch a subagent. Available: ${accessible.map((a) => a.name).join(", ")}`,
      parameters: z.object({
        description: z.string().describe("Short (3-5 word) task description"),
        prompt: z.string().describe("The task for the agent"),
        subagent_type: z.string().describe("Agent type to use"),
        task_id: z.string().optional().describe("Resume a prior task"),
      }),

      async execute(params: any, ctx: ToolContext) {
        const agent = await getAgent(params.subagent_type)

        // --- KEY PATTERN: Create isolated child session ---
        const session = params.task_id
          ? await getSession(params.task_id) // Resume existing
          : await createSession({
              parentID: ctx.sessionID,
              title: `${params.description} (@${agent.name} subagent)`,
              // Restrict child permissions
              permission: [
                { permission: "todowrite", pattern: "*", action: "deny" },
                { permission: "todoread", pattern: "*", action: "deny" },
                // Optionally block recursive subagent spawning
                ...(canSpawnNested(agent) ? [] : [{ permission: "task", pattern: "*", action: "deny" }]),
              ],
            })

        // --- KEY PATTERN: Invoke child session's own LLM loop ---
        const result = await sessionPrompt({
          sessionID: session.id,
          agent: agent.name,
          model: agent.model ?? currentModel,
          tools: { todowrite: false, todoread: false },
          parts: [{ type: "text", text: params.prompt }],
        })

        // --- Aggregate and return text result to parent ---
        const text = extractTextFromResult(result)
        return {
          title: params.description,
          output: `task_id: ${session.id}\n\n<task_result>\n${text}\n</task_result>`,
          metadata: { sessionId: session.id },
        }
      },
    }
  },
}

// --- Subtask Invocation (Alternative: Inline Subagent) ---
// For @agent mentions in messages, the system can run the subagent
// inline within the same session but with different agent config.

async function handleSubtask(task: { agent: string; prompt: string }, sessionID: string, abort: AbortSignal) {
  const agent = await getAgent(task.agent)

  // Create assistant message in SAME session, different agent
  const assistantMessage = await updateMessage({
    id: generateId("message"),
    role: "assistant",
    sessionID,
    agent: task.agent,
  })

  // Execute with the subagent's permission ruleset
  const ctx: ToolContext = {
    agent: task.agent,
    sessionID,
    abort,
    async ask(req) {
      await askPermission({
        ...req,
        sessionID,
        ruleset: mergePermissions(agent.permission, sessionPermission),
      })
    },
  }

  return TaskTool.init().then((t) => t.execute({ subagent_type: task.agent, prompt: task.prompt }, ctx))
}

// --- Placeholder types ---
type AgentInfo = { name: string; mode: string; permission: any[]; model?: any }
type ToolContext = {
  sessionID: string
  agent: string
  abort: AbortSignal
  callID?: string
  messageID?: string
  ask: (req: any) => Promise<void>
}

function evaluate(_perm: string, _name: string, _ruleset: any) {
  return { action: "allow" }
}
function listAgents(): Promise<AgentInfo[]> {
  return Promise.resolve([])
}
function getAgent(_name: string): Promise<AgentInfo> {
  return Promise.resolve({} as any)
}
function getSession(_id: string) {
  return Promise.resolve({} as any)
}
function createSession(_input: any) {
  return Promise.resolve({ id: "ses_xxx" })
}
function sessionPrompt(_input: any) {
  return Promise.resolve({})
}
function extractTextFromResult(_result: any): string {
  return ""
}
function canSpawnNested(_agent: AgentInfo): boolean {
  return false
}
function generateId(_prefix: string): string {
  return ""
}
function updateMessage(_input: any) {
  return Promise.resolve({})
}
function askPermission(_input: any) {
  return Promise.resolve()
}
function mergePermissions(..._rulesets: any[]) {
  return []
}
const currentModel = {}
const sessionPermission: any[] = []
