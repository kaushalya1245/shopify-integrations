// shopify-webhooks-all-in-one.js
require("dotenv").config();
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
const { razorpayClient } = require("./razorpayClient");

const app = express();

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

// Message queue and suppression logic
const recentUsers = new Map();
const SEND_MESSAGE_DELAY = 25 * 60 * 1000; // 25 Minutes delay // Change
const USER_SUPPRESSION_WINDOW = SEND_MESSAGE_DELAY; // Same send message delay
const MINUTES_FOR_PAYMENT_CHECK = 30; // 30 Minutes delay
let isSending = false;
const messageQueue = [];

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
  payments: path.resolve(__dirname, "processed-payments.json"),
};

function loadSet(filePath, type = "set") {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath));
    if (type === "timestamp") {
      const now = Date.now();
      const valid = {};
      for (const [token, timestamp] of Object.entries(raw)) {
        if (now - timestamp < SEND_MESSAGE_DELAY) {
          valid[token] = timestamp;
        }
      }
      return valid;
    } else {
      return new Set(raw);
    }
  } catch {
    return type === "timestamp" ? {} : new Set();
  }
}

function saveSet(filePath, dataset, item, type = "set") {
  if (type === "timestamp") {
    dataset[item] = Date.now();
    fs.writeFileSync(filePath, JSON.stringify(dataset, null, 2));
  } else {
    dataset.add(item);
    fs.writeFileSync(filePath, JSON.stringify(Array.from(dataset)));
  }
}

// --- Abandoned Checkouts ---

async function processQueue() {
  if (isSending || messageQueue.length === 0) return;
  isSending = true;
  const { checkout } = messageQueue.shift();
  try {
    await handleAbandonedCheckoutMessage(checkout);
  } catch (err) {
    console.error("Abandoned checkout message failed", err);
  } finally {
    isSending = false;
    setImmediate(processQueue);
  }
}

// async function fetchPayments() {
//   try {
//     const todaysPayments = await razorpayClient.fetchTodaysPayments();
//     if (!todaysPayments || !todaysPayments.items) {
//       console.log("No payments found for today.");
//       return;
//     }

//     todaysPayments.items.map((payment) => {
//       if (payment.status !== "captured") return;
//       console.log(payment);
//       if (payment?.notes?.cancelUrl === undefined) return;
//     });

//     const capturedPayments = todaysPayments.items.filter(
//       (payment) => payment.status === "captured"
//     );

//     console.log(capturedPayments.length, "payments found for today.");
//   } catch (error) {
//     console.error("Error fetching payments");
//   }
// }

// fetchPayments(); // Change

