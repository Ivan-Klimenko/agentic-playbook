# NemoClaw: Sandboxed Agent Deployment Orchestrator

A deep-dive into the architecture of NemoClaw — NVIDIA's open-source reference stack for running OpenClaw AI agents inside OpenShell sandboxes with declarative security policies (~5K LOC JS/TS + Python).

---

## 1. Architecture & Agent Topology

**Topology:** Infrastructure orchestrator for agents (not an agent itself). Layered plugin + blueprint + sandbox architecture.

NemoClaw is **not** an agentic system — it's the deployment and security orchestration layer that creates isolated environments for agents (OpenClaw) to run inside. The interesting agentic patterns come from how it manages lifecycle, state, policy, and migration for sandboxed agent instances.

```
Host (nemoclaw CLI — Node.js)
  │
  ├── Plugin Layer (TypeScript, runs inside sandbox OpenClaw process)
  │     ├── /nemoclaw slash command
  │     ├── Inference provider registration
  │     └── State reporting
  │
  ├── Blueprint Orchestrator (Python, called via subprocess)
  │     ├── Plan: validate profile, resolve inference config
  │     ├── Apply: create sandbox, set provider, route inference
  │     ├── Status: report run state
  │     └── Rollback: stop + remove sandbox
  │
  └── OpenShell Gateway (k3s cluster in Docker)
        └── Sandbox Pod (Landlock + seccomp + network namespace)
              └── OpenClaw Agent (with NemoClaw plugin)
```

**Key architecture decisions:**
- **Thin plugin, versioned blueprint** — plugin is stable and minimal; blueprint carries orchestration logic and can be independently versioned/released
- **Subprocess delegation** — CLI (Node.js) invokes Python blueprint runner via subprocess with structured stdout protocol (`PROGRESS:pct:label`, `RUN_ID:id`)
- **Multi-sandbox via registry** — `~/.nemoclaw/sandboxes.json` tracks named sandboxes independently; each is a separate k3s pod
- **No cross-sandbox communication** — sandboxes are fully isolated; only the host orchestrator can manage multiple instances

**Communication patterns:**
- CLI → Blueprint: subprocess with structured stdout protocol
- CLI → OpenShell: `openshell` CLI commands (execFileSync/spawnSync)
- Plugin → OpenClaw: plugin SDK API (registerCommand, registerProvider)
- Host → Sandbox: SSH via `openshell sandbox connect`

---

## 2. Thinking & Reasoning

**Not applicable** — NemoClaw follows deterministic orchestration, not LLM-driven reasoning.

The blueprint runner executes a fixed sequence: validate → create → configure → route → persist. There is no LLM call, no reasoning loop, no self-reflection. This is intentional — the orchestrator should be predictable and auditable.

The **agent** inside the sandbox (OpenClaw) has its own reasoning loop, but NemoClaw has no visibility or control over it. NemoClaw only controls the environment and inference routing.

---

## 3. Planning & Execution

### Plan Schema

The blueprint runner produces a structured plan before execution:

```python
plan = {
    "run_id": "nc-20260322-235959-a1b2c3d4",
    "profile": "default",
    "sandbox": {
        "image": "ghcr.io/nvidia/.../openclaw:latest",
        "name": "openclaw",
        "forward_ports": [18789]
    },
    "inference": {
        "provider_type": "nvidia",
        "provider_name": "nvidia-inference",
        "endpoint": "https://integrate.api.nvidia.com/v1",
        "model": "nvidia/nemotron-3-super-120b-a12b",
        "credential_env": "NVIDIA_API_KEY"
    },
    "policy_additions": {},
    "dry_run": false
}
```

### Execution Pipeline (Onboarding — 7 Steps)

The core user-facing flow is the onboard wizard in `bin/lib/onboard.js`:

