"""
Claude Code — PreToolUse Hook Pattern

Hooks intercept tool calls before execution for validation, transformation,
or blocking. This is the canonical pattern: read stdin JSON, validate against
rules, write stdout JSON with permission decision. Exit codes control
visibility: 0=ok, 1=show stderr to user only, 2=block and show to Claude.

Source: examples/hooks/bash_command_validator_example.py,
        plugins/hookify/hooks/pretooluse.py
"""

import json
import re
import sys
from typing import List, Tuple

# --- Validation Rules ---
# Each rule is a (regex_pattern, message) tuple.
# Applied to the command string for Bash tool calls.

VALIDATION_RULES: List[Tuple[str, str]] = [
    (
        r"^grep\b(?!.*\|)",
        "Use 'rg' (ripgrep) instead of 'grep' for better performance",
    ),
    (
        r"^find\s+\S+\s+-name\b",
        "Use 'rg --files -g pattern' instead of 'find -name'",
    ),
    (
        r"rm\s+-rf\s+/(?!tmp)",
        "Dangerous rm -rf outside /tmp — review carefully",
    ),
]


def validate_command(command: str) -> list[str]:
    """Check command against all validation rules."""
    return [msg for pattern, msg in VALIDATION_RULES if re.search(pattern, command)]


def main():
    """Hook entry point — read stdin, validate, write stdout/stderr."""
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        # Exit 1: show error to user, but don't show to Claude
        print(f"Invalid JSON input: {e}", file=sys.stderr)
        sys.exit(1)

    tool_name = input_data.get("tool_name", "")
    if tool_name != "Bash":
        sys.exit(0)  # Not our tool — allow

    command = input_data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    issues = validate_command(command)
    if issues:
        for msg in issues:
            print(f"• {msg}", file=sys.stderr)
        # Exit 2: block the tool call AND show stderr to Claude
        # (so Claude can adjust its approach)
        sys.exit(2)

    # Exit 0: allow the tool call
    sys.exit(0)


# --- Hook I/O Protocol ---
#
# INPUT (stdin JSON):
# {
#   "tool_name": "Bash",
#   "tool_input": { "command": "grep -r TODO ." },
#   "hook_event_name": "PreToolUse",
#   "transcript_path": "/tmp/claude-transcript-xxx.jsonl"
# }
#
# OUTPUT (stdout JSON, for more complex hooks):
# {
#   "hookSpecificOutput": {
#     "hookEventName": "PreToolUse",
#     "permissionDecision": "allow" | "deny" | "ask"
#   },
#   "systemMessage": "Optional message injected into Claude's context",
#   "updatedInput": { "command": "rg -r TODO ." }  // Can modify tool input!
# }
#
# EXIT CODES:
# 0 — Allow (or stdout JSON decides)
# 1 — Show stderr to user only (informational)
# 2 — Block tool call + show stderr to Claude (so it can adapt)
#
# HOOK TYPES in hooks.json:
# "command" — runs a script (this pattern)
# "prompt"  — LLM evaluates: Claude itself decides allow/deny based on prompt


if __name__ == "__main__":
    main()
