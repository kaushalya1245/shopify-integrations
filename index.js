// shopify-webhooks-all-in-one.js
require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  shopifyApi,
  LATEST_API_VERSION,
  Session,
} = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");
const { razorpayClient } = require("./razorpayClient");

const app = express();
// Logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

// async function getTodaysPayments() {
//   console.log("Fetching today's payments from Razorpay...");
//   if (!razorpayClient) {
//     console.log("Razorpay client not initialized. Skipping payment fetch.");
//     return;
//   }
//   if (!razorpayClient.fetchTodaysPayments) {
//     console.log(
//       "fetchTodaysPayments method not available. Skipping payment fetch."
//     );
//     return;
//   }

//   try {
//     const todaysPayments = await razorpayClient.fetchTodaysPayments();
//     if (!todaysPayments || !todaysPayments.items) {
//       console.log("No payments found for today.");
//       return;
//     }
//     const capturedPayments = todaysPayments.items.filter(
//       (payment) => payment.status === "captured"
//     );
//     console.log(`Found ${capturedPayments.length} payments for today.`);

//     todaysPayments.items.map((payment) => {
//       // console.log(payment);
//       console.log(new Date(payment.created_at * 1000).toLocaleString());

//       if (payment?.notes?.cancelUrl === undefined) return;

//       // if (payment?.notes?.cancelUrl.indexOf(checkout?.cart_token) !== -1) {
//       //   createOrderFromPayment(checkout, payment, orderId);
//       // }
//     });
//   } catch (error) {
//     console.error("Error fetching payments:", error);
//     throw error;
//   }
// }

// getTodaysPayments()
//   .then(() => {
//     console.log("Today's payments fetched successfully.");
//   })
//   .catch((error) => {
//     console.error("Error in fetching today's payments:", error);
//   });

// Shopify setup (shared)
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
const USER_SUPPRESSION_WINDOW = 1 * 60 * 60 * 1000; // 12 Hours
const SEND_MESSAGE_DELAY = 15 * 60 * 1000; // 15 Minutes delay
let isSending = false;
const messageQueue = [];

async function processQueue() {
  if (isSending || messageQueue.length === 0) return;
  isSending = true;
  const { checkout } = messageQueue.shift();
  try {
    await handleAbandonedCheckoutMessage(checkout);
  } catch (err) {
    console.error("Abandoned checkout message failed");
  } finally {
    isSending = false;
    setImmediate(processQueue);
  }
}

