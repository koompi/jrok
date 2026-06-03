import * as cliAuthService from "../services/cliAuthService";
import * as authService from "../services/authService";
import * as apiKeyService from "../services/apiKeyService";
import type { ApiKeyPermission } from "../types/index";
import { checkGlobalRateLimit, getClientIp } from "../utils/rateLimiter";

// Permissions granted to a CLI device key (tunnel + read access; no destructive admin).
const CLI_PERMISSIONS: ApiKeyPermission[] = [
  "tunnel:create",
  "tunnels:read",
  "tunnels:delete",
  "domains:read",
  "domains:write",
  "agents:read",
];

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

/** POST /auth/cli/start — begin a device-authorization handshake. Public. */
export async function handleCliStart(req: Request): Promise<Response> {
  const limit = checkGlobalRateLimit(getClientIp(req));
  if (limit) return json({ success: false, message: "Rate limit exceeded" }, 429);

  const body = (await req.json().catch(() => ({}))) as { label?: string };
  const dashboard = process.env.DASHBOARD_URL || "http://localhost:5173";
  const session = cliAuthService.start(typeof body.label === "string" ? body.label : undefined);
  const verificationUri = `${dashboard.replace(/\/$/, "")}/cli`;

  return json({
    success: true,
    deviceCode: session.deviceCode,
    userCode: session.userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(session.userCode)}`,
    intervalSec: session.intervalSec,
    expiresInSec: session.expiresInSec,
  });
}

/** POST /auth/cli/poll — CLI polls for approval. Public. */
export async function handleCliPoll(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { deviceCode?: string };
  if (!body.deviceCode || typeof body.deviceCode !== "string") {
    return json({ success: false, message: "deviceCode is required" }, 400);
  }
  const result = cliAuthService.poll(body.deviceCode);
  return json({ success: true, ...result });
}

/**
 * POST /auth/cli/approve — the signed-in dashboard user approves a device.
 * Mints a CLI API key in the approver's organization and binds it to the device.
 */
export async function handleCliApprove(req: Request): Promise<Response> {
  const auth = await authService.authenticateRequest(req);
  if (!auth) return json({ success: false, message: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as { userCode?: string };
  if (!body.userCode || typeof body.userCode !== "string") {
    return json({ success: false, message: "userCode is required" }, 400);
  }

  const orgId = auth.organization?.id;
  const userId = auth.user?.id;
  if (!orgId || !userId) {
    return json({ success: false, message: "An organization context is required to authorize the CLI." }, 403);
  }

  // Validate the code BEFORE minting a key (avoids orphaned keys on a bad code).
  const pending = cliAuthService.peek(body.userCode);
  if (!pending) return json({ success: false, message: "Invalid or expired code" }, 400);

  const name = `CLI — ${pending.label || "device"}`.slice(0, 60);
  const { rawKey } = await apiKeyService.createApiKey(orgId, userId, name, CLI_PERMISSIONS);

  const ok = cliAuthService.approve(body.userCode, rawKey, orgId);
  if (!ok) return json({ success: false, message: "Invalid or expired code" }, 400);

  return json({ success: true, organizationId: orgId });
}
