/**
 * Tool Result Sanitization & Semantic Summarization
 *
 * Pattern: Strip verbose/untrusted details from tool results before
 * the LLM sees them, and provide semantic summaries for shell commands.
 * From: OpenClaw src/agents/compaction.ts, src/agents/tool-display-common.ts
 *
 * Key ideas:
 *   - Tool results carry a `details` field for UI/audit that is NOT sent to the LLM
 *   - Shell commands get human-readable semantic summaries
 *   - Values are coerced with max length/count limits
 *   - Immutable operation — returns original array if no changes needed
 */

// ─── Types ─────────────────────────────────────────────────────────────────

interface ToolResultMessage {
  role: "toolResult";
  toolName: string;
  content: string;
  details?: Record<string, unknown>; // Verbose payload for UI/audit
}

interface AgentMessage {
  role: "user" | "assistant" | "toolResult";
  [key: string]: unknown;
}

// ─── Details Stripping ─────────────────────────────────────────────────────

/**
 * Strip the `details` field from tool results before sending to LLM.
 *
 * SECURITY: toolResult.details can contain:
 * - Untrusted payloads from external APIs
 * - Verbose debug output (terminal escape sequences, binary data)
 * - Sensitive metadata not meant for LLM consumption
 *
 * The LLM gets the clean `content` string only.
 * The `details` field is preserved in the session transcript for UI display and audit.
 */
export function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (
      !msg ||
      typeof msg !== "object" ||
      msg.role !== "toolResult" ||
      !("details" in msg)
    ) {
      out.push(msg);
      continue;
    }

    // Destructure to remove `details`, keep everything else
    const { details: _details, ...rest } = msg;
    touched = true;
    out.push(rest as AgentMessage);
  }

  return touched ? out : messages;
}

// ─── Semantic Command Summarization ────────────────────────────────────────

/**
 * Provide human-readable summaries for common shell commands.
 * The LLM understands "check git status" better than parsing verbose git output.
 *
 * This is used for tool call *display labels* — what the user and LLM see
 * as the action description, not the full output.
 */

function extractBinaryName(command: string): string {
  // Handle paths: /usr/bin/git → git, ./node_modules/.bin/jest → jest
  const parts = command.split("/");
  return parts[parts.length - 1] ?? command;
}

function extractOptionValue(
  words: string[],
  flags: string[],
): string | undefined {
  for (let i = 0; i < words.length - 1; i++) {
    if (flags.includes(words[i]!)) {
      return words[i + 1];
    }
  }
  return undefined;
}

const GIT_SUBCOMMAND_MAP: Record<string, string> = {
  status: "check git status",
  diff: "check git diff",
  log: "view git history",
  show: "show git object",
  branch: "manage git branches",
  checkout: "switch git branch",
  switch: "switch git branch",
  add: "stage files",
  commit: "create git commit",
  push: "push to remote",
  pull: "pull from remote",
  fetch: "fetch from remote",
  merge: "merge branches",
  rebase: "rebase branch",
  stash: "stash changes",
  clone: "clone repository",
  init: "initialize git repo",
  tag: "manage git tags",
  remote: "manage git remotes",
  reset: "reset git state",
  clean: "clean working directory",
  blame: "show file blame",
};

const NPM_SUBCOMMAND_MAP: Record<string, string> = {
  install: "install dependencies",
  i: "install dependencies",
  ci: "clean install dependencies",
  run: "run npm script",
  test: "run tests",
  build: "build project",
  start: "start application",
  publish: "publish package",
  init: "initialize package",
  audit: "audit dependencies",
};

