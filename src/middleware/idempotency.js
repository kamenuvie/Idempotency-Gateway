/**
 * Idempotency Middleware
 *
 * Covers all three user stories and the bonus race-condition story:
 *
 *  US1 – First request: key unseen → mark processing, hand off to route.
 *  US2 – Duplicate (same key + same body): return cached response + X-Cache-Hit: true.
 *  US3 – Conflict (same key + different body): return 422 Unprocessable Entity.
 *  Bonus – Concurrent duplicate: wait (non-blocking poll) until first request
 *           finishes, then return its result.
 *
 * The middleware also attaches two helpers to the request object:
 *   req.idempotencyKey       – the raw header value (used by the route for error cleanup)
 *   res.setIdempotencyResult – called by the route to persist the final response
 */

const crypto = require('crypto');
const idempotencyStore = require('../store/idempotencyStore');

function compactKey(key) {
  if (!key) return '-';
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}

/**
 * Produces a stable, order-independent hash of the request body.
 * Sorting keys means { a:1, b:2 } and { b:2, a:1 } hash identically.
 */
function hashBody(body) {
  const stable = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(stable).digest('hex');
}

async function idempotencyMiddleware(req, res, next) {
  const key = req.headers['idempotency-key'];

  // ── Guard: header is mandatory ───────────────────────────────────────────
  if (!key || key.trim() === '') {
    console.warn(`[IDEMPOTENCY] missing key method=${req.method} path=${req.originalUrl}`);
    return res.status(400).json({
      error: 'Missing required header: Idempotency-Key',
    });
  }

  const requestHash = hashBody(req.body);

  // Attach key to request so the route can call setFailed on errors
  req.idempotencyKey = key;

  // Attach result-setter so the route persists its response before sending
  res.setIdempotencyResult = ({ statusCode, body }) => {
    idempotencyStore.setComplete(key, { statusCode, body });
  };

  const existing = idempotencyStore.get(key);

  // ── No entry → first time seeing this key ────────────────────────────────
  if (!existing) {
    console.log(`[IDEMPOTENCY] first request key=${compactKey(key)} -> set processing`);
    idempotencyStore.setProcessing(key, requestHash);
    return next();
  }

  // ── Key exists with a DIFFERENT body → reject (US3) ──────────────────────
  if (existing.requestHash !== requestHash) {
    console.warn(`[IDEMPOTENCY] conflict key=${compactKey(key)} -> same key, different body`);
    return res.status(422).json({
      error: 'Idempotency key already used for a different request body.',
    });
  }

  // ── Same key, same body, still processing → wait for result (Bonus) ──────
  if (existing.status === 'processing') {
    console.log(`[IDEMPOTENCY] in-flight duplicate key=${compactKey(key)} -> waiting for result`);
    const result = await idempotencyStore.waitForResult(key);

    if (!result) {
      console.error(`[IDEMPOTENCY] in-flight original failed key=${compactKey(key)}`);
      // The original request failed; allow client to retry with a new key
      return res.status(500).json({
        error: 'The original request failed during processing. Please retry with a new Idempotency-Key.',
      });
    }

    console.log(`[IDEMPOTENCY] in-flight duplicate replay key=${compactKey(key)}`);

    return res
      .status(result.statusCode)
      .set('X-Cache-Hit', 'true')
      .json(result.body);
  }

  // ── Same key, same body, already complete → replay cached response (US2) ──
  console.log(`[IDEMPOTENCY] cache replay key=${compactKey(key)}`);
  return res
    .status(existing.statusCode)
    .set('X-Cache-Hit', 'true')
    .json(existing.body);
}

module.exports = idempotencyMiddleware;
