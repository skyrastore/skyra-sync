// ═══════════════════════════════════════════════════════════
// Google Sheet ↔ Supabase sync (via Apps Script Web App)
//
// pullPricelist():    GET Apps Script → upsert products in Supabase
// pushOrderToSheet(): POST Apps Script → append row to HARIAN tab
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// ─────────────────────────────────────────────
// Pull pricelist from Sheet → upsert products
// ─────────────────────────────────────────────
export async function pullPricelist() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
    console.warn("⚠️  APPS_SCRIPT_URL / APPS_SCRIPT_SECRET not set");
    return { success: false, message: "not configured" };
  }

  const url = `${APPS_SCRIPT_URL}?action=pricelist&key=${encodeURIComponent(APPS_SCRIPT_SECRET)}`;
  let data;
  try {
    const res = await fetch(url, { redirect: "follow" });
    data = await res.json();
  } catch (e) {
    console.error("Sheet pull error:", e.message);
    return { success: false, message: e.message };
  }

  if (data.error) {
    console.error("Apps Script error:", data.error);
    return { success: false, message: data.error };
  }

  const items = data.items || [];
  if (!items.length) return { success: true, inserted: 0, updated: 0 };

  // Fetch all games we need in one query
  const slugs = [...new Set(items.map((i) => i.game_slug))];
  const { data: games } = await supabase.from("games").select("id, slug").in("slug", slugs);
  const gameBySlug = new Map((games || []).map((g) => [g.slug, g.id]));

  let upserted = 0;
  let skipped = 0;

  for (const item of items) {
    const game_id = gameBySlug.get(item.game_slug);
    if (!game_id) {
      skipped++;
      continue;
    }

    const { error } = await supabase
      .from("products")
      .upsert(
        {
          game_id,
          name: item.name,
          price_idr: item.price_idr,
          cost_idr: item.cost_idr,
          supplier: "manual",
          supplier_sku: item.supplier_sku,
          is_available: true,
        },
        { onConflict: "supplier,supplier_sku", ignoreDuplicates: false }
      );

    if (error) {
      console.error(`Product upsert error [${item.supplier_sku}]:`, error.message);
      skipped++;
    } else {
      upserted++;
    }
  }

  // Mark manual products that disappeared from Sheet as unavailable
  const seenSkus = new Set(items.map((i) => i.supplier_sku));
  const { data: allManual } = await supabase
    .from("products")
    .select("id, supplier_sku")
    .eq("supplier", "manual");
  let deactivated = 0;
  for (const p of allManual || []) {
    if (!seenSkus.has(p.supplier_sku)) {
      await supabase.from("products").update({ is_available: false }).eq("id", p.id);
      deactivated++;
    }
  }

  console.log(`📊 Sheet pull: ${upserted} upserted, ${skipped} skipped, ${deactivated} deactivated`);
  return { success: true, upserted, skipped, deactivated };
}

// ─────────────────────────────────────────────
// Push 1 order (status=done) to HARIAN tab
// ─────────────────────────────────────────────
export async function pushOrderToSheet(order) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) return { success: false };

  // Fetch product cost snapshot
  let unitCost = 0;
  if (order.product_id) {
    const { data: p } = await supabase
      .from("products")
      .select("cost_idr")
      .eq("id", order.product_id)
      .maybeSingle();
    unitCost = p?.cost_idr || 0;
  }
  const qty = order.qty || 1;
  const totalModal = unitCost * qty;

  const itemLabel = `${order.game_name} | ${order.product_name}` + (qty > 1 ? ` x${qty}` : "");

  // Map our payment_channel to Sheet BAYAR dropdown values
  // (BCA / GOPAY POT 1K / GOPAY NON POT / QRIS GOPAY / QRIS DANA / PAYPAL)
  const bayar = mapBayar(order.payment_channel, order.payment_method);

  const body = {
    action: "append_order",
    key: APPS_SCRIPT_SECRET,
    order: {
      tanggal: order.fulfilled_at || order.paid_at || order.created_at,
      nama: order.phone || "Web Customer",
      item: itemLabel,
      bayar,
      jual: order.total_idr,
      modal: totalModal,
      nominal: "",
    },
  };

  try {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "follow",
    });
    const data = await res.json();
    if (data.error) {
      console.error(`Sheet push error [${order.order_code}]:`, data.error);
      return { success: false, message: data.error };
    }
    console.log(`📊 Pushed order ${order.order_code} to Sheet row ${data.appended_row}`);
    return { success: true, row: data.appended_row };
  } catch (e) {
    console.error(`Sheet push network error [${order.order_code}]:`, e.message);
    return { success: false, message: e.message };
  }
}

// Heuristic mapping Midtrans payment_type → sheet BAYAR dropdown
function mapBayar(channel, method) {
  const c = String(channel || "").toLowerCase();
  if (c.includes("gopay") && c.includes("qris")) return "QRIS GOPAY";
  if (c.includes("qris")) return "QRIS GOPAY";
  if (c.includes("gopay")) return "GOPAY NON POT";
  if (c.includes("bca") || c.includes("va")) return "BCA";
  if (c.includes("paypal")) return "PAYPAL";
  if (c === "credit_card" || c === "cc") return "BCA"; // closest fit
  if (method === "manual") return "QRIS DANA";
  return "QRIS GOPAY"; // default
}

// ─────────────────────────────────────────────
// Poller: pull pricelist on schedule
// ─────────────────────────────────────────────
const PULL_INTERVAL_MS = Number(process.env.SHEET_PULL_INTERVAL_MS || 5 * 60 * 1000);

export function startSheetPoller() {
  if (!APPS_SCRIPT_URL) {
    console.warn("⚠️  Sheet poller NOT started — APPS_SCRIPT_URL missing");
    return;
  }
  console.log(`📊 Sheet pricelist poller started — every ${PULL_INTERVAL_MS / 1000}s`);

  // Initial pull immediately
  pullPricelist().catch((e) => console.error("Initial sheet pull error:", e));

  // Then recurring
  setInterval(() => {
    pullPricelist().catch((e) => console.error("Scheduled sheet pull error:", e));
  }, PULL_INTERVAL_MS);
}
