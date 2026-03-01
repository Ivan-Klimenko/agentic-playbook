/**
 * OpenCode Event Bus & SSE Streaming Pattern
 *
 * Instance-scoped pub/sub with global cross-instance streaming.
 * Events flow: Bus.publish() → GlobalBus → SSE endpoint → Frontend.
 *
 * Source: packages/opencode/src/bus/
 */

import { EventEmitter } from "events"
import z from "zod"

// ============================================================
// 1. BUS EVENT DEFINITION
// ============================================================

namespace BusEvent {
  type Definition = ReturnType<typeof define>
  const registry = new Map<string, Definition>()

  // Define a typed event with Zod schema
  function define<Type extends string, Properties extends z.ZodType>(type: Type, properties: Properties) {
    const result = { type, properties }
    registry.set(type, result)
    return result
  }

  // Generate discriminated union of all event types (for OpenAPI spec)
  function payloads() {
    return z.discriminatedUnion(
      "type",
      registry
        .entries()
        .map(([type, def]) =>
          z.object({
            type: z.literal(type),
            properties: def.properties,
          }),
        )
        .toArray(),
    )
  }
}

// ============================================================
// 2. EVENT DEFINITIONS (Examples)
// ============================================================

const SessionCreated = BusEvent.define(
  "session.created",
  z.object({ info: z.any() }),
)

const MessageUpdated = BusEvent.define(
  "message.updated",
  z.object({ sessionID: z.string(), message: z.any() }),
)

const PartDelta = BusEvent.define(
  "message.part.delta",
  z.object({ sessionID: z.string(), messageID: z.string(), partID: z.string(), delta: z.any() }),
)

const StatusChanged = BusEvent.define(
  "status",
  z.object({ sessionID: z.string(), status: z.any() }),
)

const TodoUpdated = BusEvent.define(
  "todo.updated",
  z.object({ sessionID: z.string(), todos: z.array(z.any()) }),
)

const PermissionAsked = BusEvent.define(
  "permission.asked",
  z.object({ request: z.any() }),
)

const InstanceDisposed = BusEvent.define(
  "server.instance.disposed",
  z.object({ directory: z.string() }),
)

// ============================================================
// 3. GLOBAL BUS (Cross-instance streaming)
// ============================================================

const GlobalBus = new EventEmitter<{
  event: [{ directory?: string; payload: any }]
}>()

// ============================================================
// 4. INSTANCE-SCOPED BUS
// ============================================================

namespace Bus {
  // Per-directory subscription state (managed by Instance.state())
  function createState() {
    const subscriptions = new Map<string, Array<(event: any) => void>>()
    return { subscriptions }
  }

  // Publish an event to subscribers + global bus
  async function publish<D extends { type: string; properties: z.ZodType }>(
    def: D,
    properties: z.infer<D["properties"]>,
    instanceDirectory: string,
    state: ReturnType<typeof createState>,
  ) {
    const payload = { type: def.type, properties }

    const pending = []

    // Notify specific subscribers
    for (const key of [def.type, "*"]) {
      const match = state.subscriptions.get(key)
      for (const sub of match ?? []) {
        pending.push(sub(payload))
      }
    }

    // Emit to global bus (for SSE streaming to frontends)
    GlobalBus.emit("event", {
      directory: instanceDirectory,
      payload,
    })

    return Promise.all(pending)
  }

  // Subscribe to specific event type (or "*" for all)
  function subscribe(
    type: string,
    callback: (event: any) => void,
    state: ReturnType<typeof createState>,
  ) {
    let match = state.subscriptions.get(type) ?? []
    match.push(callback)
    state.subscriptions.set(type, match)

    // Return unsubscribe function
    return () => {
      const index = match.indexOf(callback)
      if (index !== -1) match.splice(index, 1)
    }
  }

  // Subscribe to ALL events (used by plugin system)
  function subscribeAll(callback: (event: any) => void, state: ReturnType<typeof createState>) {
    return subscribe("*", callback, state)
  }
}

// ============================================================
// 5. SSE ENDPOINT (Server-side)
// ============================================================

// Hono route handler for SSE streaming
function sseRoute(/* Hono context */) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()

        // Send keepalive ping every 30s
        const keepalive = setInterval(() => {
          controller.enqueue(encoder.encode(": keepalive\n\n"))
        }, 30_000)

        // Subscribe to global bus events
        const handler = (event: { directory?: string; payload: any }) => {
          // Filter by directory if specified in query params
          // const requestedDir = url.searchParams.get("directory")
          // if (requestedDir && event.directory !== requestedDir) return

          const data = JSON.stringify(event.payload)
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }

        GlobalBus.on("event", handler)

        // Cleanup on disconnect
        return () => {
          clearInterval(keepalive)
          GlobalBus.off("event", handler)
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  )
}

// ============================================================
// 6. FRONTEND EVENT CONSUMPTION (SolidJS)
// ============================================================

// Batched event processing at 16ms intervals (60fps)
function createEventStream(serverUrl: string, directory: string) {
  const eventSource = new EventSource(`${serverUrl}/event?directory=${encodeURIComponent(directory)}`)
  const batch: any[] = []
  let scheduled = false

  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data)
    batch.push(payload)

    if (!scheduled) {
      scheduled = true
      // Batch events into 16ms frames (requestAnimationFrame-style)
      setTimeout(() => {
        const events = batch.splice(0, batch.length)
        scheduled = false

        // Process batched events
        for (const evt of events) {
          switch (evt.type) {
            case "message.part.delta":
              // Coalesce text deltas — only keep latest state
              updatePartInStore(evt.properties)
              break
            case "session.created":
              addSessionToStore(evt.properties)
              break
            case "status":
              updateStatusInStore(evt.properties)
              break
            // ... other event types
          }
        }
      }, 16) // 16ms ≈ 60fps
    }
  }

  return {
    close: () => eventSource.close(),
  }
}

// --- Placeholder functions ---
function updatePartInStore(_props: any) {}
function addSessionToStore(_props: any) {}
function updateStatusInStore(_props: any) {}
