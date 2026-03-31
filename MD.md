# FinSafe Idempotency Gateway — Codebase Explained

> Focus: **logic**, **interconnections**, and **real-world meaning** of every piece.

---

## 1. The Big Picture — Why This Exists

Imagine a customer at a bank ATM pressing "Withdraw GHS 100". The machine freezes after debiting the account but before printing a receipt. The customer presses the button again. Should the bank charge them **twice**?

No — and that is exactly the problem this system solves. In payment APIs, networks can fail, clients can retry, and mobile apps can send the same request multiple times. Without protection, every retry becomes a fresh charge.

The **Idempotency Gateway** is a layer that sits in front of the payment processor and guarantees: **no matter how many times a client sends the same request, the money is only moved once.** The key mechanism is a unique string — the `Idempotency-Key` header — that acts like a receipt number. If you show the same receipt number twice, you get the same answer back without re-processing.

---

## 2. The Architecture — Five Files, One Pipeline

```
HTTP Request
     │
     ▼
┌─────────────┐    mounts routes    ┌──────────────────┐
│  server.js  │ ──────────────────► │ routes/payments  │
│  (entry pt) │                     │  .js             │
└─────────────┘                     └────────┬─────────┘
                                             │ runs middleware first
                                             ▼
                                    ┌──────────────────┐     reads/writes
                                    │ middleware/       │ ◄──────────────► ┌───────────────────┐
                                    │ idempotency.js   │                   │ store/idempotency  │
                                    │  (gatekeeper)    │ ──────────────►  │ Store.js (memory)  │
                                    └────────┬─────────┘                   └───────────────────┘
                                             │ only if first-time request
                                             ▼
                                    ┌──────────────────┐
                                    │ services/payment  │
                                    │ Service.js        │
                                    │  (bank simulator) │
                                    └──────────────────┘
```

Each file has **one job**. They talk to each other through function calls and shared data in the store.

---

## 3. File-by-File Logic

---

### `src/server.js` — The Entry Point

**Real-world role:** The front door of the building. It doesn't know anything about payments; it just opens the doors, sets up the security system, and directs visitors to the right desk.

**What it does:**
1. Creates the Express application.
2. Installs `express.json()` — this teaches Express to read the JSON body out of every incoming HTTP request and make it available as `req.body`. Without this, `req.body` would be `undefined` and the payment route would be reading nothing.
3. Mounts `express.static('public/')` — serves the browser UI (HTML/CSS/JS) directly from the `public` folder. When you open `http://localhost:3000/`, the server sends back `index.html`.
4. Mounts all payment routes under `/api` — so `POST /api/process-payment` is handled by `routes/payments.js`.
5. Adds a `/health` route — in production systems, load balancers ping this URL every few seconds to confirm the server is still alive. If it returns anything other than 200, the load balancer stops sending traffic to that instance.
6. Starts listening on port 3000 and auto-opens the browser.
7. Handles `EADDRINUSE` — if port 3000 is already occupied, instead of crashing with a cryptic error, it prints a clear human-readable message.

**The interconnection:** `server.js` is the **only** file that knows about all the others at the top level. Everything flows from here.

---

### `src/store/idempotencyStore.js` — The Memory

**Real-world role:** Think of this as a **ledger clerk** sitting at a desk with a filing cabinet. Every time a payment request comes in, this clerk writes it down. When someone asks "has this been processed before?", the clerk checks the files and answers.

**The data structure:**
Each entry in the `Map` looks like this:

```
key  →  {
  status:      'processing' | 'complete',
  requestHash: 'a3f9b...', // fingerprint of the request body
  statusCode:  201,         // the HTTP status to replay
  body:        { transactionId: '...', amount: 100 },
  createdAt:   1710000000000,
  waiters:     []           // queue of waiting duplicate requests
}
```

**Key functions and their real-world meaning:**

| Function                               | What it does                                             | Real-world analogy                                                    |
| -------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- |
| `get(key)`                             | Looks up a key, returns `null` if missing or expired     | Clerk searches the filing cabinet                                     |
| `setProcessing(key, hash)`             | Creates an entry marked "in progress"                    | Clerk stamps the receipt "PENDING" and files it                       |
| `setComplete(key, {statusCode, body})` | Updates entry to "done" and wakes up any waiters         | Clerk writes the final result and calls out to anyone waiting in line |
| `setFailed(key)`                       | Deletes the entry so the client can retry fresh          | Clerk shreds a failed receipt so the customer can start again         |
| `waitForResult(key)`                   | Returns a Promise that resolves when processing finishes | "Please take a seat — we'll call you when it's ready"                 |

