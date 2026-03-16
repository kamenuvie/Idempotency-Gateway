const express = require('express');
const router = express.Router();

const idempotencyMiddleware = require('../middleware/idempotency');
const idempotencyStore = require('../store/idempotencyStore');
const { processPayment } = require('../services/paymentService');

/**
 * POST /api/process-payment
 *
 * Headers:
 *   Idempotency-Key: <unique-string>  (required)
 *
 * Body:
 *   { "amount": 100, "currency": "GHS" }
 *
 * Responses:
 *   201 – Payment processed successfully (first request)
 *   201 + X-Cache-Hit: true – Replayed cached response (duplicate request)
 *   400 – Missing / invalid fields
 *   422 – Same key reused with a different request body
 *   500 – Internal processing error
 */
router.post('/process-payment', idempotencyMiddleware, async (req, res) => {
  const { amount, currency } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (amount === undefined || amount === null) {
    idempotencyStore.setFailed(req.idempotencyKey);
    return res.status(400).json({ error: 'Request body must include "amount".' });
  }
  if (!currency) {
    idempotencyStore.setFailed(req.idempotencyKey);
    return res.status(400).json({ error: 'Request body must include "currency".' });
  }
  if (typeof amount !== 'number' || amount <= 0) {
    idempotencyStore.setFailed(req.idempotencyKey);
    return res.status(400).json({ error: '"amount" must be a positive number.' });
  }
  if (typeof currency !== 'string' || currency.trim().length === 0) {
    idempotencyStore.setFailed(req.idempotencyKey);
    return res.status(400).json({ error: '"currency" must be a non-empty string.' });
  }

  // ── Process payment ───────────────────────────────────────────────────────
  try {
    const result = await processPayment({ amount, currency });

    const statusCode = 201;
    const responseBody = result;

    // IMPORTANT: persist the result to the idempotency store BEFORE sending
    // the response, so any waiting duplicate requests receive it immediately.
    res.setIdempotencyResult({ statusCode, body: responseBody });

    return res.status(statusCode).json(responseBody);
  } catch (err) {
    // Clean up the processing lock so the client can retry
    idempotencyStore.setFailed(req.idempotencyKey);
    console.error('[PaymentRoute] Unhandled error:', err);
    return res.status(500).json({ error: 'Payment processing failed. Please try again.' });
  }
});

module.exports = router;
