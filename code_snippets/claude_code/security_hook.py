"""
Claude Code — Session-Scoped Security Warning Hook

PreToolUse hook that pattern-matches file edits against 9 security anti-patterns
(command injection, eval, XSS, pickle, etc.) and blocks on first detection per
file-rule pair. Uses show-once semantics with session-scoped state files and
probabilistic cleanup of stale state files.

Source: plugins/security-guidance/hooks/security_reminder_hook.py
"""

import json
import os
import random
import sys
from datetime import datetime


# --- Security Pattern Configuration ---
# Each pattern has either a path_check (for file type matching)
# or substrings (for content matching in new code being written).

SECURITY_PATTERNS = [
    {
        "ruleName": "github_actions_workflow",
        # Path-based: triggers for ANY edit to workflow files
        "path_check": lambda path: ".github/workflows/" in path
            and (path.endswith(".yml") or path.endswith(".yaml")),
        "reminder": "You are editing a GitHub Actions workflow. "
                    "Never use untrusted input directly in run: commands...",
    },
    {
        "ruleName": "child_process_exec",
        # Content-based: scan new code for dangerous function calls
        "substrings": ["child_process.exec", "exec(", "execSync("],
        "reminder": "⚠️ child_process.exec() → command injection risk. "
                    "Use execFile() instead...",
    },
    {
        "ruleName": "eval_injection",
        "substrings": ["eval("],
        "reminder": "⚠️ eval() executes arbitrary code...",
    },
    {
        "ruleName": "react_dangerously_set_html",
        "substrings": ["dangerouslySetInnerHTML"],
        "reminder": "⚠️ dangerouslySetInnerHTML → XSS risk...",
    },
    # ... additional patterns: innerHTML, document.write, pickle, os.system, new Function
]


# --- Session-Scoped State (Show-Once Semantics) ---
# Each {file_path}-{rule_name} pair is tracked per session.
# A warning is shown at most once per unique combination.

def get_state_file(session_id: str) -> str:
    return os.path.expanduser(f"~/.claude/security_warnings_state_{session_id}.json")


def load_state(session_id: str) -> set:
    path = get_state_file(session_id)
    if os.path.exists(path):
        try:
            with open(path) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, IOError):
            return set()
    return set()


def save_state(session_id: str, shown: set):
    path = get_state_file(session_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(list(shown), f)


# --- Probabilistic Cleanup ---
# 10% chance per hook run to clean state files >30 days old.
# Avoids accumulation of stale files without dedicated cron.

def maybe_cleanup():
    if random.random() >= 0.1:
        return
    state_dir = os.path.expanduser("~/.claude")
    cutoff = datetime.now().timestamp() - (30 * 24 * 60 * 60)
    for f in os.listdir(state_dir):
        if f.startswith("security_warnings_state_") and f.endswith(".json"):
            path = os.path.join(state_dir, f)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except (OSError, IOError):
                pass


# --- Tool Input Normalization ---
# Different tools structure their edit content differently.

def extract_content(tool_name: str, tool_input: dict) -> str:
    if tool_name == "Write":
        return tool_input.get("content", "")
    elif tool_name == "Edit":
        return tool_input.get("new_string", "")
    elif tool_name == "MultiEdit":
        return " ".join(e.get("new_string", "") for e in tool_input.get("edits", []))
    return ""


def check_patterns(file_path: str, content: str):
    """Match file path or content against security patterns."""
    normalized_path = file_path.lstrip("/")
    for p in SECURITY_PATTERNS:
        if "path_check" in p and p["path_check"](normalized_path):
            return p["ruleName"], p["reminder"]
        if "substrings" in p and content:
            for sub in p["substrings"]:
                if sub in content:
                    return p["ruleName"], p["reminder"]
    return None, None


# --- Hook Entry Point ---
# Exit codes:
#   0 = allow tool call
#   2 = BLOCK tool call + show stderr to Claude (so it adjusts)

def main():
    # Environment toggle
    if os.environ.get("ENABLE_SECURITY_REMINDER", "1") == "0":
        sys.exit(0)

    maybe_cleanup()

    try:
        input_data = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        sys.exit(0)  # Can't parse input → allow (fail-safe)

    session_id = input_data.get("session_id", "default")
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {})

    if tool_name not in ("Edit", "Write", "MultiEdit"):
        sys.exit(0)

    file_path = tool_input.get("file_path", "")
    if not file_path:
        sys.exit(0)

    content = extract_content(tool_name, tool_input)
    rule_name, reminder = check_patterns(file_path, content)

    if rule_name and reminder:
        # Unique key per file-rule combination
        warning_key = f"{file_path}-{rule_name}"
        shown = load_state(session_id)

        if warning_key not in shown:
            shown.add(warning_key)
            save_state(session_id, shown)
            # Block on FIRST detection, stderr goes to Claude
            print(reminder, file=sys.stderr)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()

# --- Pattern Summary ---
#
# SHOW-ONCE SEMANTICS: Security warnings fire exactly once per
# {file, rule} pair per session. This avoids warning fatigue while
# ensuring the agent sees the warning at least once.
#
# BLOCKING ON FIRST HIT: Exit code 2 blocks the tool call and shows
# the warning to Claude. Claude then adjusts (uses safer alternative).
# Subsequent edits to the same file for the same rule are allowed.
#
# PROBABILISTIC CLEANUP: Rather than a cron job or explicit lifecycle,
# state files are cleaned up stochastically. 10% chance per run ×
# many runs per day = reliable cleanup without infrastructure.
#
# ENVIRONMENT TOGGLE: ENABLE_SECURITY_REMINDER=0 disables entirely.
# Useful for CI/CD or when the user has their own security tooling.
