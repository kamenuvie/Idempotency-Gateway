const { v4: uuidv4 } = require('uuid');

/**
 * Simulates a payment authorization with a real bank/processor.
 * The artificial 2-second delay represents the round-trip to an
 * external payment rail (e.g., card network authorization).
 *
 * @param {Object} params
 * @param {number} params.amount   - Positive numeric amount to charge
 * @param {string} params.currency - ISO 4217 currency code (e.g. "GHS", "USD")
 * @returns {Promise<Object>} Resolved payment record
 */
async function processPayment({ amount, currency }) {
  // Simulate bank/processor round-trip latency
  await new Promise((resolve) => setTimeout(resolve, 2000));

  return {
    status: 'success',
    message: `Charged ${amount} ${currency.toUpperCase()}`,
    transactionId: uuidv4(),
    amount,
    currency: currency.toUpperCase(),
    processedAt: new Date().toISOString(),
  };
}

module.exports = { processPayment };
