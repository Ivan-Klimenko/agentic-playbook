/**
 * OpenCode Snapshot & Revert System
 *
 * Uses a separate git repository to track filesystem state.
 * Enables per-file revert and full restore after code changes.
 *
 * Source: packages/opencode/src/snapshot/index.ts
 *         packages/opencode/src/session/revert.ts
 */

import { $ } from "bun"
import path from "path"
import fs from "fs/promises"

// ============================================================
// 1. FILESYSTEM SNAPSHOTS VIA GIT
// ============================================================

// Uses a SEPARATE git repo (not the project's .git)
// Location: ~/.opencode/data/snapshot/<project-id>

function gitdir(projectId: string): string {
  return path.join(homedir(), ".opencode/data/snapshot", projectId)
}

/**
 * Track: Captures current filesystem state as a git tree object.
 * Returns a hash that can be used for diffing and reverting.
 * Uses git write-tree (not commit) — O(1) snapshot.
 */
async function track(projectId: string, worktree: string): Promise<string | undefined> {
  const git = gitdir(projectId)

  // Initialize git repo for tracking (first time only)
  if (await mkdirIfNeeded(git)) {
    await $`git init`.env({ GIT_DIR: git, GIT_WORK_TREE: worktree }).quiet().nothrow()
    await $`git --git-dir ${git} config core.autocrlf false`.quiet().nothrow()
    await $`git --git-dir ${git} config core.fsmonitor false`.quiet().nothrow()
  }

  // Stage all files
  await $`git --git-dir ${git} --work-tree ${worktree} add -A`.quiet().cwd(worktree).nothrow()

  // Create tree object (snapshot without commit)
  const hash = await $`git --git-dir ${git} --work-tree ${worktree} write-tree`.quiet().cwd(worktree).nothrow().text()

  return hash.trim() || undefined
}

/**
 * Patch: Get list of changed files between snapshot and current state.
 */
async function patch(
  projectId: string,
  worktree: string,
  hash: string,
): Promise<{ hash: string; files: string[] }> {
  const git = gitdir(projectId)
  await $`git --git-dir ${git} --work-tree ${worktree} add -A`.quiet().cwd(worktree).nothrow()

  const result =
    await $`git --git-dir ${git} --work-tree ${worktree} diff --no-ext-diff --name-only ${hash} -- .`
      .quiet()
      .cwd(worktree)
      .nothrow()

  return {
    hash,
    files: result
      .text()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => path.join(worktree, x)),
  }
}

/**
 * Full diff: Get before/after content for each changed file.
 */
async function diffFull(
  projectId: string,
  worktree: string,
  from: string,
  to: string,
): Promise<FileDiff[]> {
  const git = gitdir(projectId)
  const result: FileDiff[] = []

  // Get change status (added/deleted/modified)
  const statuses =
    await $`git --git-dir ${git} --work-tree ${worktree} diff --name-status --no-renames ${from} ${to} -- .`
      .quiet()
      .cwd(worktree)
      .nothrow()
      .text()

  const statusMap = new Map<string, "added" | "deleted" | "modified">()
  for (const line of statuses.trim().split("\n")) {
    const [code, file] = line.split("\t")
    statusMap.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
  }

  // Get line counts and file content
  for (const line of (
    await $`git --git-dir ${git} --work-tree ${worktree} diff --numstat --no-renames ${from} ${to} -- .`
      .quiet()
      .cwd(worktree)
      .nothrow()
      .text()
  )
    .trim()
    .split("\n")) {
    const [additions, deletions, file] = line.split("\t")
    const isBinary = additions === "-" && deletions === "-"

    const before = isBinary
      ? ""
      : await $`git --git-dir ${git} show ${from}:${file}`.quiet().nothrow().text()
    const after = isBinary
      ? ""
      : await $`git --git-dir ${git} show ${to}:${file}`.quiet().nothrow().text()

    result.push({
      file,
      before,
      after,
      additions: parseInt(additions) || 0,
      deletions: parseInt(deletions) || 0,
      status: statusMap.get(file),
    })
  }

  return result
}

// ============================================================
// 2. REVERT OPERATIONS
// ============================================================

/**
 * Revert specific files to their state at a given snapshot.
 */
async function revertFiles(projectId: string, worktree: string, patches: Array<{ hash: string; files: string[] }>) {
  const git = gitdir(projectId)
  const reverted = new Set<string>()

  for (const item of patches) {
    for (const file of item.files) {
      if (reverted.has(file)) continue

      const result = await $`git --git-dir ${git} --work-tree ${worktree} checkout ${item.hash} -- ${file}`
        .quiet()
        .cwd(worktree)
        .nothrow()

      if (result.exitCode !== 0) {
        // Check if file existed in snapshot
        const relativePath = path.relative(worktree, file)
        const check =
          await $`git --git-dir ${git} ls-tree ${item.hash} -- ${relativePath}`.quiet().cwd(worktree).nothrow()

        if (check.text().trim()) {
          // File existed but checkout failed — keep current version
        } else {
          // File didn't exist in snapshot — delete it (was created after snapshot)
          await fs.unlink(file).catch(() => {})
        }
      }

      reverted.add(file)
    }
  }
}