**The TTL (Time-To-Live) logic:**
Every entry has a `createdAt` timestamp. After 24 hours, entries are considered expired. Stripe (the real payments company) uses the same 24-hour window. Why?
- A retry 30 seconds later? Definitely the same request — replay it.
- A retry 2 days later? Probably a genuine new payment — process it fresh.

Expiry happens in two ways:
- **Lazily on read** — when `get(key)` is called and the entry is expired, it is deleted right then.
- **Actively by a background sweep** — every hour, a `setInterval` loop walks the entire `Map` and deletes anything expired. This prevents the Map from growing forever with stale data. `.unref()` is called on the timer so it doesn't keep the Node.js process alive artificially during tests or shutdown.

**The `waiters` queue — solving the race condition:**
This is the most subtle piece. Imagine two mobile devices sending the exact same payment at the same millisecond. Device A arrives first, the store entry is created as `'processing'`, and the bank is being called. Device B arrives 50ms later — the key exists but status is still `'processing'`.

Instead of either rejecting Device B or starting a duplicate bank call, `waitForResult` adds Device B's response resolver to the `waiters` array. When Device A's bank call finishes and `setComplete` is called, it loops through `waiters` and resolves all of them with the same result. Device B gets the answer without any duplicate charge.

---

### `src/middleware/idempotency.js` — The Gatekeeper

**Real-world role:** The security guard at the vault door. Every request must pass through here before touching the payment processor. The guard has four possible decisions to make.

**The `hashBody` function:**
Before making any decision, the middleware takes the request body (`{ amount: 100, currency: "GHS" }`) and computes a SHA-256 fingerprint of it.

```
{ "amount": 100, "currency": "GHS" }  →  "a3f9b72c..."
{ "amount": 999, "currency": "GHS" }  →  "7d2e1f88..."  (completely different)
```

Keys are sorted first (`Object.keys(body).sort()`), so `{ currency: "GHS", amount: 100 }` and `{ amount: 100, currency: "GHS" }` produce the **same hash**. This is important because different HTTP clients might serialize JSON fields in different orders.

**The four decision branches:**

**Decision 1 — No key provided (→ 400 Bad Request)**
```
if (!key) return res.status(400).json({ error: 'Missing required header...' })
```
Real-world: A client that forgot to include the `Idempotency-Key` header is rejected immediately. This is mandatory — without a key there is no way to track or deduplicate the request.

**Decision 2 — Key is new (→ let it through)**
```
if (!existing) {
  idempotencyStore.setProcessing(key, requestHash);
  return next();
}
```
Real-world: First time seeing this receipt number. File it as "pending" and send the customer to the payment desk (`next()` hands control to the route handler).

**Decision 3 — Key exists, different body (→ 422 Conflict)**
```
if (existing.requestHash !== requestHash) {
  return res.status(422).json({ error: 'Key already used for a different body' })
}
```
Real-world: Someone shows a receipt number that was already used, but the amounts don't match. This is suspicious — likely a bug or an attempted fraud. Reject it.

**Decision 4 — Key exists, same body, already complete (→ replay cache)**
```
return res.status(existing.statusCode).set('X-Cache-Hit', 'true').json(existing.body);
```
Real-world: The customer shows the same receipt number and the transaction was already completed. Hand them a copy of the original receipt. The `X-Cache-Hit: true` header signals to the client (and to our UI) that this was a replay, not a new charge.

**The two helpers attached to `req` and `res`:**
```js
req.idempotencyKey       // the route uses this to call setFailed() on errors
res.setIdempotencyResult // the route calls this to save the result before sending
```
These bridges mean the route doesn't need to import the store directly for the happy path — it just calls `res.setIdempotencyResult(...)` and the middleware's closure takes care of the store update.

---

### `src/services/paymentService.js` — The Bank Simulator

**Real-world role:** In a real system, this file would contain the code that calls Visa, Mastercard, Paystack, or Flutterwave's API to authorize and move money. Here it simulates that with a 2-second delay and returns a realistic payment record.

```js
await new Promise((resolve) => setTimeout(resolve, 2000));
```

