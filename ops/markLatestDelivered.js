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

  const explicitOrderId = Number(getArg("order") || "");

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

  const fr = await client.get({ path: `orders/${order.id}/fulfillments`, query: { limit: 50 } });
  const fulfillments = fr?.body?.fulfillments || [];
  if (!fulfillments.length) {
    throw new Error(`Latest order ${order.id} has no fulfillments to mark delivered`);
  }

  const fulfillment = fulfillments
    .slice()
    .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];

  const fulfillmentId = fulfillment?.id;
  if (!fulfillmentId) throw new Error("Fulfillment id missing");

  const ev = await client.post({
    path: `orders/${order.id}/fulfillments/${fulfillmentId}/events`,
    data: { event: { status: "delivered" } },
    type: "application/json",
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        orderId: order.id,
        orderName: order.name,
        fulfillmentId,
        touchedIdempotency: false,
        fulfillmentEventId: ev?.body?.fulfillment_event?.id || null,
        fulfillmentEventStatus: ev?.body?.fulfillment_event?.status || "delivered",
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("❌ Failed:", err?.response?.body || err?.message || err);
  process.exitCode = 1;
});
