/**
 * Plugin Lifecycle Hook System (Typed, Priority-Ordered)
 *
 * Pattern: First-class typed hooks with priority ordering and sync/async modes.
 * From: OpenClaw src/plugins/hooks.ts, src/plugins/types.ts, src/plugins/registry.ts
 *
 * Key ideas:
 * - Two execution modes: parallel (fire-and-forget) vs sequential (modifying)
 * - Priority ordering: higher number runs first
 * - Sync-only enforcement for hot-path hooks
 * - Typed handler signatures via discriminated union map
 * - Error catching per-handler (one handler failure doesn't kill others)
 */

// --- Hook name and handler type map ---

type HookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_tool_call"
  | "after_tool_call"
  | "tool_result_persist" // SYNC ONLY
  | "message_received"
  | "message_sending"
  | "message_sent"
  | "session_start"
  | "session_end"
  | "agent_end"
  | "gateway_start"
  | "gateway_stop";

// Events and results for each hook
interface BeforeToolCallEvent {
  toolName: string;
  toolInput: Record<string, unknown>;
  sessionKey: string;
}
interface BeforeToolCallResult {
  toolInput?: Record<string, unknown>; // Modified input
  blocked?: boolean;
  blockReason?: string;
}

interface ToolResultPersistEvent {
  toolName: string;
  message: unknown; // The tool result message to persist
  sessionKey: string;
}
interface ToolResultPersistResult {
  message: unknown; // Potentially modified message
}

interface MessageSendingEvent {
  text: string;
  channel: string;
  threadId?: string;
}
interface MessageSendingResult {
  text?: string; // Modified text
  cancelled?: boolean;
}

// Handler type map — compile-time safety for hook registration
type HookHandlerMap = {
  before_model_resolve: (event: { model: string; provider: string }) => Promise<{ model?: string } | void>;
  before_prompt_build: (event: { systemPrompt: string }) => Promise<{ systemPrompt?: string } | void>;
  before_tool_call: (event: BeforeToolCallEvent) => Promise<BeforeToolCallResult | void>;
  after_tool_call: (event: { toolName: string; result: unknown }) => Promise<void>;
  tool_result_persist: (event: ToolResultPersistEvent) => ToolResultPersistResult | void; // SYNC
  message_received: (event: { text: string; channel: string }) => Promise<void>;
  message_sending: (event: MessageSendingEvent) => Promise<MessageSendingResult | void>;
  message_sent: (event: { text: string; channel: string }) => Promise<void>;
  session_start: (event: { sessionKey: string }) => Promise<void>;
  session_end: (event: { sessionKey: string }) => Promise<void>;
  agent_end: (event: { sessionKey: string; messages: unknown[] }) => Promise<void>;
  gateway_start: (event: { port: number }) => Promise<void>;
  gateway_stop: (event: Record<string, never>) => Promise<void>;
};

// --- Hook registration ---

interface HookRegistration<K extends HookName = HookName> {
  pluginId: string;
  hookName: K;
  handler: HookHandlerMap[K];
  priority: number; // Higher = runs first
}

// --- Hook runner ---