This simulated delay is intentional and important for demonstrating the race condition scenario. In 2 seconds, a second duplicate request can arrive and be queued in the `waiters` array, proving that the system handles concurrency correctly.

The function returns:
```json
{
  "status":        "success",
  "message":       "Charged 100 GHS",
  "transactionId": "550e8400-e29b-41d4-a716-446655440000",
  "amount":        100,
  "currency":      "GHS",
  "processedAt":   "2026-03-12T10:00:00.000Z"
}
```

The `transactionId` is a UUID v4 (randomly generated). Notice that on a cache replay, the **same** `transactionId` is returned — proof that no new bank transaction was created.

---

### `src/routes/payments.js` — The Cashier

**Real-world role:** The cashier at the payment desk. By the time a request reaches here, the middleware has already verified the idempotency key. The cashier's job is to validate the money amount, call the bank, save the result, and hand back the receipt.

**The order of operations is critical:**

```
1. Validate inputs (amount > 0, currency present)
       │
       ▼ (if invalid)
   setFailed(key)  ← IMPORTANT: releases the 'processing' lock
   return 400
       │
       ▼ (if valid)
2. Call processPayment({ amount, currency })  ← 2-second bank call
       │
       ▼
3. res.setIdempotencyResult({ statusCode: 201, body: result })
   ← SAVES to store BEFORE sending the response
       │
       ▼
4. res.status(201).json(result)  ← sends response to client
```

**Why step 3 must come before step 4:**
If the response was sent first and then the store was updated, any duplicate request that arrived during the 2-second bank call would still be in the `waiters` queue. That queue gets flushed by `setComplete` (which is called inside `setIdempotencyResult`). If `setComplete` ran after `res.json()`, the waiters would have already timed out or the Node.js event loop might have moved on. Saving first guarantees atomic consistency.

**Why validation failures call `setFailed`:**
When the middleware runs, it writes `{ status: 'processing' }` to the store for new keys. If the route then rejects the request due to bad inputs, that `'processing'` entry would be stuck forever — no new request with the same key could ever get through. `setFailed` deletes the entry, freeing the key for a corrected retry.

---

## 4. The Four Real-World Scenarios — End to End

### Scenario A — Normal First Payment

**User story:** Amara opens the FinSafe app and sends GHS 100 to her landlord.

```
Amara's App ──[POST /api/process-payment]──►
  Headers: { Idempotency-Key: "pay-uuid-001" }
  Body:    { amount: 100, currency: "GHS" }

  middleware.js:
    → key "pay-uuid-001" not in store → setProcessing("pay-uuid-001", hash)
    → next()

  payments.js:
    → amount=100 ✓, currency="GHS" ✓
    → processPayment({ amount:100, currency:"GHS" })  [2 second wait]
    → setIdempotencyResult({ statusCode:201, body:{transactionId:"550e...", ...} })
    → res.status(201).json(...)

◄── { status:"success", transactionId:"550e...", amount:100 }  HTTP 201
```

Landlord receives the GHS 100. Store now holds the completed entry.

---

### Scenario B — Network Retry (Safe Duplicate)

**User story:** Amara's app received a connection timeout — it never saw the 201. The app retries with the **same key**.

```
Amara's App ──[POST /api/process-payment]──► (retry, same key, same body)
  Headers: { Idempotency-Key: "pay-uuid-001" }

  middleware.js:
    → key "pay-uuid-001" IS in store, status = 'complete'
    → requestHash matches ✓
    → return res.status(201).set('X-Cache-Hit','true').json(existing.body)

◄── { status:"success", transactionId:"550e..." }  HTTP 201  X-Cache-Hit: true
```

Amara's app sees status 201 with the **same transactionId** from the first request. The landlord is not charged again. The wallet balance in the UI does not change.

---

### Scenario C — Tampered Request (Conflict)

**User story:** A buggy client sends the same `Idempotency-Key` but accidentally changes the amount from 100 to 9999.

```
Client ──[POST /api/process-payment]──►
  Headers: { Idempotency-Key: "pay-uuid-001" }
  Body:    { amount: 9999, currency: "GHS" }   ← DIFFERENT BODY

  middleware.js:
    → key "pay-uuid-001" IS in store
    → requestHash("9999 GHS") ≠ requestHash("100 GHS") stored
    → return res.status(422).json({ error: "Key already used for a different body" })

◄── HTTP 422  { error: "Idempotency key already used for a different request body." }
```

