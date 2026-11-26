// ═══════════════════════════════════════════════════════════
// Telegram Bot
// - Sends order notifications (new, paid, fulfilled, failed)
// - Handles inline button callbacks: confirm/reject/recheck
// - Long-polling (getUpdates) — no webhook/public URL needed
// Setup bot: @BotFather → /newbot → paste TELEGRAM_BOT_TOKEN env
// Get chat id: @userinfobot → paste TELEGRAM_CHAT_ID env
// ═══════════════════════════════════════════════════════════

import { supabase } from "./supabase.js";
import { recheckUniPlayOrder } from "./fulfill.js";
import { getSaldo } from "./uniplay.js";
import { pushOrderToSheet, pullPricelist } from "./sheet-sync.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SITE_URL = process.env.PUBLIC_SITE_URL || "https://skyra.id";

const API = `https://api.telegram.org/bot${TOKEN}`;

// Track message_id per order for editing after state changes
const orderMessageMap = new Map(); // orderId → telegram message_id

// ─────────────────────────────────────────────
// Low-level: send / edit / answer callback
// ─────────────────────────────────────────────
async function tg(method, body) {
  if (!TOKEN) {
    console.warn("⚠️  TELEGRAM_BOT_TOKEN not set, skipping", method);
    return null;
  }
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`TG ${method} failed:`, data.description);
  return data;
}

