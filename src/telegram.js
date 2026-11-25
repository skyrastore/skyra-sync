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
      await pushOrderToSheet(order); // manual done → append to HARIAN
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
      `🤖 <b>Skyra Bot ready!</b>\n\n` +
        `Commands:\n` +
        `/saldo — cek saldo UniPlay\n` +
        `/orders — list 5 order terakhir\n` +
        `/pending — list order status=paid/pending\n` +
        `/status &lt;code&gt; — detail order by code\n` +
        `/pullsheet — force sync pricelist dari Google Sheet`
    );
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
