const express = require('express');

const app = express();

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────
const paymentRoutes = require('./routes/payments');
app.use('/api', paymentRoutes);

// Health check — useful for load-balancer liveness probes
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FinSafe Idempotency Gateway running on http://localhost:${PORT}`);
  console.log(`  POST http://localhost:${PORT}/api/process-payment`);
  console.log(`  GET  http://localhost:${PORT}/health`);
});

module.exports = app; // exported for testing
