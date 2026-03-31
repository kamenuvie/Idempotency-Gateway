const express = require('express');
const path    = require('path');
const { exec } = require('child_process');

const app = express();

function compactKey(key) {
  if (!key) return '-';
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

function formatPayload(payload) {
  if (payload === undefined) return '-';

  let pretty;
  if (typeof payload === 'string') {
    try {
      pretty = JSON.stringify(JSON.parse(payload), null, 2);
    } catch {
      pretty = payload;
    }
  } else {
    pretty = JSON.stringify(payload, null, 2);
  }

  const maxChars = 1200;
  if (pretty.length > maxChars) {
    pretty = `${pretty.slice(0, maxChars)}\n...<truncated>`;
  }

  return pretty;
}

// ── Global middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Terminal request logger (helps track API behavior without relying only on UI)
app.use((req, res, next) => {
  const startedAt = Date.now();
  const idemKey = req.headers['idempotency-key'];
  let responsePayload;

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    responsePayload = body;
    return originalJson(body);
  };

  const originalSend = res.send.bind(res);
  res.send = (body) => {
    if (responsePayload === undefined) responsePayload = body;
    return originalSend(body);
  };

  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api') && req.originalUrl !== '/health') return;
    const durationMs = Date.now() - startedAt;
    const cacheHit = res.getHeader('X-Cache-Hit') === 'true' ? ' cache-hit=true' : '';

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────');
    console.log(
      `│ [HTTP] ${req.method} ${req.originalUrl} status=${res.statusCode} duration=${durationMs}ms key=${compactKey(idemKey)}${cacheHit}`
    );
    console.log('├─────────────────────────────────────────────────────────────');
    console.log('│ [RESP]');

    const formatted = formatPayload(responsePayload)
      .split('\n')
      .map((line) => `│   ${line}`)
      .join('\n');
    console.log(formatted);
    console.log('└─────────────────────────────────────────────────────────────');
  });

  next();
});

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
