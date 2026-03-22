/**
 * Session Write Lock with Staleness Detection
 *
 * Pattern: File-based exclusive lock with PID recycling detection, reentrant
 * acquisition, watchdog cleanup, and signal-safe release.
 * From: OpenClaw src/agents/session-write-lock.ts
 *
 * Key ideas:
 * - Lock file contains JSON: { pid, createdAt, starttime }
 * - Staleness detection: dead PID, recycled PID (start time mismatch),
 *   missing PID, age > threshold, orphan self-lock
 * - PID recycling: OS can reuse a PID after process death. We record the
 *   process start time (from /proc/pid/stat) and compare on contention —
 *   if the PID is alive but start time differs, it's a recycled PID → stale
 * - Reentrant: same process can acquire the same lock multiple times (ref count)
 * - Watchdog: periodic timer force-releases locks held beyond maxHoldMs
 * - Signal handlers: SIGINT/SIGTERM/SIGQUIT/SIGABRT → synchronous cleanup
 * - Lock timeout with exponential backoff on contention (50ms * attempt, cap 1s)
 * - Stale lock reclaim: contended lock files are auto-removed if stale,
 *   with mtime fallback when PID/createdAt data is missing
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

// --- Types ---

type LockFilePayload = {
  pid?: number;
  createdAt?: string;
  /** Process start time in clock ticks (from /proc/pid/stat). */
  starttime?: number;
};

type HeldLock = {
  count: number;          // reentrant ref count
  handle: fs.FileHandle;
  lockPath: string;
  acquiredAt: number;
  maxHoldMs: number;
};

type LockInspection = {
  pid: number | null;
  pidAlive: boolean;
  createdAt: string | null;
  ageMs: number | null;
  stale: boolean;
  staleReasons: string[];  // "dead-pid" | "recycled-pid" | "missing-pid" | "too-old" | "invalid-createdAt"
};

// --- Constants ---

const DEFAULT_STALE_MS = 30 * 60 * 1000;     // 30 minutes
const DEFAULT_MAX_HOLD_MS = 5 * 60 * 1000;   // 5 minutes
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_GRACE_MS = 2 * 60 * 1000;

// Process-global map of held locks (Symbol.for for cross-bundle sharing)
const HELD_LOCKS = new Map<string, HeldLock>();

// --- PID Alive Check ---

/** Check if a PID is alive (platform-specific, simplified). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch {
    return false;
  }
}

/** Get process start time for PID recycling detection.
 * On Linux: reads /proc/pid/stat field 22 (starttime in clock ticks).
 * Returns null on non-Linux or if process doesn't exist. */
function getProcessStartTime(pid: number): number | null {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.split(" ");
    return fields.length > 21 ? Number(fields[21]) : null;
  } catch {
    return null; // Non-Linux or process gone
  }
}

// --- Lock Payload Inspection ---

function inspectLockPayload(
  payload: LockFilePayload | null,
  staleMs: number,
  nowMs: number,
): LockInspection {
  const pid = typeof payload?.pid === "number" && payload.pid > 0 ? payload.pid : null;
  const pidAlive = pid !== null ? isPidAlive(pid) : false;
  const createdAt = typeof payload?.createdAt === "string" ? payload.createdAt : null;
  const createdAtMs = createdAt ? Date.parse(createdAt) : NaN;
  const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;

  // PID recycling detection: PID alive but start time doesn't match
  const storedStarttime = typeof payload?.starttime === "number" ? payload.starttime : null;
  const pidRecycled = pidAlive && pid !== null && storedStarttime !== null
    ? (() => {
        const currentStarttime = getProcessStartTime(pid);
        return currentStarttime !== null && currentStarttime !== storedStarttime;
      })()
    : false;

  // Determine staleness reasons
  const staleReasons: string[] = [];
  if (pid === null) staleReasons.push("missing-pid");
  else if (!pidAlive) staleReasons.push("dead-pid");
  else if (pidRecycled) staleReasons.push("recycled-pid");
  if (ageMs === null) staleReasons.push("invalid-createdAt");
  else if (ageMs > staleMs) staleReasons.push("too-old");

  return { pid, pidAlive, createdAt, ageMs, stale: staleReasons.length > 0, staleReasons };
}

// --- Reentrant Release ---

async function releaseHeldLock(
  sessionFile: string,
  held: HeldLock,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (opts.force) {
    held.count = 0;
  } else {
    held.count -= 1;
    if (held.count > 0) return false; // still held by another caller
  }

  HELD_LOCKS.delete(sessionFile);
  try { await held.handle.close(); } catch { /* best effort */ }
  try { await fs.rm(held.lockPath, { force: true }); } catch { /* best effort */ }
  return true;
}

/** Synchronous release for process exit when async isn't reliable. */
function releaseAllLocksSync(): void {
  for (const [sessionFile, held] of HELD_LOCKS) {
    try { held.handle.close().catch(() => {}); } catch { /* ignore */ }
    try { fsSync.rmSync(held.lockPath, { force: true }); } catch { /* ignore */ }
    HELD_LOCKS.delete(sessionFile);
  }
}