The API refuses to process GHS 9999. The original GHS 100 transaction is protected. This guards against bugs and accidental double-charges with different amounts.

---

### Scenario D — Missing Key

**User story:** A badly written integration forgets to include the `Idempotency-Key` header entirely.

```
Client ──[POST /api/process-payment]──►
  Headers: { Content-Type: "application/json" }
  Body:    { amount: 100, currency: "GHS" }   (no Idempotency-Key)

  middleware.js:
    → key is undefined → reject immediately
    → return res.status(400).json({ error: "Missing required header: Idempotency-Key" })

◄── HTTP 400  { error: "Missing required header: Idempotency-Key" }
```

No store entry is created. No bank call is made. The client is told exactly what is wrong.

---

### Scenario E — Race Condition (Concurrent Duplicate)

**User story:** Amara's app has a bug — it fires two identical requests simultaneously before the first one returns. This is the hardest scenario.

```
t=0ms   Request A ──► middleware: new key → setProcessing → processPayment starts
t=10ms  Request B ──► middleware: key exists, status='processing'
                       → waitForResult(key)  → pushes resolve into entry.waiters
                       → suspends here, waiting...

t=2000ms  processPayment resolves
          route calls setIdempotencyResult → setComplete
          setComplete loops entry.waiters → calls resolve({ statusCode:201, body })

         Request B's Promise resolves:
           → res.status(201).set('X-Cache-Hit','true').json(body)

◄── Request A: HTTP 201  { transactionId: "550e...", amount: 100 }
◄── Request B: HTTP 201  X-Cache-Hit: true  { transactionId: "550e...", amount: 100 }
```

Both requests return the **same transactionId**. The bank was only called **once**. With the `waiters` queue, no polling, no busy-waiting, and no wasted threads — just a Promise that resolves when the data is ready.

---

## 5. The Data Flow Summary

```
                         ┌─────────────────────────────────────────────────┐
                         │              idempotencyStore (Map)             │
                         │                                                 │
                         │  "pay-uuid-001" → {                             │
                         │    status: 'complete',                          │
                         │    requestHash: 'a3f9b...',                     │
                         │    statusCode: 201,                             │
                         │    body: { transactionId: '550e...' },          │
                         │    createdAt: 1710000000000,                    │
                         │    waiters: []                                  │
                         │  }                                              │
                         └────────────────┬────────────────────────────────┘
                                          │
                    ┌─────────────────────┼──────────────────────┐
                    │ reads               │ writes               │ wakes waiters
                    ▼                     ▼                       ▼
          idempotency.js         idempotency.js           idempotency.js
          (get, waitForResult)   (setProcessing)          (setComplete via
                                                           res.setIdempotencyResult
                                                           called from route)

                                 payments.js
                                 (setFailed on error)
```

---

## 6. Security Observations Built Into the Design

| Risk                                      | How the code addresses it                                    |
| ----------------------------------------- | ------------------------------------------------------------ |
| Double charge on network retry            | Cached response replayed from store                          |
| Malicious key reuse with different amount | SHA-256 hash mismatch → 422                                  |
| No key at all                             | 400 immediately, no processing begins                        |
| Memory growing forever                    | TTL expiry + hourly sweep                                    |
| Concurrent duplicate charging             | `waiters` queue — only one bank call ever made               |
| Failed payment locking the key forever    | `setFailed` deletes the entry on any error                   |
| XSS in API responses                      | All outputs are JSON — no HTML is ever returned from the API |
| Port conflict crash                       | Friendly `EADDRINUSE` message with resolution steps          |

---

## 7. How to Read the Code in Sequence

If you want to trace a single payment from start to finish in the source code, follow this path:

1. **`server.js` line 12** — `app.use('/api', paymentRoutes)` → mounts the router
2. **`routes/payments.js` line 22** — `router.post('/process-payment', idempotencyMiddleware, ...)` → middleware runs first
3. **`middleware/idempotency.js` line 28** — `hashBody(req.body)` → fingerprint computed
4. **`middleware/idempotency.js` line 47** — `idempotencyStore.get(key)` → check for existing entry
5. **`store/idempotencyStore.js` line 35** — `get(key)` → map lookup with TTL check
6. **`middleware/idempotency.js` line 52** — `setProcessing(key, hash)` then `next()` → new request proceeds
7. **`routes/payments.js` line 38–48** — input validation
8. **`routes/payments.js` line 52** — `processPayment(...)` → 2-second bank call
9. **`services/paymentService.js` line 15** — `setTimeout(resolve, 2000)` + UUID generation
10. **`routes/payments.js` line 56** — `res.setIdempotencyResult(...)` → store updated via the closure from step 3
11. **`store/idempotencyStore.js` line 59** — `setComplete` flushes `waiters`
12. **`routes/payments.js` line 58** — `res.status(201).json(result)` → response sent

