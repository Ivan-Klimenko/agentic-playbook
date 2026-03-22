"""
NemoClaw Blueprint Orchestrator

Cross-language orchestration via structured stdout protocol. The Python
blueprint runner communicates plan/apply/status/rollback actions to the
Node.js CLI wrapper through parseable stdout lines, avoiding IPC complexity
while keeping the orchestrator independently testable.

Source: nemoclaw-blueprint/orchestrator/runner.py
"""

# --- Structured Output Protocol ---
# The Node.js wrapper parses stdout for these prefixed lines:
#   PROGRESS:<0-100>:<label>  — progress updates for the UI
#   RUN_ID:<id>               — run identifier for tracking/rollback


def progress(pct: int, label: str) -> None:
    """Emit a progress update that the host CLI can parse and display."""
    print(f"PROGRESS:{pct}:{label}", flush=True)


def emit_run_id() -> str:
    """Generate and emit a unique run identifier."""
    import uuid
    from datetime import UTC, datetime

    rid = f"nc-{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    print(f"RUN_ID:{rid}", flush=True)
    return rid


# --- Plan/Apply Pattern ---
# Plans are structured dicts that describe what will happen.
# Apply executes the plan via sequential openshell CLI calls.


def action_plan(
    profile: str,
    blueprint: dict,
    *,
    dry_run: bool = False,
    endpoint_url: str | None = None,
) -> dict:
    """Validate inputs, resolve profile, produce a plan dict."""
    rid = emit_run_id()
    progress(10, "Validating blueprint")

    inference_profiles = blueprint.get("components", {}).get("inference", {}).get("profiles", {})
    if profile not in inference_profiles:
        raise ValueError(f"Profile '{profile}' not found. Available: {', '.join(inference_profiles)}")

    progress(20, "Checking prerequisites")
    # ... openshell availability check omitted ...

    inference_cfg = inference_profiles[profile]
    if endpoint_url:
        inference_cfg = {**inference_cfg, "endpoint": endpoint_url}  # Override without mutating original

    plan = {
        "run_id": rid,
        "profile": profile,
        "sandbox": {
            "image": blueprint.get("components", {}).get("sandbox", {}).get("image", "openclaw"),
            "name": blueprint.get("components", {}).get("sandbox", {}).get("name", "openclaw"),
        },
        "inference": {
            "provider_type": inference_cfg.get("provider_type"),
            "provider_name": inference_cfg.get("provider_name"),
            "endpoint": inference_cfg.get("endpoint"),
            "model": inference_cfg.get("model"),
            "credential_env": inference_cfg.get("credential_env"),
        },
        "dry_run": dry_run,
    }

    progress(100, "Plan complete")
    return plan


def action_apply(profile: str, blueprint: dict, endpoint_url: str | None = None) -> None:
    """Execute the plan: create sandbox, configure provider, set inference route."""
    import json
    import os
    import subprocess
    from datetime import UTC, datetime
    from pathlib import Path

    rid = emit_run_id()

    # Step 1: Create sandbox — tolerates "already exists"
    progress(20, "Creating OpenClaw sandbox")
    result = subprocess.run(
        ["openshell", "sandbox", "create", "--from", "openclaw", "--name", "openclaw"],
        check=False, capture_output=True, text=True,
    )
    if result.returncode != 0 and "already exists" not in (result.stderr or ""):
        raise RuntimeError(f"Failed to create sandbox: {result.stderr}")

    # Step 2: Configure provider — credential resolved from env, never hardcoded
    progress(50, "Configuring inference provider")
    credential_env = blueprint.get("components", {}).get("inference", {}).get("profiles", {}).get(profile, {}).get("credential_env")
    credential = os.environ.get(credential_env, "") if credential_env else ""
    # ... openshell provider create ...

    # Step 3: Set inference route
    progress(70, "Setting inference route")
    # ... openshell inference set ...

    # Step 4: Persist run state for rollback
    progress(85, "Saving run state")
    state_dir = Path.home() / ".nemoclaw" / "state" / "runs" / rid
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "plan.json").write_text(json.dumps({
        "run_id": rid, "profile": profile, "timestamp": datetime.now(UTC).isoformat(),
    }, indent=2))

    progress(100, "Apply complete")


# --- Rollback ---
# Rollback uses persisted run state to find and destroy the sandbox.
# A "rolled_back" marker prevents double-rollback.


def action_rollback(rid: str) -> None:
    """Stop and remove the sandbox associated with a specific run."""
    import json
    import subprocess
    from datetime import UTC, datetime
    from pathlib import Path

    state_dir = Path.home() / ".nemoclaw" / "state" / "runs" / rid
    plan = json.loads((state_dir / "plan.json").read_text())
    sandbox_name = plan.get("sandbox_name", "openclaw")

    progress(30, f"Stopping sandbox {sandbox_name}")
    subprocess.run(["openshell", "sandbox", "stop", sandbox_name], check=False, capture_output=True, text=True)

    progress(60, f"Removing sandbox {sandbox_name}")
    subprocess.run(["openshell", "sandbox", "remove", sandbox_name], check=False, capture_output=True, text=True)

    # Marker file prevents re-rollback
    (state_dir / "rolled_back").write_text(datetime.now(UTC).isoformat())
    progress(100, "Rollback complete")
