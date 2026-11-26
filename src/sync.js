// ═══════════════════════════════════════════════════════════
// Skyra Sync — Fetch UniPlay catalog, upsert to Supabase
// ═══════════════════════════════════════════════════════════

import { getDTU, getVoucher, getPPOB, getSaldo } from "./uniplay.js";
import { supabase } from "./supabase.js";

const MARKUP = Number(process.env.MARKUP_PCT || "2.5") / 100; // default 2.5%

// Helper: slug from name
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// Helper: calc sell price with markup, rounded to nearest 50
function sellPrice(cost) {
  const n = Math.ceil(Number(cost) * (1 + MARKUP));
  return Math.ceil(n / 50) * 50; // round up to nearest 50 rupiah
}

// ─────────────────────────────────────────────
// Sync one category (DTU / Voucher / PPOB)
// ─────────────────────────────────────────────
async function syncCategory(categoryLabel, fetcher, category) {
  console.log(`\n──── Syncing ${categoryLabel} ────`);
  const list = await fetcher();
  console.log(`✓ Fetched ${list.length} items from UniPlay`);

  const syncedGameIds = new Set();
  const syncedProductIds = new Set();
  let newGames = 0, updatedGames = 0, unchangedGames = 0, newProducts = 0, updatedProducts = 0, unchangedProducts = 0;

  // Pre-fetch current state of every game and product we may touch this cycle,
  // so we can skip no-op writes. Each skipped upsert is one less Supabase log
  // entry — the diff before this change was blowing through Free-tier log
  // ingestion (~180k product writes/day of mostly identical rows).
  const allSlugs = list.map((item) => `${category}-${slugify(item.name)}`);
  const { data: existingGames } = await supabase
    .from("games")
    .select("id, slug, name, publisher, image_url, category")
    .in("slug", allSlugs);
  const existingGameBySlug = new Map((existingGames || []).map((g) => [g.slug, g]));

  const { data: existingProducts } = await supabase
    .from("products")
    .select("id, game_id, supplier_sku, name, price_idr, cost_idr, is_available")
    .eq("supplier", "uniplay")
    .in("game_id", (existingGames || []).map((g) => g.id));
  const existingProductBySku = new Map((existingProducts || []).map((p) => [p.supplier_sku, p]));

  for (const item of list) {
    // 1. UPSERT game
    const gameSlug = `${category}-${slugify(item.name)}`;
    const existingGame = existingGameBySlug.get(gameSlug);

    const gameData = {
      slug: gameSlug,
      name: item.name,
      publisher: item.publisher || null,
      icon_emoji: "🎮",
      image_url: item.image || null,
      color_theme: "default",
      category,
      // Don't populate instructions from publisher website — it's noise on game page.
      // Leave null, use frontend's static badge instead.
      instructions: null,
      is_active: true,
      is_featured: false,
      sort_order: 0,
    };

    // Only seed input_fields/input_type on FIRST INSERT (default generic
    // template). Admin will later edit via SQL to match UniPlay's actual
    // form schema (see scripts/build-updates.mjs).
    if (!existingGame) {
      gameData.input_type = category === "voucher" ? "none" : "user_id";
      gameData.input_fields = category === "voucher" ? [] : [
        { key: "user_id", label: "User ID", type: "text", required: true, placeholder: "Masukkan User ID" },
        { key: "server_id", label: "Server ID (opsional)", type: "text", required: false },
      ];
    }

    // Skip game upsert if nothing user-visible changed (name/publisher/image/
    // category). All other sync-maintained fields are constant per sync.
    let upsertedGame;
    const gameChanged = !existingGame
      || existingGame.name !== gameData.name
      || (existingGame.publisher || null) !== gameData.publisher
      || (existingGame.image_url || null) !== gameData.image_url
      || existingGame.category !== gameData.category;

    if (gameChanged) {
      const { data: g, error: gameErr } = await supabase
        .from("games")
        .upsert(gameData, { onConflict: "slug", ignoreDuplicates: false })
        .select("id, created_at")
        .single();
      if (gameErr) {
        console.error(`  ✗ Game error (${item.name}):`, gameErr.message);
        continue;
      }
      upsertedGame = g;
      const isNewGame = new Date(g.created_at) > new Date(Date.now() - 60000);
      if (isNewGame) newGames++; else updatedGames++;
    } else {
      upsertedGame = { id: existingGame.id };
      unchangedGames++;
    }
    syncedGameIds.add(upsertedGame.id);

    // 2. UPSERT products (denom)
    // supplier_sku = stable NAME-based key: slugify(game_name)--slugify(denom_name)
    // Reason: UniPlay API returns encoded tokens as item.id / denom.id that
    // ROTATE per API call (not stable identifiers). Fulfill engine must call
    // getDTU fresh to resolve current ids at order time.
    const seenSkus = new Set();
    for (const denom of item.denom || []) {
      if (!denom.package) continue;
      const compositeSku = `${slugify(item.name)}--${slugify(denom.package)}`;
      if (seenSkus.has(compositeSku)) continue;
      seenSkus.add(compositeSku);

      const cost = Number(denom.price);
      const sell = sellPrice(cost);

      const productData = {
        game_id: upsertedGame.id,
        name: denom.package,
        amount: null,
        unit: null,
        price_idr: sell,
        cost_idr: cost,
        supplier: "uniplay",
        supplier_sku: compositeSku,
        notes: `[uniplay/${category}] ${item.name}`,
        is_hot: false,
        is_available: true,
        sort_order: 0,
      };

      // Skip write if the UniPlay catalog says the same price + name as what's
      // already in the DB. Most sync cycles leave the vast majority of products
      // untouched; this is the single biggest log-volume reduction.
      const curProd = existingProductBySku.get(compositeSku);
      if (
        curProd &&
        curProd.game_id === productData.game_id &&
        curProd.name === productData.name &&
        Number(curProd.price_idr) === Number(productData.price_idr) &&
        Number(curProd.cost_idr || 0) === Number(productData.cost_idr || 0) &&
        !!curProd.is_available === !!productData.is_available
      ) {
        syncedProductIds.add(curProd.id);
        unchangedProducts++;
        continue;
      }

      // Upsert by (supplier, supplier_sku) — needs unique index
      const { data: upserted, error } = await supabase
        .from("products")
        .upsert(productData, {
          onConflict: "supplier,supplier_sku",
          ignoreDuplicates: false,
        })
        .select("id, created_at")
        .single();

      if (error) {
        console.error(`  ✗ Product error (${denom.package}):`, error.message);
        continue;
      }
      syncedProductIds.add(upserted.id);
      const isNew = new Date(upserted.created_at) > new Date(Date.now() - 60000);
      if (isNew) newProducts++; else updatedProducts++;
    }
  }

  // 3. Mark stale products (uniplay, not in sync anymore) as unavailable
  const { data: allUniplayProducts } = await supabase
    .from("products")
    .select("id, game_id")
    .eq("supplier", "uniplay")
    .in("game_id", [...syncedGameIds]);

  let marked = 0;
  if (allUniplayProducts) {
    const stale = allUniplayProducts.filter((p) => !syncedProductIds.has(p.id));
    if (stale.length > 0) {
      const { error } = await supabase
        .from("products")
        .update({ is_available: false })
        .in("id", stale.map((p) => p.id));
      if (!error) marked = stale.length;
    }
  }

  console.log(`  📦 Games: +${newGames} new, ~${updatedGames} updated, ⚡ ${unchangedGames} unchanged`);
  console.log(`  🎫 Products: +${newProducts} new, ~${updatedProducts} updated, ⚡ ${unchangedProducts} unchanged, ❌ ${marked} marked unavailable`);

  return { newGames, updatedGames, newProducts, updatedProducts, marked };
}

