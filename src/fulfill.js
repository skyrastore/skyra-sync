// ═══════════════════════════════════════════════════════════
// Order Fulfillment Engine
// - Called per order dengan status='paid'
// - Routes ke UniPlay API (via uniplay.js) atau skip (manual supplier)
// - Updates order status: fulfilling → done / failed
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";
import { inquiryPayment, confirmPayment, checkOrder, getDTU, getVoucher, getPPOB } from "./uniplay.js";

const PINCODE = process.env.UNIPLAY_PINCODE;

// ─────────────────────────────────────────────
// Short-lived catalog cache (30s) — reduces UniPlay calls
// if multiple orders arrive back-to-back
// ─────────────────────────────────────────────
const CACHE_TTL_MS = 30_000;
const catalogCache = { dtu: null, voucher: null, ppob: null, at: 0 };

async function getUniplayCatalog() {
  if (catalogCache.dtu && Date.now() - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache;
  }
  const [dtu, voucher, ppob] = await Promise.all([
    getDTU().catch(() => []),
    getVoucher().catch(() => []),
    getPPOB().catch(() => []),
  ]);
  catalogCache.dtu = dtu;
  catalogCache.voucher = voucher;
  catalogCache.ppob = ppob;
  catalogCache.at = Date.now();
  return catalogCache;
}

// Simple slug helper — must MATCH sync.js slugify() output exactly
function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// Resolve fresh (entitasId, denomId) from UniPlay API using stored stable SKU
// stable sku format: slugify(game_name) + "--" + slugify(denom_name)
async function resolveUniplayIds(order) {
  if (!order.supplier_sku?.includes("--")) {
    return { error: `supplier_sku missing "--" separator: ${order.supplier_sku}` };
  }

  const [gameSlug, denomSlug] = order.supplier_sku.split("--");
  const { dtu, voucher, ppob } = await getUniplayCatalog();
  const allItems = [...dtu, ...voucher, ...ppob];

  const item = allItems.find((it) => slugify(it.name) === gameSlug);
  if (!item) return { error: `Game not found in UniPlay catalog: ${gameSlug}` };

  const denom = (item.denom || []).find((d) => slugify(d.package) === denomSlug);
  if (!denom) return { error: `Denom not found: ${denomSlug} dalam ${item.name}` };

  const entitasId = item.id ?? item.entitas_id ?? item.entitasId;
  if (!entitasId || !denom.id) {
    return { error: `Missing entitas_id or denom.id in UniPlay response` };
  }

  return { entitasId, denomId: denom.id, itemName: item.name, denomName: denom.package };
}

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

  if (!order.supplier_sku) {
    await markFailed(order.id, "supplier_sku missing in order");
    return { success: false, message: "supplier_sku missing" };
  }

  // ─── Resolve FRESH entitasId + denomId from UniPlay API ───
  // (UniPlay rotates these tokens per call, can't cache)
  const resolved = await resolveUniplayIds(order);
  if (resolved.error) {
    await markFailed(order.id, `resolve IDs: ${resolved.error}`);
    return { success: false, message: resolved.error };
  }
  const { entitasId, denomId } = resolved;
  await appendLog(order.id, { action: "resolved_ids", entitasId, denomId });

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
      entitasId,
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
