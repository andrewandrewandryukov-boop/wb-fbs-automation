# V0.16 — safe read-only preflight

Scope: one pending FBS order already observed in the private idempotency ledger.

- Fail closed if WB returns 0 or more than 1 pending order.
- Verify order ID against the existing ledger, seller warehouse ID 1992848, and nmId.
- Fetch the product card with the same WB_API_TOKEN (Marketplace + Content), verify exactly one matching SKU, title and vendorCode.
- Request ONLY the official WB order sticker using the documented sticker retrieval endpoint. Its POST is a read operation; no supply or order state is changed.
- Convert the returned official PNG to an in-memory 40×30 mm PDF and verify its PDF header. PDF bytes are discarded.
- Persist and expose only aggregate booleans and HTTP statuses via /status.pendingOrderProbe; never persist order IDs, barcodes, product names, card bodies, image bytes or PDF bytes in this probe.
- One-shot Durable Object storage key pendingOrderProbeV1 is written before network access. No automatic retries or additional Cron.
- READ_ONLY remains mandatory. No supply creation, no shipping date, no order status changes, no Telegram document delivery.
- A 58×40 mm supply QR cannot be produced for a newly pending order without a verified real supply ID. Do not substitute a historical QR.
- Four-page production PDF remains blocked pending full page layout validation and a genuine supply; state ready_for_label_layout is NOT authorization to ship.

Check the deployed version in /health and the aggregate pendingOrderProbe in /status. A GitHub commit alone does not prove deployment.
