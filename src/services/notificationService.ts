/**
 * Telegram notification service
 * Sends alerts for certificate activation, server health, and other critical events.
 * Certificates are provisioned and auto-renewed by Cloudflare (Cloudflare for SaaS);
 * there is no Certbot/Let's Encrypt and no VPS-level certificate sync.
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
 * Notify that a custom domain's Cloudflare edge certificate is active.
 * Cloudflare auto-renews the cert; `expiry` is informational and may be 0/unknown.
 */
export async function notifyCertIssued(domain: string, expiry: number): Promise<void> {
  const expiryLine = expiry ? `\nExpires: ${new Date(expiry).toISOString().split("T")[0]}` : "";
  const message = `
✅ <b>Certificate Active</b>
Domain: <code>${domain}</code>${expiryLine}
Status: Cloudflare edge certificate active (auto-renewed)
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
${!healthy ? "Action: Check server connectivity" : ""}
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
 * Send test notification to verify configuration
 */
export async function sendTestNotification(): Promise<boolean> {
  const timestamp = new Date().toISOString();
  const message = `
✅ <b>Test Notification</b>
KProxy is connected to Telegram
Timestamp: <code>${timestamp}</code>
  `.trim();

  return await sendTelegramMessage(message);
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
