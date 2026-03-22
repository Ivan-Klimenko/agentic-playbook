/**
 * NemoClaw Snapshot-Based State Migration
 *
 * Captures host agent state (config, workspace, extensions, skills) into
 * immutable snapshots for migration into sandboxed environments. Key pattern:
 * external root tracking with config path rewriting and security validation
 * to prevent path traversal attacks from crafted snapshot manifests.
 *
 * Source: nemoclaw/src/commands/migration-state.ts
 */

// --- Types ---

type MigrationRootKind = "workspace" | "agentDir" | "skillsExtraDir";

interface MigrationExternalRoot {
  id: string;
  kind: MigrationRootKind;
  sourcePath: string;               // Host path (e.g., ~/projects/my-agent)
  snapshotRelativePath: string;      // Path inside snapshot bundle
  sandboxPath: string;               // Rewritten path for sandbox mount
  symlinkPaths: string[];            // Preserved symlinks for migration safety
  bindings: { configPath: string }[]; // Config keys that reference this root
}

interface SnapshotManifest {
  version: number;
  createdAt: string;
  homeDir: string;
  stateDir: string;
  configPath: string | null;
  hasExternalConfig: boolean;
  externalRoots: MigrationExternalRoot[];
  warnings: string[];
}

// --- Security: Path Containment Check (C-4) ---
// All write targets must be within a trusted root directory.
// Uses the HOST's actual home — not manifest.homeDir which is
// attacker-controlled data from the snapshot JSON.

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  const path = require("path");
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// --- Restore with Security Validation ---
// The core safety invariant: never trust paths from the manifest.
// Validate every write target against the actual host home directory.

function restoreSnapshotToHost(snapshotDir: string): boolean {
  const os = require("os");
  const manifest: SnapshotManifest = JSON.parse(
    require("fs").readFileSync(`${snapshotDir}/snapshot.json`, "utf-8")
  );

  // Use the host's ACTUAL home, not the manifest's claimed home
  const trustedRoot = os.homedir();

  // Validate manifest.homeDir is within trusted root
  if (!isWithinRoot(manifest.homeDir, trustedRoot)) {
    throw new Error(
      `Snapshot homeDir outside trusted root: ${manifest.homeDir}`
    );
  }

  // Validate stateDir
  if (!isWithinRoot(manifest.stateDir, trustedRoot)) {
    throw new Error(
      `Snapshot stateDir outside trusted root: ${manifest.stateDir}`
    );
  }

  // Validate external config path if present
  if (manifest.hasExternalConfig && manifest.configPath) {
    if (!isWithinRoot(manifest.configPath, trustedRoot)) {
      throw new Error(
        `Snapshot configPath outside trusted root: ${manifest.configPath}`
      );
    }
  }

  // Archive current state before overwriting (safety net)
  // ... rename current stateDir to .nemoclaw-archived-<timestamp> ...

  // Copy snapshot state to host
  // ... copyDirectory(snapshotDir/openclaw, manifest.stateDir) ...

  return true;
}

// --- Config Path Rewriting ---
// When migrating to sandbox, config paths pointing to host directories
// must be rewritten to sandbox mount points.

function rewriteConfigForSandbox(
  config: Record<string, unknown>,
  externalRoots: MigrationExternalRoot[],
): void {
  for (const root of externalRoots) {
    for (const binding of root.bindings) {
      // e.g., config["agents.list[0].workspace"] = "/sandbox/.nemoclaw/migration/workspaces/..."
      setNestedValue(config, binding.configPath, root.sandboxPath);
    }
  }
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: string): void {
  const tokens = path.match(/[^.[\]]+/g) || [];
  let current: unknown = obj;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const record = current as Record<string, unknown>;
    if (!record[token] || typeof record[token] !== "object") {
      record[token] = /^\d+$/.test(tokens[i + 1]) ? [] : {};
    }
    current = record[token];
  }
  (current as Record<string, unknown>)[tokens[tokens.length - 1]] = value;
}