// ─────────────────────────────────────────────
// Main sync entry point
// ─────────────────────────────────────────────
export async function runSync() {
  const startTime = Date.now();
  console.log("\n════════════════════════════════════");
  console.log(`🔄 Skyra Sync started: ${new Date().toISOString()}`);
  console.log(`   Markup: +${(MARKUP * 100).toFixed(1)}%`);
  console.log("════════════════════════════════════");

  try {
    // Check saldo first
    const saldo = await getSaldo();
    console.log(`💰 UniPlay Saldo: Rp ${saldo.toLocaleString("id-ID")}`);

    // Sync all 3 categories
    const dtuResult = await syncCategory("DTU (Game)", getDTU, "mobile");
    const voucherResult = await syncCategory("Voucher", getVoucher, "voucher");
    const ppobResult = await syncCategory("PPOB", getPPOB, "ppob");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Sync complete in ${elapsed}s`);
    console.log("════════════════════════════════════\n");

    return { success: true, saldo, dtu: dtuResult, voucher: voucherResult, ppob: ppobResult, elapsed };
  } catch (err) {
    console.error("\n❌ Sync FAILED:", err.message);
    console.error(err.stack);
    return { success: false, error: err.message };
  }
}

// Allow running directly: `node src/sync.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runSync().then(() => process.exit(0));
}
