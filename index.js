// ═══════════════════════════════════════════════════════════
// Skyra Sync Worker — Entry Point
// Runs sync every 15 minutes via node-cron
// ═══════════════════════════════════════════════════════════

import cron from "node-cron";
import { runSync } from "./src/sync.js";

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *"; // every 15 min

console.log("🚀 Skyra Sync Worker starting...");
console.log(`📅 Schedule: ${CRON_SCHEDULE}`);

// Run once on startup
console.log("⚡ Running initial sync...");
runSync().catch((e) => console.error("Initial sync error:", e));

// Then schedule recurring
cron.schedule(CRON_SCHEDULE, () => {
  runSync().catch((e) => console.error("Scheduled sync error:", e));
});

// Keep process alive
console.log("✅ Worker running. Waiting for next scheduled sync...");

// Graceful shutdown
process.on("SIGINT", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n👋 Shutting down..."); process.exit(0); });