async function send(text, extra = {}) {
  return await tg("sendMessage", {
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function editMessage(messageId, text, extra = {}) {
  return await tg("editMessageText", {
    chat_id: CHAT_ID,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

// HTML-escape user-supplied values so they can't break the message parse
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function answerCallback(callbackId, text = "") {
  return await tg("answerCallbackQuery", { callback_query_id: callbackId, text });
}

// ─────────────────────────────────────────────
// Format order → readable Telegram message
// ─────────────────────────────────────────────
function fmtIDR(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function fmtOrder(o) {
  const custom = Object.entries(o.custom_data || {})
    .map(([k, v]) => `   • ${esc(k)}: <code>${esc(v)}</code>`)
    .join("\n");

  const statusEmoji = {
    pending_payment: "⏳",
    paid: "💰",
    fulfilling: "⚙️",
    done: "✅",
    failed: "❌",
    expired: "⌛",
    cancelled: "🚫",
    refunded: "↩️",
  }[o.status] || "❓";

  const qtyLine = o.qty && o.qty > 1 ? ` <i>(×${o.qty})</i>` : "";
  const contactLines = [
    o.phone ? `📱 ${esc(o.phone)}` : null,
    o.email ? `📧 ${esc(o.email)}` : null,
  ].filter(Boolean).join("\n");

  return (
    `${statusEmoji} <b>${esc(o.order_code)}</b> · <i>${esc(o.status)}</i>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🎮 ${esc(o.game_name)}\n` +
    `💎 ${esc(o.product_name)}${qtyLine}\n` +
    `💰 ${fmtIDR(o.total_idr)}` +
    (o.voucher_code ? ` <i>(voucher ${esc(o.voucher_code)} -${fmtIDR(o.voucher_discount_idr)})</i>` : "") +
    `\n${contactLines || "(no contact)"}\n` +
    (custom ? `\n<b>Data Akun:</b>\n${custom}\n` : "") +
    (o.notes ? `\n📝 <i>${esc(o.notes)}</i>\n` : "") +
    `\n📦 supplier: <code>${esc(o.supplier)}</code>` +
    (o.uniplay_order_id ? `\n🔗 uniplay: <code>${esc(o.uniplay_order_id)}</code>` : "")
  );
}

// ─────────────────────────────────────────────
// Build WhatsApp "send invoice" URL for click-to-WA pattern
// Hera clicks the button → WA opens on her device with pre-filled
// text to the customer's phone. No WA gateway needed.
// ─────────────────────────────────────────────
function buildInvoiceWaUrl(order) {
  const phoneDigits = String(order.phone || "").replace(/\D/g, "");
  if (!phoneDigits) return null; // customer pakai email → tombol WA ga ditampilkan
  const qtyLine = order.qty && order.qty > 1 ? `🔢 Qty: ${order.qty}×\n` : "";
  const msg =
    `Halo kak! Pesanan kamu di Skyra Store selesai ✨\n\n` +
    `📝 Kode Order: ${order.order_code}\n` +
    `🎮 ${order.game_name}\n` +
    `💎 ${order.product_name}\n` +
    qtyLine +
    `💰 Total: ${fmtIDR(order.total_idr)}\n\n` +
    `Cek detail lengkap: ${SITE_URL}/order/${order.order_code}\n\n` +
    `Makasih udah top up di Skyra! 🙏`;
  return `https://wa.me/${phoneDigits}?text=${encodeURIComponent(msg)}`;
}

function buildInvoiceMailtoUrl(order) {
  if (!order.email) return null;
  const qtyLine = order.qty && order.qty > 1 ? `Qty: ${order.qty}×\n` : "";
  const subject = `[Skyra Store] Pesanan ${order.order_code} Selesai`;
  const body =
    `Halo kak!\n\nPesanan kamu di Skyra Store selesai ✨\n\n` +
    `Kode Order: ${order.order_code}\n` +
    `Game: ${order.game_name}\n` +
    `Paket: ${order.product_name}\n` +
    qtyLine +
    `Total: ${fmtIDR(order.total_idr)}\n\n` +
    `Cek detail: ${SITE_URL}/order/${order.order_code}\n\n` +
    `Makasih udah top up di Skyra! 🙏`;
  return `mailto:${order.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// ─────────────────────────────────────────────
// Notification helpers (called from poller / webhook)
// ─────────────────────────────────────────────
export async function notifyNewOrder(order) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ Udah Bayar (manual)", callback_data: `confirm_paid:${order.id}` },
        { text: "🚫 Cancel", callback_data: `cancel:${order.id}` },
      ],
    ],
  };
  const msg = `🔔 <b>ORDER BARU</b> (nunggu pembayaran)\n\n${fmtOrder(order)}`;
  const result = await send(msg, { reply_markup: keyboard });
  if (result?.ok) orderMessageMap.set(order.id, result.result.message_id);
}

export async function notifyPaid(order) {
  const isManual = order.supplier === "manual" || order.supplier === "lapakgaming";
  const msg = isManual
    ? `💰 <b>PAYMENT RECEIVED</b> — perlu fulfillment manual\n\n${fmtOrder(order)}`
    : `💰 <b>PAYMENT RECEIVED</b> — auto-fulfilling…\n\n${fmtOrder(order)}`;

  // Manual orders get action buttons so admin can override status
  const keyboard = isManual
    ? {
        inline_keyboard: [
          [
            { text: "▶ Set Processing", callback_data: `set_processing:${order.id}` },
            { text: "✅ Mark DONE", callback_data: `mark_done:${order.id}` },
          ],
          [
            { text: "❌ Mark FAILED", callback_data: `mark_failed:${order.id}` },
          ],
        ],
      }
    : undefined;

  const mid = orderMessageMap.get(order.id);
  const opts = keyboard ? { reply_markup: keyboard } : {};
  if (mid) {
    await editMessage(mid, msg, opts);
  } else {
    const result = await send(msg, opts);
    if (result?.ok) orderMessageMap.set(order.id, result.result.message_id);
  }
}

export async function notifyFulfilled(order) {
  const msg = `✅ <b>ORDER FULFILLED</b>\n\n${fmtOrder(order)}`;

  // Click-to-WA / Email invoice button — Hera clicks, WA/Mail opens with pre-filled text to customer
  const waUrl = buildInvoiceWaUrl(order);
  const mailUrl = buildInvoiceMailtoUrl(order);
  const buttons = [];
  if (waUrl) buttons.push({ text: "📤 Kirim Invoice (WA)", url: waUrl });
  if (mailUrl) buttons.push({ text: "📧 Kirim Invoice (Email)", url: mailUrl });
  const keyboard = buttons.length ? { inline_keyboard: [buttons] } : undefined;
  const opts = keyboard ? { reply_markup: keyboard } : {};

  const mid = orderMessageMap.get(order.id);
  if (mid) await editMessage(mid, msg, opts);
  else await send(msg, opts);
}

export async function notifyFailed(order, reason) {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "🔁 Retry", callback_data: `retry:${order.id}` },
        { text: "🔍 Recheck UniPlay", callback_data: `recheck:${order.id}` },
      ],
    ],
  };
  const msg = `❌ <b>ORDER FAILED</b>\n\n${fmtOrder(order)}\n\n⚠️ <i>${esc(reason)}</i>`;
  const mid = orderMessageMap.get(order.id);
  if (mid) await editMessage(mid, msg, { reply_markup: keyboard });
  else await send(msg, { reply_markup: keyboard });
}

// ─────────────────────────────────────────────
// Callback handlers
// ─────────────────────────────────────────────
async function handleCallback(cb) {
  const data = cb.data || "";
  const [action, orderId] = data.split(":");

  if (!orderId) {
    await answerCallback(cb.id, "Invalid callback");
    return;
  }

  // Cache message id
  if (cb.message?.message_id) orderMessageMap.set(orderId, cb.message.message_id);

  if (action === "confirm_paid") {
    // Check current state first so we can give a better error
    const { data: existing } = await supabase
      .from("orders")
      .select("status")
      .eq("id", orderId)
      .single();
    if (!existing) {
      await answerCallback(cb.id, "Order not found");
      return;
    }
    if (["paid", "fulfilling", "done"].includes(existing.status)) {
      await answerCallback(cb.id, `Already ${existing.status}`);
      return;
    }
    // Allow confirm from any non-terminal payment state (pending/expired)
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "paid", paid_at: new Date().toISOString(), payment_method: "manual" })
      .eq("id", orderId)
      .in("status", ["pending_payment", "expired"])
      .select()
      .single();

    if (order) {
      await answerCallback(cb.id, "Marked paid ✅");
      await notifyPaid(order);
      await pushOrderToSheet(order); // insert ke ORDER WEB
    } else {
      await answerCallback(cb.id, `Can't confirm (current: ${existing.status})`);
    }
    return;
  }

  if (action === "cancel") {
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "cancelled" })
      .eq("id", orderId)
      .select()
      .single();

    if (order) {
      await answerCallback(cb.id, "Cancelled");
      const mid = orderMessageMap.get(orderId);
      if (mid) await editMessage(mid, `🚫 <b>CANCELLED</b>\n\n${fmtOrder(order)}`, {});
      await pushOrderToSheet(order); // cancelled → sheet (biar laba = 0)
    }
    return;
  }

  if (action === "retry") {
    // Reset to paid → poller will pick it up
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "paid" })
      .eq("id", orderId)
      .select()
      .single();
    if (order) {
      await answerCallback(cb.id, "Queued for retry");
      await notifyPaid(order);
    }
    return;
  }

  if (action === "set_processing") {
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "fulfilling", fulfilling_at: new Date().toISOString() })
      .eq("id", orderId)
      .in("status", ["paid"])
      .select()
      .single();
    if (order) {
      await answerCallback(cb.id, "Marked as processing");
      const mid = orderMessageMap.get(orderId);
      const keyboard = {
        inline_keyboard: [[
          { text: "✅ Mark DONE", callback_data: `mark_done:${orderId}` },
          { text: "❌ Mark FAILED", callback_data: `mark_failed:${orderId}` },
        ]],
      };
      if (mid) await editMessage(mid, `⚙️ <b>PROCESSING</b>\n\n${fmtOrder(order)}`, { reply_markup: keyboard });
      await pushOrderToSheet(order); // update sheet status → fulfilling
    } else {
      await answerCallback(cb.id, "Can't set processing (bukan paid)");
    }
    return;
  }

  if (action === "mark_done") {
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "done", fulfilled_at: new Date().toISOString() })
      .eq("id", orderId)
      .in("status", ["paid", "fulfilling"])
      .select()
      .single();
    if (order) {
      await answerCallback(cb.id, "Marked DONE ✅");
      await notifyFulfilled(order);
      await pushOrderToSheet(order); // manual done → ORDER WEB
    } else {
      await answerCallback(cb.id, "Can't mark done (status ga match)");
    }
    return;
  }

  if (action === "mark_failed") {
    const { data: order } = await supabase
      .from("orders")
      .update({ status: "failed" })
      .eq("id", orderId)
      .select()
      .single();
    if (order) {
      await answerCallback(cb.id, "Marked FAILED ❌");
      await notifyFailed(order, "Manual admin override");
      await pushOrderToSheet(order); // failed → sheet (laba 0)
    }
    return;
  }

  if (action === "recheck") {
    const result = await recheckUniPlayOrder(orderId);
    await answerCallback(cb.id, result.success ? "Recheck done — see logs" : `Fail: ${result.message}`);
    return;
  }

  await answerCallback(cb.id, "Unknown action");
}