```
Step 1: Preflight    — Docker, OpenShell CLI, port availability, GPU detection
Step 2: Gateway      — Destroy stale, create fresh, CoreDNS patch, health poll
Step 3: Sandbox      — Build Docker image, push to k3s, create pod, wait for Ready
Step 4: NIM          — Detect local inference (Ollama/vLLM), select provider + model
Step 5: Inference    — Register provider with OpenShell, set model route
Step 6: OpenClaw     — Write NemoClaw config into sandbox via SSH
Step 7: Policies     — Auto-detect tokens → suggest presets, apply YAML policy
```

**Re-planning:** Not supported. Failures exit immediately; operator must retry manually. Rollback is available via `runner.py action_rollback <run_id>` but doesn't re-plan.

**Completion verification:** Sandbox readiness is polled via `openshell sandbox list` with ANSI stripping and exact name matching. 30 attempts × 2s delay = 60s timeout.

---

## 4. Context Management

### Three-Layer Context Isolation

1. **Host context** — CLI process, `~/.nemoclaw/` state directory, Docker socket
2. **Gateway context** — k3s cluster, blueprint orchestrator, provider configs
3. **Sandbox context** — OpenClaw agent, Landlock-enforced filesystem, network namespace

### Filesystem Isolation (Declarative Policy)

```yaml
filesystem_policy:
  read_only:
    - /usr, /lib, /proc, /etc, /app
    - /sandbox/.openclaw              # Immutable gateway config (prevents token tampering)
  read_write:
    - /sandbox                        # Agent workspace
    - /tmp
    - /sandbox/.openclaw-data         # Writable state (symlinked from .openclaw)
```

**Split read-only/read-write for `.openclaw`:** The gateway config (auth tokens, CORS) is mounted read-only to prevent the agent from tampering. Mutable agent state (plugins, workspace) lives in `.openclaw-data` and is symlinked in.

### Migration State & Snapshots

The most sophisticated context management pattern is in `migration-state.ts`: capturing the host OpenClaw state for migration into a sandbox. This involves:

- **External root tracking** — workspaces, agent dirs, skills dirs that live outside `~/.openclaw`
- **Snapshot bundling** — copy state + external roots + config into a timestamped bundle
- **Config path rewriting** — rewrite config paths to point to sandbox mount points
- **Symlink preservation** — detect and log symlinks for migration safety
- **Security validation (C-4)** — validate all restore paths are within trusted home directory

---

## 5. Tool System

NemoClaw doesn't have a tool system in the agentic sense. Instead:

### CLI Command Dispatch

```javascript
// bin/nemoclaw.js — two-tier dispatch
const GLOBAL_COMMANDS = new Set([
  "onboard", "list", "deploy", "setup", "start", "stop", "status", "debug", "uninstall"
]);

// Global commands: nemoclaw <command>
if (GLOBAL_COMMANDS.has(cmd)) { /* dispatch to handler */ }

// Sandbox-scoped: nemoclaw <sandbox-name> <action>
const sandbox = registry.getSandbox(cmd);
if (sandbox) { /* dispatch to sandbox action */ }
```

### Plugin SDK Surface

The plugin exposes a minimal API to the OpenClaw host:

- **1 slash command** — `/nemoclaw` (status, eject, onboard subcommands)
- **1 inference provider** — model routing through OpenShell gateway
- **0 background services** — services (Telegram, cloudflared) run on host, not inside sandbox

### Policy Presets as "Tools"

Network policy presets function as the closest analogue to a tool system — they're discoverable modules that extend sandbox capabilities:

```
9 presets: discord, docker, huggingface, jira, npm, outlook, pypi, slack, telegram
```

Each preset is a YAML file defining allowed network endpoints. Presets are merged into the sandbox's active policy via YAML manipulation (not template rendering — direct AST-level merge).

---

## 6. Flow Control & Error Handling

### Core Loop (Onboarding)

```
preflight() → startGateway() → createSandbox() → setupNim()
  → setupInference() → setupOpenclaw() → setupPolicies() → printDashboard()
```

Linear pipeline, no retry loop. Each step can fail and exit the process.

### Error Handling Patterns

