/**
 * OpenCode Instance Context & State Management
 *
 * AsyncLocalStorage-based per-directory isolation.
 * Lazy-initialized singletons with disposal lifecycle.
 *
 * Source: packages/opencode/src/project/instance.ts
 *         packages/opencode/src/project/state.ts
 *         packages/opencode/src/util/context.ts
 *         packages/opencode/src/id/id.ts
 */

import { AsyncLocalStorage } from "async_hooks"
import { randomBytes } from "crypto"

// ============================================================
// 1. CONTEXT UTILITY (AsyncLocalStorage wrapper)
// ============================================================

namespace Context {
  class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  // Creates an isolated async context namespace
  function create<T>(name: string) {
    const storage = new AsyncLocalStorage<T>()
    return {
      use() {
        const result = storage.getStore()
        if (!result) throw new NotFound(name)
        return result
      },
      provide<R>(value: T, fn: () => R) {
        return storage.run(value, fn)
      },
    }
  }
}

// ============================================================
// 2. STATE MANAGEMENT (Per-directory singletons)
// ============================================================

namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  // Map<directory, Map<initFunction, Entry>>
  const recordsByKey = new Map<string, Map<any, Entry>>()

  /**
   * Creates a state getter bound to a directory key.
   * First call initializes; subsequent calls return cached value.
   * Disposal runs on Instance.dispose().
   */
  function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    return () => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map()
        recordsByKey.set(key, entries)
      }
      const existing = entries.get(init)
      if (existing) return existing.state as S
      const state = init()
      entries.set(init, { state, dispose })
      return state
    }
  }

  // Dispose all state for a directory
  async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    const tasks: Promise<void>[] = []
    for (const [, entry] of entries) {
      if (!entry.dispose) continue
      tasks.push(
        Promise.resolve(entry.state)
          .then((state) => entry.dispose!(state))
          .catch((error) => console.error("Dispose error:", error)),
      )
    }
    await Promise.all(tasks)
    entries.clear()
    recordsByKey.delete(key)
  }
}

// ============================================================
// 3. INSTANCE (Project-scoped context provider)
// ============================================================

interface InstanceContext {
  directory: string
  worktree: string
  project: { id: string; vcs: string }
}

const instanceContext = /* Context.create<InstanceContext>("instance") */ null as any
const cache = new Map<string, Promise<InstanceContext>>()

const Instance = {
  /**
   * Provides an isolated async context for a project directory.
   * Caches initialization per directory — second call reuses context.
   */
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    let existing = cache.get(input.directory)
    if (!existing) {
      existing = (async () => {
        const project = await detectProject(input.directory)
        const ctx: InstanceContext = {
          directory: input.directory,
          worktree: project.worktree,
          project,
        }
        await instanceContext.provide(ctx, async () => {
          await input.init?.()
        })
        return ctx
      })()
      cache.set(input.directory, existing)
    }
    const ctx = await existing
    return instanceContext.provide(ctx, async () => input.fn())
  },

  // Access current directory from async context
  get directory() {
    return instanceContext.use().directory
  },
  get worktree() {
    return instanceContext.use().worktree
  },
  get project() {
    return instanceContext.use().project
  },

  /**
   * Creates a per-directory lazy singleton with disposal.
   * The init function identity is the cache key.
   *
   * Usage:
   *   const toolRegistry = Instance.state(
   *     async () => { ... load tools ... },
   *     async (state) => { ... cleanup ... }
   *   )
   *   // Later: toolRegistry() returns cached value
   */
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.directory, init, dispose)
  },

  // Dispose all state for current directory
  async dispose() {
    await State.dispose(Instance.directory)
    cache.delete(Instance.directory)
  },

  // Dispose ALL directories (server shutdown)
  async disposeAll() {
    for (const [key, value] of cache.entries()) {
      const ctx = await value.catch(() => undefined)
      if (!ctx) {
        cache.delete(key)
        continue
      }
      await instanceContext.provide(ctx, () => Instance.dispose())
    }
  },
}

// ============================================================
// 4. DATABASE CONTEXT (Transaction scoping)
// ============================================================

// Database uses the same AsyncLocalStorage pattern for transactions

namespace Database {
  const ctx = /* Context.create<{ tx: any; effects: Function[] }>("database") */ null as any

  // Auto-wraps in transaction context if not already in one
  function use<T>(callback: (trx: any) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      // Not in transaction context — execute directly
      const effects: Function[] = []
      const result = ctx.provide({ effects, tx: getClient() }, () => callback(getClient()))
      // Run deferred effects after direct execution
      for (const effect of effects) effect()
      return result
    }
  }

  // Defer side effects until transaction completes
  function effect(fn: () => any) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn() // Not in transaction — run immediately
    }
  }

  // Full transaction with effect deferral
  function transaction<T>(callback: (tx: any) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch {
      const effects: Function[] = []
      const result = getClient().transaction((tx: any) => {
        return ctx.provide({ tx, effects }, () => callback(tx))
      })
      for (const effect of effects) effect()
      return result
    }
  }
}

// ============================================================
// 5. MONOTONIC ID GENERATION
// ============================================================

namespace Identifier {
  const prefixes = {
    session: "ses",
    message: "msg",
    permission: "per",
    part: "prt",
    tool: "tool",
  } as const

  let lastTimestamp = 0
  let counter = 0

  /**
   * Generates monotonically increasing IDs with embedded timestamps.
   * Format: {prefix}_{6-byte-time-hex}{14-char-random-base62}
   *
   * ascending:  newest IDs sort last  (for messages within a session)
   * descending: newest IDs sort first (for session listing)
   */
  function create(prefix: keyof typeof prefixes, descending: boolean): string {
    const currentTimestamp = Date.now()

    // Counter prevents collisions within same millisecond
    if (currentTimestamp !== lastTimestamp) {
      lastTimestamp = currentTimestamp
      counter = 0
    }
    counter++

    let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)
    now = descending ? ~now : now

    const timeBytes = Buffer.alloc(6)
    for (let i = 0; i < 6; i++) {
      timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
    }

    return prefixes[prefix] + "_" + timeBytes.toString("hex") + randomBase62(14)
  }

  function randomBase62(length: number): string {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let result = ""
    const bytes = randomBytes(length)
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % 62]
    }
    return result
  }

  // Extract timestamp from an ascending ID
  function timestamp(id: string): number {
    const prefix = id.split("_")[0]
    const hex = id.slice(prefix.length + 1, prefix.length + 13)
    const encoded = BigInt("0x" + hex)
    return Number(encoded / BigInt(0x1000))
  }
}

// --- Placeholder ---
function detectProject(_dir: string): Promise<any> {
  return Promise.resolve({ id: "proj_1", vcs: "git", worktree: "/" })
}
function getClient(): any {
  return {}
}
