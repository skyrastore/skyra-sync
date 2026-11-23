// ═══════════════════════════════════════════════════════════
// Skyra Sync Worker — Entry Point
// Runs sync every 15 minutes via node-cron
// ═══════════════════════════════════════════════════════════

import cron from "node-cron";
import { runSync } from "./src/sync.js";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *"; // every 15 min

console.log("🚀 Skyra Sync Worker starting...");
console.log(`📅 Schedule: ${CRON_SCHEDULE}`);

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
    if (ipv6Res.status === "fulfilled") {
      console.log(`📡 Outbound IPv6: ${ipv6Res.value.ip}`);
    } else {
      console.log("⚠️  No IPv6 outbound available");
    }
    if (ipv4Res.status === "fulfilled") {
      console.log(`📡 Outbound IPv4: ${ipv4Res.value.ip}`);
    } else {
      console.log("⚠️  No IPv4 outbound available");
    }
    console.log("👉 Whitelist IP di atas ke UniPlay Arena → Akses API → Whitelist IP");
  } catch (err) {
    console.error("Failed to check IP:", err.message);
  }
}

await printOutboundIP();

// Run sync once on startup
console.log("\n⚡ Running initial sync...");
runSync().catch((e) => console.error("Initial sync error:", e));

// Then schedule recurring
cron.schedule(CRON_SCHEDULE, () => {
  runSync().catch((e) => console.error("Scheduled sync error:", e));
});

console.log("\n✅ Worker running. Waiting for next scheduled sync...");

// Graceful shutdown
process.on("SIGINT", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