// --- Watchdog ---

/**
 * Periodic check: force-release any lock held beyond maxHoldMs.
 * Prevents hung operations from permanently locking a session file.
 */
async function runWatchdogCheck(nowMs = Date.now()): Promise<number> {
  let released = 0;
  for (const [sessionFile, held] of HELD_LOCKS.entries()) {
    if (nowMs - held.acquiredAt > held.maxHoldMs) {
      const didRelease = await releaseHeldLock(sessionFile, held, { force: true });
      if (didRelease) released++;
    }
  }
  return released;
}

function startWatchdog(intervalMs = DEFAULT_WATCHDOG_INTERVAL_MS): void {
  const timer = setInterval(() => { runWatchdogCheck().catch(() => {}); }, intervalMs);
  timer.unref?.(); // Don't keep process alive
}

// --- Signal Handlers ---

function registerCleanupHandlers(): void {
  process.on("exit", releaseAllLocksSync);

  for (const signal of ["SIGINT", "SIGTERM", "SIGQUIT", "SIGABRT"] as const) {
    try {
      process.on(signal, () => {
        releaseAllLocksSync();
        // Re-raise if we're the only listener
        if (process.listenerCount(signal) === 1) {
          process.kill(process.pid, signal);
        }
      });
    } catch { /* unsupported signal on this platform */ }
  }

  startWatchdog();
}

// --- Lock Acquisition ---

/**
 * Acquire an exclusive write lock on a session file.
 *
 * Strategy:
 *   1. If already held by this process (reentrant) → increment ref count
 *   2. Try to create lock file with O_EXCL (atomic create-or-fail)
 *   3. On EEXIST: inspect existing lock for staleness
 *   4. If stale (dead PID, recycled PID, too old) → remove and retry
 *   5. If not stale → backoff and retry until timeout
 *   6. Lock payload includes PID + starttime for recycling detection
 */
async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  allowReentrant?: boolean;
}): Promise<{ release: () => Promise<void> }> {
  registerCleanupHandlers();

  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? DEFAULT_STALE_MS;
  const maxHoldMs = params.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const sessionFile = path.resolve(params.sessionFile);
  const lockPath = `${sessionFile}.lock`;

  // Reentrant: already held by this process
  const allowReentrant = params.allowReentrant ?? true;
  const held = HELD_LOCKS.get(sessionFile);
  if (allowReentrant && held) {
    held.count++;
    return { release: async () => { await releaseHeldLock(sessionFile, held); } };
  }

  // Acquire with retry
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt++;
    let handle: fs.FileHandle | null = null;

    try {
      // O_EXCL: fail if file exists (atomic contention check)
      handle = await fs.open(lockPath, "wx");

      // Write lock payload with PID and start time
      const starttime = getProcessStartTime(process.pid);
      const payload: LockFilePayload = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        ...(starttime !== null ? { starttime } : {}),
      };
      await handle.writeFile(JSON.stringify(payload, null, 2), "utf8");

      const newHeld: HeldLock = { count: 1, handle, lockPath, acquiredAt: Date.now(), maxHoldMs };
      HELD_LOCKS.set(sessionFile, newHeld);

      return { release: async () => { await releaseHeldLock(sessionFile, newHeld); } };
    } catch (err: any) {
      // Cleanup on failed initialization
      if (handle) {
        try { await handle.close(); } catch { /* ignore */ }
        try { await fs.rm(lockPath, { force: true }); } catch { /* ignore */ }
      }

      if (err.code !== "EEXIST") throw err;

      // Lock file exists — inspect for staleness
      const payload = await readLockPayload(lockPath);
      const inspection = inspectLockPayload(payload, staleMs, Date.now());

      if (inspection.stale) {
        // Stale lock: remove and retry immediately
        await fs.rm(lockPath, { force: true });
        continue;
      }

      // Not stale: backoff and retry
      const delay = Math.min(1000, 50 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`session file locked (timeout ${timeoutMs}ms): ${lockPath}`);
}

async function readLockPayload(lockPath: string): Promise<LockFilePayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Usage Example ---

/*
// Acquire lock before modifying session file:
const lock = await acquireSessionWriteLock({
  sessionFile: "/data/sessions/agent-main.jsonl",
  timeoutMs: 10_000,
  maxHoldMs: 5 * 60_000,
});

try {
  // Safe to read-modify-write the session file
  await appendToSession(sessionFile, newMessages);
} finally {
  await lock.release();
}

// Reentrant: nested operations on same session auto-share the lock:
const outer = await acquireSessionWriteLock({ sessionFile });
const inner = await acquireSessionWriteLock({ sessionFile }); // increments ref count
await inner.release(); // decrements ref count, lock still held
await outer.release(); // ref count → 0, lock file removed

// Stale lock recovery: if process dies without cleanup, the next acquirer
// detects the dead PID (or recycled PID) and auto-removes the lock file.
// PID recycling example:
//   Lock file says pid=12345, starttime=98765
//   PID 12345 is alive but getProcessStartTime(12345) = 11111 (different process)
//   → staleReasons = ["recycled-pid"] → lock reclaimed
*/
