# Review message (5 days after delivery)

## What this does

- On `fulfillments/update` webhook with `shipment_status === "delivered"`, the app captures a per-fulfillment delivery record into `delivery-review-fulfillments.json`.
- The main server (`index.js`) runs an in-process scheduler (no cron required) that sends an order review WhatsApp template **once per fulfillment** after a delay.

## Template

- Template name: `kaj_order_review_v2`
- Body placeholders: `{{1}} = customer name`, `{{2}} = order name`
- Button: expects a URL parameter (used for **Submit Review**)

## Env vars

Required for sending:
- `DOUBLETICK_API_KEY`
- `REVIEW_BUTTON_URL` **or** `REVIEW_BUTTON_URL_TEMPLATE`

Optional:
- `REVIEW_TEMPLATE_NAME` (default: `kaj_order_review_v2`)
- `DT_LANGUAGE` (default: `en`)
- `REVIEW_DELAY_MS` (default: 1 minute)
- `REVIEW_SCHEDULER_ENABLED` (default: `true`; set to `false` to disable in-process scheduler)
- `REVIEW_SCHEDULER_INTERVAL_MS` (default: 1 hour)

### REVIEW_BUTTON_URL_TEMPLATE

Use `{orderId}` and `{orderName}` tokens.

Example:
- `REVIEW_BUTTON_URL_TEMPLATE="https://yourdomain.com/review?orderId={orderId}&order={orderName}"`

## Run manually

- `npm run send:review`

## Logs

- Captures and sends are appended to `delivery-review-logs.jsonl`.
