/**
 * Agent Sandbox Security
 *
 * Pattern: Defense-in-depth sandboxing for agent shell execution.
 * From: OpenClaw src/infra/exec-safe-bin-policy.ts, src/agents/sandbox/
 *
 * Key ideas:
 * - Safe-bin profiles: per-command flag allowlists
 * - Path-like token rejection
 * - Docker container hardening (read-only root, network=none, blocked mounts)
 * - Bind mount validation with symlink escape detection
 * - Dangerous config flag detection
 * - Security audit framework
 */

// --- Safe-Bin Profile Types ---

interface SafeBinProfile {
  maxPositional: number;        // Max positional args (0 = stdin-only)
  allowedValueFlags?: string[]; // Flags that take values (--arg, -e)
  deniedFlags?: string[];       // Explicitly blocked flags
}

// --- Safe-Bin Profile Definitions ---

const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> = {
  jq: {
    maxPositional: 1,
    allowedValueFlags: ["--arg", "--argjson", "--argstr"],
    deniedFlags: [
      "--argfile", "--rawfile", "--slurpfile", // File access
      "--from-file", "--library-path", "-L", "-f",
    ],
  },
  grep: {
    maxPositional: 0, // stdin-only
    allowedValueFlags: [
      "--regexp", "--max-count", "--after-context",
      "--before-context", "--context", "-e", "-m", "-A", "-B", "-C",
    ],
    deniedFlags: [
      "--file", "--exclude-from", "--recursive",
      "-f", "-d", "-r", "-R",
    ],
  },
  cut: {
    maxPositional: 0,
    allowedValueFlags: ["--bytes", "--characters", "--fields", "-b", "-c", "-f"],
  },
  sort: {
    maxPositional: 0,
    allowedValueFlags: ["--key", "--field-separator", "--buffer-size", "-k", "-t"],
    deniedFlags: ["--compress-program", "--files0-from", "--output", "-o"],
  },
};

// --- Token Classification ---

type TokenKind = "empty" | "stdin" | "terminator" | "long_flag" | "short_flag" | "positional";

interface ParsedToken {
  kind: TokenKind;
  flag?: string;
  inlineValue?: string;
}

function parseToken(raw: string): ParsedToken {
  if (!raw || raw.trim() === "") return { kind: "empty" };
  if (raw === "-") return { kind: "stdin" };
  if (raw === "--") return { kind: "terminator" };
  if (raw.startsWith("--")) {
    const eqIdx = raw.indexOf("=");
    if (eqIdx >= 0) {
      return {
        kind: "long_flag",
        flag: raw.slice(0, eqIdx),
        inlineValue: raw.slice(eqIdx + 1),
      };
    }
    return { kind: "long_flag", flag: raw };
  }
  if (raw.startsWith("-") && raw.length > 1) {
    return { kind: "short_flag", flag: raw };
  }
  return { kind: "positional" };
}

// --- Path-like token detection ---

function looksLikePath(token: string): boolean {
  if (token.startsWith("/")) return true;
  if (token.startsWith("~/")) return true;
  if (token.startsWith("./")) return true;
  if (token.startsWith("../")) return true;
  if (token.includes("/../")) return true;
  return false;
}

function containsGlob(token: string): boolean {
  return /[*?[\]]/.test(token);
}

// --- Safe-Bin Validation ---

function validateSafeBinArgv(args: string[], profile: SafeBinProfile): boolean {
  const allowedValueFlags = profile.allowedValueFlags ?? [];
  const deniedFlags = profile.deniedFlags ?? [];
  const positionals: string[] = [];

  let i = 0;
  while (i < args.length) {
    const raw = args[i] ?? "";
    const token = parseToken(raw);

    if (token.kind === "empty" || token.kind === "stdin") {
      i += 1;
      continue;
    }

    if (token.kind === "terminator") {
      // Everything after -- is positional
      for (let j = i + 1; j < args.length; j++) {
        const arg = args[j] ?? "";
        if (looksLikePath(arg) || containsGlob(arg)) return false;
        positionals.push(arg);
      }
      break;
    }

    if (token.kind === "long_flag") {
      const flag = token.flag!;
      // Check denied
      if (deniedFlags.includes(flag)) return false;
      // Check if it takes a value
      if (allowedValueFlags.includes(flag)) {
        if (token.inlineValue !== undefined) {
          // --flag=value (inline)
          if (looksLikePath(token.inlineValue)) return false;
        } else {
          // --flag value (next arg)
          i += 1;
          const value = args[i];
          if (value && looksLikePath(value)) return false;
        }
      }
      i += 1;
      continue;
    }

    if (token.kind === "short_flag") {
      const flag = token.flag!;
      if (deniedFlags.includes(flag)) return false;
      if (allowedValueFlags.includes(flag)) {
        // Next arg is the value
        i += 1;
        const value = args[i];
        if (value && looksLikePath(value)) return false;
      }
      i += 1;
      continue;
    }

    // Positional
    if (looksLikePath(raw) || containsGlob(raw)) return false;
    positionals.push(raw);
    i += 1;
  }

  // Check positional count limit
  return positionals.length <= profile.maxPositional;
}

// --- Docker Sandbox Validation ---

const BLOCKED_HOST_PATHS = [
  "/etc", "/private/etc",
  "/proc", "/sys", "/dev",
  "/root", "/boot",
  "/run", "/var/run", "/private/var/run",
  "/var/run/docker.sock",
  "/run/docker.sock",
];

const BLOCKED_NETWORK_MODES = new Set(["host"]);
const BLOCKED_SECCOMP_PROFILES = new Set(["unconfined"]);

interface SandboxConfig {
  image: string;
  readOnlyRoot?: boolean;
  network?: string;
  user?: string;
  binds?: string[];
  seccompProfile?: string;
  memory?: string;
}

