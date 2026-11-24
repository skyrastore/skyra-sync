// ═══════════════════════════════════════════════════════════
// Order Fulfillment Engine
// - Called per order dengan status='paid'
// - Routes ke UniPlay API (via uniplay.js) atau skip (manual supplier)
// - Updates order status: fulfilling → done / failed
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";
import { inquiryPayment, confirmPayment, checkOrder } from "./uniplay.js";

const PINCODE = process.env.UNIPLAY_PINCODE;

/**
 * Append a log entry to order.fulfill_log
 */
async function appendLog(orderId, entry) {
  const { data: current } = await supabase
    .from("orders")
    .select("fulfill_log")
    .eq("id", orderId)
    .single();
  const log = Array.isArray(current?.fulfill_log) ? current.fulfill_log : [];
  log.push({ at: new Date().toISOString(), ...entry });
  await supabase.from("orders").update({ fulfill_log: log }).eq("id", orderId);
}

/**
 * Main entrypoint: fulfill an order by id
 * @returns {Promise<{success: boolean, message: string, uniplayOrderId?: string}>}
 */
export async function fulfillOrder(orderId) {
  // ─── Fetch latest order state ───
  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single();

  if (error || !order) {
    return { success: false, message: `Order not found: ${orderId}` };
  }

  if (order.status !== "paid") {
    return {
      success: false,
      message: `Order status is '${order.status}', only 'paid' can be fulfilled`,
    };
  }

  // ─── Transition: paid → fulfilling (lock) ───
  const { error: lockErr } = await supabase
    .from("orders")
    .update({
      status: "fulfilling",
      fulfilling_at: new Date().toISOString(),
      fulfill_attempts: (order.fulfill_attempts || 0) + 1,
    })
    .eq("id", orderId)
    .eq("status", "paid"); // optimistic lock: fails kalau udah bukan paid

  if (lockErr) {
    return { success: false, message: `Lock failed: ${lockErr.message}` };
  }

  await appendLog(orderId, { action: "fulfilling_start", supplier: order.supplier });

  // ─── Route by supplier ───
  if (order.supplier === "uniplay") {
    return await fulfillUniPlay(order);
  }

  if (order.supplier === "manual" || order.supplier === "lapakgaming") {
    // Manual supplier: biarkan admin fulfill via Telegram button atau dashboard
    // Status tetep 'fulfilling' — admin akan update ke 'done' manually
    await appendLog(orderId, {
      action: "manual_queue",
      note: "Manual supplier — nunggu admin fulfill",
    });
    return {
      success: true,
      message: `Manual supplier (${order.supplier}) — nunggu admin`,
    };
  }

  // Unknown supplier
  await markFailed(orderId, `Unknown supplier: ${order.supplier}`);
  return { success: false, message: `Unknown supplier: ${order.supplier}` };
}

// ─────────────────────────────────────────────
// UniPlay fulfillment
// ─────────────────────────────────────────────
async function fulfillUniPlay(order) {
  if (!PINCODE) {
    await markFailed(order.id, "UNIPLAY_PINCODE not set in env");
    return { success: false, message: "UNIPLAY_PINCODE not set" };
  }

  if (!order.entitas_id || !order.supplier_sku) {
    await markFailed(
      order.id,
      `Missing UniPlay IDs — entitas_id=${order.entitas_id}, sku=${order.supplier_sku}`
    );
    return {
      success: false,
      message: "Missing UniPlay entitas_id/supplier_sku",
    };
  }

  // Extract denom_id from supplier_sku (format: "entitasId:denomId")
  const denomId = order.supplier_sku.includes(":")
    ? order.supplier_sku.split(":")[1]
    : order.supplier_sku;

  // Extract user_id / server_id dari custom_data
  const userId = String(order.custom_data?.user_id || order.custom_data?.userId || "");
  const serverId = String(
    order.custom_data?.server_id || order.custom_data?.serverId || order.custom_data?.zone_id || ""
  );

  if (!userId) {
    await markFailed(order.id, "custom_data.user_id missing");
    return { success: false, message: "user_id missing in custom_data" };
  }

  // ─── Step 1: inquiry-payment (verify user + lock price) ───
  let inquiryId;
  try {
    const inquiry = await inquiryPayment({
      entitasId: order.entitas_id,
      denomId,
      userId,
      serverId,
    });
    inquiryId = inquiry.inquiryId;
    await supabase
      .from("orders")
      .update({ uniplay_inquiry_id: inquiryId })
      .eq("id", order.id);
    await appendLog(order.id, {
      action: "inquiry_success",
      inquiryId,
      info: inquiry.info,
    });
  } catch (err) {
    await markFailed(order.id, `inquiry-payment failed: ${err.message}`);
    return { success: false, message: `inquiry failed: ${err.message}` };
  }

  // ─── Step 2: confirm-payment (actually fulfill, deduct saldo) ───
  let uniplayOrderId;
  try {
    const confirm = await confirmPayment({ inquiryId, pincode: PINCODE });
    uniplayOrderId = confirm.orderId;
    await appendLog(order.id, {
      action: "confirm_success",
      uniplayOrderId,
      info: confirm.info,
    });
  } catch (err) {
    // Payment confirm failed — order mungkin tetep ter-charge, perlu cek manual
    await appendLog(order.id, {
      action: "confirm_failed",
      error: err.message,
      note: "DOUBLE-CHECK saldo & UniPlay dashboard — mungkin ter-charge tapi response fail",
    });
    await markFailed(order.id, `confirm-payment failed: ${err.message}`);
    return { success: false, message: `confirm failed: ${err.message}` };
  }

  // ─── Step 3: mark done ───
  await supabase
    .from("orders")
    .update({
      status: "done",
      uniplay_order_id: uniplayOrderId,
      fulfilled_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  await appendLog(order.id, { action: "fulfilled", uniplayOrderId });

  return {
    success: true,
    message: `UniPlay fulfilled: ${uniplayOrderId}`,
    uniplayOrderId,
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
async function markFailed(orderId, reason) {
  await supabase
    .from("orders")
    .update({ status: "failed" })
    .eq("id", orderId);
  await appendLog(orderId, { action: "failed", reason });
}

/**
 * Re-check UniPlay order status (for pending orders)
 */
export async function recheckUniPlayOrder(orderId) {
  const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single();
  if (!order?.uniplay_order_id) return { success: false, message: "No uniplay_order_id" };

  try {
    const result = await checkOrder(order.uniplay_order_id);
    await appendLog(orderId, { action: "recheck", info: result.info });
    return { success: true, info: result.info };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