/**
 * Restore entire filesystem to a snapshot state.
 */
async function restoreFull(projectId: string, worktree: string, snapshot: string) {
  const git = gitdir(projectId)
  // read-tree loads the tree into git index, checkout-index writes files
  await $`git --git-dir ${git} --work-tree ${worktree} read-tree ${snapshot} && git --git-dir ${git} --work-tree ${worktree} checkout-index -a -f`
    .quiet()
    .cwd(worktree)
    .nothrow()
}

// ============================================================
// 3. SESSION REVERT FLOW
// ============================================================

/**
 * Reverts a session to a specific message/part point.
 *
 * Flow:
 * 1. Walk message history, collect PatchParts after revert point
 * 2. Revert files using collected patches
 * 3. Compute diffs for UI display
 * 4. Store revert state on session (enables unrevert)
 */
async function revertSession(input: { sessionID: string; messageID: string; partID?: string }) {
  const messages = await getMessages(input.sessionID)
  const session = await getSession(input.sessionID)
  let revertPoint: { messageID: string; partID?: string } | undefined
  const patches: Array<{ hash: string; files: string[] }> = []

  // Find revert point and collect patches after it
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (revertPoint) {
        // After revert point — collect patches to undo
        if (part.type === "patch") {
          patches.push(part)
        }
        continue
      }

      // Check if this is the revert point
      if (msg.info.id === input.messageID && !input.partID) {
        revertPoint = { messageID: msg.info.id }
      }
      if (part.id === input.partID) {
        revertPoint = { messageID: msg.info.id, partID: input.partID }
      }
    }
  }

  if (!revertPoint) return session

  // Save snapshot for potential unrevert
  const snapshot = session.revert?.snapshot ?? (await track("project-id", "/worktree"))

  // Revert files
  await revertFiles("project-id", "/worktree", patches)

  // Compute diffs for UI
  const diffs = snapshot ? await diffFull("project-id", "/worktree", snapshot, "HEAD") : []

  // Store revert state (enables unrevert later)
  session.revert = {
    ...revertPoint,
    snapshot,
    diff: JSON.stringify(diffs),
  }

  return session
}

/**
 * Unrevert: Restore files to state before revert was applied.
 */
async function unrevertSession(sessionID: string) {
  const session = await getSession(sessionID)
  if (!session.revert?.snapshot) return session

  // Restore to the snapshot taken before revert
  await restoreFull("project-id", "/worktree", session.revert.snapshot)
  session.revert = undefined
  return session
}

/**
 * Cleanup: After next chat, remove reverted messages/parts from DB.
 * Called at the start of each new prompt to finalize the revert.
 */
async function cleanupRevert(session: any) {
  if (!session.revert) return

  const messages = await getMessages(session.id)
  const revertMessageID = session.revert.messageID

  // Remove messages after revert point
  for (const msg of messages) {
    if (msg.info.id > revertMessageID) {
      await deleteMessage(msg.info.id)
    }
  }

  // If reverted at a specific part, remove parts after it
  if (session.revert.partID) {
    const target = messages.find((m: any) => m.info.id === revertMessageID)
    if (target) {
      const partIndex = target.parts.findIndex((p: any) => p.id === session.revert.partID)
      for (const part of target.parts.slice(partIndex)) {
        await deletePart(part.id)
      }
    }
  }

  session.revert = undefined
}

// ============================================================
// 4. GARBAGE COLLECTION
// ============================================================

// Runs hourly via scheduler
async function cleanup(projectId: string, worktree: string) {
  const git = gitdir(projectId)
  // Prune objects older than 7 days
  await $`git --git-dir ${git} --work-tree ${worktree} gc --prune=7.days`.quiet().nothrow()
}

// --- Types ---
interface FileDiff {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

// --- Placeholders ---
function homedir(): string { return "" }
function mkdirIfNeeded(_path: string): Promise<boolean> { return Promise.resolve(false) }
function getMessages(_sessionID: string): Promise<any[]> { return Promise.resolve([]) }
function getSession(_sessionID: string): Promise<any> { return Promise.resolve({}) }
function deleteMessage(_id: string): Promise<void> { return Promise.resolve() }
function deletePart(_id: string): Promise<void> { return Promise.resolve() }
