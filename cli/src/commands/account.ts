import type { Command } from "commander";
import { hostname } from "os";
import { KproxyApi } from "../api";
import { loadConfig, saveConfig, resolveContext, configPaths } from "../config";
import { openUrl } from "../util/open";
import { promptHidden } from "../util/prompt";
import { out, isJson } from "../output";
import { apiFrom, contextFrom, fail, handleError, maskKey } from "./shared";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return "device";
  }
}

type DeviceResult = { token: string } | { unsupported: true } | { timeout: true };

/** Device-authorization flow: open the dashboard, poll until the user approves. */
async function deviceLogin(serverUrl: string): Promise<DeviceResult> {
  const api = new KproxyApi(serverUrl);
  let start;
  try {
    start = await api.cliStart(safeHostname());
  } catch {
    return { unsupported: true }; // older server without the device endpoints
  }

  out.info("To authorize this CLI, open this URL and confirm the code:");
  out.info(out.colors.cyan(`  ${start.verificationUriComplete}`));
  out.info(`  code: ${out.colors.bold(start.userCode)}`);
  openUrl(start.verificationUriComplete);
  out.step("Waiting for approval in your browser…");

  const deadline = Date.now() + start.expiresInSec * 1000;
  const interval = Math.max(2, start.intervalSec) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let r;
    try {
      r = await api.cliPoll(start.deviceCode);
    } catch {
      continue; // transient network error — keep polling
    }
    if (r.status === "approved" && r.apiKey) return { token: r.apiKey };
    if (r.status === "denied") fail("Authorization was denied.");
    if (r.status === "expired") break;
  }
  return { timeout: true };
}

function dashboardUrl(serverUrl: string): string {
  if (process.env.KPROXY_DASHBOARD) return process.env.KPROXY_DASHBOARD;
  try {
    const u = new URL(serverUrl);
    if (/^(api|tunnel)\./.test(u.hostname)) {
      return `https://${u.hostname.replace(/^(api|tunnel)\./, "dash.")}`;
    }
    return serverUrl;
  } catch {
    return serverUrl;
  }
}

export function registerAccountCommands(program: Command): void {
  program
    .command("login")
    .description("Authenticate this CLI via the browser (device authorization)")
    .option("--token <key>", "provide an API key directly (non-interactive)")
    .action(async (_o, cmd: Command) => {
      try {
        const ctx = contextFrom(cmd);
        let token = (cmd.opts() as { token?: string }).token;

        if (!token) {
          const res = await deviceLogin(ctx.serverUrl);
          if ("token" in res) {
            token = res.token;
          } else if ("timeout" in res) {
            fail("Authorization timed out. Run `kproxy login` again, or use `kproxy login --token <key>`.");
          } else {
            // Server doesn't support the device flow — fall back to manual key entry.
            if (isJson()) fail("Device authorization is unavailable on this server. Use `kproxy login --token <key>`.");
            const dash = dashboardUrl(ctx.serverUrl);
            out.warn("Browser authorization unavailable — falling back to manual API key entry.");
            out.info(`Create an API key at: ${out.colors.cyan(dash)}`);
            openUrl(dash);
            token = await promptHidden("Paste your API key: ");
          }
        }
        if (!token) fail("No API key obtained.");

        // Validate by listing the key's organizations.
        const api = new KproxyApi(ctx.serverUrl, token);
        const resp = await api.listOrganizations();
        const orgs = resp.organizations ?? (Array.isArray(resp) ? resp : []);

        const cfg = loadConfig();
        cfg.apiKey = token;
        cfg.serverUrl = ctx.serverUrl;
        if (orgs[0]) {
          cfg.organizationId = orgs[0].id ?? orgs[0]._id;
          cfg.organizationName = orgs[0].name;
        }
        saveConfig(cfg);

        if (isJson()) {
          out.json({ success: true, server: ctx.serverUrl, organization: cfg.organizationName ?? null });
        } else {
          out.success(`Logged in to ${ctx.serverUrl}`);
          if (cfg.organizationName) out.info(out.colors.dim(`Organization: ${cfg.organizationName}`));
        }
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("logout")
    .description("Remove the stored API key")
    .action(() => {
      const cfg = loadConfig();
      delete cfg.apiKey;
      saveConfig(cfg);
      out.result({ success: true }, () => out.success("Logged out (API key removed)."));
    });

  program
    .command("whoami")
    .description("Show the current authentication context")
    .action(async (_o, cmd: Command) => {
      try {
        const { api, ctx } = apiFrom(cmd);
        let email: string | undefined;
        let organization = ctx.organizationName;
        try {
          const me = await api.me();
          email = me?.user?.email ?? me?.email;
          organization = me?.organization?.name ?? organization;
        } catch {
          // /auth/me may not support API-key auth — fall back to org listing.
          const resp = await api.listOrganizations();
          const orgs = resp.organizations ?? (Array.isArray(resp) ? resp : []);
          organization = orgs[0]?.name ?? organization;
        }
        out.result(
          { server: ctx.serverUrl, organization: organization ?? null, email: email ?? null, apiKey: maskKey(ctx.authToken) },
          () => {
            out.info(`Server:       ${ctx.serverUrl}`);
            out.info(`Organization: ${organization ?? "(unknown)"}`);
            if (email) out.info(`User:         ${email}`);
            out.info(`API key:      ${maskKey(ctx.authToken)}`);
          },
        );
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("config")
    .description("Show or set stored CLI configuration")
    .option("--server <url>", "set the default server URL")
    .option("--auth <key>", "set the default API key")
    .option("--org <id>", "set the default organization id")
    .option("--clear", "clear all stored configuration")
    .action((_o, cmd: Command) => {
      const opts = cmd.opts() as { server?: string; auth?: string; org?: string; clear?: boolean };
      const cfg = loadConfig();
      let changed = false;

      if (opts.clear) {
        saveConfig({});
        out.result({ success: true }, () => out.success("Configuration cleared."));
        return;
      }
      if (opts.server) { cfg.serverUrl = opts.server; changed = true; }
      if (opts.auth) { cfg.apiKey = opts.auth; changed = true; }
      if (opts.org) { cfg.organizationId = opts.org; changed = true; }

      if (changed) {
        saveConfig(cfg);
        out.result({ success: true }, () => out.success("Configuration saved."));
        return;
      }

      const ctx = resolveContext({});
      out.result(
        { server: ctx.serverUrl, organizationId: ctx.organizationId ?? null, apiKey: maskKey(ctx.authToken), path: configPaths.file },
        () => {
          out.info(`Server:       ${ctx.serverUrl}`);
          out.info(`Organization: ${ctx.organizationId ?? "(none)"}`);
          out.info(`API key:      ${maskKey(ctx.authToken)}`);
          out.info(out.colors.dim(`Config file:  ${configPaths.file}`));
        },
      );
    });
}
