/**
 * NemoClaw Multi-Sandbox Registry
 *
 * File-based registry for tracking multiple named sandbox instances.
 * Pure JSON with 0600 permissions — no database, no server. Default sandbox
 * auto-cascades on removal. Pattern is useful for any CLI tool that manages
 * multiple named resource instances on disk.
 *
 * Source: bin/lib/registry.js
 */

const fs = require("fs");
const path = require("path");

const REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json");

// --- Load/Save with corruption tolerance ---
// Silent fallback to empty state on parse errors — prevents CLI crash
// from corrupted registry blocking all operations.

function load() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
    }
  } catch {} // Corrupt file → treat as empty
  return { sandboxes: {}, defaultSandbox: null };
}

function save(data) {
  const dir = path.dirname(REGISTRY_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// --- CRUD with default cascade ---

function registerSandbox(entry) {
  const data = load();
  data.sandboxes[entry.name] = {
    name: entry.name,
    createdAt: entry.createdAt || new Date().toISOString(),
    model: entry.model || null,
    provider: entry.provider || null,
    gpuEnabled: entry.gpuEnabled || false,
    policies: entry.policies || [],
  };
  // First sandbox becomes default automatically
  if (!data.defaultSandbox) {
    data.defaultSandbox = entry.name;
  }
  save(data);
}

function removeSandbox(name) {
  const data = load();
  if (!data.sandboxes[name]) return false;
  delete data.sandboxes[name];
  // Cascade default to next available sandbox
  if (data.defaultSandbox === name) {
    const remaining = Object.keys(data.sandboxes);
    data.defaultSandbox = remaining.length > 0 ? remaining[0] : null;
  }
  save(data);
  return true;
}

function getDefault() {
  const data = load();
  // Validate that default still exists; fall back to first sandbox
  if (data.defaultSandbox && data.sandboxes[data.defaultSandbox]) {
    return data.defaultSandbox;
  }
  const names = Object.keys(data.sandboxes);
  return names.length > 0 ? names[0] : null;
}
