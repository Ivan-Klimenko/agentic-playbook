#!/bin/bash
#
# Claude Code — Self-Referential Loop via Stop Hook
#
# Creates iterative agent loops without external infrastructure by intercepting
# the Stop event and feeding the same prompt back. The agent sees its previous
# work in modified files, creating a self-correcting loop that continues until
# a completion promise is fulfilled or max iterations are reached.
#
# Source: plugins/ralph-wiggum/hooks/stop-hook.sh,
#         plugins/ralph-wiggum/scripts/setup-ralph-loop.sh

set -euo pipefail

# --- State File Schema ---
# .claude/ralph-loop.local.md (markdown with YAML frontmatter):
#
# ---
# active: true
# iteration: 1
# max_iterations: 20          # 0 = unlimited (dangerous!)
# completion_promise: "DONE"  # Exact string match in <promise> tags
# started_at: "2026-03-24T..."
# ---
#
# Build a REST API with full test coverage

HOOK_INPUT=$(cat)
STATE_FILE=".claude/ralph-loop.local.md"

# No state file = no loop active → allow exit
[[ ! -f "$STATE_FILE" ]] && exit 0

# --- Parse YAML Frontmatter ---
FRONTMATTER=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$STATE_FILE")
ITERATION=$(echo "$FRONTMATTER" | grep '^iteration:' | sed 's/iteration: *//')
MAX_ITERATIONS=$(echo "$FRONTMATTER" | grep '^max_iterations:' | sed 's/max_iterations: *//')
COMPLETION_PROMISE=$(echo "$FRONTMATTER" | grep '^completion_promise:' | sed 's/completion_promise: *//' | sed 's/^"\(.*\)"$/\1/')

# --- Numeric Validation (detect corruption) ---
# Strict regex prevents code injection via crafted state files
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]] || [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
    echo "⚠️  State file corrupted — stopping loop" >&2
    rm "$STATE_FILE"
    exit 0  # Always exit 0 (fail-safe — never hang on corrupt state)
fi

# --- Max Iterations Check ---
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
    echo "🛑 Max iterations ($MAX_ITERATIONS) reached."
    rm "$STATE_FILE"
    exit 0  # Allow exit
fi

# --- Completion Promise Detection ---
# Read transcript to check if agent output the magic phrase
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path')
[[ ! -f "$TRANSCRIPT_PATH" ]] && { rm "$STATE_FILE"; exit 0; }

# Extract last assistant message from JSONL transcript
LAST_OUTPUT=$(grep '"role":"assistant"' "$TRANSCRIPT_PATH" | tail -1 | \
    jq -r '.message.content | map(select(.type == "text")) | map(.text) | join("\n")' 2>/dev/null || echo "")

if [[ "$COMPLETION_PROMISE" != "null" ]] && [[ -n "$COMPLETION_PROMISE" ]]; then
    # Extract text from <promise> tags using Perl multiline regex
    # -0777 slurps entire input; s flag makes . match newlines
    # .*? is non-greedy (takes FIRST tag); whitespace normalized
    PROMISE_TEXT=$(echo "$LAST_OUTPUT" | \
        perl -0777 -pe 's/.*?<promise>(.*?)<\/promise>.*/$1/s; s/^\s+|\s+$//g; s/\s+/ /g' 2>/dev/null || echo "")

    # CRITICAL: Use = for LITERAL comparison, not == (which does glob matching)
    # This prevents injection via *, ?, [ characters in the promise text
    if [[ -n "$PROMISE_TEXT" ]] && [[ "$PROMISE_TEXT" = "$COMPLETION_PROMISE" ]]; then
        echo "✅ Completion promise fulfilled: <promise>$COMPLETION_PROMISE</promise>"
        rm "$STATE_FILE"
        exit 0  # Allow exit
    fi
fi

# --- Continue Loop: Feed Same Prompt Back ---
NEXT_ITERATION=$((ITERATION + 1))

# Extract prompt (everything after the closing --- in frontmatter)
# Use i>=2 to handle --- appearing in prompt content itself
PROMPT_TEXT=$(awk '/^---$/{i++; next} i>=2' "$STATE_FILE")

# Atomic state update (temp file + mv for POSIX safety)
TEMP_FILE="${STATE_FILE}.tmp.$$"
sed "s/^iteration: .*/iteration: $NEXT_ITERATION/" "$STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$STATE_FILE"

# --- Hook Response: Block Stop + Re-Feed Prompt ---
# The "reason" field becomes Claude's next prompt
# The "systemMessage" provides iteration context
jq -n \
    --arg prompt "$PROMPT_TEXT" \
    --arg msg "🔄 Ralph iteration $NEXT_ITERATION" \
    '{
        "decision": "block",
        "reason": $prompt,
        "systemMessage": $msg
    }'

exit 0

# --- How the Self-Referential Loop Works ---
#
# 1. User: /ralph-loop "Build a REST API" --completion-promise "DONE" --max-iterations 20
# 2. Setup script creates state file with prompt and config
# 3. Claude works on the task (writes code, runs tests, etc.)
# 4. Claude tries to stop → this Stop hook fires
# 5. Hook reads last assistant message from transcript
# 6. Checks for <promise>DONE</promise> → not found
# 7. Returns { "decision": "block", "reason": "Build a REST API" }
# 8. Claude receives the SAME prompt again
# 9. Claude sees its previous work in modified files → continues from there
# 10. Repeat until promise fulfilled or max iterations reached
#
# KEY INSIGHT: The prompt doesn't change, but CONTEXT changes because
# files were modified in previous iterations. This creates deterministic
# improvement — each iteration sees past work and test failures.
#
# SAFETY:
# - Literal string comparison prevents glob injection
# - Numeric validation detects state file corruption
# - Atomic file operations prevent partial writes
# - Fail-safe: any error → cleanup state and allow exit
# - /cancel-ralph deletes state file to break the loop