class HookRunner {
  private hooks: HookRegistration[] = [];
  private catchErrors: boolean;
  private logger: { debug: (...args: unknown[]) => void; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

  constructor(opts?: {
    catchErrors?: boolean;
    logger?: typeof console;
  }) {
    this.catchErrors = opts?.catchErrors ?? true;
    this.logger = opts?.logger ?? console;
  }

  /**
   * Register a typed hook handler.
   */
  on<K extends HookName>(
    hookName: K,
    handler: HookHandlerMap[K],
    opts?: { pluginId?: string; priority?: number },
  ): void {
    this.hooks.push({
      pluginId: opts?.pluginId ?? "unknown",
      hookName,
      handler: handler as HookHandlerMap[HookName],
      priority: opts?.priority ?? 0,
    });
  }

  /**
   * Get hooks for a specific name, sorted by priority (highest first).
   */
  private getHooks<K extends HookName>(hookName: K): HookRegistration<K>[] {
    return (this.hooks as HookRegistration<K>[])
      .filter((h) => h.hookName === hookName)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Run void hooks in parallel (fire-and-forget).
   * Used for: session_start, session_end, message_sent, gateway_start, etc.
   */
  async runParallel<K extends HookName>(
    hookName: K,
    event: Parameters<HookHandlerMap[K]>[0],
  ): Promise<void> {
    const hooks = this.getHooks(hookName);
    if (hooks.length === 0) return;

    this.logger.debug(`[hooks] running ${hookName} (${hooks.length} handlers, parallel)`);

    const promises = hooks.map(async (hook) => {
      try {
        await (hook.handler as (event: unknown) => Promise<void>)(event);
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (this.catchErrors) {
          this.logger.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    });

    await Promise.all(promises);
  }

  /**
   * Run modifying hooks sequentially with result merging.
   * Used for: before_tool_call, message_sending, before_model_resolve, etc.
   */
  async runSequential<K extends HookName, TResult>(
    hookName: K,
    event: Parameters<HookHandlerMap[K]>[0],
    mergeResults?: (accumulated: TResult | undefined, next: TResult) => TResult,
  ): Promise<TResult | undefined> {
    const hooks = this.getHooks(hookName);
    if (hooks.length === 0) return undefined;

    this.logger.debug(
      `[hooks] running ${hookName} (${hooks.length} handlers, sequential)`,
    );

    let result: TResult | undefined;

    for (const hook of hooks) {
      try {
        const handlerResult = await (
          hook.handler as (event: unknown) => Promise<TResult>
        )(event);

        if (handlerResult !== undefined && handlerResult !== null) {
          if (mergeResults && result !== undefined) {
            result = mergeResults(result, handlerResult);
          } else {
            result = handlerResult;
          }
        }
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (this.catchErrors) {
          this.logger.error(msg);
        } else {
          throw new Error(msg, { cause: err });
        }
      }
    }

    return result;
  }

  /**
   * Run synchronous-only hooks (hot path).
   * Used for: tool_result_persist, before_message_write.
   * WARNING: If a handler returns a Promise, it's detected and warned.
   */
  runSync<K extends HookName>(
    hookName: K,
    event: Parameters<HookHandlerMap[K]>[0],
  ): ReturnType<HookHandlerMap[K]> | undefined {
    const hooks = this.getHooks(hookName);
    if (hooks.length === 0) return undefined;

    let current = event;

    for (const hook of hooks) {
      try {
        const out = (hook.handler as (event: unknown) => unknown)(current);

        // Guard against accidental async handlers
        if (out && typeof (out as { then?: unknown }).then === "function") {
          const msg =
            `[hooks] ${hookName} handler from ${hook.pluginId} returned a Promise; ` +
            `this hook is synchronous and the result was ignored.`;
          if (this.catchErrors) {
            this.logger.warn(msg);
            continue;
          }
          throw new Error(msg);
        }

        if (out !== undefined && out !== null) {
          current = out as typeof event;
        }
      } catch (err) {
        const msg = `[hooks] ${hookName} handler from ${hook.pluginId} failed: ${String(err)}`;
        if (this.catchErrors) {
          this.logger.error(msg);
        } else {
          throw err;
        }
      }
    }

    return current as ReturnType<HookHandlerMap[K]>;
  }
}

// --- Usage example ---

/*
const hookRunner = new HookRunner({ catchErrors: true });

// Plugin A: high-priority safety check
hookRunner.on("before_tool_call", async (event) => {
  if (event.toolName === "exec" && event.toolInput.command?.includes("rm -rf")) {
    return { blocked: true, blockReason: "Dangerous command blocked" };
  }
}, { pluginId: "safety-plugin", priority: 100 });

// Plugin B: lower-priority audit logging
hookRunner.on("before_tool_call", async (event) => {
  console.log(`[audit] Tool call: ${event.toolName}`, event.toolInput);
}, { pluginId: "audit-plugin", priority: 10 });

// Plugin C: sync-only hot-path hook
hookRunner.on("tool_result_persist", (event) => {
  // Strip sensitive data from persisted tool results
  const msg = event.message as { content: string };
  if (msg.content.includes("API_KEY=")) {
    return { message: { ...msg, content: "[REDACTED]" } };
  }
}, { pluginId: "redact-plugin", priority: 50 });

// Running hooks:
// Parallel (observing):
await hookRunner.runParallel("session_start", { sessionKey: "test-123" });

// Sequential (modifying):
const toolResult = await hookRunner.runSequential<"before_tool_call", BeforeToolCallResult>(
  "before_tool_call",
  { toolName: "exec", toolInput: { command: "ls -la" }, sessionKey: "test-123" },
);
if (toolResult?.blocked) {
  console.log("Tool call blocked:", toolResult.blockReason);
}

// Sync-only (hot path):
const persistResult = hookRunner.runSync("tool_result_persist", {
  toolName: "read",
  message: { content: "file contents here" },
  sessionKey: "test-123",
});
*/