| Pattern | Implementation |
|---------|---------------|
| Stale gateway cleanup | Detect via `hasStaleGateway()`, destroy before port check |
| Sandbox readiness poll | 30 × 2s attempts with ANSI-stripped exact name matching |
| Orphan cleanup | If sandbox created but never reaches Ready, delete it before exiting |
| Port conflict detection | `lsof` parsing with process identification and remediation hints |
| Command failure | `run()` exits on non-zero unless `{ ignoreError: true }` |
| Non-interactive fallback | All prompts accept env var overrides via `promptOrDefault()` |

### Security Regression Guards

Enforced via dedicated test suites:

- **C-2: Dockerfile injection** — Tests prove that `ARG → python3 -c` string interpolation allows code execution via single-quote; fixed pattern uses `os.environ` (data path, not code path)
- **C-4: Manifest traversal** — `restoreSnapshotToHost()` validates all paths are within trusted home directory before writing, using `isWithinRoot()` not manifest-provided paths
- **Shell quoting** — All sandbox names pass through `shellQuote()` (single-quote wrapping with escape); `validateName()` enforces RFC 1123 labels
- **No execSync in CLI** — Regression guard ensures main CLI uses `execFileSync` (no shell) or `spawnSync` (explicit bash -c)

---

## 7. User Interruption & Interference

### Permission Gates

- **Sandbox destroy** — confirmation prompt unless `--yes` or `--force` flag
- **Policy application** — user confirms preset selection before applying
- **Credential prompts** — readline-based; falls back to `/dev/tty` when stdin is piped

### Non-Interactive Mode

Full CI/CD automation via `--non-interactive` flag or `NEMOCLAW_NON_INTERACTIVE=1`:

```javascript
async function promptOrDefault(question, envVar, defaultValue) {
  if (isNonInteractive()) {
    const val = envVar ? process.env[envVar] : null;
    return val || defaultValue;
  }
  return prompt(question);
}
```

Every decision point has an env var override:
- `NEMOCLAW_PROVIDER` — cloud/ollama/vllm/nim
- `NEMOCLAW_MODEL` — model ID
- `NEMOCLAW_SANDBOX_NAME` — sandbox name
- `NEMOCLAW_POLICY_MODE` — suggested/custom/skip
- `NEMOCLAW_POLICY_PRESETS` — comma-separated preset names

### Cancellation

- Ctrl+C propagates to child processes via bash signal forwarding
- No soft shutdown or graceful cancellation token
- Stale state from interrupted runs detected and cleaned up on next onboard

---

## 8. State & Persistence

### State Tiers

**Tier 1: Sandbox Registry** (`~/.nemoclaw/sandboxes.json`, mode 0600)

```javascript
{
  sandboxes: {
    "my-assistant": {
      name: "my-assistant",
      createdAt: "2026-03-22T...",
      model: "nvidia/nemotron-3-super-120b-a12b",
      nimContainer: null,
      provider: "nvidia-nim",
      gpuEnabled: false,
      policies: ["pypi", "npm"]
    }
  },
  defaultSandbox: "my-assistant"
}
```

**Tier 2: Plugin State** (`~/.nemoclaw/state/nemoclaw.json`)

```javascript
{
  lastRunId: "nc-20260322-...",
  lastAction: "apply",
  blueprintVersion: "0.1.0",
  sandboxName: "my-assistant",
  migrationSnapshot: null,
  hostBackupPath: null,
  createdAt: "2026-03-22T...",
  updatedAt: "2026-03-22T..."
}
```

**Tier 3: Credentials** (`~/.nemoclaw/credentials.json`, mode 0600)

```javascript
{
  NVIDIA_API_KEY: "nvapi-...",
  GITHUB_TOKEN: "ghp_...",
  TELEGRAM_BOT_TOKEN: "...",
}
```

**Tier 4: Run History** (`~/.nemoclaw/state/runs/<run_id>/plan.json`)

Each blueprint execution persists its plan as JSON for auditing and potential rollback.

**Tier 5: Migration Snapshots** (`~/.nemoclaw/snapshots/<timestamp>/`)

Immutable captures of host OpenClaw state with manifest, external roots, and sandbox-rewritten config.