function validateBindMount(bind: string): { valid: boolean; reason?: string } {
  const trimmed = bind.trim();
  if (!trimmed) return { valid: true };

  // Extract source path (before first colon)
  const colonIdx = trimmed.indexOf(":");
  const sourcePath = colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;

  // Check against blocked paths
  for (const blocked of BLOCKED_HOST_PATHS) {
    if (sourcePath === blocked || sourcePath.startsWith(blocked + "/")) {
      return { valid: false, reason: `Blocked host path: ${blocked}` };
    }
  }

  // Check for path traversal
  if (sourcePath.includes("/../") || sourcePath.endsWith("/..")) {
    return { valid: false, reason: "Path traversal detected" };
  }

  // Check for double slashes (potential normalization issues)
  if (sourcePath.includes("//")) {
    return { valid: false, reason: "Suspicious double-slash in path" };
  }

  return { valid: true };
}

function validateSandboxConfig(config: SandboxConfig): string[] {
  const errors: string[] = [];

  // Network mode
  if (config.network && BLOCKED_NETWORK_MODES.has(config.network.toLowerCase())) {
    errors.push(
      `Network mode "${config.network}" blocked: bypasses container isolation. Use "bridge" or "none".`,
    );
  }

  // Seccomp
  if (config.seccompProfile && BLOCKED_SECCOMP_PROFILES.has(config.seccompProfile.toLowerCase())) {
    errors.push(
      `Seccomp profile "${config.seccompProfile}" blocked: removes syscall filtering.`,
    );
  }

  // Bind mounts
  if (config.binds) {
    for (const bind of config.binds) {
      const result = validateBindMount(bind);
      if (!result.valid) {
        errors.push(`Bind mount "${bind}" blocked: ${result.reason}`);
      }
    }
  }

  return errors;
}

// --- Dangerous Config Flag Detection ---

interface AppConfig {
  gateway?: {
    controlUi?: {
      allowInsecureAuth?: boolean;
      dangerouslyDisableDeviceAuth?: boolean;
    };
  };
  tools?: {
    exec?: {
      applyPatch?: { workspaceOnly?: boolean };
    };
  };
}

function collectDangerousFlags(config: AppConfig): string[] {
  const flags: string[] = [];

  if (config.gateway?.controlUi?.allowInsecureAuth === true) {
    flags.push("gateway.controlUi.allowInsecureAuth=true");
  }
  if (config.gateway?.controlUi?.dangerouslyDisableDeviceAuth === true) {
    flags.push("gateway.controlUi.dangerouslyDisableDeviceAuth=true");
  }
  if (config.tools?.exec?.applyPatch?.workspaceOnly === false) {
    flags.push("tools.exec.applyPatch.workspaceOnly=false");
  }

  return flags;
}

// --- Security Audit Framework ---

type Severity = "info" | "warn" | "critical";

interface AuditFinding {
  checkId: string;
  severity: Severity;
  title: string;
  detail: string;
  remediation?: string;
}

interface AuditReport {
  timestamp: number;
  summary: { critical: number; warn: number; info: number };
  findings: AuditFinding[];
}

function runSecurityAudit(config: AppConfig): AuditReport {
  const findings: AuditFinding[] = [];

  // Check dangerous flags
  const dangerousFlags = collectDangerousFlags(config);
  if (dangerousFlags.length > 0) {
    findings.push({
      checkId: "config.dangerous_flags",
      severity: "warn",
      title: "Dangerous config flags enabled",
      detail: `Detected ${dangerousFlags.length} flag(s): ${dangerousFlags.join(", ")}`,
      remediation: "Disable these flags for production deployments.",
    });
  }

  // Check workspace-only mode
  if (config.tools?.exec?.applyPatch?.workspaceOnly === false) {
    findings.push({
      checkId: "config.patch_workspace_only",
      severity: "critical",
      title: "Patch application not restricted to workspace",
      detail: "apply_patch can write to any path on the filesystem.",
      remediation: "Set tools.exec.applyPatch.workspaceOnly to true.",
    });
  }

  // Count by severity
  const summary = { critical: 0, warn: 0, info: 0 };
  for (const f of findings) {
    summary[f.severity] += 1;
  }

  return { timestamp: Date.now(), summary, findings };
}

// --- Usage examples ---

/*
// Safe-bin validation:
const valid = validateSafeBinArgv(
  ["--regexp", "pattern", "-m", "10"],
  SAFE_BIN_PROFILES.grep,
);
// valid === true (allowed flags, no positional args)

const invalid = validateSafeBinArgv(
  ["-r", "/etc/passwd"],
  SAFE_BIN_PROFILES.grep,
);
// invalid === false (-r is denied, /etc/passwd is a path)

// Docker sandbox validation:
const errors = validateSandboxConfig({
  image: "node:22",
  readOnlyRoot: true,
  network: "none",
  binds: ["/home/user/workspace:/workspace:rw"],
});
// errors === [] (all valid)

const badErrors = validateSandboxConfig({
  image: "node:22",
  network: "host",
  binds: ["/var/run/docker.sock:/var/run/docker.sock"],
  seccompProfile: "unconfined",
});
// badErrors = [
//   "Network mode 'host' blocked...",
//   "Bind mount blocked: Blocked host path: /var/run/docker.sock",
//   "Seccomp profile 'unconfined' blocked...",
// ]

// Security audit:
const report = runSecurityAudit({
  gateway: { controlUi: { dangerouslyDisableDeviceAuth: true } },
  tools: { exec: { applyPatch: { workspaceOnly: false } } },
});
// report.summary = { critical: 1, warn: 1, info: 0 }
*/
