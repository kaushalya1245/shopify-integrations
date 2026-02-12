require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
} = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");
const { razorpayClient } = require("./razorpayClient");
const { countries } = require("country-data");
const cheerio = require("cheerio");

const DOUBLETICK_TEMPLATE_ENDPOINT =
  "https://public.doubletick.io/whatsapp/message/template";

const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: true }));

// Message queue and suppression logic
const CHECK_INTERVAL = 60 * 1000; // 1 minute
const SEND_MESSAGE_DELAY = 60 * 60 * 1000; // Change
const MINUTES_FOR_PAYMENT_CHECK = 120; // Payment check from 2 hours ago
let isSending = false;
const messageQueue = [];
const processingPayments = new Set();
const queuedAbandonedCartTokens = new Set();

function enqueueAbandonedCheckout(checkout, reason = "") {
  const cartToken = checkout?.cart_token;
  if (!cartToken) return;

  if (queuedAbandonedCartTokens.has(cartToken)) {
    if (reason) {
      console.log(
        `Abandoned checkout already queued for cart_token: ${cartToken}. Skipping enqueue (${reason}).`,
      );
    }
    return;
  }

  queuedAbandonedCartTokens.add(cartToken);
  messageQueue.push({ checkout, cartToken });
  processQueue();
}

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  scopes: ["read_orders", "write_orders", "read_checkouts", "read_customers"],
  shop: process.env.SHOPIFY_DOMAIN,
  apiVersion: LATEST_API_VERSION,
  isCustomStoreApp: true,
  hostName: process.env.HOST_NAME,
  adapter: nodeAdapter,
});

const session = new Session({
  id: process.env.SHOPIFY_DOMAIN,
  shop: process.env.SHOPIFY_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  state: "active",
  isOnline: false,
});

const client = new shopify.clients.Rest({ session });

const dataFiles = {
  checkouts: path.resolve(__dirname, "debounced-checkouts.json"),
  orders: path.resolve(__dirname, "processed-orders.json"),
  fulfillments: path.resolve(__dirname, "processed-fulfillments.json"),
  deliveries: path.resolve(__dirname, "processed-deliveries.json"),
  deliveryReviewRecords: path.resolve(__dirname, "delivery-review-records.json"),
  deliveryReviewFulfillments: path.resolve(
    __dirname,
    "delivery-review-fulfillments.json",
  ),
  storeCreditRefunds: path.resolve(
    __dirname,
    "processed-store-credit-refunds.json",
  ),
  payments: path.resolve(__dirname, "processed-payments.json"),
  locks: path.resolve(__dirname, "in-process-locks.json"),
};

const deliveryWebhookLogFile = path.resolve(
  __dirname,
  "delivery-webhook-logs.jsonl",
);

const storeCreditRefundWebhookLogFile = path.resolve(
  __dirname,
  "store-credit-refund-webhook-logs.jsonl",
);

const deliveryReviewLogFile = path.resolve(
  __dirname,
  "delivery-review-logs.jsonl",
);

// In-memory timers to send review messages close to the target delay.
// Persistence + periodic scan still acts as a fallback across restarts.
const __reviewTimersByFulfillmentId = new Map();

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

