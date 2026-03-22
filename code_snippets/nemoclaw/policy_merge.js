/**
 * NemoClaw Policy Preset Merge
 *
 * Hot-applies network policy presets by merging YAML entries into the
 * sandbox's active policy. Demonstrates: path traversal prevention in
 * preset loading, YAML-level merge (not template rendering), and
 * registry-tracked application state.
 *
 * Source: bin/lib/policies.js
 */

const fs = require("fs");
const path = require("path");
const { shellQuote } = require("./runner");
const registry = require("./registry");

const PRESETS_DIR = "/path/to/nemoclaw-blueprint/policies/presets";

// --- Path Traversal Guard ---
// Preset names are user-provided; resolve and validate against the presets directory.

function loadPreset(name) {
  const file = path.resolve(PRESETS_DIR, `${name}.yaml`);
  // Guard: resolved path must still be under PRESETS_DIR
  if (!file.startsWith(PRESETS_DIR + path.sep) && file !== PRESETS_DIR) {
    throw new Error(`Invalid preset name: ${name}`);
  }
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf-8");
}

// --- YAML Merge ---
// Extracts network_policies entries from a preset and merges them into
// the sandbox's current policy at the YAML level. Not a simple concat —
// inserts before the next top-level key to maintain valid YAML structure.

function extractPresetEntries(presetContent) {
  const match = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  return match ? match[1].trimEnd() : null;
}

function mergePresetIntoPolicy(currentPolicy, presetEntries) {
  if (!currentPolicy) {
    return "version: 1\n\nnetwork_policies:\n" + presetEntries;
  }

  if (!currentPolicy.includes("network_policies:")) {
    if (!currentPolicy.includes("version:")) {
      currentPolicy = "version: 1\n" + currentPolicy;
    }
    return currentPolicy + "\n\nnetwork_policies:\n" + presetEntries;
  }

  // Insert preset entries into existing network_policies section
  const lines = currentPolicy.split("\n");
  const result = [];
  let inNetworkPolicies = false;
  let inserted = false;

  for (const line of lines) {
    const isTopLevel = /^\S.*:/.test(line);

    if (line.trim().startsWith("network_policies:")) {
      inNetworkPolicies = true;
      result.push(line);
      continue;
    }

    // Insert before the next top-level key after network_policies
    if (inNetworkPolicies && isTopLevel && !inserted) {
      result.push(presetEntries);
      inserted = true;
      inNetworkPolicies = false;
    }

    result.push(line);
  }

  // If network_policies was the last section, append at end
  if (inNetworkPolicies && !inserted) {
    result.push(presetEntries);
  }

  return result.join("\n");
}

// --- Apply with RFC 1123 Validation ---
// WSL can truncate hyphenated names during argument parsing
// (e.g., "my-assistant" → "m"), so validate before applying.

function applyPreset(sandboxName, presetName) {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sandboxName) || sandboxName.length > 63) {
    throw new Error(`Invalid or truncated sandbox name: '${sandboxName}'`);
  }

  const presetContent = loadPreset(presetName);
  if (!presetContent) throw new Error(`Preset not found: ${presetName}`);

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) throw new Error(`No network_policies in preset: ${presetName}`);

  // Get current policy from sandbox, merge, write temp file, apply
  // ... openshell policy get → merge → openshell policy set ...

  // Track applied presets in registry for UI display
  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = sandbox.policies || [];
    if (!pols.includes(presetName)) pols.push(presetName);
    registry.updateSandbox(sandboxName, { policies: pols });
  }
}
