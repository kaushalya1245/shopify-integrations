require("dotenv").config();

const { shopifyApi, LATEST_API_VERSION, Session } = require("@shopify/shopify-api");
const { nodeAdapter } = require("@shopify/shopify-api/adapters/node");

async function fetchNgrokPublicUrl() {
  return new Promise((resolve) => {
    const http = require("http");
    const req = http.get("http://127.0.0.1:4040/api/tunnels", (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const obj = JSON.parse(data);
          const tunnels = Array.isArray(obj.tunnels) ? obj.tunnels : [];
          const https = tunnels.find((t) => String(t.public_url || "").startsWith("https://"));
          resolve(https?.public_url || tunnels[0]?.public_url || "");
        } catch {
          resolve("");
        }
      });
    });
    req.on("error", () => resolve(""));
  });
}

async function main() {
  const shop = process.env.SHOPIFY_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token) {
    throw new Error("Missing SHOPIFY_DOMAIN or SHOPIFY_ADMIN_TOKEN in .env");
  }

  const baseUrl = process.env.PUBLIC_BASE_URL || (await fetchNgrokPublicUrl());
  if (!baseUrl) {
    throw new Error(
      "Could not determine public base URL. Start ngrok or set PUBLIC_BASE_URL=https://...",
    );
  }

  const shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    adminApiAccessToken: token,
    scopes: ["read_orders", "write_orders", "read_customers"],
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

  const addressPath = (addr) => {
    try {
      return new URL(String(addr)).pathname;
    } catch {
      return String(addr || "");
    }
  };

  const desired = [
    {
      topic: "fulfillments/update",
      address: `${baseUrl}/webhook/fulfillments/update`,
    },
    {
      // Local pickup: detect "Ready for pickup" from fulfillments/update
      topic: "fulfillments/update",
      address: `${baseUrl}/webhook/fulfillments/update-pickup`,
    },
    {
      topic: "refunds/create",
      address: `${baseUrl}/webhook/refunds/create`,
    },
    {
      // Admin label: "Fulfillment order line items are prepared for pickup"
      topic: "fulfillment_orders/line_items_prepared_for_pickup",
      address: `${baseUrl}/webhook/fulfillment_orders/line_items_prepared_for_pickup`,
    },
  ];

  const resp = await client.get({ path: "webhooks", query: { limit: 250 } });
  const existing = resp?.body?.webhooks || [];

  for (const d of desired) {
    const exact = existing.find((w) => w.topic === d.topic && w.address === d.address);
    if (exact) {
      console.log("✅ Webhook already present", {
        topic: d.topic,
        id: exact.id,
        address: exact.address,
      });
      continue;
    }

    // If the route already exists for this topic but public base URL changed, update that one.
    const byTopicAndPath = existing.find(
      (w) => w.topic === d.topic && addressPath(w.address) === addressPath(d.address),
    );
    if (byTopicAndPath) {
      const updated = await client.put({
        path: `webhooks/${byTopicAndPath.id}`,
        data: { webhook: { id: byTopicAndPath.id, address: d.address } },
        type: "application/json",
      });

      console.log("♻️ Webhook updated", {
        topic: d.topic,
        id: byTopicAndPath.id,
        from: byTopicAndPath.address,
        to: d.address,
        resultId: updated?.body?.webhook?.id,
      });
      continue;
    }

    const created = await client.post({
      path: "webhooks",
      data: { webhook: { topic: d.topic, address: d.address, format: "json" } },
      type: "application/json",
    });

    console.log("➕ Webhook created", {
      topic: d.topic,
      id: created?.body?.webhook?.id,
      address: d.address,
    });
  }

  console.log("Public base URL:", baseUrl);
}

main().catch((err) => {
  console.error("❌ Failed:", err?.response?.body || err?.message || err);
  process.exitCode = 1;
});
