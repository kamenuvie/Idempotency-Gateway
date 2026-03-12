/**
 * In-Memory Idempotency Store
 *
 * Each entry shape:
 * {
 *   status      : 'processing' | 'complete' | 'failed',
 *   requestHash : string,   // SHA-256 of the original request body
 *   statusCode  : number,   // set when complete
 *   body        : object,   // set when complete
 *   createdAt   : number,   // epoch ms — used for TTL enforcement
 *   waiters     : Function[], // resolve callbacks for in-flight duplicate requests
 * }
 *
 * Developer's Choice Feature — TTL Expiry:
 * A key expires after IDEMPOTENCY_TTL_MS (default 24 h).
 * Expired keys are evicted lazily on read and actively by a background sweep.
 * This prevents unbounded memory growth and mirrors Stripe's 24-hour idempotency window.
 */

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const store = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function isExpired(entry) {
  return Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Retrieve an entry by key. Returns null if not found or expired.
 */
function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    // Lazy eviction: notify any stuck waiters then remove
    entry.waiters.forEach((resolve) => resolve(null));
    store.delete(key);
    return null;
  }
  return entry;
}

/**
 * Mark a key as in-flight. Called before processing begins.
 */
function setProcessing(key, requestHash) {
  store.set(key, {
    status: 'processing',
    requestHash,
    createdAt: Date.now(),
    waiters: [],
  });
}

/**
 * Mark a key as complete with the final response. Unblocks any waiters.
 */
function setComplete(key, { statusCode, body }) {
  const entry = store.get(key);
  if (!entry) return;

  entry.status = 'complete';
  entry.statusCode = statusCode;
  entry.body = body;

  // Wake up any requests that were waiting on this key
  entry.waiters.forEach((resolve) => resolve({ statusCode, body }));
  entry.waiters = [];
}

/**
 * Mark a key as failed (e.g. unhandled error during processing).
 * Removes the key so the client can retry with a fresh request,
 * and notifies any in-flight waiters to fail gracefully.
 */
function setFailed(key) {
  const entry = store.get(key);
  if (!entry) return;
  entry.waiters.forEach((resolve) => resolve(null));
  store.delete(key);
}

/**
 * Returns a Promise that resolves once the in-flight request for `key`
 * completes. Used to block duplicate concurrent requests (Bonus User Story).
 *
 * Resolves with { statusCode, body } on success, or null on failure/expiry.
 */
function waitForResult(key) {
  return new Promise((resolve) => {
    const entry = store.get(key);
    if (!entry) return resolve(null);
    if (entry.status === 'complete') {
      return resolve({ statusCode: entry.statusCode, body: entry.body });
    }
    // Still processing — queue this resolver
    entry.waiters.push(resolve);
  });
}

// ─── Background TTL Sweep ────────────────────────────────────────────────────
// Runs every hour to evict fully-expired entries and prevent memory leaks.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

const sweepTimer = setInterval(() => {
  for (const [key, entry] of store.entries()) {
    if (isExpired(entry)) {
      entry.waiters.forEach((resolve) => resolve(null));
      store.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS);

// Allow the process to exit cleanly even if the timer is active
sweepTimer.unref();

module.exports = { get, setProcessing, setComplete, setFailed, waitForResult };
