import type { Command } from "commander";
import * as net from "net";
import { KproxyApi } from "../api";
import { out } from "../output";
import { contextFrom, handleError, maskKey } from "./shared";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function checkPort(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function registerSystemCommands(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose your environment and connection")
    .option("--port <port>", "also check that a local port is reachable")
    .action(async (opts: { port?: string }, cmd: Command) => {
      try {
        const ctx = contextFrom(cmd);
        const checks: Check[] = [];

        const major = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        checks.push({ name: "Node.js >= 18", ok: major >= 18, detail: `v${process.versions.node}` });

        const api = new KproxyApi(ctx.serverUrl, ctx.authToken);
        try {
          const h = await api.health();
          checks.push({ name: "Server reachable", ok: true, detail: `${ctx.serverUrl}${h.serverId ? ` (node ${h.serverId})` : ""}` });
        } catch (e) {
          checks.push({ name: "Server reachable", ok: false, detail: `${ctx.serverUrl} — ${e instanceof Error ? e.message : String(e)}` });
        }

        if (ctx.authToken) {
          try {
            const resp = await api.listOrganizations();
            const orgs = resp.organizations ?? (Array.isArray(resp) ? resp : []);
            checks.push({ name: "API key valid", ok: true, detail: `${maskKey(ctx.authToken)} · ${orgs.length} org(s)` });
          } catch (e) {
            checks.push({ name: "API key valid", ok: false, detail: e instanceof Error ? e.message : String(e) });
          }
        } else {
          checks.push({ name: "API key present", ok: false, detail: "not set — run `kproxy login`" });
        }

        if (opts.port) {
          const port = parseInt(opts.port, 10);
          const ok = await checkPort("localhost", port);
          checks.push({ name: `Local port ${port}`, ok, detail: ok ? "reachable" : "not listening" });
        }

        const allOk = checks.every((c) => c.ok);
        out.result({ ok: allOk, checks }, () => {
          for (const c of checks) {
            const mark = c.ok ? out.colors.green("✓") : out.colors.red("✗");
            out.raw(`${mark} ${c.name.padEnd(22)} ${out.colors.dim(c.detail)}`);
          }
          out.raw("");
          out.raw(allOk ? out.colors.green("All checks passed.") : out.colors.yellow("Some checks failed (see above)."));
        });
        if (!allOk) process.exitCode = 1;
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("completion <shell>")
    .description("Output a shell completion script (bash|zsh|fish)")
    .action((shell: string) => {
      const commands = "http tcp connect list ls disconnect rm login logout whoami config org apikey domain doctor completion";
      if (shell === "bash") {
        out.raw(`# kproxy bash completion — add to ~/.bashrc:  source <(kproxy completion bash)\n_kproxy(){ COMPREPLY=( $(compgen -W "${commands}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _kproxy kproxy`);
      } else if (shell === "zsh") {
        out.raw(`# kproxy zsh completion — add to ~/.zshrc:  source <(kproxy completion zsh)\n_kproxy(){ compadd ${commands} }\ncompdef _kproxy kproxy`);
      } else if (shell === "fish") {
        out.raw(`# kproxy fish completion — save to ~/.config/fish/completions/kproxy.fish\ncomplete -c kproxy -f -a "${commands}"`);
      } else {
        out.error(`Unsupported shell: ${shell} (use bash, zsh, or fish)`);
        process.exitCode = 1;
      }
    });
}
