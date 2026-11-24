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

// Manual orders stay in 'paid' status until admin acts via Telegram button.
// Remember which have already been notified so we don't re-notify every tick.
const manualNotified = new Set();

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
    .select("id, order_code, supplier")
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

    const isManual = o.supplier === "manual" || o.supplier === "lapakgaming";
    // Manual order already notified → skip. Admin's Telegram action will
    // transition status away from 'paid'.
    if (isManual && manualNotified.has(o.id)) continue;

    inflight.add(o.id);

    (async () => {
      try {
        const { data: fullOrder } = await supabase.from("orders").select("*").eq("id", o.id).single();
        if (fullOrder) await notifyPaid(fullOrder);

        if (isManual) {
          manualNotified.add(o.id);
          console.log(`Order ${o.order_code} queued for manual (admin via Telegram)`);
          return;
        }

        const result = await fulfillOrder(o.id);

        const { data: finalOrder } = await supabase.from("orders").select("*").eq("id", o.id).single();
        if (!finalOrder) return;

        if (result.success && finalOrder.status === "done") {
          await notifyFulfilled(finalOrder);
        } else if (finalOrder.status === "failed") {
          await notifyFailed(finalOrder, result.message);
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
