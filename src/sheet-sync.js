// ═══════════════════════════════════════════════════════════
// Google Sheet ↔ Supabase sync (via Apps Script Web App)
//
// pullPricelist():    GET Apps Script → upsert products in Supabase
// pushOrderToSheet(): POST Apps Script → upsert row in ORDER WEB tab
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET;

// Sheet is a REAL financial book — don't pollute with Midtrans sandbox orders.
// Hera's Claude-chat explicitly asked to gate on MIDTRANS_IS_PRODUCTION.
const MIDTRANS_IS_PRODUCTION = (process.env.MIDTRANS_ENV || "sandbox").toLowerCase() === "production";

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

  // Pre-fetch current state of every sku we might touch so we can skip no-op
  // writes. Cutting ~90% of upsert calls here is the quickest way to stop
  // blowing through Supabase's free-tier log quota (observed >1 GB/mo before).
  const skus = items.map((i) => i.supplier_sku);
  const { data: existingRows } = await supabase
    .from("products")
    .select("id, supplier_sku, game_id, name, price_idr, cost_idr, price_vip_idr, is_available, sort_order")
    .eq("supplier", "manual")
    .in("supplier_sku", skus);
  const existingBySku = new Map((existingRows || []).map((r) => [r.supplier_sku, r]));

  let upserted = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const item of items) {
    const game_id = gameBySlug.get(item.game_slug);
    if (!game_id) {
      skipped++;
      continue;
    }

    const next = {
      game_id,
      name: item.name,
      price_idr: item.price_idr,
      cost_idr: item.cost_idr,
      supplier: "manual",
      supplier_sku: item.supplier_sku,
      price_vip_idr: item.price_vip_idr ?? null, // VIP rate swap (NULL = sama dengan price_idr)
      is_available: item.available !== false, // KATALOG WEB passes `available: false` for HABIS rows; legacy PRODUK rows don't set this so default to true
      sort_order: Number(item.row_index) || 0, // urut sesuai baris sheet (Apps Script kirim row_index)
    };

    // Skip write if nothing user-visible changed. Normalise types since
    // PostgREST may hand back numeric strings for bigint columns.
    const cur = existingBySku.get(item.supplier_sku);
    if (
      cur &&
      cur.game_id === next.game_id &&
      cur.name === next.name &&
      Number(cur.price_idr) === Number(next.price_idr) &&
      Number(cur.cost_idr || 0) === Number(next.cost_idr || 0) &&
      (cur.price_vip_idr == null ? null : Number(cur.price_vip_idr)) === (next.price_vip_idr == null ? null : Number(next.price_vip_idr)) &&
      !!cur.is_available === !!next.is_available &&
      Number(cur.sort_order || 0) === Number(next.sort_order || 0)
    ) {
      unchanged++;
      continue;
    }

    const { error } = await supabase
      .from("products")
      .upsert(next, { onConflict: "supplier,supplier_sku", ignoreDuplicates: false });

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

  console.log(`📊 Sheet pull: ${upserted} upserted, ${unchanged} unchanged, ${skipped} skipped, ${deactivated} deactivated`);
  return { success: true, upserted, unchanged, skipped, deactivated };
}

// ─────────────────────────────────────────────
// Upsert 1 order to ORDER WEB tab (Apps Script tab bukan HARIAN lagi — Nov 2026)
// Idempotent per order_code: insert kalau belum ada, kalau sudah ada hanya
// update STATUS + FEE. Panggil di tiap status change (paid, fulfilling, done,
// refunded, failed, cancelled). Status pending_payment / expired diabaikan
// sheet-side kalau belum pernah tercatat.
//
// JANGAN kirim custom_data / phone / email customer — modal/USD/laba dihitung
// di sheet via ARRAYFORMULA matching game_slug + product_name ke PRODUK /
// KATALOG WEB.
// ─────────────────────────────────────────────
export async function pushOrderToSheet(order) {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) return { success: false };
  if (!MIDTRANS_IS_PRODUCTION) {
    console.log(`📊 Sheet push SKIPPED for ${order.order_code} (sandbox mode — not a real order)`);
    return { success: true, skipped: "sandbox" };
  }

  const body = {
    action: "upsert_order",
    key: APPS_SCRIPT_SECRET,
    order: {
      order_code: order.order_code,
      game_slug: order.game_slug,
      product_name: order.product_name,
      qty: Number(order.qty) || 1,
      subtotal_idr: Number(order.subtotal_idr) || 0,
      voucher_discount_idr: Number(order.voucher_discount_idr) || 0,
      total_idr: Number(order.total_idr) || 0,
      fee_idr: Number(order.fee_idr) || 0, // Midtrans fee kalau ada
      payment_method: order.payment_method || "midtrans",
      payment_channel: order.payment_channel || null,
      status: order.status || "done",
      paid_at: order.paid_at || order.fulfilled_at || order.created_at,
      // Hanya untuk sky-via-gift — admin pilih gifter saat mark done via Telegram.
      // Apps Script menulis ini ke ORDER WEB kolom T (GIFTER).
      gifter_code: order.custom_data?.gifter_code || null,
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
      console.error(`Sheet upsert error [${order.order_code}]:`, data.error);
      return { success: false, message: data.error };
    }
    const tag = data.action === "inserted"
      ? `row ${data.row} · modal ${data.modal ?? "?"} · laba ${data.laba ?? "?"}`
      : data.action === "updated"
      ? `row ${data.row} → ${data.status}`
      : data.action === "skipped"
      ? `skipped (${data.status})`
      : "ok";
    console.log(`📊 Sheet upsert ${order.order_code}: ${tag}`);
    // Warn kalau modal null (berarti PRODUK/KATALOG WEB ga cocok nama/slug-nya)
    if (data.action === "inserted" && (data.modal === null || data.modal === "" || data.modal === undefined)) {
      console.warn(`⚠️  ${order.order_code}: modal kosong — product_name "${order.product_name}" ga match di sheet`);
    }
    return { success: true, ...data };
  } catch (e) {
    console.error(`Sheet upsert network error [${order.order_code}]:`, e.message);
    return { success: false, message: e.message };
  }
}

// ─────────────────────────────────────────────
// Fetch daftar gifter dari Apps Script — dipakai Telegram bot buat tombol
// "Pilih Gifter" saat admin fulfill order sky-via-gift.
// Return: { gifters: [{name, sisa_usd, rate_idr}], count, fetched_at } | null
// ─────────────────────────────────────────────
export async function fetchGifters() {
  if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) return null;
  const url = `${APPS_SCRIPT_URL}?action=gifters&key=${encodeURIComponent(APPS_SCRIPT_SECRET)}`;
  try {
    const res = await fetch(url, { redirect: "follow" });
    const data = await res.json();
    if (data.error) { console.error("Gifters fetch error:", data.error); return null; }
    return data;
  } catch (e) {
    console.error("Gifters fetch network error:", e.message);
    return null;
  }
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
