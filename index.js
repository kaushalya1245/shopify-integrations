// shopify-webhooks-all-in-one.js
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
} = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");
require("dotenv").config();

const app = express();
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Shopify setup (shared)
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  scopes: ["read_orders", "write_orders", "read_checkouts"],
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

// --- Helpers for persistence ---
const dataFiles = {
  tokens: path.resolve(__dirname, "processed-tokens.json"),
  orders: path.resolve(__dirname, "processed-orders.json"),
  fulfillments: path.resolve(__dirname, "processed-fulfillments.json"),
};

function loadSet(filePath) {
  try {
    return new Set(JSON.parse(fs.readFileSync(filePath)));
  } catch {
    return new Set();
  }
}

function saveSet(filePath, set, item) {
  set.add(item);
  fs.writeFileSync(filePath, JSON.stringify(Array.from(set)));
}

// --- Abandoned Checkouts ---
// Message queue and suppression logic
const recentUsers = new Map();
const USER_SUPPRESSION_WINDOW = 10 * 60 * 1000; // 10 mins
const SEND_MESSAGE_DELAY = 1 * 60 * 1000; // 1 min delay
let isSending = false;
const messageQueue = [];

async function processQueue() {
  if (isSending || messageQueue.length === 0) return;
  isSending = true;
  const { checkout } = messageQueue.shift();
  try {
    await handleAbandonedCheckoutMessage(checkout);
  } catch (err) {
    console.error("Abandoned checkout message failed:", err);
  } finally {
    isSending = false;
    setImmediate(processQueue);
  }
}

async function handleAbandonedCheckoutMessage(checkout) {
  if (!checkout.token) return;

  if (!checkout.email && !checkout.phone && !checkout.shipping_address?.phone) {
    console.log("Skipping incomplete checkout (missing contact info)");
    return;
  }

  const processedTokens = loadSet(dataFiles.tokens);
  if (processedTokens.has(checkout.token)) return;

  let orders = [];
  try {
    const queryField = checkout.email ? "email" : "phone";
    const queryValue = checkout.email || checkout.phone;
    const res = await client.get({
      path: "orders",
      query: {
        [queryField]: queryValue,
        fields: "id, checkout_token, cart_token",
        status: "any",
        limit: 5,
      },
    });
    orders = res.body.orders;
  } catch (err) {
    console.error("Failed to fetch orders:", err);
  }

  const isOrderNotAbandoned = orders.find(
    (o) => o.cart_token === checkout.cart_token
  );
  if (isOrderNotAbandoned) return;

  const isConverted = orders.find((o) => o.checkout_token === checkout.token);
  if (isConverted) return;

  const name = checkout.shipping_address?.first_name || "Customer";
  const amount = checkout.total_price || "0";
  const abandonedCheckoutUrl = `checkouts/cn/${checkout.cart_token}/information`;

  // Fetch product image
  const variantId = Number(checkout.line_items[0]?.variant_id);
  const productId = Number(checkout.line_items[0]?.product_id);
  const headers = {
    headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN },
  };

  let imageUrl = "https://your-default.jpg";

  try {
    const variantRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2023-07/variants/${variantId}.json`,
      headers
    );
    const imageId = variantRes.data.variant.image_id;

    const productImagesRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2023-07/products/${productId}/images.json`,
      headers
    );
    const allImages = productImagesRes.data?.images || [];

    imageUrl = allImages[0]?.src.split("?")[0] || imageUrl;
    if (imageId) {
      const matchedImage = allImages.find((img) => img.id === imageId);
      imageUrl = matchedImage?.src || imageUrl;
    }
  } catch (err) {
    console.error("Failed to fetch product images:", err);
  }

  let rawPhone = checkout.shipping_address?.phone || "";
  let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);

  const payload = {
    apiKey: process.env.AISENSY_API_KEY,
    campaignName: process.env.AC_CAMPAIGN_NAME,
    destination: cleanedPhone,
    userName: name,
    source: "organic",
    templateParams: [name, amount, abandonedCheckoutUrl],
    media: {
      url: imageUrl,
      filename: "product.jpg",
    },
    buttons: [
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: abandonedCheckoutUrl }],
      },
    ],
  };

  if (rawPhone.includes("7073968463")) {
    const response = await axios.post(
      "https://backend.aisensy.com/campaign/t1/api/v2",
      payload
    );
    console.log("Abandoned checkout message sent:", response.data);
    saveSet(dataFiles.tokens, processedTokens, checkout.token);
  } else {
    console.log("Skipping message for phone:", rawPhone);
  }
}

function isRecentlyMessaged(checkout) {
  const now = Date.now();
  const key =
    checkout.email || checkout.phone || checkout.shipping_address?.phone;
  if (!key) return false;

  const lastSeen = recentUsers.get(key);
  if (lastSeen && now - lastSeen < USER_SUPPRESSION_WINDOW) return true;

  recentUsers.set(key, now);
  return false;
}