// ─────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────
async function handleCommand(msg) {
  const text = (msg.text || "").trim();

  if (text === "/start" || text === "/help") {
    await send(
      `🤖 <b>Skyra Bot</b>\n\n` +
        `<b>📊 Orders & Stats</b>\n` +
        `/stats — overview hari ini\n` +
        `/orders — 5 order terakhir\n` +
        `/pending — order yg butuh action\n` +
        `/status &lt;code&gt; — detail order\n` +
        `/revenue [day|week|month] — omzet\n\n` +
        `<b>💰 Supplier & Sync</b>\n` +
        `/saldo — saldo UniPlay\n` +
        `/pullsheet — sync pricelist dari Sheet\n\n` +
        `<b>👤 User</b>\n` +
        `/user &lt;email&gt; — lookup user\n` +
        `/saldo_add &lt;email&gt; &lt;amount&gt; [note]\n` +
        `/saldo_sub &lt;email&gt; &lt;amount&gt; [note]\n\n` +
        `<b>🎫 Voucher</b>\n` +
        `/voucher_list — voucher aktif\n` +
        `/voucher_new &lt;code&gt; &lt;min&gt; &lt;%&gt; &lt;days&gt;\n` +
        `/voucher_off &lt;code&gt;\n\n` +
        `<b>⭐ VIP Member</b>\n` +
        `/vip_on &lt;email&gt; &lt;@ig_handle&gt;\n` +
        `/vip_off &lt;email&gt;\n` +
        `/vip_list — daftar VIP aktif\n\n` +
        `<b>📦 Katalog</b>\n` +
        `/stock_off &lt;sku&gt;  /stock_on &lt;sku&gt;\n` +
        `/game_off &lt;slug&gt; /game_on &lt;slug&gt;`
    );
    return;
  }

  // ─── /stats ───
  if (text === "/stats") {
    const todayISO = new Date().toISOString().slice(0, 10);
    const { data: today } = await supabase.from("orders")
      .select("status, total_idr").gte("created_at", todayISO);
    const paid = (today || []).filter((o) => ["paid", "fulfilling", "done"].includes(o.status));
    const rev = paid.reduce((s, o) => s + Number(o.total_idr || 0), 0);
    const { count: totalUsers } = await supabase.from("wallets").select("*", { count: "exact", head: true });
    const { data: wSum } = await supabase.from("wallets").select("balance_idr");
    const walletTotal = (wSum || []).reduce((s, w) => s + Number(w.balance_idr || 0), 0);
    await send(
      `📊 <b>Stats Skyra — ${todayISO}</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📥 Orders today: <b>${today?.length || 0}</b> (paid: ${paid.length})\n` +
      `💵 Revenue today: <b>${fmtIDR(rev)}</b>\n` +
      `👤 Users: <b>${totalUsers || 0}</b>\n` +
      `👛 Total wallet balance: <b>${fmtIDR(walletTotal)}</b>`
    );
    return;
  }

  // ─── /revenue [day|week|month] ───
  if (text.startsWith("/revenue")) {
    const period = text.split(/\s+/)[1] || "day";
    const now = new Date();
    const since = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1)
                : period === "week"  ? new Date(now.getTime() - 7 * 86400000)
                : new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const { data } = await supabase.from("orders")
      .select("total_idr, voucher_discount_idr, status")
      .gte("created_at", since.toISOString())
      .in("status", ["paid", "fulfilling", "done"]);
    const rev = (data || []).reduce((s, o) => s + Number(o.total_idr || 0), 0);
    const discount = (data || []).reduce((s, o) => s + Number(o.voucher_discount_idr || 0), 0);
    await send(
      `💵 <b>Revenue (${period})</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `Gross: <b>${fmtIDR(rev)}</b> · ${data?.length || 0} orders\n` +
      `Voucher given out: ${fmtIDR(discount)}\n` +
      `Period: sejak ${since.toLocaleDateString("id-ID")}`
    );
    return;
  }

  // ─── /user <email> ───
  if (text.startsWith("/user ")) {
    const email = text.slice(6).trim().toLowerCase();
    const { data: userResp } = await supabase.auth.admin.listUsers();
    const u = userResp?.users?.find((x) => x.email?.toLowerCase() === email);
    if (!u) return await send(`❌ User <code>${esc(email)}</code> tidak ditemukan`);
    const [wallet, orders, claims] = await Promise.all([
      supabase.from("wallets").select("balance_idr").eq("user_id", u.id).maybeSingle(),
      supabase.from("orders").select("order_code, total_idr, status").eq("user_id", u.id).order("created_at", { ascending: false }).limit(5),
      supabase.from("vouchers_claimed").select("voucher_code, used_at").eq("user_id", u.id),
    ]);
    const claimTotal = claims.data?.length || 0;
    const claimUsed = (claims.data || []).filter((c) => c.used_at).length;
    const orderLines = (orders.data || []).slice(0, 5)
      .map((o) => `  • <code>${o.order_code}</code> ${o.status} ${fmtIDR(o.total_idr)}`).join("\n") || "  <i>(belum ada order)</i>";
    await send(
      `👤 <b>${esc(email)}</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💰 Balance: <b>${fmtIDR(wallet.data?.balance_idr || 0)}</b>\n` +
      `🎫 Voucher: ${claimUsed}/${claimTotal} used\n` +
      `📦 Recent orders:\n${orderLines}`
    );
    return;
  }

  // ─── /saldo_add <email> <amount> [note] ───
  if (text.startsWith("/saldo_add ") || text.startsWith("/saldo_sub ")) {
    const isAdd = text.startsWith("/saldo_add ");
    const parts = text.split(/\s+/);
    const email = (parts[1] || "").toLowerCase();
    const amount = Math.abs(parseInt(parts[2] || "0", 10));
    const note = parts.slice(3).join(" ") || (isAdd ? "Topup manual admin" : "Pengurangan manual admin");
    if (!email || !amount) return await send(`❌ Usage: <code>${isAdd ? "/saldo_add" : "/saldo_sub"} email amount [note]</code>`);

    const { data: userResp } = await supabase.auth.admin.listUsers();
    const u = userResp?.users?.find((x) => x.email?.toLowerCase() === email);
    if (!u) return await send(`❌ User <code>${esc(email)}</code> tidak ditemukan`);

    const { data, error } = await supabase.rpc("apply_wallet_tx", {
      p_user_id: u.id,
      p_tx_type: isAdd ? "admin_add" : "admin_sub",
      p_amount_idr: isAdd ? amount : -amount,
      p_description: note,
      p_related_order_id: null,
      p_midtrans_order_id: null,
    });
    if (error) return await send(`❌ RPC failed: <code>${esc(error.message)}</code>`);
    const balance = data?.balance ?? "?";
    await send(`${isAdd ? "✅" : "➖"} <b>${isAdd ? "+" : "-"}${fmtIDR(amount)}</b> ${esc(email)}\nSaldo baru: ${fmtIDR(balance)}\n📝 ${esc(note)}`);
    return;
  }

  // ─── /voucher_list ───
  if (text === "/voucher_list") {
    const { data } = await supabase.from("vouchers")
      .select("code, title, discount_type, discount_value, max_discount_idr, min_purchase_idr, used_count, max_uses, expires_at, is_active")
      .order("is_active", { ascending: false }).order("code");
    if (!data?.length) return await send("<i>Belum ada voucher.</i>");
    const lines = data.map((v) => {
      const d = v.discount_type === "percentage" ? `${v.discount_value}%` : fmtIDR(v.discount_value);
      const cap = v.max_uses ? `${v.used_count || 0}/${v.max_uses}` : `${v.used_count || 0}/∞`;
      const exp = v.expires_at ? new Date(v.expires_at).toLocaleDateString("id-ID") : "∞";
      const status = v.is_active ? "🟢" : "⚫";
      return `${status} <code>${v.code}</code> — ${d} min ${fmtIDR(v.min_purchase_idr)} · ${cap} · exp ${exp}`;
    }).join("\n");
    await send(`🎫 <b>Vouchers</b>\n━━━━━━━━━━━━━━━\n${lines}`);
    return;
  }

  // ─── /voucher_new <code> <min> <percent> <days> ───
  if (text.startsWith("/voucher_new ")) {
    const parts = text.split(/\s+/);
    const code = (parts[1] || "").toUpperCase();
    const min = parseInt(parts[2] || "0", 10);
    const pct = parseInt(parts[3] || "0", 10);
    const days = parseInt(parts[4] || "30", 10);
    if (!code || !min || !pct) return await send(`❌ Usage: <code>/voucher_new CODE min_idr percent days</code>\nContoh: <code>/voucher_new WELCOME10 100000 10 30</code>`);
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    const { error } = await supabase.from("vouchers").insert({
      code, title: `Diskon ${pct}% Min ${fmtIDR(min)}`,
      description: `Diskon ${pct}% untuk belanja min ${fmtIDR(min)}, berlaku ${days} hari.`,
      discount_type: "percentage", discount_value: pct,
      min_purchase_idr: min, max_discount_idr: null, max_uses: null,
      per_user_limit: 1, is_public: true, is_active: true, expires_at: expires,
    });
    if (error) return await send(`❌ Insert failed: <code>${esc(error.message)}</code>`);
    await send(`✅ Voucher <code>${code}</code> created · ${pct}% off · min ${fmtIDR(min)} · exp ${days} hari`);
    return;
  }

  // ─── /voucher_off <code> ───
  if (text.startsWith("/voucher_off ")) {
    const code = text.slice(13).trim().toUpperCase();
    const { error } = await supabase.from("vouchers").update({ is_active: false }).eq("code", code);
    if (error) return await send(`❌ ${esc(error.message)}`);
    await send(`🔒 Voucher <code>${code}</code> dinonaktifkan`);
    return;
  }

  // ─── /vip_on <email> <ig_handle> ───
  // Grant VIP status: create (if not exists) a vip_mode voucher with the IG
  // handle, scoped to Roblox / Sky / Heartopia, then claim it for the user.
  // Unlimited use — admin revokes via /vip_off when unfollow detected.
  const VIP_GAME_SLUGS = ["roblox-login", "roblox-username", "sky-via-id", "sky-via-login", "sky-via-gift", "heartopia"];
  if (text.startsWith("/vip_on ")) {
    const parts = text.split(/\s+/);
    const email = (parts[1] || "").toLowerCase();
    const igRaw = (parts[2] || "").replace(/^@/, "").trim();
    if (!email || !igRaw) return await send(`❌ Usage: <code>/vip_on email @ig_handle</code>`);
    const code = `VIP-${igRaw.toUpperCase().replace(/[^A-Z0-9_]/g, "")}`;
    const { data: userResp } = await supabase.auth.admin.listUsers();
    const u = userResp?.users?.find((x) => x.email?.toLowerCase() === email);
    if (!u) return await send(`❌ User <code>${esc(email)}</code> tidak ditemukan`);

    // Upsert voucher
    await supabase.from("vouchers").upsert({
      code,
      title: `VIP Member — @${igRaw}`,
      description: `Harga VIP untuk @${igRaw}. Aktif selama follow Instagram @skyra_store2.`,
      discount_type: "percentage",
      discount_value: 0,
      max_discount_idr: null,
      min_purchase_idr: 0,
      max_uses: null,
      per_user_limit: null,
      is_public: false,
      is_active: true,
      vip_mode: true,
      game_slugs: VIP_GAME_SLUGS,
    }, { onConflict: "code" });

    // Attach claim for user (ignore if already exists)
    await supabase.from("vouchers_claimed").upsert({
      user_id: u.id,
      voucher_code: code,
    }, { onConflict: "user_id,voucher_code", ignoreDuplicates: true });

    await send(
      `⭐ <b>VIP ACTIVATED</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `User: <code>${esc(email)}</code>\n` +
      `IG: <b>@${esc(igRaw)}</b>\n` +
      `Voucher: <code>${code}</code>\n` +
      `Scope: Roblox, Sky, Heartopia\n` +
      `Status: 🟢 Aktif (unlimited use)`
    );
    return;
  }

  // ─── /vip_off <email> ───
  // Revoke: deactivate the user's VIP voucher. Checkout will fall back to NON VIP.
  if (text.startsWith("/vip_off ")) {
    const email = text.slice(9).trim().toLowerCase();
    const { data: userResp } = await supabase.auth.admin.listUsers();
    const u = userResp?.users?.find((x) => x.email?.toLowerCase() === email);
    if (!u) return await send(`❌ User <code>${esc(email)}</code> tidak ditemukan`);

    // Find user's claimed vip voucher
    const { data: claim } = await supabase
      .from("vouchers_claimed")
      .select("voucher_code, voucher:vouchers!inner(vip_mode)")
      .eq("user_id", u.id);
    const vipClaim = (claim || []).find((c) => c.voucher?.vip_mode);
    if (!vipClaim) return await send(`ℹ️ ${esc(email)} bukan VIP.`);

    await supabase.from("vouchers").update({ is_active: false }).eq("code", vipClaim.voucher_code);
    await send(`🔒 VIP revoked: <code>${esc(email)}</code> — voucher <code>${vipClaim.voucher_code}</code> nonaktif`);
    return;
  }

  // ─── /vip_list ───
  if (text === "/vip_list") {
    const { data: vips } = await supabase
      .from("vouchers_claimed")
      .select("user_id, claimed_at, voucher:vouchers!inner(code, title, is_active, vip_mode)")
      .order("claimed_at", { ascending: false });
    const active = (vips || []).filter((c) => c.voucher?.vip_mode && c.voucher?.is_active);
    if (!active.length) return await send("<i>Belum ada VIP member aktif.</i>");
    const { data: userResp } = await supabase.auth.admin.listUsers();
    const emailOf = (uid) => userResp?.users?.find((u) => u.id === uid)?.email || uid.slice(0, 8);
    const lines = active.map((c) => `⭐ <code>${emailOf(c.user_id)}</code> — ${esc(c.voucher.code)}`).join("\n");
    await send(`<b>👑 VIP Members Aktif (${active.length})</b>\n━━━━━━━━━━━━━━━\n${lines}`);
    return;
  }

  // ─── /stock_on | /stock_off <sku> ───
  if (text.startsWith("/stock_on ") || text.startsWith("/stock_off ")) {
    const on = text.startsWith("/stock_on ");
    const sku = text.slice(on ? 10 : 11).trim();
    const { error, data } = await supabase.from("products").update({ is_available: on }).eq("supplier_sku", sku).select("name");
    if (error || !data?.length) return await send(`❌ SKU <code>${esc(sku)}</code> tidak ditemukan`);
    await send(`${on ? "🟢" : "🔴"} <b>${esc(data[0].name)}</b> ${on ? "aktif" : "nonaktif"}`);
    return;
  }

  // ─── /game_on | /game_off <slug> ───
  if (text.startsWith("/game_on ") || text.startsWith("/game_off ")) {
    const on = text.startsWith("/game_on ");
    const slug = text.slice(on ? 9 : 10).trim();
    const { error, data } = await supabase.from("games").update({ is_active: on }).eq("slug", slug).select("name");
    if (error || !data?.length) return await send(`❌ Game <code>${esc(slug)}</code> tidak ditemukan`);
    await send(`${on ? "🟢" : "🔴"} Game <b>${esc(data[0].name)}</b> ${on ? "muncul di home" : "disembunyikan"}`);
    return;
  }

  if (text === "/saldo") {
    try {
      const saldo = await getSaldo();
      await send(`💰 <b>UniPlay Saldo:</b> ${fmtIDR(saldo)}`);
    } catch (e) {
      await send(`❌ Error cek saldo: <code>${esc(e.message)}</code>`);
    }
    return;
  }

  if (text === "/orders") {
    const { data } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(5);
    if (!data?.length) {
      await send("<i>Belum ada order.</i>");
      return;
    }
    for (const o of data) {
      await send(fmtOrder(o));
    }
    return;
  }

  if (text === "/pending") {
    const { data } = await supabase
      .from("orders")
      .select("*")
      .in("status", ["pending_payment", "paid", "fulfilling", "failed"])
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data?.length) {
      await send("<i>Semua order sudah done 🎉</i>");
      return;
    }
    for (const o of data) {
      const keyboard = o.status === "pending_payment"
        ? { inline_keyboard: [[
            { text: "✅ Udah Bayar", callback_data: `confirm_paid:${o.id}` },
            { text: "🚫 Cancel", callback_data: `cancel:${o.id}` },
          ]]}
        : o.status === "failed"
        ? { inline_keyboard: [[{ text: "🔁 Retry", callback_data: `retry:${o.id}` }]] }
        : undefined;
      const res = await send(fmtOrder(o), keyboard ? { reply_markup: keyboard } : {});
      if (res?.ok) orderMessageMap.set(o.id, res.result.message_id);
    }
    return;
  }

  if (text === "/pullsheet" || text === "/pull-sheet") {
    await send("⏳ Pulling pricelist dari Sheet…");
    const result = await pullPricelist();
    if (result.success) {
      await send(
        `✅ <b>Sheet sync done</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📥 Upserted: <b>${result.upserted}</b>\n` +
        `⚠️ Skipped: ${result.skipped}\n` +
        `🚫 Deactivated: ${result.deactivated}`
      );
    } else {
      await send(`❌ Pull failed: <code>${esc(result.message)}</code>`);
    }
    return;
  }

  if (text.startsWith("/status ")) {
    const code = text.slice(8).trim();
    const { data } = await supabase.from("orders").select("*").eq("order_code", code).single();
    if (!data) return await send(`❌ Order <code>${esc(code)}</code> not found`);
    await send(fmtOrder(data));
    return;
  }
}