function verifyShopifyWebhookHmac(req) {
  const hmacHeader = (req.get("X-Shopify-Hmac-Sha256") || "").trim();
  if (!hmacHeader) return false;

  const secret =
    process.env.SHOPIFY_WEBHOOK_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    process.env.SHOPIFY_API_SECRET_KEY;
  if (!secret) {
    console.error(
      "Missing SHOPIFY_WEBHOOK_SECRET (required to verify Shopify webhooks)",
    );
    return false;
  }

  const rawBody = req.rawBody;
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody || "", "utf8");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(bodyBuffer)
    .digest("base64");

  try {
    const a = Buffer.from(digest, "utf8");
    const b = Buffer.from(hmacHeader, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function hasStoreCreditRefundBeenNotified(refundId) {
  const set = loadSet(dataFiles.storeCreditRefunds, "set");
  return set.has(String(refundId));
}

function markStoreCreditRefundNotified(refundId) {
  const set = loadSet(dataFiles.storeCreditRefunds, "set");
  set.add(String(refundId));
  fs.writeFileSync(dataFiles.storeCreditRefunds, JSON.stringify(Array.from(set)));
}

function computeStoreCreditRefundAmount(refund) {
  const transactions = Array.isArray(refund?.transactions)
    ? refund.transactions
    : [];

  const normalizeGateway = (g) =>
    String(g || "")
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/-/g, "_")
      .trim();

  const isStoreCreditGateway = (g) => {
    const gw = normalizeGateway(g);
    // Shopify commonly reports store credit refunds as "shopify_store_credit".
    // Keep this flexible to avoid breaking on minor naming changes.
    return gw === "store_credit" || gw === "shopify_store_credit" || gw.includes("store_credit");
  };

  const matches = transactions.filter(
    (t) =>
      t &&
      String(t.kind || "").toLowerCase() === "refund" &&
      isStoreCreditGateway(t.gateway) &&
      String(t.status || "").toLowerCase() === "success",
  );

  const amount = matches.reduce((sum, t) => {
    const n = Number(t.amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);

  const currency =
    (matches.find((t) => t.currency)?.currency || refund?.currency || "INR").toString();

  return { matches, amount, currency };
}

function formatMoney(amount, currency) {
  const cur = String(currency || "").toUpperCase();
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;

  if (cur === "INR") return `₹${safe.toFixed(2)}`;
  if (cur) return `${cur} ${safe.toFixed(2)}`;
  return safe.toFixed(2);
}

async function resolveOrderRecipientForRefund(order) {
  const shipping = order?.shipping_address || {};
  const billing = order?.billing_address || {};
  const customer = order?.customer || {};

  const countryCode =
    shipping.country_code || billing.country_code || customer.country_code || "IN";
  const name =
    shipping.first_name || customer.first_name || billing.first_name || "Customer";

  const candidates = [
    shipping.phone,
    billing.phone,
    customer.phone,
    order?.phone,
    customer?.default_address?.phone,
  ];

  for (const cand of candidates) {
    const d = extractDigitsPhone(cand);
    if (isLikelyValidWhatsAppNumberDigits(d)) {
      return { name, countryCode, digits: d, source: "order.phone" };
    }
  }

  return {
    name,
    countryCode,
    digits: extractDigitsPhone(order?.phone),
    source: "order.phone",
  };
}

async function sendStoreCreditRefundNotification({ order, refund, amount, currency }) {
  const recipient = await resolveOrderRecipientForRefund(order);
  if (!isLikelyValidWhatsAppNumberDigits(recipient.digits)) {
    const err = new Error(
      `No valid phone number found for store credit notification (source=${recipient.source})`,
    );
    err.code = "NO_VALID_PHONE";
    throw err;
  }

  const dialCode = getDialCode(recipient.countryCode || "IN") || "+91";
  const cleanedPhone = recipient.digits.slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const orderName = order?.name || (order?.id ? String(order.id) : "Unknown Order");
  const name = recipient.name || "Customer";
  const formattedAmount = formatMoney(amount, currency);

  const payload = {
    to: phoneNumberInternationalFormat,
    templateName:
      process.env.SCR_CAMPAIGN_NAME ||
      "kaj_store_credit_refund_v2",
    language: process.env.DT_LANGUAGE || "en",
    // Template: Hi {{1}}, Store credit of {{2}} ... order {{3}}
    bodyPlaceholders: [name, formattedAmount, String(orderName)],
  };

  const resp = await sendDoubleTickTemplateMessage(payload);
  return { ok: true, providerResponse: resp?.data, recipientSource: recipient.source };
}

function extractDigitsPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isLikelyValidWhatsAppNumberDigits(digits) {
  // Keep it simple: WhatsApp numbers are typically 10+ digits (incl. country code).
  // We use 10 as minimum to avoid sending to junk like "555555".
  return Boolean(digits) && digits.length >= 10;
}

async function resolveDeliveryRecipient(fulfillment) {
  const dest = fulfillment?.destination || {};

  // Prefer fulfillment destination info
  const baseCountryCode = dest.country_code || "IN";
  const baseName = dest.first_name || "Customer";
  const baseDigits = extractDigitsPhone(dest.phone);

  if (isLikelyValidWhatsAppNumberDigits(baseDigits)) {
    return {
      name: baseName,
      countryCode: baseCountryCode,
      digits: baseDigits,
      source: "fulfillment.destination.phone",
    };
  }

  // Fallback: fetch order to find a better phone
  const orderId = fulfillment?.order_id;
  if (!orderId) {
    return {
      name: baseName,
      countryCode: baseCountryCode,
      digits: baseDigits,
      source: "fulfillment.destination.phone",
    };
  }

  try {
    const or = await client.get({ path: `orders/${orderId}` });
    const order = or?.body?.order || {};
    const shipping = order.shipping_address || {};
    const billing = order.billing_address || {};
    const customer = order.customer || {};

    const countryCode =
      shipping.country_code || billing.country_code || baseCountryCode || "IN";
    const name = shipping.first_name || customer.first_name || baseName;

    const candidates = [
      shipping.phone,
      billing.phone,
      customer.phone,
      order.phone,
      customer?.default_address?.phone,
    ];

    for (const cand of candidates) {
      const d = extractDigitsPhone(cand);
      if (isLikelyValidWhatsAppNumberDigits(d)) {
        return {
          name,
          countryCode,
          digits: d,
          source: "order.phone",
        };
      }
    }
  } catch (err) {
    // ignore, we'll return base info
  }

  return {
    name: baseName,
    countryCode: baseCountryCode,
    digits: baseDigits,
    source: "fulfillment.destination.phone",
  };
}

function pickFirstTrackingNumber(fulfillment) {
  if (!fulfillment) return "";
  if (fulfillment.tracking_number) return String(fulfillment.tracking_number);
  if (
    Array.isArray(fulfillment.tracking_numbers) &&
    fulfillment.tracking_numbers.length
  ) {
    return String(fulfillment.tracking_numbers[0]);
  }
  if (
    Array.isArray(fulfillment.tracking_info) &&
    fulfillment.tracking_info.length
  ) {
    return String(fulfillment.tracking_info[0]?.number || "");
  }
  if (
    fulfillment.tracking_info &&
    typeof fulfillment.tracking_info === "object"
  ) {
    return String(fulfillment.tracking_info.number || "");
  }
  return "";
}

function pickCarrier(fulfillment) {
  if (!fulfillment) return "";
  if (fulfillment.tracking_company) return String(fulfillment.tracking_company);
  if (
    Array.isArray(fulfillment.tracking_info) &&
    fulfillment.tracking_info.length
  ) {
    return String(fulfillment.tracking_info[0]?.company || "");
  }
  if (
    fulfillment.tracking_info &&
    typeof fulfillment.tracking_info === "object"
  ) {
    return String(fulfillment.tracking_info.company || "");
  }
  return "";
}

function loadSet(filePath, type = "set") {
  try {
    const data = JSON.parse(fs.readFileSync(filePath));
    if (type === "set") return new Set(data);
    return data;
  } catch {
    return type === "set" ? new Set() : {};
  }
}

function saveSet(filePath, dataset, item, type = "set") {
  if (type === "debounced") {
    const { cart_token, checkout } = item;
    if (!cart_token || !checkout) {
      console.warn("Invalid debounced item");
      return;
    }
    dataset[cart_token] = {
      checkout,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2));
  } else {
    dataset.add(item);
    fs.writeFileSync(filePath, JSON.stringify(Array.from(dataset)));
  }
}

function normalizeToDoubleTickTo(to) {
  const digitsOnly = String(to || "").replace(/\D/g, "");
  if (!digitsOnly) return "";

  // DoubleTick examples use countrycode+number without '+' (e.g. 91XXXXXXXXXX)
  if (digitsOnly.length === 10) return `91${digitsOnly}`;
  return digitsOnly;
}

async function sendDoubleTickTemplateMessage({
  to,
  templateName,
  language = "en",
  bodyPlaceholders = [],
  headerImageUrl,
  headerFilename,
  buttonUrl,
}) {
  const apiKey = process.env.DOUBLETICK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing DOUBLETICK_API_KEY env var (set it to the 'key_...' value)",
    );
  }

  if (!templateName) {
    throw new Error("Missing DoubleTick templateName");
  }

  const toNormalized = normalizeToDoubleTickTo(to);
  if (!toNormalized) {
    throw new Error("Missing/invalid destination phone number");
  }

  const payload = {
    messages: [
      {
        to: toNormalized,
        from: "+919136524727",
        content: {
          templateName,
          language,
          templateData: {
            ...(headerImageUrl
              ? {
                  header: {
                    type: "IMAGE",
                    mediaUrl: headerImageUrl,
                    filename: headerFilename || "image.jpeg",
                  },
                }
              : {}),
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

// --- Locks ---
// Used to prevent multiple processes from handling the same checkout at the same time

function loadLocks() {
  try {
    return JSON.parse(fs.readFileSync(dataFiles.locks));
  } catch {
    return {};
  }
}

function saveLocks(locks) {
  fs.writeFileSync(dataFiles.locks, JSON.stringify(locks, null, 2));
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

// --- Abandoned Checkouts ---
async function processQueue() {
  if (isSending || messageQueue.length === 0) return;
  isSending = true;
  const { checkout, cartToken } = messageQueue.shift();
  try {
    await handleAbandonedCheckoutMessage(checkout);
  } catch (err) {
    console.error("Abandoned checkout message failed", err);
  } finally {
    if (cartToken) queuedAbandonedCartTokens.delete(cartToken);
    else if (checkout?.cart_token)
      queuedAbandonedCartTokens.delete(checkout.cart_token);
    isSending = false;
    setImmediate(processQueue);
  }
}

// Function for getting country calling code based on country code
function getDialCode(countryCode) {
  try {
    const country = countries[countryCode];
    return country ? `${country.countryCallingCodes[0]}` : "+91";
  } catch (error) {
    console.error("Error fetching country calling code");
    return null;
  }
}

async function handleAbandonedCheckoutMessage(checkout) {
  if (
    !checkout.email &&
    !checkout?.phone &&
    !checkout.shipping_address?.phone
  ) {
    console.log(
      "Skipping incomplete checkout for sending message (missing contact info)",
    );
    return;
  }

  const name = checkout.shipping_address?.first_name || "Customer";
  const amount = checkout.total_price || "0";
  const abandonedCheckoutUrl = `checkouts/cn/${checkout.cart_token}/information`;
  const countryCode =
    checkout.shipping_address?.country_code ||
    checkout.billing_address?.country_code ||
    checkout.country_code ||
    "IN";

  // Fetch product image
  const variantId = Number(checkout.line_items[0]?.variant_id);
  const productId = Number(checkout.line_items[0]?.product_id);
  const headers = {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
  };

  let imageUrl =
    "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";

  try {
    const variantRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
      headers,
    );
    const imageId = variantRes.data.variant.image_id;

    const productImagesRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
      headers,
    );
    const allImages = productImagesRes.data?.images || [];

    imageUrl = allImages[0]?.src.split("?")[0] || imageUrl;
    if (imageId) {
      const matchedImage = allImages.find((img) => img.id === imageId);
      imageUrl = matchedImage?.src || imageUrl;
    }
  } catch (err) {
    console.error("Failed to fetch product images");
  }

  const dialCode = getDialCode(countryCode);

  let rawPhone = checkout?.shipping_address?.phone || checkout?.phone || "";
  let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const payload = {
    to: phoneNumberInternationalFormat,
    from: "+919136524727",
    templateName:
      process.env.AC_CAMPAIGN_NAME ||
      process.env.AC_TEMPLATE_NAME ||
      "kaj_abandoned_checkout_v1",
    language: process.env.DT_LANGUAGE || "en",
    bodyPlaceholders: [name, `₹${amount}`],
    headerImageUrl: imageUrl,
    headerFilename: "product.jpg",
    buttonUrl: abandonedCheckoutUrl,
  };

  try {
    const response = await sendDoubleTickTemplateMessage(payload);
    console.log(
      `Abandoned checkout message sent for cart_token: ${checkout.cart_token}.  Response: ${response.data}`,
    );
    console.log(`Abandoned checkout message sent to ${name} (${cleanedPhone})`);
  } catch (err) {
    console.error(
      "Abandoned checkout message error: ",
      err?.response?.data || err?.message,
    );
    console.log(
      `Abandoned checkout message cannot be sent to ${name} (${cleanedPhone})`,
    );
    if (err.response) {
      console.error("Response data:", err.response.data);
      console.error("Response status:", err.response.status);
    }
  }
}

async function createOrderFromPayment(checkout, payment) {
  if (!checkout) {
    console.log("No checkout token provided. Skipping order creation.");
    return;
  }
  if (!payment || !payment.id) {
    console.log("No payment ID provided. Skipping order creation.");
    return;
  }

  const countryCode =
    checkout.shipping_address?.country_code ||
    checkout.billing_address?.country_code ||
    checkout.country_code ||
    "IN";

  const rawPhone =
    checkout.phone ||
    checkout.shipping_address?.phone ||
    checkout.billing_address?.phone ||
    "";

  const sanitizedPhone = rawPhone.replace(/\D/g, "");

  const dialCode = getDialCode(countryCode);
  const phoneNumberInternationalFormat = dialCode
    ? `${dialCode}${sanitizedPhone}`
    : `+91${sanitizedPhone}`;

  const formattedPhone =
    sanitizedPhone.length === 10
      ? `${phoneNumberInternationalFormat}`
      : `+${sanitizedPhone}`;

  let customerId = null;

  try {
    let res = await client.get({
      path: "customers/search",
      query: { phone: `${formattedPhone}` },
    });

    if (res.body.customers?.length > 0) {
      customerId = res.body.customers?.[0]?.id || null;
      console.log("✅ Found customer by phone:", customerId);
    } else if (checkout.email) {
      console.log(
        "ℹ️ No customer found by phone. Trying by email:",
        checkout.email,
      );

      res = await client.get({
        path: "customers/search",
        query: { email: `${checkout.email}` },
      });

      if (res.body.customers?.length > 0) {
        customerId = res.body.customers?.[0]?.id || null;
        console.log("✅ Found customer by email:", customerId);
      } else {
        console.log("❌ No existing customer found by phone or email.");
      }
    }
  } catch (error) {
    console.error(
      "Error fetching customer:",
      error.response?.data || error.message,
    );
    return;
  }

  let customerData = null;

  if (checkout.customer) {
    customerData = checkout.customer;
  } else if (customerId) {
    customerData = { id: customerId };
  } else {
    customerData = {
      first_name:
        checkout.shipping_address?.first_name ||
        checkout.billing_address?.first_name ||
        "Guest",
      last_name:
        checkout.shipping_address?.last_name ||
        checkout.billing_address?.last_name ||
        "",
      email: checkout.email,
      phone: formattedPhone,
    };
  }

  const includeEmail = !customerId && checkout.email;

  const orderPayload = {
    order: {
      ...(includeEmail && { email: checkout.email }),
      phone:
        checkout.phone ||
        checkout.shipping_address?.phone ||
        checkout.billing_address?.phone ||
        undefined,

      currency: checkout.currency || "INR",

      customer: customerData,

      billing_address: {
        first_name: checkout.billing_address?.first_name || "",
        last_name: checkout.billing_address?.last_name || "",
        address1: checkout.billing_address?.address1 || "",
        address2: checkout.billing_address?.address2 || "",
        city: checkout.billing_address?.city || "",
        province: checkout.billing_address?.province || "",
        country: checkout.billing_address?.country || "",
        zip: checkout.billing_address?.zip || "",
        phone: checkout.billing_address?.phone || "",
      },

      shipping_address: {
        first_name: checkout.shipping_address?.first_name || "",
        last_name: checkout.shipping_address?.last_name || "",
        address1: checkout.shipping_address?.address1 || "",
        address2: checkout.shipping_address?.address2 || "",
        city: checkout.shipping_address?.city || "",
        province: checkout.shipping_address?.province || "",
        country: checkout.shipping_address?.country || "",
        zip: checkout.shipping_address?.zip || "",
        phone: checkout.shipping_address?.phone || "",
      },

      line_items: (checkout.line_items || []).map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity || 1,
        title: item.title || undefined,
        price: parseFloat(item.price || 0).toFixed(2),
      })),

      shipping_lines: [
        {
          title: checkout?.shipping_lines[0]?.title || "Standard",
          price: parseFloat(
            checkout.shipping_lines[0]?.price ||
              checkout?.shipping_lines[0]?.original_shop_price ||
              0,
          ).toFixed(2),
          code: checkout.shipping_lines[0]?.code || "Standard",
          source: "shopify",
        },
      ],

      tax_lines: (checkout.tax_lines || []).map((t) => ({
        price: parseFloat(t.price || 0).toFixed(2),
        rate: t.rate,
        title: t.title,
      })),

      total_tax: parseFloat(checkout.total_tax || 0).toFixed(2),
      total_discounts: parseFloat(checkout.total_discounts || 0).toFixed(2),

      financial_status: "paid",

      transactions: [
        {
          kind: "sale",
          status: "success",
          amount: parseFloat(checkout.total_price || 0).toFixed(2),
          gateway: "razorpay",
          authorization: payment.id,
        },
      ],

      note: `Auto-created after Razorpay capture (${payment.id}) | cart_token: ${checkout.cart_token} | checkout_token: ${checkout.token}`,
      tags: "ManualOrder, RazorpayPaid",
    },
  };

  try {
    const orderResponse = await client.post({
      path: "orders",
      data: orderPayload,
      type: "application/json",
    });

    console.log(
      "✅ Order created from abandoned checkout:",
      orderResponse.body.order.id,
    );

    try {
      const locationRes = await client.get({ path: "locations" });
      const locationId = locationRes.body.locations[0].id;
      if (!locationId) {
        console.error("No location ID found. Cannot adjust inventory.");
        return;
      }

      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      orderResponse.body.order.line_items.forEach(async (item) => {
        const deductionQuantity = item.quantity || 1;
        const variantId = item?.variant_id || 0;
        if (!variantId) {
          console.log("No variant ID found for item:", item);
          return;
        }
        try {
          const variantRes = await axios.get(
            `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
            headers,
          );

          if (!variantRes.data || !variantRes.data.variant) {
            console.log(`No variant found for ID ${variantId}`);
            return;
          }

          console.log(
            `Processing variant ${variantId} for inventory adjustment`,
          );
          if (!variantRes.data.variant.inventory_item_id) {
            console.log(`Variant ${variantId} has no inventory item ID`);
            return;
          }

          const inventoryItemId = variantRes.data.variant.inventory_item_id;
          if (!inventoryItemId) {
            console.log("No inventory item ID found for variant:", variantId);
            return;
          }
          console.log(
            `Adjusting inventory for variant ${variantId} (item ID: ${inventoryItemId})`,
          );

          try {
            if (orderResponse) {
              const inventoryResponse = await client.post({
                path: `inventory_levels/adjust`,
                data: {
                  location_id: locationId,
                  inventory_item_id: inventoryItemId,
                  available_adjustment: -deductionQuantity,
                },
                type: "application/json",
              });
              if (!inventoryResponse) {
                console.error(
                  `Failed to adjust inventory for variant ${variantId}:`,
                  inventoryResponse,
                );
              }
            }
          } catch (inventoryError) {
            console.error(`Error adjusting inventory for variant ${variantId}`);
            if (inventoryError.response) {
              console.error("Response data:", inventoryError.response.data);
              console.error("Response status:", inventoryError.response.status);
            }
          }
        } catch (error) {
          console.error(`Error adjusting inventory for variant ${variantId}`);
          if (error.response) {
            console.error("Response data:", error.response.data);
            console.error("Response status:", error.response.status);
          }
        }
      });
    } catch (error) {
      console.error("❌ Error creating order from checkout");
      if (error.response) {
        console.error("Response data:", error.response.data);
        console.error("Response status:", error.response.status);
      }
    }
  } catch (locationError) {
    console.error("Failed to fetch locations: ", locationError);
    return;
  }
}

async function verifyCheckout(checkout) {
  if (!checkout) {
    console.log("No checkout token provided. Skipping payment fetch.");
    return;
  }

  if (!razorpayClient) {
    console.log("Razorpay client not initialized. Skipping payment fetch.");
    return;
  }

  if (
    !checkout?.email &&
    !checkout?.phone &&
    !checkout?.shipping_address?.phone
  ) {
    console.log("Skipping incomplete checkout (missing contact info)");
    return;
  }

  let orders = [];
  try {
    const phone = checkout?.shipping_address?.phone || checkout?.phone;
    const email = checkout.email;
    const res = await client.get({
      path: "orders",
      query: {
        status: "any",
        limit: 50,
      },
    });
    orders = res.body.orders;

    if (orders) {
      const isOrderNotAbandoned = orders.find(
        (o) => o.cart_token === checkout.cart_token,
      );
      if (isOrderNotAbandoned) {
        orderId = isOrderNotAbandoned.id;
        console.log(
          `Checkout ${checkout.cart_token} is not abandoned. Skipping payment verification.`,
        );
        return; // Change
      } else {
        console.log(
          `Checkout ${checkout.cart_token} is abandoned. Proceeding with payment verification.`,
        );
      }

      const isConverted = orders.find(
        (o) => o.checkout_token === checkout.token,
      );
      if (isConverted) {
        console.log(
          `Checkout ${checkout.token} already converted to order. Skipping payment verification.`,
        );
        return; // Change
      }

      if (orders?.length) {
        const matchingOrder = orders.find((o) => {
          const orderPhones = [
            o.phone,
            o?.customer?.phone,
            o?.customer?.default_address?.phone,
            o?.shipping_address?.phone,
          ].filter(Boolean);

          const phoneMatches =
            phone && orderPhones.some((p) => p.includes(phone));

          const priceMatches =
            Number(o.total_price) === Number(checkout.total_price);

          return phoneMatches && priceMatches;
        });

        if (matchingOrder) {
          console.log(
            `Duplicate order detected for phone ${phone} with total_price ${checkout.total_price}. Order ID: ${matchingOrder.id}`,
          );
          return;
        }
      }

      if (orders?.length) {
        const matchingOrder = orders.find((o) => {
          const orderEmails = [o?.email, o?.customer?.email].filter(Boolean);

          const emailMatches = email && orderEmails.some((e) => e === email);

          const priceMatches =
            Number(o.total_price) === Number(checkout.total_price);

          return emailMatches && priceMatches;
        });

        if (matchingOrder) {
          console.log(
            `Duplicate order detected for email ${email} with total_price ${checkout.total_price}. Order ID: ${matchingOrder.id}`,
          );
          return;
        }

        console.log(
          `Checkout ${checkout.cart_token} seems abandoned. Proceeding with payment verification.`,
        );
      }
    }
  } catch (err) {
    console.error("Failed to fetch orders:", err.response.data);
  }

  try {
    const processedPayments = loadSet(dataFiles.payments, "set");

    const todaysPayments = await razorpayClient.fetchTodaysPayments();
    if (!todaysPayments || !todaysPayments.items) {
      console.log("No payments found for today.");
    } else {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const twoHoursAgo = currentTimestamp - MINUTES_FOR_PAYMENT_CHECK * 60;
      const totalCheckoutPrice = Number(checkout.total_price);

      const matchingPayments = todaysPayments.items
        .filter((payment) => {
          if (payment.status !== "captured") return false;
          if (!payment?.notes?.cancelUrl) return false;

          const perfectPhoneDigits = payment?.contact
            .replace(/\s+/g, "")
            .slice(-10);
          const perfectAmount = payment.amount / 100;

          const matchesPhoneAndAmount =
            (perfectPhoneDigits === checkout?.shipping_address?.phone &&
              perfectAmount === totalCheckoutPrice) ||
            (payment.contact === checkout?.phone &&
              perfectAmount === totalCheckoutPrice);

          const matchesCartToken = payment.notes.cancelUrl.includes(
            checkout?.cart_token,
          );

          const isWithinTimeRange =
            payment.created_at >= twoHoursAgo &&
            payment.created_at <= currentTimestamp;

          return (
            (matchesPhoneAndAmount || matchesCartToken) && isWithinTimeRange
          );
        })
        .sort((a, b) => b.created_at - a.created_at);

      const capturedPayment = matchingPayments[0];

      if (!capturedPayment) {
        console.log(
          `No captured payments found for checkout ${checkout.cart_token}. Proceeding with message queueing.`,
        );
        enqueueAbandonedCheckout(checkout, "no_captured_payment");
        return;
      }

      if (processingPayments.has(capturedPayment.id)) {
        console.log(
          `⚠️ Payment ${capturedPayment.id} is being processed. Skipping.`,
        );
        return;
      }

      if (!lockId(capturedPayment.id)) {
        console.log(`Payment ${capturedPayment.id} is locked persistently.`);
        return;
      }

      processingPayments.add(capturedPayment.id);

      // try {
      //   if (processedPayments.has(capturedPayment.id)) {
      //     console.log(
      //       `Payment ${capturedPayment.id} already processed. Skipping.`
      //     );
      //     return;
      //   }

      //   console.log(
      //     `Captured payment found for checkout ${checkout.cart_token}:`,
      //     capturedPayment.contact,
      //     capturedPayment.id,
      //     new Date(capturedPayment.created_at * 1000).toLocaleString()
      //   );

      //   await createOrderFromPayment(checkout, capturedPayment);
      //   saveSet(dataFiles.payments, processedPayments, capturedPayment.id);
      // } finally {
      //   processingPayments.delete(capturedPayment.id);
      //   unlockId(capturedPayment.id);
      // }
    }
  } catch (error) {
    console.error("Error fetching payments");
  }
}

setInterval(() => {
  const checkouts = loadSet(dataFiles.checkouts, "debounced");
  const now = Date.now();

  if (Object.keys(checkouts).length === 0) return;

  let changed = false;

  for (const [cart_token, data] of Object.entries(checkouts)) {
    const timeSinceUpdate = now - data.updatedAt;

    if (timeSinceUpdate >= SEND_MESSAGE_DELAY) {
      const checkout = data.checkout;

      const shipping = checkout.shipping_address || {};
      const email = checkout.email || "";
      const rawPhone = shipping?.phone || checkout.phone || "";
      const hasValidPhone = rawPhone.replace(/\D/g, "").length >= 10;

      const hasContactInfo = hasValidPhone || email;

      if (hasContactInfo) {
        console.log(`Processing cart_token: ${cart_token}`);
        verifyCheckout(checkout);
      } else {
        console.log(`Still missing info for: ${cart_token}`);
      }

      delete checkouts[cart_token];
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(dataFiles.checkouts, JSON.stringify(checkouts, null, 2));
  }
}, CHECK_INTERVAL);

app.post("/webhook/abandoned-checkouts", async (req, res) => {
  res.status(200).send("OK");

  const checkout = req.body;
  const cart_token = checkout?.cart_token;

  if (!cart_token) return;

  const checkouts = loadSet(dataFiles.checkouts, "debounced");

  saveSet(
    dataFiles.checkouts,
    checkouts,
    { cart_token, checkout },
    "debounced",
  );
});

// --- Order Confirmation ---
// const restockInventoryFromOrder = async (orderId) => {
//   try {
//     // 1. Fetch the order to get line_items
//     const orderRes = await client.get({
//       path: `orders/${orderId}.json`,
//     });
//     const order = orderRes.body.order;
//     const lineItems = order.line_items;

//     const locationRes = await client.get({ path: "locations" });
//     const locationId = locationRes.body.locations[0].id;
//     if (!locationId) {
//       console.error("No location ID found. Cannot adjust inventory.");
//       return;
//     }

//     const headers = {
//       headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
//     };

//     if (!lineItems.length) {
//       console.log("No line items found to restock.");
//       return;
//     }

//     // 3. Loop through each item and restock
//     for (const item of lineItems) {
//       const variantId = item.variant_id;
//       const quantityToRestock = item.quantity;

//       // Get inventory_item_id for the variant
//       const variantRes = await axios.get(
//         `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
//         headers
//       );

//       if (!variantRes.data || !variantRes.data.variant) {
//         console.log(`No variant found for ID ${variantId}`);
//         return;
//       }

//       console.log(`Processing variant ${variantId} for inventory adjustment`);
//       if (!variantRes.data.variant.inventory_item_id) {
//         console.log(`Variant ${variantId} has no inventory item ID`);
//         return;
//       }

//       const inventoryItemId = variantRes.data.variant.inventory_item_id;
//       if (!inventoryItemId) {
//         console.log("No inventory item ID found for variant:", variantId);
//         return;
//       }
//       console.log(
//         `Adjusting inventory for variant ${variantId} (item ID: ${inventoryItemId})`
//       );
//       // Restock the inventory
//       const inventoryResponse = await client.post({
//         path: `inventory_levels/adjust.json`,
//         data: {
//           location_id: locationId,
//           inventory_item_id: inventoryItemId,
//           available_adjustment: quantityToRestock,
//         },
//         type: "application/json",
//       });

//       console.log(
//         `Restocked ${quantityToRestock} units for variant ${variantId}`
//       );
//     }

//     console.log(`✅ Inventory restocked successfully for order ${orderId}`);
//   } catch (error) {
//     console.error(
//       "❌ Error restocking inventory:",
//       error.response?.data || error.message
//     );
//   }
// };

// const cancelOrder = async (orderId) => {
//   try {
//     restockInventoryFromOrder(orderId).then(async () => {
//       const cancelResponse = await client.post({
//         path: `orders/${orderId}/cancel.json`,
//         data: {
//           email: false,
//         },
//         type: "application/json",
//       });

//       console.log(`✅ Order ${orderId} cancelled successfully`);
//       return cancelResponse.body;
//     });
//   } catch (error) {
//     console.error(
//       "❌ Error cancelling order:",
//       error.response?.data || error.message
//     );
//   }
// };

// async function processOrder(order) {
//   const phone =
//     order?.phone ||
//     order.billing_address?.phone ||
//     order.customer.default_address?.phone;
//   const queryField = order.email || order.customer?.email ? "email" : "phone";
//   const queryValue = order.email || phone;

//   const res = await client.get({
//     path: "orders",
//     query: {
//       [queryField]: queryValue,
//       fields: "id, note",
//       status: "any",
//       limit: 50,
//     },
//   });
//   const orders = res.body.orders;
//   if (orders || orders.length > 0) {
//     const matchingOrder = orders.find(
//       (o) => o.note && o.note.indexOf(order.checkout_token) !== -1
//     );
//     if (matchingOrder) {
//       cancelOrder(order.id);
//       return;
//     }
//   }
// }

const processedOrders = loadSet(dataFiles.orders, "set");

async function sendOrderConfirmation(order) {
  try {
    const customer = order.customer || {};
    const shippingAddress = order.shipping_address || {};
    const name =
      shippingAddress.first_name || customer.first_name || "Customer";
    const orderName = order.name.replace("#", "") || "Unknown Order";
    const amount = order.total_price || "0";

    const countryCode =
      order.shipping_address?.country_code ||
      order.billing_address?.country_code ||
      "IN";

    const dialCode = getDialCode(countryCode);

    let rawPhone = shippingAddress.phone || customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
    const phoneNumberInternationalFormat = dialCode + cleanedPhone;

    let imageUrl =
      "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";
    if (order.line_items?.length) {
      const productId = order.line_items[0].product_id;
      const variantId = order.line_items[0].variant_id;
      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers,
        );
        if (productImagesRes?.data?.images?.length) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId),
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image");
      }
    }

    let orderStatusURL = `${process.env.SHOP_URL}/account/order/${order.id}`;
    if (order.order_status_url) {
      orderStatusURL = (() => {
        try {
          const url = new URL(order.order_status_url);
          return url.pathname.replace(/^\//, "");
        } catch {
          return order.order_status_url;
        }
      })();
    }

    const payload = {
      to: phoneNumberInternationalFormat,
      from: "+919136524727",
      templateName:
        process.env.OC_CAMPAIGN_NAME ||
        process.env.OC_TEMPLATE_NAME ||
        "kaj_order_confirmation_v3",
      language: process.env.DT_LANGUAGE || "en",
      // Your provided curl uses 3 body placeholders + URL button
      bodyPlaceholders: [name, orderName, `₹${amount}`],
      headerImageUrl: imageUrl,
      headerFilename: "order.jpg",
      buttonUrl: orderStatusURL,
    };

    try {
      const response = await sendDoubleTickTemplateMessage(payload);
      saveSet(dataFiles.orders, processedOrders, order.id.toString(), "set");
      console.log(`Order confirmation message sent for ${order.cart_token}`);
      console.log(`Order confirmation sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error(
        "Order confirmation message error",
        err?.response?.data || err?.message,
      );
      console.log(`Order confirmation cannot be sent to (${cleanedPhone})`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
    }
  } catch (err) {
    console.error("Order confirmation error");
  }
}

async function sendLowStockNotification(order) {
  const orderId = order.id;
  try {
    // 1. Fetch the order to get line_items
    const orderRes = await client.get({
      path: `orders/${orderId}.json`,
    });

    const order = orderRes.body.order;
    const lineItems = order.line_items;

    const locationRes = await client.get({ path: "locations" });

    const locationId = locationRes.body.locations[0].id;
    if (!locationId) {
      console.error("No location ID found. Cannot adjust inventory.");
      return;
    }

    const headers = {
      headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
    };

    if (!lineItems.length) {
      console.log("No line items found to restock.");
      return;
    }

    // 3. Loop through each item and restock
    for (const item of lineItems) {
      const productId = item.product_id;
      const variantId = item.variant_id;

      // Get inventory_item_id for the variant
      const productRes = await axios.get(
        `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}.json`,
        headers,
      );

      // Get inventory_item_id for the variant
      const variantRes = await axios.get(
        `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/variants/${variantId}.json`,
        headers,
      );

      if (!variantRes.data || !variantRes.data.variant) {
        console.log(`No variant found for ID ${variantId}`);
        return;
      }

      const productTitle = productRes.data.product.title;
      let productCode = productRes.data.product.body_html || "";
      const $ = cheerio.load(productCode);
      productCode = $("p").text().trim() || "No code available";

      const productOption = variantRes.data.variant.option1;
      const currentStock = variantRes.data.variant.inventory_quantity;

      const thresholdQuantity = 4; // Set your low stock threshold
      let imageUrl =
        "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers,
        );

        if (productImagesRes?.data?.images?.length > 0) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId),
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image");
      }
      const viewInventoryUrl = `admin/products/${productId}?variant=${variantId}`;

      if (currentStock < thresholdQuantity) {
        const payload = {
          to: "+917715878352",
          from: "+919136524727",
          templateName:
            process.env.DT_TEMPLATE_LOW_STOCK ||
            process.env.LSA_TEMPLATE_NAME ||
            process.env.LSA_CAMPAIGN_NAME,
          language: process.env.DT_LANGUAGE || "en",
          bodyPlaceholders: [
            productTitle.toString(),
            productCode.toString(),
            productOption.toString() || "Default Variant",
            currentStock.toString(),
            thresholdQuantity.toString(),
            viewInventoryUrl.toString(),
          ],
          headerImageUrl: imageUrl,
          headerFilename: "product.jpg",
          buttonUrl: viewInventoryUrl,
        };

        try {
          await sendDoubleTickTemplateMessage(payload);
          console.log(
            `Low stock alert sent for ${productTitle} (${productOption})`,
          );
        } catch (err) {
          console.error(
            "Low stock alert message error",
            err?.response?.data || err?.message,
          );
          if (err.response) {
            console.error("Response data: ", err.response.data);
            console.error("Response status: ", err.response.status);
          }
        }
      }
    }
  } catch (error) {
    console.error(
      "❌ Error sending low stock alert: ",
      error.response?.data || error.message,
    );
  }
}

app.post("/webhook/order-confirmation", (req, res) => {
  res.status(200).send("Order confirmation webhook received");
  const order = req.body;

  if (processedOrders.has(order.id.toString())) {
    console.log(`Order ${order.id} already processed`);
    return;
  }

  // processOrder(order);
  sendLowStockNotification(order);
  sendOrderConfirmation(order);
});

// --- Fulfillment Creation ---
const processedFulfillments = loadSet(dataFiles.fulfillments, "set");

async function sendFulfillmentMessage(fulfillment) {
  try {
    const orderId = fulfillment.order_id;
    const customer = fulfillment.destination || {};
    const name = customer.first_name || "Customer";
    const orderName =
      fulfillment.name.replace("#", "").split(".")[0] || "Unknown Order";
    const trackingNumber = fulfillment.tracking_number || "Unknown fulfillment";
    try {
      const order = await client.get({
        path: `orders/${orderId}`,
      });
      amount = order.body.order.total_price || "0";
    } catch (orderError) {
      console.error("Failed to fetch order details:", orderError);
    } finally {
      console.log(`Processing fulfillment for order ${orderName} (${orderId})`);
    }

    const countryCode = fulfillment.destination?.country_code || "IN"; // Default to India if not found

    const dialCode = getDialCode(countryCode);

    let rawPhone = customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);
    const phoneNumberInternationalFormat = dialCode + cleanedPhone;

    const fulfillmentStatusURL = fulfillment.tracking_url;

    // Product image
    let imageUrl =
      "https://cdn.shopify.com/s/files/1/0655/1352/1302/files/WhatsApp_Image_2025-05-21_at_21.13.58.jpg";
    if (fulfillment.line_items?.length > 0) {
      const productId = fulfillment.line_items[0].product_id;
      const variantId = fulfillment.line_items[0].variant_id;
      const headers = {
        headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
      };

      try {
        const productImagesRes = await axios.get(
          `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
          headers,
        );
        if (productImagesRes?.data?.images?.length > 0) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId),
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image here:", imageError);
      }
    }

    const payload = {
      to: phoneNumberInternationalFormat,
      from: "+919136524727",
      templateName:
        process.env.OST_CAMPAIGN_NAME ||
        process.env.OST_TEMPLATE_NAME ||
        "kaj_order_shipping_v1",
      language: process.env.DT_LANGUAGE || "en",
      bodyPlaceholders: [`${name}`, `${orderName}`, `${trackingNumber}`],
      headerImageUrl: imageUrl,
      headerFilename: "product.jpg",
      buttonUrl: fulfillmentStatusURL,
    };

    try {
      const response = await sendDoubleTickTemplateMessage(payload);
      saveSet(
        dataFiles.fulfillments,
        processedFulfillments,
        fulfillment.id.toString(),
        "set",
      );
      console.log("Fulfillment message sent:", response.data);
      console.log(`Fulfillment message sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error(
        "Fulfillment message error",
        err?.response?.data || err?.message,
      );
      console.log(`Fulfillment message cannot be sent`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
    }
  } catch (err) {
    console.error("Fulfillment message error");
  }
}

app.post("/webhook/fulfillment-creation", (req, res) => {
  res.status(200).send("OK");
  const fulfillment = req.body;

  if (processedFulfillments.has(fulfillment.id.toString())) {
    console.log(`Fulfillment ${fulfillment.id} already processed`);
    return;
  }

  sendFulfillmentMessage(fulfillment);
});

// --- Fulfillment Update (Delivery Detection) ---
// Shopify doesn't provide an order/delivered webhook.
// Delivery is inferred from fulfillments/update where shipment_status === "delivered".
async function sendDeliveryNotification(fulfillment) {
  const orderId = fulfillment?.order_id;
  const fulfillmentId = fulfillment?.id;
  const shipmentStatus = fulfillment?.shipment_status;

  const recipient = await resolveDeliveryRecipient(fulfillment);
  const name = recipient.name || "Customer";

  const orderName = fulfillment?.name
    ? fulfillment.name.replace("#", "").split(".")[0]
    : orderId
      ? String(orderId)
      : "Unknown Order";

  const trackingNumber = pickFirstTrackingNumber(fulfillment) || "";
  const carrier = pickCarrier(fulfillment) || "";

  if (!isLikelyValidWhatsAppNumberDigits(recipient.digits)) {
    const err = new Error(
      `No valid phone number found for delivery notification (source=${recipient.source})`,
    );
    err.code = "NO_VALID_PHONE";
    throw err;
  }

  const countryCode = recipient.countryCode || "IN";
  const dialCode = getDialCode(countryCode) || "+91";
  // Use last 10 digits to match existing message formatting
  const cleanedPhone = recipient.digits.slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const payload = {
    to: phoneNumberInternationalFormat,
    templateName:
      process.env.OD_CAMPAIGN_NAME ||
      "kaj_order_delivered_v3",
    language: process.env.DT_LANGUAGE || "en",
    // Template in screenshot: "Hi {{1}}, Your order {{2}} has been delivered..."
    bodyPlaceholders: [name, `${orderName}`],
  };

  // Fire WhatsApp (or replace with SMS/Email integrations).
  const resp = await sendDoubleTickTemplateMessage(payload);
  return {
    ok: true,
    shipmentStatus,
    orderId,
    fulfillmentId,
    trackingNumber,
    carrier,
    recipientSource: recipient.source,
    providerResponse: resp?.data,
  };
}

function hasDeliveryBeenNotified(key) {
  // Read from disk for safety across restarts/instances
  const set = loadSet(dataFiles.deliveries, "set");
  return set.has(String(key));
}

function markDeliveryNotified(key) {
  const set = loadSet(dataFiles.deliveries, "set");
  set.add(String(key));
  fs.writeFileSync(dataFiles.deliveries, JSON.stringify(Array.from(set)));
}

function loadDeliveryReviewRecords() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFiles.deliveryReviewRecords, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveDeliveryReviewRecords(records) {
  fs.writeFileSync(
    dataFiles.deliveryReviewRecords,
    JSON.stringify(records || {}, null, 2),
    "utf8",
  );
}

function loadDeliveryReviewFulfillmentRecords() {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(dataFiles.deliveryReviewFulfillments, "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveDeliveryReviewFulfillmentRecords(records) {
  fs.writeFileSync(
    dataFiles.deliveryReviewFulfillments,
    JSON.stringify(records || {}, null, 2),
    "utf8",
  );
}

function parseDateMs(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function getReviewDelayMs() {
  const parsedDelayMs = Number(process.env.REVIEW_DELAY_MS);
  return Number.isFinite(parsedDelayMs) ? parsedDelayMs : 4 * 24 * 60 * 60 * 1000;
}

async function attemptSendReviewForFulfillmentId(fulfillmentId) {
  if (!fulfillmentId) return;

  const lockKey = `review_send:${fulfillmentId}`;
  if (!lockId(lockKey)) return;

  try {
    const records = loadDeliveryReviewFulfillmentRecords();
    const rec = records[String(fulfillmentId)];
    if (!rec || rec.reviewMessageSent) return;

    const deliveredAtMs = Number(rec.deliveredAtMs);
    if (!Number.isFinite(deliveredAtMs)) return;

    const delayMs = getReviewDelayMs();
    if (deliveredAtMs > Date.now() - delayMs) return;

    const result = await sendOrderReviewRequestForRecord(rec);

    records[String(fulfillmentId)] = {
      ...rec,
      reviewMessageSent: true,
      reviewMessageSentAtMs: Date.now(),
      reviewMessageSentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    saveDeliveryReviewFulfillmentRecords(records);

    appendJsonlLog(deliveryReviewLogFile, {
      event: "review_message_sent",
      order_id: rec.orderId || null,
      fulfillment_id: fulfillmentId,
      result: "notified",
      notification: result,
    });
  } catch (err) {
    appendJsonlLog(deliveryReviewLogFile, {
      event: "review_message_sent",
      order_id: null,
      fulfillment_id: fulfillmentId,
      result: "error",
      error: err?.response?.data || err?.message || String(err),
    });
  } finally {
    unlockId(lockKey);
  }
}

function scheduleReviewSendForFulfillmentId(fulfillmentId, deliveredAtMs) {
  if (!fulfillmentId) return;

  const delayMs = getReviewDelayMs();
  const dueAtMs =
    (Number.isFinite(Number(deliveredAtMs)) ? Number(deliveredAtMs) : Date.now()) +
    delayMs;
  const msUntilDue = Math.max(0, dueAtMs - Date.now());

  const existing = __reviewTimersByFulfillmentId.get(String(fulfillmentId));
  if (existing?.timeoutId) {
    clearTimeout(existing.timeoutId);
  }

  const timeoutId = setTimeout(() => {
    __reviewTimersByFulfillmentId.delete(String(fulfillmentId));
    attemptSendReviewForFulfillmentId(String(fulfillmentId)).catch(() => {});
  }, msUntilDue);

  __reviewTimersByFulfillmentId.set(String(fulfillmentId), { timeoutId, dueAtMs });
}

async function upsertDeliveryReviewRecordFromFulfillment(fulfillment, receivedAtMs) {
  const orderId = fulfillment?.order_id;
  if (!orderId) return;

  const fulfillmentId = fulfillment?.id ? String(fulfillment.id) : null;
  if (!fulfillmentId) return;
  const deliveredAtMs =
    parseDateMs(fulfillment?.updated_at) ||
    parseDateMs(fulfillment?.delivered_at) ||
    Number(receivedAtMs) ||
    Date.now();

  const orderName = fulfillment?.name
    ? fulfillment.name.replace("#", "").split(".")[0]
    : String(orderId);

  const recipient = await resolveDeliveryRecipient(fulfillment);

  const lockKey = `delivery_review_capture:${fulfillmentId}`;
  if (!lockId(lockKey)) return;

  try {
    const records = loadDeliveryReviewFulfillmentRecords();
    const key = String(fulfillmentId);
    const prev = records[key] || {};

    const prevDeliveredAtMs = Number(prev.deliveredAtMs);
    const nextDeliveredAtMs =
      Number.isFinite(prevDeliveredAtMs) && prevDeliveredAtMs > deliveredAtMs
        ? prevDeliveredAtMs
        : deliveredAtMs;

    records[key] = {
      fulfillmentId,
      orderId: Number(orderId),
      orderName,
      deliveredAtMs: nextDeliveredAtMs,
      deliveredAt: new Date(nextDeliveredAtMs).toISOString(),
      recipient: {
        name: recipient?.name || prev?.recipient?.name || "Customer",
        countryCode:
          recipient?.countryCode || prev?.recipient?.countryCode || "IN",
        digits: recipient?.digits || prev?.recipient?.digits || "",
        source: recipient?.source || prev?.recipient?.source || "unknown",
      },
      reviewMessageSent: Boolean(prev.reviewMessageSent),
      reviewMessageSentAt: prev.reviewMessageSentAt || null,
      reviewMessageSentAtMs: Number(prev.reviewMessageSentAtMs) || null,
      updatedAt: new Date().toISOString(),
    };

    saveDeliveryReviewFulfillmentRecords(records);

    // Schedule review send ~delayMs after deliveredAt.
    scheduleReviewSendForFulfillmentId(fulfillmentId, nextDeliveredAtMs);

    appendJsonlLog(deliveryReviewLogFile, {
      event: "delivery_captured",
      order_id: orderId,
      fulfillment_id: fulfillmentId,
      delivered_at: new Date(nextDeliveredAtMs).toISOString(),
      result: "ok",
    });
  } catch (err) {
    appendJsonlLog(deliveryReviewLogFile, {
      event: "delivery_captured",
      order_id: orderId,
      fulfillment_id: fulfillmentId,
      result: "error",
      error: err?.message || String(err),
    });
  } finally {
    unlockId(lockKey);
  }
}

function buildReviewButtonUrl({ orderId, orderName }) {
  const tmpl = String(process.env.REVIEW_BUTTON_URL_TEMPLATE || "").trim();
  const base = String(process.env.REVIEW_BUTTON_URL || "").trim();

  if (tmpl) {
    return tmpl
      .replaceAll("{orderId}", String(orderId))
      .replaceAll(
        "{orderName}",
        encodeURIComponent(String(orderName || "")),
      );
  }

  return base;
}

async function sendOrderReviewRequestForRecord(record) {
  const orderId = record?.orderId;
  const orderName = record?.orderName || (orderId ? String(orderId) : "Unknown");

  const recipient = record?.recipient || {};
  const name = recipient?.name || "Customer";
  const countryCode = recipient?.countryCode || "IN";
  const digits = extractDigitsPhone(recipient?.digits);

  if (!isLikelyValidWhatsAppNumberDigits(digits)) {
    const err = new Error(
      `No valid phone number found for review notification (orderId=${orderId})`,
    );
    err.code = "NO_VALID_PHONE";
    throw err;
  }

  const dialCode = getDialCode(countryCode) || "+91";
  const cleanedPhone = digits.slice(-10);
  const phoneNumberInternationalFormat = dialCode + cleanedPhone;

  const buttonUrl = buildReviewButtonUrl({ orderId, orderName });
  if (!buttonUrl) {
    const err = new Error(
      "Missing REVIEW_BUTTON_URL or REVIEW_BUTTON_URL_TEMPLATE for review message button",
    );
    err.code = "MISSING_REVIEW_URL";
    throw err;
  }

  const payload = {
    to: phoneNumberInternationalFormat,
    templateName:
      process.env.OR_CAMPAIGN_NAME ||
      "kaj_order_review_v2",
    language: process.env.DT_LANGUAGE || "en",
    bodyPlaceholders: [name, String(orderName)],
    buttonUrl,
  };

  const resp = await sendDoubleTickTemplateMessage(payload);
  return {
    ok: true,
    orderId,
    orderName,
    recipientSource: recipient?.source || null,
    providerResponse: resp?.data,
  };
}

let __reviewSchedulerRunning = false;
async function runReviewSchedulerOnce() {
  const enabled =
    String(process.env.REVIEW_SCHEDULER_ENABLED || "true").toLowerCase() !==
    "false";
  if (!enabled) return;

  if (__reviewSchedulerRunning) return;
  __reviewSchedulerRunning = true;

  const lockKey = "review_scheduler";
  if (!lockId(lockKey)) {
    __reviewSchedulerRunning = false;
    return;
  }

  try {
    const now = Date.now();
    const delayMs = getReviewDelayMs();

    const records = loadDeliveryReviewFulfillmentRecords();
    const list = Object.values(records || {}).filter(Boolean);

    for (const rec of list) {
      const orderId = rec?.orderId;
      const fulfillmentId = rec?.fulfillmentId;
      const deliveredAtMs = Number(rec?.deliveredAtMs);
      if (!orderId || !fulfillmentId || !Number.isFinite(deliveredAtMs)) continue;

      if (rec.reviewMessageSent) continue;
      if (deliveredAtMs > now - delayMs) continue;

      // Use the shared send path (handles idempotency + persistence).
      await attemptSendReviewForFulfillmentId(String(fulfillmentId));
    }
  } finally {
    unlockId(lockKey);
    __reviewSchedulerRunning = false;
  }
}

async function handleFulfillmentsUpdateWebhook(req, res) {
  const allowUnverified =
    String(process.env.ALLOW_UNVERIFIED_SHOPIFY_WEBHOOKS || "").toLowerCase() ===
    "true";

  const topic = (req.get("X-Shopify-Topic") || "").trim();
  const shopDomain = (req.get("X-Shopify-Shop-Domain") || "").trim();

  // Only accept the specific Shopify topic we rely on for delivery status.
  if (topic && topic !== "fulfillments/update") {
    res.status(200).send("OK");
    appendJsonlLog(deliveryWebhookLogFile, {
      event: "fulfillments/update",
      result: "ignored",
      reason: "wrong_topic",
      topic,
      shop_domain: shopDomain || null,
    });
    return;
  }

  // Basic shop-domain allowlist. (HMAC is the real protection; this prevents obvious misroutes.)
  if (process.env.SHOPIFY_DOMAIN && shopDomain && shopDomain !== process.env.SHOPIFY_DOMAIN) {
    res.status(200).send("OK");
    appendJsonlLog(deliveryWebhookLogFile, {
      event: "fulfillments/update",
      result: "ignored",
      reason: "wrong_shop_domain",
      topic: topic || null,
      shop_domain: shopDomain,
      expected_shop_domain: process.env.SHOPIFY_DOMAIN,
    });
    return;
  }

  if (!allowUnverified && !verifyShopifyWebhookHmac(req)) {
    appendJsonlLog(deliveryWebhookLogFile, {
      event: "fulfillments/update",
      result: "rejected",
      reason: "invalid_hmac",
      topic: topic || null,
      shop_domain: shopDomain || null,
    });
    return res.status(401).send("Invalid webhook signature");
  }

  // Always acknowledge quickly to Shopify
  res.status(200).send("OK");

  const payload = req.body || {};
  const fulfillment = payload.fulfillment || payload;

  const shipmentStatus =
    fulfillment?.shipment_status || payload?.shipment_status || "";
  if (shipmentStatus !== "delivered") {
    return;
  }

  const orderId = fulfillment?.order_id || payload?.order_id;
  const fulfillmentId = fulfillment?.id || payload?.id;

  const trackingNumber = pickFirstTrackingNumber(fulfillment) || "";
  const carrier = pickCarrier(fulfillment) || "";

  const idempotencyKey = fulfillmentId
    ? String(fulfillmentId)
    : `${orderId || "unknown"}:${trackingNumber || "unknown"}`;

  // Capture delivery for 5-day review message scheduling (independent of delivered-message sending).
  // This is per-order persistence and is idempotent.
  (async () => {
    try {
      await upsertDeliveryReviewRecordFromFulfillment(fulfillment, Date.now());
    } catch {
      // errors already logged inside
    }
  })();

  if (hasDeliveryBeenNotified(idempotencyKey)) {
    appendJsonlLog(deliveryWebhookLogFile, {
      event: "fulfillments/update",
      shipment_status: shipmentStatus,
      order_id: orderId || null,
      fulfillment_id: fulfillmentId || null,
      tracking_number: trackingNumber || null,
      carrier: carrier || null,
      result: "ignored",
      reason: "already_notified",
      idempotency_key: idempotencyKey,
    });
    return;
  }

  const lockKey = `delivery:${idempotencyKey}`;
  if (!lockId(lockKey)) {
    appendJsonlLog(deliveryWebhookLogFile, {
      event: "fulfillments/update",
      shipment_status: shipmentStatus,
      order_id: orderId || null,
      fulfillment_id: fulfillmentId || null,
      result: "ignored",
      reason: "locked",
      idempotency_key: idempotencyKey,
    });
    return;
  }

  (async () => {
    try {
      if (hasDeliveryBeenNotified(idempotencyKey)) return;

      const result = await sendDeliveryNotification(fulfillment);
      markDeliveryNotified(idempotencyKey);

      appendJsonlLog(deliveryWebhookLogFile, {
        event: "fulfillments/update",
        shipment_status: shipmentStatus,
        order_id: orderId || null,
        fulfillment_id: fulfillmentId || null,
        tracking_number: trackingNumber || null,
        carrier: carrier || null,
        result: "notified",
        idempotency_key: idempotencyKey,
        notification: result,
        payload: fulfillment,
      });
    } catch (err) {
      appendJsonlLog(deliveryWebhookLogFile, {
        event: "fulfillments/update",
        shipment_status: shipmentStatus,
        order_id: orderId || null,
        fulfillment_id: fulfillmentId || null,
        tracking_number: trackingNumber || null,
        carrier: carrier || null,
        result: "error",
        idempotency_key: idempotencyKey,
        error: err?.response?.data || err?.message || String(err),
        payload: fulfillment,
      });
    } finally {
      unlockId(lockKey);
    }
  })();
}

app.post("/webhook/fulfillments-update", handleFulfillmentsUpdateWebhook);
app.post("/webhook/fulfillments/update", handleFulfillmentsUpdateWebhook);

// --- Refunds/Create (Store Credit Only) ---
// Shopify refunds/create is the ONLY reliable trigger.
// Only notify when refund.transactions includes a successful store_credit refund transaction.
async function handleRefundsCreateWebhook(req, res) {
  const allowUnverified =
    String(process.env.ALLOW_UNVERIFIED_SHOPIFY_WEBHOOKS || "").toLowerCase() ===
    "true";

  const topic = (req.get("X-Shopify-Topic") || "").trim();
  const shopDomain = (req.get("X-Shopify-Shop-Domain") || "").trim();

  if (topic && topic !== "refunds/create") {
    res.status(200).send("OK");
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "ignored",
      reason: "wrong_topic",
      topic,
      shop_domain: shopDomain || null,
    });
    return;
  }

  if (
    process.env.SHOPIFY_DOMAIN &&
    shopDomain &&
    shopDomain !== process.env.SHOPIFY_DOMAIN
  ) {
    res.status(200).send("OK");
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "ignored",
      reason: "wrong_shop_domain",
      topic: topic || null,
      shop_domain: shopDomain,
      expected_shop_domain: process.env.SHOPIFY_DOMAIN,
    });
    return;
  }

  if (!allowUnverified && !verifyShopifyWebhookHmac(req)) {
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "rejected",
      reason: "invalid_hmac",
      topic: topic || null,
      shop_domain: shopDomain || null,
    });
    return res.status(401).send("Invalid webhook signature");
  }

  // Always acknowledge quickly to Shopify
  res.status(200).send("OK");

  const payload = req.body || {};
  const refund = payload.refund || payload;

  const refundId = refund?.id;
  const orderId = refund?.order_id;

  const { matches, amount, currency } = computeStoreCreditRefundAmount(refund);
  if (!matches.length || amount <= 0) {
    const gateways = Array.isArray(refund?.transactions)
      ? refund.transactions
          .map((t) => (t ? String(t.gateway || "") : ""))
          .filter(Boolean)
      : [];
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "ignored",
      reason: "not_store_credit",
      refund_id: refundId || null,
      order_id: orderId || null,
      store_credit_transactions: matches.length,
      gateways,
      payload: refund,
    });
    return;
  }

  if (!refundId) {
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "error",
      reason: "missing_refund_id",
      order_id: orderId || null,
      payload: refund,
    });
    return;
  }

  if (hasStoreCreditRefundBeenNotified(refundId)) {
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "ignored",
      reason: "already_notified",
      refund_id: refundId,
      order_id: orderId || null,
      amount,
      currency,
    });
    return;
  }

  const lockKey = `store_credit_refund:${refundId}`;
  if (!lockId(lockKey)) {
    appendJsonlLog(storeCreditRefundWebhookLogFile, {
      event: "refunds/create",
      result: "ignored",
      reason: "locked",
      refund_id: refundId,
      order_id: orderId || null,
      amount,
      currency,
    });
    return;
  }

  (async () => {
    try {
      if (hasStoreCreditRefundBeenNotified(refundId)) return;

      let order = null;
      if (orderId) {
        try {
          const or = await client.get({ path: `orders/${orderId}` });
          order = or?.body?.order || null;
        } catch (err) {
          // will log below
        }
      }

      if (!order) {
        appendJsonlLog(storeCreditRefundWebhookLogFile, {
          event: "refunds/create",
          result: "error",
          reason: "order_lookup_failed",
          refund_id: refundId,
          order_id: orderId || null,
          amount,
          currency,
          payload: refund,
        });
        return;
      }

      const result = await sendStoreCreditRefundNotification({
        order,
        refund,
        amount,
        currency,
      });

      markStoreCreditRefundNotified(refundId);

      appendJsonlLog(storeCreditRefundWebhookLogFile, {
        event: "refunds/create",
        result: "notified",
        refund_id: refundId,
        order_id: orderId || null,
        amount,
        currency,
        notification: result,
        payload: refund,
      });
    } catch (err) {
      appendJsonlLog(storeCreditRefundWebhookLogFile, {
        event: "refunds/create",
        result: "error",
        refund_id: refundId,
        order_id: orderId || null,
        amount,
        currency,
        error: err?.response?.data || err?.message || String(err),
        payload: refund,
      });
    } finally {
      unlockId(lockKey);
    }
  })();
}

app.post("/webhook/refunds-create", handleRefundsCreateWebhook);
app.post("/webhook/refunds/create", handleRefundsCreateWebhook);

// --- Order Cancellation ---
app.post("/webhook/order-cancellation", (req, res) => {
  res.status(200).send("Order cancellation webhook received");

  const payload = req.body || {};
  const order = payload.order || payload;
  const orderId = order?.id || order?.order_id;

  if (!orderId) {
    console.log(
      "Order cancellation webhook received with no order id. Skipping.",
    );
    return;
  }

  global.__processedCancellations =
    global.__processedCancellations || new Set();
  if (global.__processedCancellations.has(String(orderId))) {
    console.log(`Order cancellation ${orderId} already processed`);
    return;
  }
  global.__processedCancellations.add(String(orderId));
  (async () => {
    try {
      console.log(
        `Processing cancellation for order ${orderId} (sending WhatsApp)`,
      );

      // Use provided payload; fetch full order only to enrich message if available
      let fullOrder = order;
      try {
        const or = await client.get({ path: `orders/${orderId}` });
        fullOrder = or.body.order || fullOrder;
      } catch (err) {
        // ignore — proceed with payload
      }

      const customer = fullOrder.customer || {};
      const shipping = fullOrder.shipping_address || {};
      const name = shipping.first_name || customer.first_name || "Customer";
      const orderName = fullOrder.name
        ? fullOrder.name.replace("#", "")
        : String(orderId);
      const amount = fullOrder.total_price || fullOrder.subtotal_price || "0";

      const countryCode =
        shipping?.country_code ||
        fullOrder?.billing_address?.country_code ||
        "IN";
      const dialCode = getDialCode(countryCode) || "+91";

      const rawPhone =
        shipping.phone || customer.phone || fullOrder.phone || "";
      const cleanedPhone = rawPhone.replace(/\D/g, "").slice(-10);
      const phoneNumberInternationalFormat = dialCode + cleanedPhone;

      const payload = {
        to: phoneNumberInternationalFormat,
        from: "+919136524727",
        templateName:
          process.env.OCD_CAMPAIGN_NAME ||
          process.env.OCD_TEMPLATE_NAME ||
          "kaj_order_cancellation_v1",
        language: process.env.DT_LANGUAGE || "en",
        bodyPlaceholders: [name, `${orderName}`, `₹${amount}`],
      };

      try {
        const resp = await sendDoubleTickTemplateMessage(payload);
        console.log(
          `Order cancellation WhatsApp sent for order ${orderId}:`,
          resp.data || "(no body)",
        );
      } catch (err) {
        console.error(
          "Failed to send order cancellation WhatsApp:",
          err.response?.data || err.message,
        );
      }
    } catch (err) {
      console.error(
        "Unexpected error processing order cancellation:",
        err?.message,
      );
    }
  })();
});

// --- Redirect Service ---
app.get("/redirect_for_shipment", (req, res) => {
  const target = req.query.link;

  if (!target || typeof target !== "string") {
    return res.status(400).send("Missing or invalid 'link' parameter.");
  }

  return res.redirect(target);
});

// --- 1️⃣ CORS Middleware for Order Tracking ---
function corsForOrderTracking(req, res, next) {
  const origin = req.headers.origin;

  // Allow Shopify domains
  const SHOPIFY_FRONTEND_ORIGINS = [
    "https://de5ebb-74.myshopify.com",
    "https://www.kaushalyaartjewellery.com",
  ];

  // ✅ If the origin is allowed, apply dynamic CORS headers
  if (SHOPIFY_FRONTEND_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return next();
  }

  // ✅ Allow direct browser (no-origin) calls, e.g., testing
  if (!origin) return next();

  // ❌ Deny all other origins but return JSON instead of HTML
  res.status(403).json({ error: "CORS blocked. Unauthorized origin.", origin });
}

// --- 2️⃣ Order Tracking Endpoint ---
app.options("/order-tracking", corsForOrderTracking, (req, res) => {
  res.sendStatus(204);
});

app.get("/order-tracking", corsForOrderTracking, async (req, res) => {
  try {
    const { order, order_id, name, phone } = req.query;

    const clean = (v) => (v ? v.toString().trim().toLowerCase() : "");
    const digits = (v) => (v ? v.toString().replace(/[^0-9]/g, "") : "");
    const last10 = (v) => digits(v).slice(-10);

    // Helper: latest fulfillment
    async function getFulfillment(orderId) {
      try {
        const f = await client.get({ path: `orders/${orderId}/fulfillments` });
        const list = f.body.fulfillments || [];
        return list.length ? list[list.length - 1] : null;
      } catch {
        return null;
      }
    }

    const formatTracking = (f) => ({
      tracking_number: f?.tracking_number || "Not Available",
      tracking_url: f?.tracking_url || null,
      courier: f?.tracking_company || "Not Specified",
      status: f?.shipment_status || "pending",
      estimated_delivery: f?.estimated_delivery_at || null,
    });

    const extractPhones = (o) => {
      const arr = [];
      arr.push(last10(o?.billing_address?.phone));
      arr.push(last10(o?.shipping_address?.phone));
      arr.push(last10(o?.customer?.phone));
      arr.push(last10(o?.customer?.default_address?.phone));
      arr.push(last10(o?.phone));
      // Sometimes captured in note attributes under various keys
      if (Array.isArray(o.note_attributes)) {
        o.note_attributes.forEach((attr) => {
          const key = (attr.name || "").toLowerCase();
          if (
            key.includes("phone") ||
            key.includes("whatsapp") ||
            key.includes("mobile") ||
            key.includes("contact")
          ) {
            arr.push(last10(attr.value));
          }
        });
      }
      return arr.filter(Boolean);
    };

    const getCandidateNames = (o) => {
      const names = [];
      const cust = o.customer || {};
      const ship = o.shipping_address || {};
      const bill = o.billing_address || {};
      const join = (a, b) => [a || "", b || ""].join(" ").trim();
      names.push(join(cust.first_name, cust.last_name));
      names.push(join(ship.first_name, ship.last_name));
      names.push(join(bill.first_name, bill.last_name));
      return names
        .filter(Boolean)
        .map((n) => n.toString().trim())
        .map((n) => n.toLowerCase());
    };

    const nameMatches = (o, targetName) => {
      const tokens = targetName
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => t.toLowerCase());
      const candidates = getCandidateNames(o);
      if (!tokens.length || !candidates.length) return false;
      return candidates.some(
        (cand) =>
          // either full target is substring, or all tokens appear
          cand.includes(targetName) || tokens.every((t) => cand.includes(t)),
      );
    };

    // Name + phone lookup
    if (name && phone) {
      const target = last10(phone);
      const targetName = clean(name);

      const resp = await client.get({
        path: "orders",
        query: { status: "any", limit: 250 },
      });

      let orders = resp.body.orders || [];
      let matchedByPhone = orders.filter((o) =>
        extractPhones(o).some((p) => p === target),
      );

      // Fallback: if no recent orders match by phone, search customers by phone and fetch their orders
      if (!matchedByPhone.length) {
        const phoneVariants = (() => {
          const v = [];
          // bare last 10, +<last10>, country-specific
          v.push(target);
          v.push(`+${target}`);
          v.push(`+91${target}`);
          v.push(`91${target}`);
          v.push(`+1${target}`);
          return v;
        })();

        let customers = [];
        for (const pv of phoneVariants) {
          try {
            const c = await client.get({
              path: "customers/search",
              query: { query: `phone:${pv}` },
            });
            if (Array.isArray(c.body.customers) && c.body.customers.length) {
              customers = c.body.customers;
              break;
            }
          } catch (e) {
            // ignore and try next variant
          }
        }

        if (customers.length) {
          const allOrders = [];
          for (const cust of customers) {
            try {
              const o = await client.get({
                path: "orders",
                query: { status: "any", limit: 250, customer_id: cust.id },
              });
              if (Array.isArray(o.body.orders))
                allOrders.push(...o.body.orders);
            } catch (e) {
              // continue
            }
          }
          orders = allOrders;
          matchedByPhone = orders.filter((o) =>
            extractPhones(o).some((p) => p === target),
          );
        }
      }

      if (!matchedByPhone.length) {
        return res.json({
          orders: [],
          error: "No orders found for this phone number.",
        });
      }

      const matchedFinal = matchedByPhone.filter((o) =>
        nameMatches(o, targetName),
      );

      if (!matchedFinal.length) {
        // Still return tracking for phone-only matches to be helpful
        const results = [];
        for (const o of matchedByPhone) {
          const f = await getFulfillment(o.id);
          results.push({ id: o.id, name: o.name, tracking: formatTracking(f) });
        }
        return res.json({
          warning:
            "Phone matched but the customer name did not match. Returning phone-matched orders.",
          orders: results,
        });
      }

      const results = [];
      for (const o of matchedFinal) {
        const f = await getFulfillment(o.id);
        results.push({ id: o.id, name: o.name, tracking: formatTracking(f) });
      }
      return res.json({ orders: results });
    }

    // Order number/id lookup
    if (!order && !order_id) {
      return res.json({
        orders: [],
        error: "Provide order number or order_id.",
      });
    }

    let targetID = order_id;
    if (order && !order_id) {
      const resp = await client.get({
        path: "orders",
        query: { name: `${order.replace("#", "")}`, limit: 1, status: "any" },
      });
      const found = resp.body.orders?.[0];
      if (!found) {
        return res.json({
          error: `No order found with number ${order}`,
          orders: [],
        });
      }
      targetID = found.id;
    }

    const f = await getFulfillment(targetID);
    return res.json({
      orders: [
        {
          id: targetID,
          name: `#${order || targetID}`,
          tracking: formatTracking(f),
        },
      ],
    });
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
});

// Refund processed webhook (handles Razorpay nested payloads)
app.post("/webhook/refund-processed", async (req, res) => {
  // Quick ACK to webhook sender
  res.status(200).send("Refund webhook received");

  const body = req.body || {};

  // Normalize payload shapes (Razorpay: { payload: { refund: { entity }, payment: { entity } } })
  const refundEntity =
    body.payload?.refund?.entity || body.refund?.entity || body.refund || body;
  const paymentEntity =
    body.payload?.payment?.entity ||
    body.payment?.entity ||
    body.payment ||
    null;

  try {
    const refundId =
      refundEntity?.id ||
      refundEntity?.refund_id ||
      JSON.stringify(refundEntity).slice(0, 200);
    global.__processedRefunds = global.__processedRefunds || new Set();
    if (global.__processedRefunds.has(refundId)) {
      console.log("Refund already processed:", refundId);
      return;
    }
    global.__processedRefunds.add(refundId);

    (async () => {
      try {
        // Amount (Razorpay amounts are in paise)
        const rawAmount =
          refundEntity?.amount || refundEntity?.amount_refunded || 0;
        const currency = (
          refundEntity?.currency ||
          paymentEntity?.currency ||
          "INR"
        ).toString();
        const formatAmount = (a, cur) => {
          if (typeof a === "number") {
            if (cur && cur.toUpperCase() === "INR") return (a / 100).toFixed(2);
            return a.toFixed(2);
          }
          const n = Number(a);
          if (!isNaN(n))
            return cur && cur.toUpperCase() === "INR"
              ? (n / 100).toFixed(2)
              : n.toFixed(2);
          return "0";
        };
        const amount = formatAmount(rawAmount, currency);

        // Extract phone (prefer payment.contact)
        const rawPhone = (
          paymentEntity?.contact ||
          refundEntity?.contact ||
          refundEntity?.notes?.contact ||
          ""
        ).toString();
        const cleanedPhone = rawPhone.replace(/\D/g, "").slice(-10);
        const countryCode = "IN";
        const dialCode = getDialCode(countryCode) || "+91";
        const phoneNumber = dialCode + cleanedPhone;

        // Resolve Shopify order: direct id or search by phone/email
        let shopifyOrder = null;
        const possibleOrderId =
          paymentEntity?.order_id ||
          refundEntity?.order_id ||
          refundEntity?.order_number;
        if (possibleOrderId && /^[0-9]+$/.test(String(possibleOrderId))) {
          try {
            const or = await client.get({ path: `orders/${possibleOrderId}` });
            shopifyOrder = or.body.order || null;
          } catch (err) {
            // continue to fallback search
          }
        }

        if (!shopifyOrder) {
          try {
            let resp = null;
            if (cleanedPhone) {
              resp = await client.get({
                path: "orders",
                query: { status: "any", limit: 1, phone: cleanedPhone },
              });
            }
            if ((!resp || !resp.body?.orders?.length) && paymentEntity?.email) {
              resp = await client.get({
                path: "orders",
                query: { status: "any", limit: 1, email: paymentEntity.email },
              });
            }
            if (resp && resp.body?.orders?.length)
              shopifyOrder = resp.body.orders[0];
          } catch (err) {
            // ignore
          }
        }

        // const orderName = shopifyOrder?.name || possibleOrderId || "Unknown Order";
        // const name = shopifyOrder?.shipping_address?.first_name || shopifyOrder?.customer?.first_name || refundEntity?.notes?.comment || "Customer";

        // Refund template expects: {{1}} = amount, {{2}} = refund method (capitalized)
        const rawMethod = (
          paymentEntity?.method ||
          refundEntity?.method ||
          paymentEntity?.payment_method ||
          ""
        ).toString();
        const method = rawMethod
          ? rawMethod.toLowerCase().replace(/(^|\s)\S/g, (t) => t.toUpperCase())
          : "";

        const aiPayload = {
          to: phoneNumber,
          from: "+919136524727",
          templateName:
            process.env.RP_TEMPLATE_NAME ||
            "kaj_refund_processed_v1",
          language: process.env.DT_LANGUAGE || "en",
          bodyPlaceholders: [`${amount}`, method],
        };

        try {
          const r = await sendDoubleTickTemplateMessage(aiPayload);
          console.log("Refund message sent:", r.data || "(no body)");
        } catch (err) {
          console.error(
            "Failed to send refund message:",
            err?.response?.data || err.message,
          );
        }
      } catch (err) {
        console.error(
          "Unexpected error processing refund webhook:",
          err?.message || err,
        );
      }
    })();
  } catch (err) {
    console.error("Refund webhook handler error:", err?.message || err);
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopify webhook server running on port ${PORT}`);

  // --- Review message scheduler (no-cron) ---
  // Sends `kaj_order_review_v2` once per fulfillment after a delay (default: 1 minute).
  // Disable with REVIEW_SCHEDULER_ENABLED=false
  const schedulerEnabled =
    String(process.env.REVIEW_SCHEDULER_ENABLED || "true").toLowerCase() !==
    "false";

  const hasReviewUrlConfig = Boolean(
    String(process.env.REVIEW_BUTTON_URL_TEMPLATE || "").trim() ||
      String(process.env.REVIEW_BUTTON_URL || "").trim(),
  );

  if (schedulerEnabled && !hasReviewUrlConfig) {
    console.warn(
      "Review scheduler is enabled but REVIEW_BUTTON_URL/REVIEW_BUTTON_URL_TEMPLATE is missing; review messages will fail to send.",
    );
  }

  const intervalMs =
    Number(process.env.REVIEW_SCHEDULER_INTERVAL_MS) || 30 * 1000;

  // Run shortly after boot, then periodically.
  setTimeout(() => {
    runReviewSchedulerOnce().catch(() => {});
  }, 30 * 1000);

  setInterval(() => {
    runReviewSchedulerOnce().catch(() => {});
  }, intervalMs);
});
