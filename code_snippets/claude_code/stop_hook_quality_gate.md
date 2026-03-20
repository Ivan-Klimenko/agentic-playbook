/**
 * Claude Code — Stop Hook as Quality Gate
 *
 * Stop hooks prevent the agent from finishing until quality criteria are met.
 * This is a powerful pattern for enforcing workflow discipline: the agent
 * cannot "decide it's done" without passing checks. Works via both
 * prompt-based hooks (LLM evaluates) and command-based hooks (scripts check).
 *
 * Source: plugins/plugin-dev/skills/hook-development/references/patterns.md,
 *         plugins/hookify/hooks/stop.py,
 *         plugins/ralph-wiggum/commands/ralph-loop.md
 */

// --- Pattern 1: Prompt-Based Stop Gate ---
// The LLM itself evaluates whether the agent should be allowed to stop.
// This is the simplest approach — no scripts needed.

```json
{
  "Stop": [
    {
      "hooks": [
        {
          "type": "prompt",
          "prompt": "Review the transcript. If code was modified (Write/Edit tools used), verify that tests were executed. If no tests were run after code changes, block with reason 'Tests must be run after code changes'."
        }
      ]
    }
  ]
}
```

// How it works:
// 1. Agent decides it's done → emits stop signal
// 2. Claude Code fires Stop hook → sends transcript to a separate LLM call
// 3. LLM reads transcript, checks if tests were run
// 4. If not: returns { "decision": "block", "reason": "..." }
// 5. Agent receives block → forced to continue and run tests

// --- Pattern 2: Build Verification ---

```json
{
  "Stop": [
    {
      "hooks": [
        {
          "type": "prompt",
          "prompt": "Check if code was modified. If Write/Edit tools were used, verify the project was built (npm run build, cargo build, etc). If not built, block and request build."
        }
      ]
    }
  ]
}
```

// --- Pattern 3: Script-Based Stop Gate (Hookify) ---
// Declarative rules that check the transcript for specific patterns.

// Rule file: .claude/hookify.require-tests.local.md
```markdown
---
name: require-tests
enabled: true
event: stop
action: block
conditions:
  - field: transcript
    operator: not_contains
    pattern: npm test|pytest|cargo test|go test
---

⚠️ **Tests not detected in session transcript.**

Please run the project's test suite before finishing.
Detected code changes but no test execution.
```

// How this works:
// 1. Stop event fires → hookify stop.py loads rules with event='stop'
// 2. Rule engine reads transcript file from `transcript_path`
// 3. Checks if transcript contains test execution patterns
// 4. If not_contains matches → rule fires → returns block decision

// The response format for Stop hooks:
```json
{
  "decision": "block",
  "reason": "⚠️ **[require-tests]**\nTests not detected...",
  "systemMessage": "⚠️ **[require-tests]**\nTests not detected..."
}
```

// --- Pattern 4: Completion Promise (Ralph Wiggum) ---
// A creative enforcement pattern: the agent can only output a specific
// string when the task is truly complete. The Stop hook feeds the SAME
// prompt back until the promise is fulfilled.

```markdown
CRITICAL RULE: If a completion promise is set, you may ONLY output it
when the statement is completely and unequivocally TRUE. Do not output
false promises to escape the loop, even if you think you're stuck.
The loop is designed to continue until genuine completion.
```

// This creates an "honest completion" constraint:
// - Agent works on task
// - Tries to stop → loop feeds same prompt back
// - Agent sees previous work in files/git history
// - Can only truly stop when completion criteria are met

// --- When to Use Stop Hooks ---
//
// Good uses:
// - Enforce test execution after code changes
// - Require build verification before stopping
// - Check for linting/formatting compliance
// - Verify documentation was updated
// - Ensure commit messages follow conventions
//
// Anti-patterns:
// - Don't use for blocking indefinitely (agent may get stuck)
// - Don't use for subjective quality (use review agents instead)
// - Don't use for things the agent can't fix (e.g., CI failures)
//
// The power of Stop hooks is that they make quality enforcement
// automatic and unavoidable — the agent literally cannot finish
// without meeting the criteria.
