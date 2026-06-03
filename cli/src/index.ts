import { Command } from "commander";
import { VERSION } from "./version";
import { configureOutput } from "./output";
import { registerTunnelCommands } from "./commands/tunnel";
import { registerAccountCommands } from "./commands/account";
import { registerResourceCommands } from "./commands/resources";
import { registerSystemCommands } from "./commands/system";

const program = new Command();

program
  .name("kproxy")
  .description("Expose local services to the internet via a secure reverse proxy (HTTP + TCP tunnels)")
  .version(VERSION, "-v, --version", "show the version")
  .showHelpAfterError("(add --help for usage)");

registerTunnelCommands(program);
registerAccountCommands(program);
registerResourceCommands(program);
registerSystemCommands(program);

// Cross-cutting flags (context + output) are attached to every leaf command so they
// can be passed naturally AFTER the command, e.g. `kproxy doctor --json`. Commander
// scopes options to where they're declared, so we inject them once here.
function injectCommonOptions(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (sub.commands.length > 0) {
      injectCommonOptions(sub);
      continue;
    }
    const existing = new Set(sub.options.map((o) => o.long));
    const add = (flags: string, desc: string) => {
      const long = flags.match(/--[a-z-]+/)?.[0];
      if (long && !existing.has(long)) sub.option(flags, desc);
    };
    add("--server <url>", "kproxy server URL");
    add("--auth <key>", "API key");
    add("--org <id>", "organization id");
    add("--json", "output machine-readable JSON");
    add("-q, --quiet", "suppress non-essential output");
    add("--verbose", "verbose output");
    add("--no-color", "disable colored output");
  }
}
injectCommonOptions(program);

// Apply output options before the selected command runs.
program.hook("preAction", (_thisCommand, actionCommand) => {
  const o = actionCommand.optsWithGlobals() as {
    json?: boolean; quiet?: boolean; verbose?: boolean; color?: boolean;
  };
  configureOutput({ json: o.json, quiet: o.quiet, verbose: o.verbose, color: o.color });
});

program.addHelpText(
  "after",
  [
    "",
    "Examples:",
    "  $ kproxy http 3000                 Expose localhost:3000 over HTTPS",
    "  $ kproxy http 8080 --inspect       …with a local request inspector (localhost:4040)",
    "  $ kproxy tcp 22 --domain ssh       Expose SSH over a raw TCP tunnel",
    "  $ kproxy login                     Authenticate this CLI",
    "  $ kproxy list                      List your active tunnels",
    "  $ kproxy domain register example.com --email you@example.com",
    "",
    "Environment: KPROXY_SERVER, KPROXY_AUTH, KPROXY_ORG (legacy JROK_* still honored)",
    "",
  ].join("\n"),
);

async function main(): Promise<void> {
  if (process.argv.length <= 2) {
    program.help();
  }
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
