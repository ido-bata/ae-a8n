/**
 * `ae-a8n agent`: the in-session Windows agent, started from the installed
 * package.
 *
 * It exists so a host needs no clone. `npm install -g @ido-bata/ae-a8n` (or
 * `npx --package @ido-bata/ae-a8n ae-a8n agent ...`) puts this entry on the
 * host; `scripts/windows-agent.mjs` remains as a checkout-only alias and is
 * not part of the published surface.
 *
 * The agent refuses to start outside an interactive session: a process started
 * from SSH or a service has session 0 and no desktop, and treating it as
 * GUI-capable would be a lie the rest of the pipeline would build on.
 */

import { AGENT_OPTIONS, HIDDEN_FLAG, LOG_FLAG, detachAgent } from "../platform/windows/agent-detach.js";
import { main as runAgentMain } from "../platform/windows/agent-main.js";

export const AGENT_HELP = [
  "Usage: ae-a8n agent --channel <dir> --key-file <file> --host <name> --user <name>",
  "                       [--agent-id <id>] [--session-id <n>] [--version <v>]",
  "                       [--hidden] [--log <file>]",
  "",
  "Runs the in-session agent on the target host. It claims one job at a time",
  "from the channel, verifies the agent's own interactive session, runs the",
  "job, and publishes one signed result. It writes a signed heartbeat so the",
  "controller can see it is alive, interactive and the agent the target names.",
  "",
  "Options:",
  "  --channel <dir>    The channel root both sides can read and write",
  "  --key-file <file>  The shared channel key; never printed or sent anywhere",
  "  --agent-id <id>    Defaults to ae-a8n",
  "  --host <name>      The host name the controller verifies",
  "  --user <name>      The account the agent must be running as",
  "  --session-id <n>   Defaults to the measured interactive session",
  "  --version <v>      Defaults to this package's version",
  "  --hidden           Start a hidden, detached copy and return; no console",
  "                     window is created. The agent must still run in the",
  "                     signed-in session, so use this from a logon entry or",
  "                     a shortcut, not from a service.",
  "  --log <file>       With --hidden, where the agent's output goes",
  "                     (default: %LOCALAPPDATA%\\ae-a8n\\logs\\agent.log)",
  "  --help, -h         Show this help",
  "",
  "Stop it with Ctrl+C or SIGTERM. It never starts or quits After Effects by",
  "itself, and it never reads a credential.",
].join("\n");

/** The flag names the agent accepts; anything else is a usage error. */
const AGENT_FLAGS = AGENT_OPTIONS;

/** Every agent flag but `--hidden` is followed by its value. */
const VALUE_FLAGS = new Set([...AGENT_OPTIONS].filter((flag) => flag !== HIDDEN_FLAG));

/**
 * The first token that is not an agent flag, or null.
 *
 * Values are skipped, not inspected. They are paths and names — a channel
 * root, a key file, a host — and a check that read every token as a flag
 * rejected the documented command with "unknown option <path>" before the
 * agent ever saw it. The flags themselves are still checked here so a usage
 * error is reported without the agent starting.
 */
export function unknownAgentOption(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!AGENT_FLAGS.has(token)) {
      return token;
    }
    if (VALUE_FLAGS.has(token)) {
      index += 1;
    }
  }
  return null;
}

export type AgentCommandResult = { readonly exitCode: number };

export async function runAgentCommand(
  argv: readonly string[],
): Promise<AgentCommandResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${AGENT_HELP}\n`);
    return { exitCode: 0 };
  }
  const unknown = unknownAgentOption(argv);
  if (unknown !== null) {
    process.stderr.write(`ae-a8n agent: unknown option ${unknown}; run "ae-a8n agent --help"\n`);
    return { exitCode: 2 };
  }
  if (argv.includes(HIDDEN_FLAG) || argv.includes(LOG_FLAG)) {
    return { exitCode: detachAgent(argv) };
  }
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => controller.abort());
  }
  const exitCode = await runAgentMain(argv, { signal: controller.signal });
  return { exitCode };
}