async function handleAbandonedCheckoutMessage(checkout) {
  if (!checkout.token) return;
  const token = checkout.token;

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

  const processedTokens = loadSet(dataFiles.tokens, "timestamp");
  if (token in processedTokens) {
    console.log(token, " token is already processed. Skipping.");
    return;
  }

  let orders = [];
  try {
    const phone = checkout?.shipping_address?.phone || checkout?.phone;
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
    console.error("Failed to fetch orders");
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
    console.error("Failed to fetch product images");
  }

  let rawPhone = checkout?.shipping_address?.phone || checkout?.phone || "";
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
    const response = await axios.post(
      "https://backend.aisensy.com/campaign/t1/api/v2",
      payload
    ); // Change
    saveSet(dataFiles.tokens, processedTokens, checkout.token, "timestamp");
    setTimeout(() => {
      loadSet(dataFiles.tokens, "timestamp");
    }, 1 * 60 * 1000); // Delay for 1 minute for deleting old tokens
    console.log(
      `Abandoned checkout message sent for cart_token: ${checkout.cart_token}.  Response: ${response.data}`
    );
    console.log(`Abandoned checkout message sent to ${name} (${cleanedPhone})`);
  } catch (err) {
    console.error("Abandoned checkout message error: ", err);
    console.log(
      `Abandoned checkout message cannot be sent to ${name} (${cleanedPhone})`
    );
    if (err.response) {
      console.error("Response data:", err.response.data);
      console.error("Response status:", err.response.status);
    }
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

  const rawPhone =
    checkout.phone ||
    checkout.shipping_address?.phone ||
    checkout.billing_address?.phone ||
    "";

  const sanitizedPhone = rawPhone.replace(/\D/g, ""); // remove all non-digits

  // Prefix country code if missing
  const formattedPhone =
    sanitizedPhone.length === 10
      ? `+91${sanitizedPhone}`
      : `+${sanitizedPhone}`;

  let customerId = null;
  try {
    const res = await client.get({
      path: "customers/search",
      query: { phone: `${formattedPhone}` },
    });
    if (res.body.customers?.length > 0) {
      customerId = res.body.customers?.[0]?.id || null;
      console.log("Found customer id:", customerId);
    } else {
      console.log("ℹ️ No existing customer found with phone:", formattedPhone);
    }
  } catch (error) {
    console.error("Error fetching customer by phone:", error);
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
      phone: formattedPhone, // Make sure this is validated
    };
  }

  const orderPayload = {
    order: {
      email: checkout.email,
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
              0
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

      note: `Auto-created after Razorpay capture (${payment.id})`,
      tags: "ManualOrder, RazorpayPaid",
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
            headers
          );

          if (!variantRes.data || !variantRes.data.variant) {
            console.log(`No variant found for ID ${variantId}`);
            return;
          }

          console.log(
            `Processing variant ${variantId} for inventory adjustment`
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
            `Adjusting inventory for variant ${variantId} (item ID: ${inventoryItemId})`
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
                  inventoryResponse
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
    const phone = checkout?.shipping_address?.phone || checkout?.phone;
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

    if (orders) {
      const isOrderNotAbandoned = orders.find(
        (o) => o.cart_token === checkout.cart_token
      );
      if (isOrderNotAbandoned) {
        orderId = isOrderNotAbandoned.id;
        console.log(
          `Checkout ${checkout.cart_token} is not abandoned. Skipping payment verification.`
        );
        return; // Change
      } else {
        console.log(
          `Checkout ${checkout.cart_token} is abandoned. Proceeding with payment verification.`
        );
      }

      const isConverted = orders.find(
        (o) => o.checkout_token === checkout.token
      );
      if (isConverted) {
        console.log(
          `Checkout ${checkout.token} already converted to order. Skipping payment verification.`
        );
        return; // Change
      }
    }
  } catch (err) {
    console.error("Failed to fetch orders:", err);
  }

  try {
    const processedPayments = loadSet(dataFiles.payments, "set");

    const todaysPayments = await razorpayClient.fetchTodaysPayments();
    if (!todaysPayments || !todaysPayments.items) {
      console.log("No payments found for today.");
    } else {
      const capturedPayments = todaysPayments.items.find((payment) => {
        if (payment.status !== "captured") return;
        if (payment?.notes?.cancelUrl === undefined) return;
        const perfectPhoneDigits = payment?.contact
          .replace(/\s+/g, "")
          .slice(-10);
        const perfectAmount = payment?.amount / 100;
        const totalCheckoutPrice = Number(checkout.total_price);
        const currentTimestamp = Math.floor(Date.now() / 1000);
        const thirtyMinutesAgo =
          currentTimestamp - MINUTES_FOR_PAYMENT_CHECK * 60;
        if (
          ((perfectPhoneDigits === checkout?.shipping_address?.phone &&
            perfectAmount == totalCheckoutPrice) ||
            (payment?.contact === checkout?.phone &&
              perfectAmount == totalCheckoutPrice) ||
            payment?.notes?.cancelUrl.indexOf(checkout?.cart_token) !== -1) &&
          payment.created_at >= thirtyMinutesAgo &&
          payment.created_at <= currentTimestamp
        ) {
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
      }

      if (processedPayments.has(capturedPayments.id)) {
        console.log(
          `Payment ${capturedPayments.id} already processed. Skipping.`
        );
        return;
      }

      console.log(
        `Captured payment found for checkout ${checkout.cart_token}:`,
        capturedPayments.contact,
        capturedPayments.id,
        new Date(capturedPayments.created_at * 1000).toLocaleString()
      );

      saveSet(dataFiles.payments, processedPayments, capturedPayments.id);
      await createOrderFromPayment(checkout, capturedPayments);
    }
  } catch (error) {
    console.error("Error fetching payments");
  }
}

app.post("/webhook/abandoned-checkouts", async (req, res) => {
  res.status(200).send("OK");

  const checkout = req.body;
  const token = checkout?.token;
  const cart_token = checkout?.cart_token;
  const eventType = req.headers["x-shopify-topic"];
  if (cart_token) {
    console.log(`[${eventType}] Processing cart_token: ${cart_token}`);
  }

  if (!token) {
    console.log(`[${eventType}] Missing token. Ignored.`);
    return;
  }

  const processedTokens = loadSet(dataFiles.tokens, "timestamp");
  if (token in processedTokens) {
    console.log(`[${eventType}] Already processed token: ${token}`);
    return;
  }

  const rawPhone = checkout?.shipping_address?.phone || checkout?.phone || "";

  if (rawPhone.replace(/\D/g, "").length < 10) {
    console.log("Missing contact info. Skipping...");
    return;
  }

  if (
    (checkout?.shipping_address?.phone &&
      checkout?.shipping_address?.first_name) ||
    (checkout?.phone && checkout?.shipping_address?.first_name)
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
const processedOrders = loadSet(dataFiles.orders, "set");

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
        console.error("Failed to fetch product image");
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
      ); // Change
      saveSet(dataFiles.orders, processedOrders, order.id.toString(), "set");
      console.log(
        `Order confirmation message sent for ${order.cart_token}. Response: ${response.data}`
      );
      console.log(`Order confirmation sent to ${name} (${cleanedPhone})`);
    } catch (err) {
      console.error("Order confirmation message error");
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
        `${name}`,
        `${orderName}`,
        `${trackingNumber}`,
        `${fulfillmentStatusURL}`,
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
      ); // Change
      saveSet(
        dataFiles.fulfillments,
        processedFulfillments,
        fulfillment.id.toString(),
        "set"
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