app.post("/webhook/abandoned-checkouts", async (req, res) => {
  res.status(200).send("OK");

  const checkout = req.body;
  const token = checkout?.token;
  const eventType = req.headers["x-shopify-topic"];

  if (!token) {
    console.log(`[${eventType}] Missing token. Ignored.`);
    return;
  }

  const processedTokens = loadSet(dataFiles.tokens);
  if (processedTokens.has(token)) {
    console.log(`[${eventType}] Already processed token: ${token}`);
    return;
  }

  const rawPhone = checkout.phone || checkout.shipping_address?.phone || "";

  if (rawPhone.replace(/\D/g, "").length <= 10) {
    console.log("Missing contact info. Skipping...");
    return;
  }

  if (isRecentlyMessaged(checkout)) {
    console.log(`[${eventType}] User recently messaged. Skipping...`);
    return;
  }

  console.log(`[${eventType}] Queuing new message for token: ${token}`);

  setTimeout(() => {
    messageQueue.push({ checkout });
    processQueue();
  }, SEND_MESSAGE_DELAY);
});

// --- Order Confirmation ---
const processedOrders = loadSet(dataFiles.orders);

async function sendOrderConfirmation(order) {
  try {
    const customer = order.customer || {};
    const shippingAddress = order.shipping_address || {};
    const name =
      shippingAddress.first_name || customer.first_name || "Customer";
    const confirmationNumber = order.confirmation_number || "Unknown Order";
    const amount = order.total_price || "0";

    let rawPhone = shippingAddress.phone || customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);

    // Fetch product image
    let imageUrl = "https://default-product-image.jpg";
    if (order.line_items?.length) {
      const productId = order.line_items[0].product_id;
      const variantId = order.line_items[0].variant_id;

      try {
        const productRes = await client.get({
          path: `products/${productId}/images`,
        });
        if (productRes.body.images?.length) {
          const variantImage = productRes.body.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (variantImage || productRes.body.images[0]).src.split(
            "?"
          )[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image:", imageError);
      }
    }

    let orderStatusURL = `${process.env.SHOP_URL}/account/order/${order.id}`;
    if (order.order_status_url) {
      orderStatusURL = order.order_status_url.replace(
        `https://${process.env.HOST_NAME}/`,
        ""
      );
    }

    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.OC_CAMPAIGN_NAME,
      destination: cleanedPhone,
      userName: name,
      source: "organic",
      templateParams: [name, confirmationNumber, `₹${amount}`, orderStatusURL],
      media: {
        url: imageUrl,
        filename: "order.jpg",
      },
      buttons: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: orderStatusURL }],
        },
      ],
    };

    if (rawPhone.includes("7073968463")) {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      console.log("Order confirmation message sent:", response.data);
      saveSet(dataFiles.orders, processedOrders, order.id.toString());
    } else {
      console.log("Skipping message for phone:", rawPhone);
    }
  } catch (err) {
    console.error("Order confirmation error:", err);
  }
}

app.post("/webhook/order-confirmation", (req, res) => {
  res.status(200).send("OK");
  const order = req.body;

  if (processedOrders.has(order.id.toString())) {
    console.log(`Order ${order.id} already processed`);
    return;
  }

  sendOrderConfirmation(order);
});

// --- Fulfillment Creation ---
const processedFulfillments = loadSet(dataFiles.fulfillments);

async function sendFulfillmentMessage(fulfillment) {
  try {
    const orderId = fulfillment.order_id;
    const customer = fulfillment.destination || {};
    const name = customer.first_name || "Customer";
    const trackingNumber = fulfillment.tracking_number || "Unknown fulfillment";
    let amount = "0";
    try {
      const order = await client.get({
        path: `orders/${orderId}`,
      });
      amount = order.body.order.total_price || "0";
    } catch (orderError) {
      console.error("Failed to fetch order details:", orderError);
    }

    let rawPhone = customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);

    const fulfillmentStatusURL = fulfillment.tracking_url;
    console.log(`Fulfillment status URL: ${fulfillmentStatusURL}`);

    // Product image
    let imageUrl = "https://default-product-image.jpg";
    if (fulfillment.line_items?.length > 0) {
      const productId = fulfillment.line_items[0].product_id;
      const variantId = fulfillment.line_items[0].variant_id;
      try {
        const productRes = await client.get({
          path: `products/${productId}/images`,
        });
        if (productRes.body.images?.length > 0) {
          const variantImage = productRes.body.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (variantImage || productRes.body.images[0]).src.split(
            "?"
          )[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image:", imageError);
      }
    }

    console.log(fulfillmentStatusURL);

    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.OST_CAMPAIGN_NAME,
      destination: cleanedPhone,
      userName: name,
      source: "fulfillment",
      templateParams: [name, `${orderId}`, `${trackingNumber}`],
      media: {
        url: imageUrl,
        filename: "product.jpg",
      },
      buttons: [
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [
            {
              type: "text",
              text: `${fulfillmentStatusURL}`,
            },
          ],
        },
      ],
    };

    console.log(rawPhone);
    if (rawPhone.includes("7073968463")) {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      console.log("Fulfillment message sent:", response.data);
      saveSet(
        dataFiles.fulfillments,
        processedFulfillments,
        fulfillment.id.toString()
      );
    } else {
      console.log("Skipping fulfillment message for phone:", rawPhone);
    }
  } catch (err) {
    console.error("Fulfillment message error:", err);
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

// --- Redirect Service ---
app.get("/redirect_for_shipment", (req, res) => {
  const target = req.query.link;

  if (!target || typeof target !== "string") {
    return res.status(400).send("Missing or invalid 'link' parameter.");
  }

  return res.redirect(target);
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shopify webhook server running on port ${PORT}`);
});
