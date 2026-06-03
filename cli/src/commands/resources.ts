import type { Command } from "commander";
import { loadConfig, saveConfig, type CliContext } from "../config";
import { out, table } from "../output";
import { apiFrom, fail, handleError } from "./shared";

function requireOrg(ctx: CliContext): string {
  if (!ctx.organizationId) {
    fail("No organization selected. Pass --org <id>, or set a default with `kproxy org use <id>`.");
  }
  return ctx.organizationId;
}

const id = (o: { id?: string; _id?: string }): string => o.id ?? o._id ?? "";

export function registerResourceCommands(program: Command): void {
  // ---- tunnels ----
  program
    .command("list")
    .alias("ls")
    .description("List your active tunnels")
    .action(async (_o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.listTunnels();
        const tunnels = resp.tunnels ?? (Array.isArray(resp) ? resp : []);
        out.result({ tunnels }, () => {
          if (!tunnels.length) return out.info("No active tunnels.");
          table(
            ["DOMAIN", "PROTOCOL", "TCP PORT", "ACTIVE"],
            tunnels.map((t) => [t.domain ?? "", t.protocol ?? "http", t.tcpPort ? String(t.tcpPort) : "-", t.active ? "yes" : "no"]),
            [32, 10, 10, 8],
          );
        });
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command("disconnect <domain>")
    .alias("rm")
    .description("Disconnect a tunnel by subdomain")
    .action(async (domain: string, _o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        await api.deleteTunnel(domain);
        out.result({ success: true, domain }, () => out.success(`Disconnected ${domain}`));
      } catch (err) {
        handleError(err);
      }
    });

  // ---- organizations ----
  const org = program.command("org").description("Manage organizations");
  org
    .command("list")
    .alias("ls")
    .description("List your organizations")
    .action(async (_o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.listOrganizations();
        const orgs = resp.organizations ?? (Array.isArray(resp) ? resp : []);
        out.result({ organizations: orgs }, () => {
          if (!orgs.length) return out.info("No organizations. Create one with `kproxy org create <name>`.");
          table(["ID", "NAME", "SLUG", "ROLE"], orgs.map((o) => [id(o), o.name, o.slug ?? "", o.role ?? "member"]), [26, 24, 18, 8]);
        });
      } catch (err) {
        handleError(err);
      }
    });
  org
    .command("create <name>")
    .description("Create an organization and set it as default")
    .action(async (name: string, _o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.createOrganization(name);
        const o = resp.organization ?? resp;
        const cfg = loadConfig();
        cfg.organizationId = id(o);
        cfg.organizationName = o.name;
        saveConfig(cfg);
        out.result({ success: true, organization: o }, () => {
          out.success(`Organization created: ${o.name}`);
          out.info(out.colors.dim(`Default org set to ${id(o)}`));
        });
      } catch (err) {
        handleError(err);
      }
    });
  org
    .command("use <id>")
    .description("Set the default organization")
    .action((orgId: string) => {
      const cfg = loadConfig();
      cfg.organizationId = orgId;
      saveConfig(cfg);
      out.result({ success: true, organizationId: orgId }, () => out.success(`Default organization set to ${orgId}`));
    });

  // ---- API keys ----
  const apikey = program.command("apikey").description("Manage API keys");
  apikey
    .command("list")
    .alias("ls")
    .description("List API keys for the active organization")
    .action(async (_o, cmd: Command) => {
      try {
        const { api, ctx } = apiFrom(cmd);
        const orgId = requireOrg(ctx);
        const resp = await api.listApiKeys(orgId);
        const keys = resp.apiKeys ?? (Array.isArray(resp) ? resp : []);
        out.result({ apiKeys: keys }, () => {
          if (!keys.length) return out.info("No API keys. Create one with `kproxy apikey create <name>`.");
          table(["ID", "PREFIX", "NAME", "PERMISSIONS"], keys.map((k) => [id(k), k.keyPrefix ?? "kproxy_…", k.name, (k.permissions ?? []).join(",")]), [26, 14, 20, 24]);
        });
      } catch (err) {
        handleError(err);
      }
    });
  apikey
    .command("create <name>")
    .description("Create an API key")
    .option("--permissions <csv>", "comma-separated permissions", "tunnel:create,tunnels:read,tunnels:delete")
    .action(async (name: string, opts: { permissions: string }, cmd: Command) => {
      try {
        const { api, ctx } = apiFrom(cmd);
        const orgId = requireOrg(ctx);
        const perms = opts.permissions.split(",").map((p) => p.trim()).filter(Boolean);
        const resp = await api.createApiKey(orgId, name, perms);
        const rawKey = resp.rawKey ?? resp.key;
        out.result({ success: true, name, key: rawKey }, () => {
          out.success(`API key created: ${name}`);
          out.warn("Save this key now — it will not be shown again:");
          out.raw(`  ${rawKey}`);
          out.info(out.colors.dim(`Use it: kproxy config --auth ${rawKey}`));
        });
      } catch (err) {
        handleError(err);
      }
    });
  apikey
    .command("revoke <keyId>")
    .description("Revoke an API key")
    .action(async (keyId: string, _o, cmd: Command) => {
      try {
        const { api, ctx } = apiFrom(cmd);
        const orgId = requireOrg(ctx);
        await api.revokeApiKey(orgId, keyId);
        out.result({ success: true, keyId }, () => out.success(`API key revoked: ${keyId}`));
      } catch (err) {
        handleError(err);
      }
    });

  // ---- custom domains ----
  const domain = program.command("domain").description("Manage custom domains");
  domain
    .command("register <domain>")
    .description("Register a custom domain")
    .requiredOption("--email <email>", "contact email")
    .option("--subdomain <name>", "subdomain to map")
    .action(async (domainName: string, opts: { email: string; subdomain?: string }, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.registerDomain(domainName, opts.email, opts.subdomain);
        const d = resp.domain ?? resp;
        out.result({ success: true, domain: d }, () => {
          out.success(`Custom domain registered: ${domainName}`);
          out.info("Next: add a DNS-only (grey-cloud) CNAME record:");
          out.raw(`  ${domainName}  CNAME  ${d.cnameTarget ?? "(see dashboard)"}`);
          out.info(out.colors.dim(`Then run: kproxy domain verify ${domainName}`));
        });
      } catch (err) {
        handleError(err);
      }
    });
  domain
    .command("status <domain>")
    .description("Check CNAME/SSL status for a custom domain")
    .action(async (domainName: string, _o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const data = await api.domainStatus(domainName);
        out.result(data, () => {
          out.info(`Domain:    ${domainName}`);
          out.info(`CNAME →    ${data.cnameTarget ?? "?"}`);
          out.info(`Actual:    ${data.actualCname ?? "(none found)"}`);
          out.info(`Verified:  ${data.verified ? "yes" : "no"}`);
          if (data.sslStatus) out.info(`SSL:       ${data.sslStatus}`);
          if (!data.verified && data.error) out.warn(data.error);
        });
      } catch (err) {
        handleError(err);
      }
    });
  domain
    .command("verify <domain>")
    .description("Verify CNAME and activate the certificate")
    .action(async (domainName: string, _o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.verifyDomain(domainName);
        const d = resp.domain ?? resp;
        out.result({ success: true, domain: d }, () => {
          out.success(`Verified: ${d.domain ?? domainName}`);
          out.info(`Active: ${d.active ? "yes" : "no"} · Synced: ${d.synced ? "yes" : "no"}`);
        });
      } catch (err) {
        handleError(err);
      }
    });
  domain
    .command("list")
    .alias("ls")
    .description("List your custom domains")
    .action(async (_o, cmd: Command) => {
      try {
        const { api } = apiFrom(cmd);
        const resp = await api.listDomains();
        const domains = resp.domains ?? (Array.isArray(resp) ? resp : []);
        out.result({ domains }, () => {
          if (!domains.length) return out.info("No custom domains.");
          table(["DOMAIN", "SSL", "ACTIVE"], domains.map((d) => [d.domain, d.sslStatus ?? "-", d.active ? "yes" : "no"]), [32, 16, 8]);
        });
      } catch (err) {
        handleError(err);
      }
    });
}
