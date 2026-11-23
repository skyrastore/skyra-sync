// ═══════════════════════════════════════════════════════════
// UniPlay Reseller API Client
// Docs: https://documenter.getpostman.com/view/2760553/TzsbKnVP
// ═══════════════════════════════════════════════════════════

import crypto from "crypto";

const BASE_URL = "https://api-reseller.uniplay.id/v1";

// ─────────────────────────────────────────────
// Signature: HMAC-SHA512 with custom key format
// Format: api_key + '|' + json_string
// ─────────────────────────────────────────────
function generateSignature(apiKey, timestamp, extraBody = {}) {
  const body = { api_key: apiKey, timestamp, ...extraBody };
  const jsonString = JSON.stringify(body);
  const hmacKey = `${apiKey}|${jsonString}`;
  return crypto.createHmac("sha512", hmacKey).update(jsonString).digest("hex");
}

// ─────────────────────────────────────────────
// Timestamp format: YYYY-MM-DD HH:mm:ss (UTC+7)
// ─────────────────────────────────────────────
function getTimestamp() {
  const d = new Date(Date.now() + 7 * 3600 * 1000); // WIB
  return d.toISOString().replace("T", " ").split(".")[0];
}

// ─────────────────────────────────────────────
// Core request helper
// ─────────────────────────────────────────────
async function uplRequest(endpoint, body, accessToken = null) {
  const headers = {
    "Content-Type": "application/json",
    "UPL-SIGNATURE": generateSignature(body.api_key, body.timestamp, _omit(body, ["api_key", "timestamp"])),
  };
  if (accessToken) headers["UPL-ACCESS-TOKEN"] = accessToken;

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.status !== "200") {
    throw new Error(`UniPlay ${endpoint} failed [${data.status}]: ${data.message}`);
  }
  return data;
}

function _omit(obj, keys) {
  const out = { ...obj };
  keys.forEach((k) => delete out[k]);
  return out;
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

const apiKey = process.env.UNIPLAY_API_KEY;
if (!apiKey) throw new Error("UNIPLAY_API_KEY env var not set");

export async function getAccessToken() {
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp };
  const data = await uplRequest("/access-token", body);
  return data.access_token;
}

export async function getSaldo() {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp };
  const data = await uplRequest("/inquiry-saldo", body, token);
  return Number(data.saldo);
}

export async function getDTU() {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp };
  const data = await uplRequest("/inquiry-dtu", body, token);
  return data.list_dtu || [];
}

export async function getVoucher() {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp };
  const data = await uplRequest("/inquiry-voucher", body, token);
  return data.list_voucher || [];
}

export async function getPPOB() {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp };
  const data = await uplRequest("/inquiry-ppob", body, token);
  return data.list_dtu || []; // note: PPOB response pakai key "list_dtu" juga (dari docs)
}

export async function inquiryPayment({ entitasId, denomId, userId = "", serverId = "" }) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = {
    api_key: apiKey,
    timestamp,
    entitas_id: entitasId,
    denom_id: denomId,
    user_id: userId,
    server_id: serverId,
  };
  const data = await uplRequest("/inquiry-payment", body, token);
  return { inquiryId: data.inquiry_id, info: data.inquiry_info };
}

export async function confirmPayment({ inquiryId, pincode }) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = {
    api_key: apiKey,
    timestamp,
    inquiry_id: inquiryId,
    pincode,
  };
  const data = await uplRequest("/confirm-payment", body, token);
  return { orderId: data.order_id, info: data.order_info };
}

export async function checkOrder(orderId) {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const body = { api_key: apiKey, timestamp, order_id: orderId };
  const data = await uplRequest("/check-order", body, token);
  return { orderId: data.order_id, info: data.order_info };
}