---

## 8. Data Structures & Design Patterns

This section covers **every data structure used**, why it was chosen, and answers common interview questions.

---

### 8.1 Map — The Core Store

**Where it's used:** `store/idempotencyStore.js` — the central in-memory key-value store.

```javascript
const store = new Map();  // line 15

store.set(key, {
  status: 'processing' | 'complete',
  requestHash: 'a3f9b...',
  statusCode: 201,
  body: { transactionId, amount, currency },
  createdAt: 1710000000000,
  waiters: []
});

const entry = store.get(key);
```

**Why Map, not plain Object?**

| Question                      | Answer                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why not `{}` (plain object)?  | `{}` enumerates all keys in `for...in` loops. Map is designed specifically for this use case: arbitrary string keys with type safety.                    |
| What is O(1) lookup?          | Map's `.get()` and `.set()` are hash table operations — constant time regardless of how many entries exist. Even with 1 million keys, lookup is instant. |
| Could you use `new Object()`? | Technically yes, but you'd lose prototype chain control. Map is safer and cleaner semantically.                                                          |
| How many entries can it hold? | Limited by available memory (RAM). A typical laptop can store tens of millions of entries. With TTL expiry every hour, memory never grows unbounded.     |

**Entry value structure — an Object:**

Each Map value is a plain JavaScript object:

```javascript
{
  status: 'processing' | 'complete',  // enum-like string
  requestHash: 'sha256hash...',        // 64-char hex string
  statusCode: 201,                     // HTTP status code (number)
  body: { ... },                       // response payload (object)
  createdAt: 1710000000000,            // epoch millisecond (number)
  waiters: [resolve1, resolve2, ...]   // array of Promise resolvers (functions)
}
```

**Interview questions likely to follow:**

**Q1: "Why store the `requestHash` inside the entry instead of using it as the Map key?"**

A: Two keys could have the same hash (hash collision, though rare with SHA-256). More importantly, we need to store the original key-to-hash mapping so we can detect when the **same key is used with a different request body**. If we keyed by hash, a legitimate retry with amount 100 GHS and a fraudulent attempt with amount 500 GHS would both collide on the key name — we'd lose the ability to distingush them.

**Q2: "What happens if two requests have the exact same `requestHash` but different `Idempotency-Key` values?"**

A: They are treated as completely separate requests. The system keys off the `Idempotency-Key` header, not the request body. Two customers independently sending "charge 100 GHS" would both get unique transactions (if their keys differ). This is correct — idempotency is per-client per-request, not per-amount-globally.

**Q3: "Couldn't you use a database instead of Map?"**

A: Absolutely. A Map is appropriate for a single-node, in-memory system (like this assessment). In production:
- Replace `store/` with Redis or PostgreSQL calls.
- All other code remains unchanged.
- The interface (`get`, `setProcessing`, `setComplete`, `waitForResult`) stays the same.

---

### 8.2 Array — The Waiters Queue

**Where it's used:** `store/idempotencyStore.js`, line 7 and 55–60.

```javascript
waiters: []  // initialized as empty array on line 58

// Adding to array (line 85)
entry.waiters.push(resolve);

// Flushing array (line 62)
entry.waiters.forEach((resolve) => resolve({ statusCode, body }));
entry.waiters = [];
```

**Why Array?**

A simple FIFO (First In First Out) queue structure. We need:
- An ordered list (happens naturally with array indices).
- To append to the end (`push`).
- To iterate over all items and call them (`forEach`).
- No random access removal — every item gets resolved.

**Alternative structures considered:**

| Structure              | Why not used                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `Queue` (custom class) | Overkill. For ≤ 10 concurrent duplicates per key, Array is fine.                  |
| `Set`                  | Sets don't guarantee order. A queue should be FIFO.                               |
| Single Promise         | Only one waiter per key? No — what if 5 retries arrive during the 2-second delay? |

**Interview questions:**

**Q4: "What's the maximum size of the `waiters` array?"**