// ─────────────────────────────────────────────
// Long polling loop
// ─────────────────────────────────────────────
let lastUpdateId = 0;

async function pollUpdates() {
  try {
    const res = await fetch(`${API}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`);
    const data = await res.json();
    if (!data.ok) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;

      try {
        if (update.message) {
          // Only accept from configured chat id
          if (String(update.message.chat.id) !== String(CHAT_ID)) {
            console.warn("Ignoring message from unauthorized chat:", update.message.chat.id);
            continue;
          }
          await handleCommand(update.message);
        }
        if (update.callback_query) {
          if (String(update.callback_query.from.id) !== String(CHAT_ID)) {
            await answerCallback(update.callback_query.id, "Unauthorized");
            continue;
          }
          await handleCallback(update.callback_query);
        }
      } catch (e) {
        console.error("Update handler error:", e);
      }
    }
  } catch (e) {
    // network error — swallow and retry
  }
}

export async function startBot() {
  if (!TOKEN || !CHAT_ID) {
    console.warn("⚠️  Telegram bot NOT started — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing");
    return;
  }
  console.log("🤖 Telegram bot started (long polling)");
  await send("🚀 <b>Skyra Worker Online</b> — ready to process orders");

  // Infinite long-poll loop
  (async function loop() {
    while (true) {
      await pollUpdates();
      // tiny delay to prevent tight-loop in error states
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
}
