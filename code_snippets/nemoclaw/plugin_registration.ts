/**
 * NemoClaw Plugin Registration
 *
 * Minimal plugin pattern for extending an agent runtime (OpenClaw) with
 * infrastructure concerns. Registers exactly one slash command and one
 * inference provider — the thinnest possible surface area. Types are
 * declared as local stubs because the host SDK isn't available at build time.
 *
 * Source: nemoclaw/src/index.ts
 */

// --- Local SDK Type Stubs ---
// The real types come from openclaw/plugin-sdk, available only at runtime
// inside the host process. Declaring minimal stubs keeps the build independent.

interface PluginCommandContext {
  args?: string;
  commandBody: string;
  config: Record<string, unknown>;
}

interface PluginCommandResult {
  text?: string;
}

interface ModelProviderEntry {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutput?: number;
}

interface ProviderPlugin {
  id: string;
  label: string;
  aliases?: string[];
  models?: { chat?: ModelProviderEntry[] };
  auth: { type: string; envVar?: string; headerName?: string; label?: string }[];
}

interface OpenClawPluginApi {
  logger: { info(msg: string): void };
  registerCommand: (cmd: {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    handler: (ctx: PluginCommandContext) => PluginCommandResult | Promise<PluginCommandResult>;
  }) => void;
  registerProvider: (provider: ProviderPlugin) => void;
}

// --- Plugin Entry Point ---
// register() is called once when the host loads the plugin.
// Keep it synchronous and side-effect-free (no network calls, no disk I/O
// beyond reading a local config file).

export default function register(api: OpenClawPluginApi): void {
  // 1. Slash command — minimal chat-accessible status/control surface
  api.registerCommand({
    name: "nemoclaw",
    description: "NemoClaw sandbox management (status, eject).",
    acceptsArgs: true,
    handler: (ctx) => {
      // Route subcommands: /nemoclaw status, /nemoclaw eject, etc.
      const subcommand = (ctx.args || "").trim().split(/\s+/)[0] || "status";
      switch (subcommand) {
        case "status": return { text: "Sandbox is running." };
        case "eject":  return { text: "Eject not yet implemented." };
        default:       return { text: `Unknown subcommand: ${subcommand}` };
      }
    },
  });

  // 2. Inference provider — model routing through the sandbox gateway.
  //    The agent never calls the inference API directly; all requests are
  //    routed through OpenShell, which enforces network policy and credentials.
  api.registerProvider({
    id: "inference",
    label: "Managed Inference Route",
    aliases: ["inference-local", "nemoclaw"],
    models: {
      chat: [
        { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", contextWindow: 131072 },
        { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", label: "Nemotron Ultra 253B", contextWindow: 131072 },
      ],
    },
    auth: [{
      type: "bearer",
      envVar: "NVIDIA_API_KEY",
      headerName: "Authorization",
      label: "NVIDIA API Key",
    }],
  });

  // 3. Banner — confirm registration to operator
  api.logger.info("  NemoClaw registered — inference routed through OpenShell gateway");
}