A: No hard limit, but practically bounded. Since payment requests take ~2 seconds, at most a few dozen retries can queue up during processing (even under load, the server can only handle so many concurrent requests). On a single thread, if 1,000 requests arrive in 1ms, they queue; at 2s per processed request, the waiters array would have ~2,000 entries. Node.js's event loop handles this gracefully — arrays can hold millions of items without performance degradation for iteration.

**Q5: "Why call `.forEach()` instead of `for (const r of entry.waiters)`?"**

A: Both are equivalent in performance. `.forEach` is more idiomatic for "run a function on every element." Either style works; `.forEach` is slightly more functional.

**Q6: "What if a waiter Promise throws an error?"**

A: The `.forEach` loop doesn't have error handling, so the error would propagate and crash the iterator. In production, you'd wrap the iterator with `try...catch` or use `.forEach((resolve) => { try { resolve(...) } catch(e) { logger.error(e) } })`.

---

### 8.3 Promise — Asynchronous Wait Mechanism

**Where it's used:** `store/idempotencyStore.js`, line 75–90 — the `waitForResult` function.

```javascript
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
```

**How it works:**

1. Create a new Promise that never rejects (only resolves).
2. If the entry is missing, resolve immediately with `null`.
3. If the entry is complete, resolve immediately with the result.
4. If the entry is still processing, push the `resolve` callback onto the `waiters` array.
5. Later, when `setComplete` is called, it iterates the `waiters` array and calls every `resolve`.

**Why Promise instead of callbacks directly?**

Promises give you:
- A **standard pattern** that JavaScript developers recognize.
- **.then() chaining** — if the middleware wanted to log or transform the result, it could.
- **Error handling via .catch()** — though this system doesn't throw, it could.
- **Non-blocking I/O** — the request doesn't halt execution; the event loop is free to serve other requests while waiting.

**Interview questions:**

**Q7: "Could you use callbacks instead of Promises?"**

A: Yes. Instead of `return new Promise((resolve) => { ... })`, you could define `function waitForResult(key, callback)` and call `callback(result)` later. The promise-based approach is just cleaner and more modern. Callbacks lead to "callback hell" in complex systems.

**Q8: "What if the Promise never resolves?"**

A: The request would hang forever. In this system, that shouldn't happen because `waitForResult` is only called after confirming an entry exists. But in production, you'd add a **timeout**:

```javascript
function waitForResultWithTimeout(key, timeoutMs = 5000) {
  return Promise.race([
    waitForResult(key),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Wait timeout')), timeoutMs)
    )
  ]);
}
```

**Q9: "Is there a race condition where a request checks `entry.status === 'complete'` and then `setComplete` runs simultaneously?"**

