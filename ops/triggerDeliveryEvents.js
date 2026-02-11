require("dotenv").config();

const { shopifyApi, LATEST_API_VERSION, Session } = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] || null;
}

async function main() {
  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) throw new Error("Missing SHOPIFY_DOMAIN/SHOPIFY_ADMIN_TOKEN");

  const orderId = Number(getArg("order") || process.env.TEST_ORDER_ID);
  const fulfillmentId = Number(getArg("fulfillment") || process.env.TEST_FULFILLMENT_ID);

  if (!orderId || !fulfillmentId) {
    throw new Error(
      "Provide --order <orderId> and --fulfillment <fulfillmentId> (or set TEST_ORDER_ID/TEST_FULFILLMENT_ID)",
    );
  }

  const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    adminApiAccessToken: token,
    scopes: ["read_orders", "write_orders"],
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

  const statuses = ["in_transit", "delivered"];
  for (const status of statuses) {
    await client.post({
      path: `orders/${orderId}/fulfillments/${fulfillmentId}/events`,
      data: { event: { status } },
      type: "application/json",
    });
    console.log("✅ created fulfillment event", { status, orderId, fulfillmentId });
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err?.response?.body || err?.message || err);
  process.exitCode = 1;
});