### State Mutability Model

- **Immutable**: blueprint.yaml, policy.yaml inside sandbox, snapshots after creation
- **Mutable**: registry (add/remove sandboxes), credentials (prompted on demand), plugin state (updated per action)
- **Hot-reloadable**: network policies (applied via `openshell policy set` without sandbox restart)

---

## Key Patterns & Takeaways

### Pattern 1: Subprocess Protocol for Cross-Language Orchestration

The blueprint runner communicates via structured stdout lines (`PROGRESS:pct:label`, `RUN_ID:id`) parsed by the Node.js wrapper. This avoids IPC complexity while keeping the Python orchestrator independently testable.

### Pattern 2: Declarative Policy as Security Boundary

Network and filesystem access are defined in YAML, not enforced in application code. The sandbox kernel (Landlock + seccomp) enforces policies at the OS level. Agent code never sees the enforcement layer.

### Pattern 3: Registry-Driven Multi-Instance Management

A single JSON file tracks all sandboxes. Default sandbox is auto-selected; removal cascades the default to the next available. No database, no server — pure file-based state with 0600 permissions.

### Pattern 4: Snapshot-Based State Migration with Security Validation

Host state (config, workspace, extensions, skills) is captured into immutable snapshots with external root tracking. Restoration validates all write targets against the trusted home directory (C-4 guard), rejecting attacker-controlled paths from the snapshot manifest.

### Pattern 5: Non-Interactive Mode as First-Class Citizen

Every interactive prompt has an env var override. CI/CD can run the full onboard pipeline without any TTY. Provider, model, sandbox name, and policy presets are all configurable via environment.

### Pattern 6: Split Read-Only/Read-Write Sandbox Filesystem

The agent's configuration directory is mounted read-only (prevents token tampering), while a separate writable directory handles mutable state via symlinks. This prevents prompt injection from modifying auth credentials.

---

## Gaps & Limitations

1. **No error recovery loop** — Failures require manual intervention; no automatic retry or re-planning
2. **No plan reuse** — Plans are generated and applied immediately; `plan_path` parameter is stubbed but unimplemented
3. **No checkpointing** — Onboarding is all-or-nothing; partial failures require starting over
4. **No cross-sandbox communication** — Each sandbox is fully isolated; no agent-to-agent messaging
5. **No graceful shutdown** — Ctrl+C kills processes; no cancellation token propagation
6. **Limited observability** — Progress is coarse (7 steps); no per-substep telemetry

---

## File Reference

| File | Purpose |
|------|---------|
| `bin/nemoclaw.js` | Main CLI dispatcher — global + sandbox-scoped commands |
| `bin/lib/runner.js` | Subprocess execution, shell quoting, name validation |
| `bin/lib/registry.js` | Multi-sandbox JSON registry at `~/.nemoclaw/sandboxes.json` |
| `bin/lib/onboard.js` | 7-step onboarding wizard with non-interactive mode |
| `bin/lib/policies.js` | Policy preset loading, YAML merge, application |
| `bin/lib/credentials.js` | Credential prompt and secure storage |
| `bin/lib/platform.js` | OS/runtime detection (WSL, Colima, Docker) |
| `bin/lib/nim.js` | NVIDIA NIM model catalog and container lifecycle |
| `bin/lib/preflight.js` | Port availability detection via lsof/net probe |
| `nemoclaw/src/index.ts` | Plugin entry — command + provider registration |
| `nemoclaw/src/commands/slash.ts` | `/nemoclaw` slash command handler |
| `nemoclaw/src/commands/migration-state.ts` | Host state snapshot/restore with security validation |
| `nemoclaw/src/blueprint/state.ts` | Plugin state persistence |
| `nemoclaw-blueprint/orchestrator/runner.py` | Python blueprint runner (plan/apply/status/rollback) |
| `nemoclaw-blueprint/blueprint.yaml` | Blueprint definition (profiles, components, policy) |
| `nemoclaw-blueprint/policies/openclaw-sandbox.yaml` | Default sandbox policy (Landlock + network rules) |