export function summarizeCommand(commandLine: string): string {
  const words = commandLine.trim().split(/\s+/);
  if (words.length === 0) return "run command";

  const bin = extractBinaryName(words[0] ?? "");

  // Git commands
  if (bin === "git") {
    const cwd = extractOptionValue(words, ["-C"]);
    const subcommand = words.find((w, i) => i > 0 && !w.startsWith("-"));
    const summary = subcommand ? GIT_SUBCOMMAND_MAP[subcommand] : undefined;
    const base = summary ?? `git ${subcommand ?? "command"}`;
    return cwd ? `${base} (in ${cwd})` : base;
  }

  // NPM/pnpm/yarn commands
  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    const subcommand = words[1];
    if (subcommand === "run" && words[2]) {
      return `run ${bin} script "${words[2]}"`;
    }
    const summary = subcommand ? NPM_SUBCOMMAND_MAP[subcommand] : undefined;
    return summary ?? `${bin} ${subcommand ?? "command"}`;
  }

  // Python
  if (bin === "python" || bin === "python3") {
    const script = words.find((w, i) => i > 0 && !w.startsWith("-"));
    return script ? `run python ${script}` : "run python";
  }

  // Docker
  if (bin === "docker") {
    const subcommand = words[1];
    return `docker ${subcommand ?? "command"}`;
  }

  // Common tools
  const SIMPLE_SUMMARIES: Record<string, string> = {
    ls: "list files",
    cat: "read file",
    grep: "search for pattern",
    find: "find files",
    mkdir: "create directory",
    rm: "remove files",
    cp: "copy files",
    mv: "move files",
    curl: "make HTTP request",
    wget: "download file",
    make: "run make",
    cargo: "run cargo",
    go: "run go",
    rustc: "compile rust",
    gcc: "compile C",
  };

  return SIMPLE_SUMMARIES[bin] ?? `run ${bin}`;
}

// ─── Value Coercion for Tool Result Display ────────────────────────────────

const MAX_STRING_CHARS = 160;
const MAX_ARRAY_ENTRIES = 3;

/**
 * Coerce tool result values for display — truncate long strings,
 * limit array entries, summarize nested objects.
 */
export function coerceDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (typeof value === "string") {
    if (value.length <= MAX_STRING_CHARS) return value;
    return value.slice(0, MAX_STRING_CHARS) + `… (${value.length} chars)`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_ENTRIES) {
      return `[${value.map(coerceDisplayValue).join(", ")}]`;
    }
    const shown = value.slice(0, MAX_ARRAY_ENTRIES).map(coerceDisplayValue);
    return `[${shown.join(", ")}, … +${value.length - MAX_ARRAY_ENTRIES} more]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    if (keys.length <= 3) {
      return `{${keys.join(", ")}}`;
    }
    return `{${keys.slice(0, 3).join(", ")}, … +${keys.length - 3} more}`;
  }

  return String(value);
}

// ─── Usage Example ─────────────────────────────────────────────────────────

/*
// Before sending messages to LLM — strip verbose details:
const messages: AgentMessage[] = [
  {
    role: "toolResult",
    toolName: "exec",
    content: "Exit code: 0\nOn branch main\nnothing to commit",
    details: {
      exitCode: 0,
      rawOutput: "... 500 lines of terminal output with escape sequences ...",
      duration: 1234,
      pid: 12345,
    },
  },
];

const cleaned = stripToolResultDetails(messages);
// Result: LLM sees only `content`, not the verbose `details`

// Semantic command summaries:
summarizeCommand("git diff --staged")        // → "check git diff"
summarizeCommand("npm run build")            // → "run npm script "build""
summarizeCommand("python3 train.py --epochs 10") // → "run python train.py"
summarizeCommand("docker compose up -d")     // → "docker compose"
summarizeCommand("grep -r TODO src/")        // → "search for pattern"

// Value coercion for display:
coerceDisplayValue("short string")           // → "short string"
coerceDisplayValue("a".repeat(200))          // → "aaa...aaa… (200 chars)"
coerceDisplayValue([1, 2, 3, 4, 5])          // → "[1, 2, 3, … +2 more]"
coerceDisplayValue({ a: 1, b: 2, c: 3, d: 4, e: 5 })  // → "{a, b, c, … +2 more}"
*/
