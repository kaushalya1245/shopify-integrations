require("dotenv").config();

const axios = require("axios");
const { countries } = require("country-data");
const {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
} = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");
const fs = require("fs");
const path = require("path");

const DOUBLETICK_TEMPLATE_ENDPOINT =
  "https://public.doubletick.io/whatsapp/message/template";

const dataFiles = {
  deliveries: path.resolve(__dirname, "..", "processed-deliveries.json"),
};

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function extractDigitsPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isLikelyValidWhatsAppNumberDigits(digits) {
  return Boolean(digits) && digits.length >= 10;
}

function getDialCode(countryCode) {
  try {
    const country = countries[String(countryCode || "").toUpperCase()];
    return country ? `${country.countryCallingCodes[0]}` : "+91";
  } catch {
    return "+91";
  }
}

function normalizeToDoubleTickTo(to) {
  const digitsOnly = String(to || "").replace(/\D/g, "");
  if (!digitsOnly) return "";
  if (digitsOnly.length === 10) return `91${digitsOnly}`;
  return digitsOnly;
}

function loadSet(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveSet(filePath, set) {
  fs.writeFileSync(filePath, JSON.stringify(Array.from(set)));
}

async function resolveRecipientForDelivery({ client, order, fulfillment }) {
  const dest = fulfillment?.destination || {};
  const shipping = order?.shipping_address || {};
  const billing = order?.billing_address || {};
  const customer = order?.customer || {};

  const baseCountryCode =
    dest.country_code || shipping.country_code || billing.country_code || "IN";
  const name =
    shipping.first_name ||
    dest.first_name ||
    customer.first_name ||
    billing.first_name ||
    "Customer";

  const candidates = [
    dest.phone,
    shipping.phone,
    billing.phone,
    customer.phone,
    order?.phone,
    customer?.default_address?.phone,
  ];

  for (const cand of candidates) {
    const d = extractDigitsPhone(cand);
    if (isLikelyValidWhatsAppNumberDigits(d)) {
      return { name, countryCode: baseCountryCode, digits: d };
    }
  }

  return { name, countryCode: baseCountryCode, digits: extractDigitsPhone(order?.phone) };
}

async function sendDoubleTickTemplateMessage({ to, templateName, language, bodyPlaceholders }) {
  const apiKey = process.env.DOUBLETICK_API_KEY;
  if (!apiKey) throw new Error("Missing DOUBLETICK_API_KEY");

  const toNormalized = normalizeToDoubleTickTo(to);
  if (!toNormalized) throw new Error("Missing/invalid destination phone number");

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

async function main() {
  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) throw new Error("Missing SHOPIFY_DOMAIN/SHOPIFY_ADMIN_TOKEN");

  const force = hasFlag("force");
  const explicitOrderId = Number(getArg("order") || "");

  const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    adminApiAccessToken: token,
    scopes: ["read_orders"],
    shop,
    apiVersion: LATEST_API_VERSION,
    isCustomStoreApp: true,
    hostName: process.env.HOST_NAME || shop,
    adapter: nodeAdapter,
  });

  const session = new Session({
    id: shop,
    shop,
    accessToken: token,
    state: "active",
    isOnline: false,
  });

  const client = new shopify.clients.Rest({ session });

  let order;
  if (explicitOrderId) {
    const or = await client.get({ path: `orders/${explicitOrderId}` });
    order = or?.body?.order;
  } else {
    const res = await client.get({ path: "orders", query: { status: "any", limit: 50 } });
    const orders = (res?.body?.orders || []).slice().sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );
    order = orders[0];
  }

  if (!order?.id) throw new Error("No order found");

  const fr = await client.get({
    path: `orders/${order.id}/fulfillments`,
    query: { limit: 50 },
  });

  const fulfillments = fr?.body?.fulfillments || [];
  if (!fulfillments.length) {
    throw new Error(`Order ${order.id} has no fulfillments; cannot send delivered message`);
  }

  // Pick the most recently updated fulfillment
  const fulfillment = fulfillments
    .slice()
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];

  const fulfillmentId = fulfillment?.id;
  if (!fulfillmentId) throw new Error("Fulfillment id missing");

  const notified = loadSet(dataFiles.deliveries);
  const idempotencyKey = String(fulfillmentId);
  if (!force && notified.has(idempotencyKey)) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          skipped: true,
          reason: "already_notified",
          orderId: order.id,
          orderName: order.name,
          fulfillmentId,
          idempotencyKey,
        },
        null,
        2,
      ),
    );
    return;
  }

  const recipient = await resolveRecipientForDelivery({ client, order, fulfillment });
  if (!isLikelyValidWhatsAppNumberDigits(recipient.digits)) {
    throw new Error("No valid phone number found on order/fulfillment");
  }

  const dialCode = getDialCode(recipient.countryCode || "IN") || "+91";
  const cleanedPhone = recipient.digits.slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const templateName = process.env.OD_CAMPAIGN_NAME || "kaj_order_delivered_v2";
  const language = process.env.DT_LANGUAGE || "en";

  const orderName = fulfillment?.name
    ? String(fulfillment.name).replace("#", "").split(".")[0]
    : order?.name
      ? String(order.name).replace("#", "")
      : String(order.id);

  const payload = {
    to: phoneNumberInternationalFormat,
    templateName,
    language,
    bodyPlaceholders: [recipient.name || "Customer", `${orderName}`],
  };

  const resp = await sendDoubleTickTemplateMessage(payload);

  notified.add(idempotencyKey);
  saveSet(dataFiles.deliveries, notified);

  console.log(
    JSON.stringify(
      {
        ok: true,
        sent: true,
        orderId: order.id,
        orderName: order.name,
        fulfillmentId,
        to: phoneNumberInternationalFormat,
        templateName,
        providerResponse: resp?.data,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("❌ Failed:", err?.response?.data || err?.response?.body || err?.message || err);
  process.exitCode = 1;
});
