const express = require('express');
const path    = require('path');
const { exec } = require('child_process');

const app = express();

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
const URL  = `http://localhost:${PORT}`;

const server = app.listen(PORT, () => {
  console.log('\n┌──────────────────────────────────────────────────┐');
  console.log('│   FinSafe Idempotency Gateway  ✓  Running         │');
  console.log('├──────────────────────────────────────────────────┤');
  console.log(`│   UI   → ${URL.padEnd(39)}│`);
  console.log(`│   POST → ${URL}/api/process-payment`.padEnd(51) + '│');
  console.log(`│   GET  → ${URL}/health`.padEnd(51) + '│');
  console.log('└──────────────────────────────────────────────────┘\n');

  // Auto-open browser (only when run directly, not during tests)
  if (process.env.NODE_ENV !== 'test') {
    const cmd =
      process.platform === 'win32'  ? `start "" "${URL}"` :
      process.platform === 'darwin' ? `open "${URL}"` :
                                      `xdg-open "${URL}"`;
    exec(cmd, (err) => {
      if (err) console.log(`  ➜  Open your browser at: ${URL}\n`);
      else     console.log(`  ➜  Opened ${URL} in your browser.\n`);
    });
  }
});

// Friendly error for "port already in use"
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗  Port ${PORT} is already in use.`);
    console.error(`     Stop the other process first, or run:\n`);
    console.error(`       PORT=3001 npm start\n`);
  } else {
    console.error('\n  ✗  Server error:', err.message);
  }
  process.exit(1);
});

module.exports = app; // exported for testing
