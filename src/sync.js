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
  let newGames = 0, updatedGames = 0, newProducts = 0, updatedProducts = 0;

  for (const item of list) {
    // 1. UPSERT game
    const gameSlug = `${category}-${slugify(item.name)}`;
    const gameData = {
      slug: gameSlug,
      name: item.name,
      publisher: item.publisher || null,
      icon_emoji: "🎮",
      image_url: item.image || null,
      color_theme: "default",
      category,
      input_type: category === "voucher" ? "none" : category === "ppob" ? "user_id" : "user_id",
      input_fields: category === "voucher" ? [] : [
        { key: "user_id", label: "User ID", type: "text", required: true },
        { key: "server_id", label: "Server ID (opsional)", type: "text", required: false },
      ],
      instructions: item.publisher_website ? `Website: ${item.publisher_website}` : null,
      is_active: true,
      is_featured: false,
      sort_order: 0,
    };

    const { data: upsertedGame, error: gameErr } = await supabase
      .from("games")
      .upsert(gameData, { onConflict: "slug", ignoreDuplicates: false })
      .select("id, created_at")
      .single();

    if (gameErr) {
      console.error(`  ✗ Game error (${item.name}):`, gameErr.message);
      continue;
    }
    syncedGameIds.add(upsertedGame.id);
    const isNewGame = new Date(upsertedGame.created_at) > new Date(Date.now() - 60000);
    if (isNewGame) newGames++; else updatedGames++;

    // 2. UPSERT products (denom)
    for (const denom of item.denom || []) {
      const cost = Number(denom.price);
      const sell = sellPrice(cost);

      // Check existing by supplier_sku
      const { data: existing } = await supabase
        .from("products")
        .select("id")
        .eq("supplier_sku", denom.id)
        .eq("supplier", "uniplay")
        .maybeSingle();

      const productData = {
        game_id: upsertedGame.id,
        name: denom.package,
        amount: null,
        unit: null,
        price_idr: sell,
        cost_idr: cost,
        supplier: "uniplay",
        supplier_sku: denom.id,
        notes: `[uniplay/${category}] ${item.name}`,
        is_hot: false,
        is_available: true,
        sort_order: 0,
      };

      if (existing) {
        const { error } = await supabase
          .from("products")
          .update(productData)
          .eq("id", existing.id);
        if (!error) {
          syncedProductIds.add(existing.id);
          updatedProducts++;
        }
      } else {
        const { data: inserted, error } = await supabase
          .from("products")
          .insert(productData)
          .select("id")
          .single();
        if (!error && inserted) {
          syncedProductIds.add(inserted.id);
          newProducts++;
        }
      }
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

  console.log(`  📦 Games: +${newGames} new, ~${updatedGames} updated`);
  console.log(`  🎫 Products: +${newProducts} new, ~${updatedProducts} updated, ❌ ${marked} marked unavailable`);

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
