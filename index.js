// ═══════════════════════════════════════════════════════════
// Skyra Sync Worker — Entry Point
// 1. Catalog sync (cron, every 15 min)
// 2. Order poller (every 5s — check paid orders + new pending)
// 3. Telegram bot (long polling — manual confirm, commands)
// ═══════════════════════════════════════════════════════════

import "dotenv/config"; // auto-load .env
import cron from "node-cron";
import { runSync } from "./src/sync.js";
import { startPoller } from "./src/poller.js";
import { startBot } from "./src/telegram.js";
import { startSheetPoller } from "./src/sheet-sync.js";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";

console.log("🚀 Skyra Sync Worker starting...");
console.log(`📅 Catalog sync schedule: ${CRON_SCHEDULE}`);

// ─────────────────────────────────────────────
// Print outbound IP (for UniPlay whitelist)
// ─────────────────────────────────────────────
async function printOutboundIP() {
  try {
    console.log("🔍 Checking outbound IP addresses...");
    const [ipv6Res, ipv4Res] = await Promise.allSettled([
      fetch("https://api6.ipify.org?format=json").then((r) => r.json()),
      fetch("https://api.ipify.org?format=json").then((r) => r.json()),
    ]);
    if (ipv6Res.status === "fulfilled") console.log(`📡 Outbound IPv6: ${ipv6Res.value.ip}`);
    if (ipv4Res.status === "fulfilled") console.log(`📡 Outbound IPv4: ${ipv4Res.value.ip}`);
  } catch (err) {
    console.error("Failed to check IP:", err.message);
  }
}

await printOutboundIP();

// ─────────────────────────────────────────────
// Start all services
// ─────────────────────────────────────────────

// 1. Catalog sync — initial run + cron
console.log("\n⚡ Running initial catalog sync...");
runSync().catch((e) => console.error("Initial sync error:", e));
cron.schedule(CRON_SCHEDULE, () => {
  runSync().catch((e) => console.error("Scheduled sync error:", e));
});

// 2. Order poller — paid orders auto-fulfill + new order notifs
startPoller();

// 3. Telegram bot — long-poll commands + inline callbacks
await startBot();

// 4. Sheet pricelist poller — pull from Google Sheet every 5 min
startSheetPoller();

console.log("\n✅ Worker running. Press Ctrl+C to stop.");

// Graceful shutdown
process.on("SIGINT", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
