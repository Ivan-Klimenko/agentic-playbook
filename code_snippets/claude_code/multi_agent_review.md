/**
 * Claude Code — Multi-Agent Review with Confidence Filtering
 *
 * A recurring pattern across Claude Code plugins: launch multiple
 * specialized agents in parallel, each focusing on a different aspect,
 * then validate findings individually and filter by confidence threshold.
 * This dramatically reduces false positives in automated code review.
 *
 * Source: plugins/code-review/commands/code-review.md,
 *         plugins/pr-review-toolkit/commands/review-pr.md,
 *         plugins/feature-dev/commands/feature-dev.md
 */

// --- Pattern: Parallel Review → Per-Issue Validation → Confidence Filter ---
//
// The key insight: parallel agents find MORE issues (better recall),
// but many are false positives. Validation agents + confidence thresholds
// filter down to high-signal findings (better precision).
//
// This is implemented entirely via markdown command definitions and
// agent orchestration — no code, just prompt engineering.

## Stage 1: Guard Check (cheap model)
// Quick check to avoid unnecessary work.
// Use a haiku agent (cheapest/fastest) to verify:

```markdown
Launch a haiku agent to check if any of the following are true:
- The pull request is closed
- The pull request is a draft
- Claude has already commented on this PR
If any condition is true, stop and do not proceed.
```

## Stage 2: Context Gathering (cheap model)
// Collect relevant project rules before review.

```markdown
Launch a haiku agent to return a list of file paths for all CLAUDE.md files:
- Root CLAUDE.md
- Any CLAUDE.md in directories containing modified files
```

## Stage 3: Parallel Review (mixed models)
// Launch N agents with different focus areas simultaneously.
// Use stronger models (opus) for harder tasks (bug detection).

```markdown
Launch 4 agents in parallel:

  Agent 1+2: CLAUDE.md compliance (sonnet, cheaper)
  - Audit changes against project rules
  - Two agents for redundancy (better recall)

  Agent 3: Bug detection (opus, stronger)
  - Only the diff — no extra context
  - Only significant bugs, ignore nitpicks

  Agent 4: Logic/security issues (opus, stronger)
  - Problems in introduced code only
  - Security issues, incorrect logic
```

## Stage 4: Per-Issue Validation
// Each finding gets its own validation agent.
// This is the key false-positive filter.

```markdown
For EACH issue found in Stage 3:
  Launch a validation subagent to:
  1. Read the actual code
  2. Verify the issue is real (not pre-existing, not a misunderstanding)
  3. Score confidence 0-100

  Use opus for bugs/logic, sonnet for style/compliance.
```

## Stage 5: Confidence Threshold Filter
// Only high-confidence findings survive.

```markdown
Filter out any issues not validated in Stage 4.
Only report issues with confidence ≥ 80.
```

## What Counts as High-Signal (from code-review plugin)

```markdown
FLAG (high-signal):
- Code will fail to compile or parse (syntax, type errors, missing imports)
- Code will definitely produce wrong results (clear logic errors)
- Clear, unambiguous CLAUDE.md violations (quote exact rule broken)

DO NOT FLAG (false positives):
- Pre-existing issues (not introduced in this PR)
- Code style or quality concerns
- Potential issues depending on specific inputs
- Issues a linter will catch
- Issues with lint-ignore comments
- Pedantic nitpicks a senior engineer would skip
```

// --- Agent Confidence Scoring (from pr-review-toolkit) ---

```markdown
## Issue Confidence Scoring

Rate each issue from 0-100:
- 0-25:  Likely false positive or pre-existing
- 26-50: Minor nitpick not explicitly in CLAUDE.md
- 51-75: Valid but low-impact issue
- 76-90: Important issue requiring attention
- 91-100: Critical bug or explicit CLAUDE.md violation

**Only report issues with confidence ≥ 80**
```

// --- Pattern Variations ---

// 1. Feature Development Review (feature-dev plugin)
//    - 3 parallel reviewers: simplicity/DRY, bugs/correctness, conventions
//    - Results presented to user for triage (fix now / fix later / skip)

// 2. PR Review Toolkit (pr-review-toolkit plugin)
//    - 6 specialized agents: comments, tests, errors, types, code, simplify
//    - Sequential or parallel mode (user choice)
//    - Results categorized: Critical / Important / Suggestions / Strengths

// 3. Deduplication Pipeline (dedupe command)
//    - 5 parallel search agents with diverse keywords
//    - Filter agent removes false positives
//    - Pattern: fan-out search → fan-in dedup → filter
