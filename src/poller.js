// ═══════════════════════════════════════════════════════════
// Order Poller
// - Polls Supabase for new orders (notify Telegram)
// - Polls for status='paid' orders → auto-fulfill
// - Interval: POLL_INTERVAL_MS (default 5000ms)
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";
import { fulfillOrder } from "./fulfill.js";
import { notifyNewOrder, notifyPaid, notifyFulfilled, notifyFailed } from "./telegram.js";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

// Prevent double-processing within the same tick
const inflight = new Set();

// Track last notification cutoff so we don't re-announce old orders on restart
let lastSeenCreatedAt = new Date().toISOString();

async function pollNewPendingOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("status", "pending_payment")
    .gt("created_at", lastSeenCreatedAt)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    console.error("Poll pending error:", error);
    return;
  }
  if (!data?.length) return;

  for (const order of data) {
    try {
      await notifyNewOrder(order);
    } catch (e) {
      console.error("notifyNewOrder error:", e);
    }
    if (order.created_at > lastSeenCreatedAt) lastSeenCreatedAt = order.created_at;
  }
}

async function pollPaidOrders() {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_code")
    .eq("status", "paid")
    .order("paid_at", { ascending: true })
    .limit(5);

  if (error) {
    console.error("Poll paid error:", error);
    return;
  }
  if (!data?.length) return;

  for (const o of data) {
    if (inflight.has(o.id)) continue;
    inflight.add(o.id);

    // Fire-and-forget (don't block poll loop)
    (async () => {
      try {
        // Notify "payment received, fulfilling…"
        const { data: fullOrder } = await supabase.from("orders").select("*").eq("id", o.id).single();
        if (fullOrder) await notifyPaid(fullOrder);

        const result = await fulfillOrder(o.id);

        // Re-fetch after fulfill (status transitioned to done/failed)
        const { data: finalOrder } = await supabase.from("orders").select("*").eq("id", o.id).single();
        if (!finalOrder) return;

        if (result.success && finalOrder.status === "done") {
          await notifyFulfilled(finalOrder);
        } else if (finalOrder.status === "failed") {
          await notifyFailed(finalOrder, result.message);
        } else if (finalOrder.status === "fulfilling" && result.success) {
          // Manual supplier — admin needs to act
          console.log(`Order ${o.order_code} queued for manual fulfillment`);
        }
      } catch (e) {
        console.error(`Fulfill ${o.order_code} error:`, e);
      } finally {
        inflight.delete(o.id);
      }
    })();
  }
}

async function tick() {
  await Promise.allSettled([pollNewPendingOrders(), pollPaidOrders()]);
}

export function startPoller() {
  console.log(`🔄 Order poller started — interval ${POLL_INTERVAL_MS}ms`);
  setInterval(() => {
    tick().catch((e) => console.error("Poll tick error:", e));
  }, POLL_INTERVAL_MS);
}
