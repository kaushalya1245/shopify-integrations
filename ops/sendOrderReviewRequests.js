require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const DOUBLETICK_TEMPLATE_ENDPOINT =
  "https://public.doubletick.io/whatsapp/message/template";

const DELIVERY_REVIEW_RECORDS = path.resolve(
  __dirname,
  "..",
  "delivery-review-fulfillments.json",
);

const LOCKS_FILE = path.resolve(__dirname, "..", "in-process-locks.json");
const REVIEW_LOG_FILE = path.resolve(__dirname, "..", "delivery-review-logs.jsonl");

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

function appendJsonlLog(filePath, entry) {
  try {
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (err) {
    console.error("Failed to append log:", err?.message || err);
  }
}

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function loadLocks() {
  return loadJson(LOCKS_FILE, {});
}

function saveLocks(locks) {
  saveJson(LOCKS_FILE, locks || {});
}

function lockId(id) {
  const locks = loadLocks();
  if (locks[id]) return false;
  locks[id] = Date.now();
  saveLocks(locks);
  return true;
}

function unlockId(id) {
  const locks = loadLocks();
  delete locks[id];
  saveLocks(locks);
}

function extractDigitsPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isLikelyValidWhatsAppNumberDigits(digits) {
  return Boolean(digits) && String(digits).length >= 10;
}

function getDialCode(countryCode) {
  const cc = String(countryCode || "IN").toUpperCase();
  if (cc === "IN") return "+91";
  // Keep minimal; most of your customers are IN. If needed, extend later.
  return "+91";
}

function normalizeToDoubleTickTo(to) {
  const digitsOnly = String(to || "").replace(/\D/g, "");
  if (!digitsOnly) return "";
  if (digitsOnly.length === 10) return `91${digitsOnly}`;
  return digitsOnly;
}

async function sendDoubleTickTemplateMessage({
  to,
  templateName,
  language = "en",
  bodyPlaceholders = [],
  buttonUrl,
}) {
  const apiKey = process.env.DOUBLETICK_API_KEY;
  if (!apiKey) throw new Error("Missing DOUBLETICK_API_KEY env var");

  const toNormalized = normalizeToDoubleTickTo(to);
  if (!toNormalized) throw new Error("Missing/invalid destination phone number");

  if (!templateName) throw new Error("Missing DoubleTick templateName");

  const payload = {
    messages: [
      {
        to: toNormalized,
        from: "+919136524727",
        content: {
          templateName,
          language,
          templateData: {
            body: {
              placeholders: (bodyPlaceholders || []).map((v) =>
                v === null || v === undefined ? "" : String(v),
              ),
            },
            ...(buttonUrl
              ? {
                  buttons: [
                    {
                      type: "URL",
                      parameter: String(buttonUrl),
                    },
                  ],
                }
              : {}),
          },
        },
      },
    ],
  };

  return axios.post(DOUBLETICK_TEMPLATE_ENDPOINT, payload, {
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
  });
}

function buildReviewButtonUrl({ orderId, orderName }) {
  const tmpl = process.env.REVIEW_BUTTON_URL_TEMPLATE;
  const base = process.env.REVIEW_BUTTON_URL;

  const raw = tmpl
    ? tmpl
        .replaceAll("{orderId}", String(orderId))
        .replaceAll("{orderName}", encodeURIComponent(String(orderName || "")))
    : base;

  return String(raw || "").trim();
}

async function main() {
  const records = loadJson(DELIVERY_REVIEW_RECORDS, {});
  const now = Date.now();

  const effectiveTemplateName =
    process.env.REVIEW_TEMPLATE_NAME ||
    process.env.OR_CAMPAIGN_NAME ||
    "kaj_order_review_v2";
  const language = process.env.DT_LANGUAGE || "en";
  const parsedDelayMs = Number(process.env.REVIEW_DELAY_MS);
  const minAgeMs = Number.isFinite(parsedDelayMs) ? parsedDelayMs : FIVE_DAYS_MS;

  const entries = Object.values(records || {}).filter(Boolean);
  entries.sort((a, b) => Number(a.deliveredAtMs) - Number(b.deliveredAtMs));

  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const rec of entries) {
    const fulfillmentId = rec.fulfillmentId;
    const orderId = rec.orderId;
    const orderName = rec.orderName || String(orderId);
    const deliveredAtMs = Number(rec.deliveredAtMs);

    if (!fulfillmentId || !orderId || !Number.isFinite(deliveredAtMs)) {
      skipped += 1;
      continue;
    }

    if (rec.reviewMessageSent) {
      skipped += 1;
      continue;
    }

    if (deliveredAtMs > now - minAgeMs) {
      skipped += 1;
      continue;
    }

    const lockKey = `review_send:${fulfillmentId}`;
    if (!lockId(lockKey)) {
      skipped += 1;
      continue;
    }

    try {
      // Re-load freshest record before sending (idempotency safety)
      const latest = loadJson(DELIVERY_REVIEW_RECORDS, {});
      const latestRec = latest[String(fulfillmentId)] || rec;
      if (latestRec.reviewMessageSent) {
        skipped += 1;
        continue;
      }

      const recipient = latestRec.recipient || {};
      const name = recipient.name || "Customer";
      const countryCode = recipient.countryCode || "IN";
      const digits = extractDigitsPhone(recipient.digits);

      if (!isLikelyValidWhatsAppNumberDigits(digits)) {
        throw new Error("No valid recipient phone digits for review message");
      }

      const dialCode = getDialCode(countryCode) || "+91";
      const cleaned = digits.slice(-10);
      const to = dialCode + cleaned;

      const buttonUrl = buildReviewButtonUrl({ orderId, orderName });
      if (!buttonUrl) {
        throw new Error(
          "Missing REVIEW_BUTTON_URL or REVIEW_BUTTON_URL_TEMPLATE (template requires button URL)",
        );
      }

      const resp = await sendDoubleTickTemplateMessage({
        to,
        templateName: effectiveTemplateName,
        language,
        bodyPlaceholders: [name, String(orderName)],
        buttonUrl,
      });

      latest[String(fulfillmentId)] = {
        ...latestRec,
        reviewMessageSent: true,
        reviewMessageSentAtMs: Date.now(),
        reviewMessageSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveJson(DELIVERY_REVIEW_RECORDS, latest);

      appendJsonlLog(REVIEW_LOG_FILE, {
        event: "review_message_sent",
        order_id: orderId,
        fulfillment_id: fulfillmentId,
        order_name: orderName,
        delivered_at: latestRec.deliveredAt,
        result: "notified",
        template: effectiveTemplateName,
        to,
        providerResponse: resp?.data || null,
      });

      sent += 1;
    } catch (err) {
      appendJsonlLog(REVIEW_LOG_FILE, {
        event: "review_message_sent",
        order_id: orderId,
        fulfillment_id: fulfillmentId || null,
        order_name: orderName,
        result: "error",
        error: err?.response?.data || err?.message || String(err),
      });
      errors += 1;
    } finally {
      unlockId(lockKey);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        scanned: entries.length,
        sent,
        skipped,
        errors,
        minAgeDays: Math.round((minAgeMs / (24 * 60 * 60 * 1000)) * 100) / 100,
        recordsFile: DELIVERY_REVIEW_RECORDS,
        logFile: REVIEW_LOG_FILE,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("❌ Failed:", err?.response?.data || err?.message || err);
  process.exitCode = 1;
});