A: No, because JavaScript is **single-threaded**. The check and the `waiters.push()` happen atomically before any other code can run. When `setComplete` is called (from a different request's route handler), it gets its own turn on the event loop.

---

### 8.4 String — Keys, Hashes, and Identifiers

**Where it's used:**
- `Idempotency-Key` header (user-supplied, any string)
- `requestHash` (SHA-256 output, 64-char hex)
- `currency` (ISO 4217 code, e.g., "GHS", "USD")
- `status` (enum-like: "processing" or "complete")
- `messageTransactionId` (UUID v4, 36 chars)

```javascript
// User-provided
const key = req.headers['idempotency-key'];  // "pay-uuid-001"

// System-generated
const requestHash = crypto.createHash('sha256')
  .update(JSON.stringify(body, Object.keys(body).sort()))
  .digest('hex');  // "a3f9b72c..."

const transactionId = uuidv4();  // "550e8400-e29b-41d4-a716-446655440000"
```

**Why SHA-256 for the hash?**

| Requirement     | Why SHA-256                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------- |
| Collisions rare | 256-bit output means 2^256 possible values. Probability of collision is negligibly small.     |
| Deterministic   | Same input always → same hash. `{a:1,b:2}` sorted and hashed = `{b:2,a:1}` sorted and hashed. |
| Fast            | SHA-256 is O(n) where n is body size. For JSON payloads < 1MB (normal), instant.              |
| Non-reversible  | Can't recover the original request body from the hash (security).                             |

**Why UUID v4 (not sequential IDs)?**

| Property               | Sequential ID                    | UUID v4                                 |
| ---------------------- | -------------------------------- | --------------------------------------- |
| Predictability         | Attackers can guess next ID      | Astronomically unlikely to collide      |
| Distribution           | Skewed to high numbers           | Uniformly random                        |
| Distributed generation | Requires coordination (database) | Any client/server can generate safely   |
| Database index         | Efficient clustering             | Not clustered, but acceptable trade-off |

For this payment system, unpredictability is more important than index performance.

**Interview questions:**

**Q10: "What if the client sends an extremely long Idempotency-Key (1MB)?**

A: The key is stored in memory. In production, you'd validate: `if (key.length > 256) return 400`. This prevents memory attacks.

**Q11: "Why sort the keys before hashing?"**

A: Because different JSON serializers output fields in different orders:
- Go: `{"amount":100,"currency":"GHS"}`
- Python: `{"currency":"GHS","amount":100}`

Both represent the same request, but the JSON strings differ. Sorting before stringifying ensures **same canonical form → same hash**, even if the client library reorders fields.

---

### 8.5 Number — Timestamps and HTTP Status

**Where it's used:**

```javascript
createdAt: Date.now(),         // epoch milliseconds (13-digit number)
statusCode: 201,               // HTTP status (3-digit number)
amount: 100.50,                // payment amount (floating point)
```

**Epoch milliseconds vs. seconds:**

```javascript
Date.now()        // 1710000000000  (milliseconds, 13 digits)
Math.floor(Date.now() / 1000)  // 1710000000  (seconds, 10 digits)
```

This system uses **milliseconds** because:
- TTL comparison is `Date.now() - createdAt > 24 * 60 * 60 * 1000`; using ms avoids floating-point division.
- More precision (useful for benchmarking, debugging).

**Interview questions:**

**Q12: "Why not use `new Date()` instead of `Date.now()`?"**

A: `new Date()` creates a Date object; `Date.now()` returns a raw number. For timestamps, a number is simpler and faster. Date objects are useful when you need formatting (like `.toISOString()`), but here we just need the raw value.

**Q13: "What happens after Year 2286 when milliseconds overflow a 32-bit integer?"**

A: JavaScript uses 64-bit IEEE 754 floats for all numbers, so overflow won't happen for hundreds of years. The practical limit is much later.

---

### 8.6 Function (References) — Callback Resolver Functions

**Where it's used:** `waiters` array stores function references.

```javascript
// Creating a Promise creates a resolver function internally
new Promise((resolve) => {
  // 'resolve' is a function reference
  entry.waiters.push(resolve);
});

// Later, calling it
entry.waiters.forEach((resolve) => resolve({ statusCode, body }));
```

**Why store functions in an array?**

Because each Promise has its own unique `resolve` function. When Request B is waiting, only B's `resolve` should be called. This is the **observer pattern** — each waiter is an observer listening for the "complete" event.

**Interview questions:**

**Q14: "Could you use an EventEmitter instead?"**

A: Yes! Node.js's `EventEmitter` is designed for this:

```javascript
const { EventEmitter } = require('events');
const events = new EventEmitter();

// Waiter subscribes
events.once('complete:key-abc', (result) => { ... });

// Completer emits
events.emit('complete:key-abc', result);
```

But for this simple system, a Promise-based queue is lighter and more direct.

---

## 9. Common Interview Questions — Comprehensive Q&A

This section covers questions you're likely to encounter in a technical interview about this codebase.

---

### Memory & Performance

**Q: "Will the Map grow forever and crash the server?"**

A: No. The system has TTL (Time-To-Live) expiry:
- Every 24 hours, entries are automatically deleted.
- A background sweep every hour evicts expired entries proactively.
- Lazy eviction on every `get()` catches any stragglers.

Even with 1,000 requests/second (100M requests/day), the Map holds at most 86.4M entries * entry size (~500 bytes) = ~43 GB. Most real production systems process far fewer requests, so the Map stays under 100MB.

---

**Q: "Is the background sweep thread-safe?"**

A: Node.js is **single-threaded**, so there are no thread-safety issues. Only one piece of code runs at a time. The sweep and request handling take turns via the event loop. No locks or atomic operations needed.

---

**Q: "What's the time complexity of the sweep?"**

A: O(n) where n = number of entries in the Map. If there are 1M entries, it takes 1M checks. Running every hour is fine — the operation completes in milliseconds on modern hardware.

---

### Correctness & Edge Cases

**Q: "What if a request is processing and the server crashes before `setComplete` is called?"**

A: A waiter Promise would never resolve, and the client would time out. In production, you'd:
1. Use a persistent database instead of in-memory Map.
2. Add client-side timeout logic (e.g., retry after 30 seconds with a new key).
3. Implement health checks and automatic restart on crash.

---

**Q: "What if the same Request Body is sent with two different keys?"**

A: Both requests are processed independently. Idempotency keys are unique per **key**, not per **payload**. If Customer A and Customer B both send identical payment details but with different keys, both are charged. This is correct — idempotency protects against the same *client* retrying, not against different clients paying the same amount.

---

**Q: "Why not use an expiry timestamp like Redis EXPIRE?"**

A: The system **does** track creation time (`createdAt`). Redis's `EXPIRE` command is more efficient than our manual sweep, but for a 24-hour window on an in-memory system, the manual sweep is acceptable. If scaling to millions of keys, Redis would be necessary.

---

### Design Trade-Offs

**Q: "Why in-memory store instead of database?"**

A: Trade-offs:

| Aspect                 | In-Memory                | Database               |
| ---------------------- | ------------------------ | ---------------------- |
| Speed                  | Ultra-fast (nanoseconds) | Slower (milliseconds)  |
| Durability             | Lost on crash            | Survives crash         |
| Scalability            | Single-node only         | Distributed            |
| Cost                   | Free (built-in)          | License/infrastructure |
| Assessment suitability | Perfect                  | Overkill               |

For a coding assessment, the in-memory Map is appropriate. In production, a database (PostgreSQL, DynamoDB) is necessary.

---

**Q: "Why not cache the response at the HTTP layer (e.g., use ETags)?"**

A: ETags are for **idempotency of reads**. This system handles **idempotency of writes** (POST requests that modify state). ETags would cache based on URL + body hash, but we need to cache based on the `Idempotency-Key` header specifically. The middleware approach is more flexible and explicit.

---

### Scalability & Production Readiness

**Q: "How do you scale this to 100,000 requests per second?"**

A: Multi-layered approach:
1. **Horizontal scaling** — Run multiple Node.js processes (load-balanced).
2. **Shared store** — Replace in-memory Map with Redis (all processes see the same idempotency keys).
3. **Database** — Use PostgreSQL for payment history and audit logs.
4. **Caching** — Add Redis for session/user context.
5. **Rate limiting** — Prevent burst attacks.
6. **Monitoring** — Track latency, error rates, store growth.

The code is already structured for this — only `src/store/` would change; the middleware and routes stay the same.

---

**Q: "What about distributed transactions?"**

A: This system handles local idempotency (within one server). For truly distributed payments (across multiple banks), you'd use:
- **Two-Phase Commit** (2PC) — lock and reserve funds, then commit.
- **Saga Pattern** — series of local transactions with rollback logic.
- **Event Sourcing** — log every state change for auditability.

None of these change the idempotency layer; they sit above or below it.

---

### Real-World Scenarios

**Q: "A VIP customer sends 1,000 identical payment requests in 1 second. What happens?"**

A:
1. Request 1: new key → `setProcessing` → bank call begins → takes 2 seconds.
2. Requests 2–1,000: arrive during those 2 seconds, same key → queued in `waiters`.
3. Request 1 completes → `setComplete` is called → resolves all 999 waiters with the same result.
4. Server returns 1,000 × 201 responses, but only 1 bank charge. Correct! ✓

---

**Q: "The customer's payment fails (bank timeout). What happens?"**

A:
1. `processPayment` throws an error.
2. The route catches it in the `catch` block (line 60 in `payments.js`).
3. `setFailed(key)` is called → entry is deleted from the Map.
4. Any waiters are notified with `null`, then the promise stream returns a 500 error.
5. The client retries with the **same key**.
6. The key is no longer in the store → treated as a new request → another bank call.
7. If it succeeds this time, cached. Correct! ✓

---

## 10. Conclusion

This codebase uses a **minimal, well-scoped set of data structures**:
- **Map** for the store (O(1) lookup, O(n) space).
- **Array** for the waiters queue (O(1) push, O(n) iteration on completion).
- **Promise** for async coordination (non-blocking, standard pattern).
- **Plain objects** for structured data (clear schema, JSON-serializable).
- **Strings and numbers** for identifiers (keys, hashes, timestamps).

Every choice has a **rationale**, **trade-off**, and **production path**. Understanding *why* each structure was picked is more important than memorizing the structures themselves.