async function handleAbandonedCheckoutMessage(checkout) {
  if (!checkout.token) return;

  if (
    !checkout.email &&
    !checkout?.phone &&
    !checkout.shipping_address?.phone
  ) {
    console.log(
      "Skipping incomplete checkout for sending message (missing contact info)"
    );
    return;
  }

  const processedTokens = loadSet(dataFiles.tokens);
  if (processedTokens.has(checkout.token)) return;

  let orders = [];
  try {
    const phone = checkout?.phone || checkout?.shipping_address?.phone;
    const queryField = checkout.email ? "email" : "phone";
    const queryValue = checkout.email || phone;
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
    const isOrderNotAbandoned = orders.find(
      (o) => o.cart_token === checkout.cart_token
    );
    if (isOrderNotAbandoned) return;

    const isConverted = orders.find((o) => o.checkout_token === checkout.token);
    if (isConverted) return;
  } catch (err) {
    console.error("Failed to fetch orders:", err);
  }

  const name = checkout.shipping_address?.first_name || "Customer";
  const amount = checkout.total_price || "0";
  const abandonedCheckoutUrl = `checkouts/cn/${checkout.cart_token}/information`;

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
      headers
    );
    const imageId = variantRes.data.variant.image_id;

    const productImagesRes = await axios.get(
      `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2025-04/products/${productId}/images.json`,
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

  let rawPhone = checkout?.phone || checkout?.shipping_address?.phone || "";
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

  try {
    // Uncomment the following lines to send the message via AISensy
    const response = await axios.post(
      "https://backend.aisensy.com/campaign/t1/api/v2",
      payload
    );
    saveSet(dataFiles.tokens, processedTokens, checkout.token);
    console.log("Abandoned checkout message sent:", response.data);
    console.log(`Abandoned checkout message sent to ${name} (${cleanedPhone})`);
  } catch (err) {
    console.error("Abandoned checkout message error");
    console.log(
      `Abandoned checkout message cannot be sent to ${name} (${cleanedPhone})`
    );
    if (err.response) {
      console.error("Response data:", err.response.data);
      console.error("Response status:", err.response.status);
    }
    throw err;
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

async function createOrderFromPayment(checkout, payment) {
  if (!checkout || !checkout.token) {
    console.log("No checkout token provided. Skipping order creation.");
    return;
  }
  if (!payment || !payment.id) {
    console.log("No payment ID provided. Skipping order creation.");
    return;
  }

  const orderPayload = {
    order: {
      email: checkout.email,
      phone: checkout.phone || checkout.shipping_address?.phone,
      currency: checkout.currency,
      // source_name: "web",
      customer: checkout.customer || undefined,
      billing_address: checkout.billing_address,
      shipping_address: checkout.shipping_address,

      // line items
      line_items: checkout.line_items.map((item) => ({
        variant_id: item.variant_id,
        quantity: item.quantity,
      })),

      // shipping lines (mirrors the store UI)
      shipping_lines: [
        {
          title: checkout.shipping_line?.title || "Standard",
          price: checkout.shipping_line?.price || "0.00",
          code: checkout.shipping_line?.code || "Standard",
          // source: "shopify",
        },
      ],

      // tax lines (so Shopify shows IGST etc)
      tax_lines: (checkout.tax_lines || []).map((t) => ({
        price: t.price,
        rate: t.rate,
        title: t.title,
      })),

      // financials
      financial_status: "paid",
      transactions: [
        {
          kind: "sale",
          status: "success",
          amount: checkout.total_price,
          gateway: "razorpay",
          authorization: payment.id,
        },
      ],

      // optional note/tag so you can skip it later
      note: `Auto-created after Razorpay capture (${payment.id})`,
      tags: "ManualOrder,RazorpayPaid",
    },
  };

  // Step 3: Create the order
  try {
    const orderResponse = await client.post({
      path: "orders",
      data: orderPayload,
      type: "application/json",
    });

    console.log(
      "✅ Order created from abandoned checkout:",
      orderResponse.body.order.id
    );
  } catch (error) {
    console.error("❌ Error creating order from checkout:", error);
    if (error.response) {
      console.error("Response data:", error.response.data);
      console.error("Response status:", error.response.status);
    }
  }
}

async function verifyCheckout(checkout) {
  if (!checkout || !checkout.token) {
    console.log("No checkout token provided. Skipping payment fetch.");
    return;
  }
  if (!razorpayClient) {
    console.log("Razorpay client not initialized. Skipping payment fetch.");
    return;
  }

  if (!checkout.token) return;

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
    const phone = checkout?.phone || checkout?.shipping_address?.phone;
    if (!phone) {
      console.log("No contact info available for checkout. Skipping.");
      return;
    }
    const queryField = checkout.email ? "email" : "phone";
    const queryValue = checkout.email || phone;
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

    const isOrderNotAbandoned = orders.find(
      (o) => o.cart_token === checkout.cart_token
    );
    if (isOrderNotAbandoned) {
      orderId = isOrderNotAbandoned.id;
      console.log(
        `Checkout ${checkout.cart_token} is not abandoned. Skipping payment verification.`
      );
      return;
    } else {
      console.log(
        `Checkout ${checkout.cart_token} is abandoned. Proceeding with payment verification.`
      );
    }

    const isConverted = orders.find((o) => o.checkout_token === checkout.token);
    if (isConverted) {
      console.log(
        `Checkout ${checkout.token} already converted to order. Skipping payment verification.`
      );
      return;
    }
  } catch (err) {
    console.error("Failed to fetch orders:", err);
  }

  try {
    const todaysPayments = await razorpayClient.fetchTodaysPayments();
    if (!todaysPayments || !todaysPayments.items) {
      console.log("No payments found for today.");
      return;
    }

    const capturedPayments = todaysPayments.items.find((payment) => {
      if (payment.status !== "captured") return;
      if (payment?.notes?.cancelUrl === undefined) return;
      if (payment?.notes?.cancelUrl.indexOf(checkout?.cart_token) !== -1) {
        return payment;
      }
    });

    if (!capturedPayments) {
      console.log(
        `No captured payments found for checkout ${checkout.cart_token}. Proceeding with message queueing.`
      );
      messageQueue.push({ checkout });
      processQueue();
      return;
    } else {
      console.log(
        `Captured payment found for checkout ${checkout.cart_token}:`,
        capturedPayments.contact,
        capturedPayments.id,
        new Date(capturedPayments.created_at * 1000).toLocaleString()
      );
      await createOrderFromPayment(checkout, capturedPayments);
      console.log(`Found ${todaysPayments.items.length} payments for today.`);
    }
  } catch (error) {
    console.error("Error fetching payments:", error);
    throw error;
  }
}

app.post("/webhook/abandoned-checkouts", async (req, res) => {
  res.status(200).send("OK");

  const checkout = req.body;
  const token = checkout?.token;
  const cart_token = checkout?.cart_token;
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

  const rawPhone = checkout?.phone || checkout?.shipping_address?.phone || "";

  if (rawPhone.replace(/\D/g, "").length <= 10) {
    console.log("Missing contact info. Skipping...");
    return;
  }

  if (
    (checkout?.phone && checkout?.shipping_address?.first_name) ||
    (checkout?.shipping_address?.phone &&
      checkout?.shipping_address?.first_name)
  ) {
    console.log(
      `[${eventType}] Checkout has contact info. Proceeding with message queueing.`
    );
  } else {
    console.log(
      `[${eventType}] Checkout missing contact info. Skipping message queueing.`
    );
    return;
  }

  if (isRecentlyMessaged(checkout)) {
    console.log(`[${eventType}] User recently messaged. Skipping...`);
    return;
  }

  console.log(
    `[${eventType}] Queuing new message for cart_token: ${cart_token}`
  );

  setTimeout(() => {
    verifyCheckout(checkout);
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
    const orderName = order.name.replace("#", "") || "Unknown Order";
    const amount = order.total_price || "0";

    let rawPhone = shippingAddress.phone || customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);

    // Fetch product image
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
          headers
        );
        if (productImagesRes?.data?.images?.length) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
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
      templateParams: [name, orderName, `₹${amount}`, orderStatusURL],
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

    try {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      saveSet(dataFiles.orders, processedOrders, order.id.toString());
      console.log("Order confirmation message sent:", response.data);
      console.log(`Order confirmation sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error("Order confirmation message error");
      console.log(`Order confirmation cannot be sent to (${cleanedPhone})`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
      throw err;
    }
  } catch (err) {
    console.error("Order confirmation error:", err);
  }
}

app.post("/webhook/order-confirmation", (req, res) => {
  res.status(200).send("Order confirmation webhook received");
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

    let rawPhone = customer.phone || "";
    let cleanedPhone = rawPhone.replace(/\s+/g, "").slice(-10);

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
          headers
        );
        if (productImagesRes?.data?.images?.length > 0) {
          const variantImage = productImagesRes?.data?.images.find((img) =>
            img.variant_ids.includes(variantId)
          );
          imageUrl = (
            variantImage || productImagesRes?.data?.images[0]
          ).src.split("?")[0];
        }
      } catch (imageError) {
        console.error("Failed to fetch product image:", imageError);
      }
    }

    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: process.env.OST_CAMPAIGN_NAME,
      destination: cleanedPhone,
      userName: name,
      source: "fulfillment",
      templateParams: [
        name,
        `${orderName}`,
        `${trackingNumber}`,
        fulfillmentStatusURL,
      ],
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

    try {
      const response = await axios.post(
        "https://backend.aisensy.com/campaign/t1/api/v2",
        payload
      );
      saveSet(
        dataFiles.fulfillments,
        processedFulfillments,
        fulfillment.id.toString()
      );
      console.log("Fulfillment message sent:", response.data);
      console.log(`Fulfillment message sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error("Fulfillment message error");
      console.log(`Fulfillment message cannot be sent to (${cleanedPhone})`);
      if (err.response) {
        console.error("Response data:", err.response.data);
        console.error("Response status:", err.response.status);
      }
      throw err;
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
