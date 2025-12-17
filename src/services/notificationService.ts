/**
 * Telegram notification service
 * Sends alerts for certificate expiry, sync failures, and other critical events
 */

interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

let config: TelegramConfig | null = null;

/**
 * Initialize Telegram notifications
 */
export function initTelegram(botToken?: string, chatId?: string): void {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chat = chatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chat) {
    console.log(
      "⚠️  Telegram notifications disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)"
    );
    config = null;
    return;
  }

  config = {
    botToken: token,
    chatId: chat,
    enabled: true,
  };

  console.log("✅ Telegram notifications enabled");
}

/**
 * Send a message to Telegram
 */
async function sendTelegramMessage(message: string): Promise<boolean> {
  if (!config || !config.enabled) {
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });

    if (!response.ok) {
      console.error(`Telegram send error: ${response.status} ${response.statusText}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error("Failed to send Telegram message:", error);
    return false;
  }
}

/**
 * Notify about certificate registered successfully
 */
export async function notifyCertIssued(domain: string, expiry: number): Promise<void> {
  const expiryDate = new Date(expiry).toISOString().split("T")[0];
  const message = `
✅ <b>Certificate Issued</b>
Domain: <code>${domain}</code>
Expires: ${expiryDate}
Status: Active and synced to all VPS servers
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about certificate sync to all VPS servers
 */
export async function notifyCertSynced(
  domain: string,
  vpsCount: number,
  successCount: number
): Promise<void> {
  const status =
    successCount === vpsCount ? "✅ Success" : successCount > 0 ? "⚠️ Partial" : "❌ Failed";
  const message = `
${status} <b>Certificate Synced</b>
Domain: <code>${domain}</code>
VPS Servers: ${successCount}/${vpsCount}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about certificate sync failure
 */
export async function notifySyncFailed(domain: string, error: string): Promise<void> {
  const message = `
❌ <b>Certificate Sync Failed</b>
Domain: <code>${domain}</code>
Error: ${error}
Action: Check VPS connectivity or try manual resync
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about certificate expiring soon
 */
export async function notifyCertExpiring(domain: string, daysRemaining: number): Promise<void> {
  const icon = daysRemaining <= 7 ? "🚨" : "⚠️";
  const message = `
${icon} <b>Certificate Expiring Soon</b>
Domain: <code>${domain}</code>
Days Remaining: ${daysRemaining}
Action: Certificate will be auto-renewed by certbot
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about certificate expired
 */
export async function notifyCertExpired(domain: string): Promise<void> {
  const message = `
🚨 <b>Certificate Expired</b>
Domain: <code>${domain}</code>
Action: Manual renewal required - check certbot logs
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about domain transfer
 */
export async function notifyDomainTransferred(
  domain: string,
  targetVpsId: string,
  allServers: boolean
): Promise<void> {
  const scope = allServers ? "all VPS servers" : "target VPS";
  const message = `
🔄 <b>Domain Transferred</b>
Domain: <code>${domain}</code>
Target VPS: <code>${targetVpsId}</code>
Scope: ${scope}
Status: Certificates synced successfully
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about domain backup created
 */
export async function notifyBackupCreated(domain: string, backupId: string, size: number): Promise<void> {
  const sizeKb = (size / 1024).toFixed(2);
  const message = `
💾 <b>Backup Created</b>
Domain: <code>${domain}</code>
Backup ID: <code>${backupId}</code>
Size: ${sizeKb} KB
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about domain backup restored
 */
export async function notifyBackupRestored(domain: string, backupId: string): Promise<void> {
  const message = `
↩️ <b>Backup Restored</b>
Domain: <code>${domain}</code>
Backup ID: <code>${backupId}</code>
Status: Certificates synced to all VPS servers
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about VPS server health status change
 */
export async function notifyVpsHealthChanged(vpsId: string, healthy: boolean): Promise<void> {
  const status = healthy ? "✅ Healthy" : "❌ Unhealthy";
  const message = `
🔔 <b>VPS Status Changed</b>
VPS ID: <code>${vpsId}</code>
Status: ${status}
${!healthy ? "Action: Check VPS connectivity and SSH access" : ""}
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about rate limit exceeded
 */
export async function notifyRateLimitExceeded(ip: string, domain?: string): Promise<void> {
  const type = domain ? `domain (${domain})` : "IP";
  const message = `
⏸️ <b>Rate Limit Exceeded</b>
Type: ${type}
Identifier: <code>${domain || ip}</code>
Action: Wait before retrying
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Notify about multiple domain sync failures
 */
export async function notifyMultipleDomainFailures(failures: string[]): Promise<void> {
  const domainList = failures.map((d) => `• ${d}`).join("\n");
  const message = `
⚠️ <b>Multiple Domain Sync Failures</b>
Domains:
${domainList}
Action: Manual intervention may be required
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Send test notification to verify configuration
 */
export async function sendTestNotification(): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const message = `
✅ <b>Test Notification</b>
Jrok is connected to Telegram
Timestamp: <code>${timestamp}</code>
  `.trim();

  return await sendTelegramMessage(message);
}

/**
 * Notify that certificate sync is available for VPS servers to pull
 */
export async function notifyCertSyncAvailable(): Promise<void> {
  const message = `
📤 <b>Certificate Sync Available</b>
New certificates are ready to be pulled by VPS servers.
Servers will automatically sync within 6 hours.
  `.trim();

  await sendTelegramMessage(message);
}

/**
 * Get current Telegram configuration status
 */
export function getTelegramStatus(): {
  enabled: boolean;
  chatId?: string;
} {
  return {
    enabled: config?.enabled || false,
    chatId: config?.chatId,
  };
}
