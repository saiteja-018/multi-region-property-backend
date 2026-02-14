/**
 * Integration tests for the multi-region property backend.
 *
 * These tests verify:
 *  1. Optimistic locking rejects stale-version updates (409)
 *  2. Concurrent updates from both regions are handled correctly
 *  3. Idempotency via X-Request-ID (422 on duplicate)
 *  4. Kafka cross-region replication
 *  5. Replication-lag endpoint responds
 *
 * Prerequisites:
 *   All services must be running (docker compose up -d)
 *   Wait ~15s after startup for Kafka consumers to connect.
 *
 * Run:
 *   node tests/integration.test.js
 */

const http = require("http");
const crypto = require("crypto");

const BASE = "http://localhost:8080";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testHealthEndpoints() {
  console.log("\n--- Test: Health endpoints ---");
  const usHealth = await request("GET", "/us/health");
  assert(usHealth.status === 200, "US /health returns 200");
  assert(usHealth.body.region === "us", "US health reports region=us");

  const euHealth = await request("GET", "/eu/health");
  assert(euHealth.status === 200, "EU /health returns 200");
  assert(euHealth.body.region === "eu", "EU health reports region=eu");
}

async function testOptimisticLocking() {
  console.log("\n--- Test: Optimistic locking (409 on stale version) ---");

  // Get current version of property 3
  const getProp = await request("GET", "/us/properties/3");
  assert(getProp.status === 200, "GET /us/properties/3 returns 200");
  const currentVersion = getProp.body.version;

  // First update should succeed
  const reqId1 = crypto.randomUUID();
  const update1 = await request(
    "PUT",
    "/us/properties/3",
    { price: 999999, version: currentVersion },
    { "X-Request-ID": reqId1 }
  );
  assert(update1.status === 200, `First PUT succeeds (200), new version=${update1.body.version}`);
  assert(update1.body.version === currentVersion + 1, "Version incremented by 1");

  // Second update with OLD version should be rejected (409)
  const reqId2 = crypto.randomUUID();
  const update2 = await request(
    "PUT",
    "/us/properties/3",
    { price: 888888, version: currentVersion },
    { "X-Request-ID": reqId2 }
  );
  assert(update2.status === 409, `Second PUT with stale version returns 409 (got ${update2.status})`);
}

async function testConcurrentUpdates() {
  console.log("\n--- Test: Concurrent updates from both regions ---");

  // Get current version of property 5
  const getProp = await request("GET", "/us/properties/5");
  assert(getProp.status === 200, "GET /us/properties/5 returns 200");
  const version = getProp.body.version;

  // Send concurrent updates to US and EU with same version
  const [resUS, resEU] = await Promise.all([
    request(
      "PUT",
      "/us/properties/5",
      { price: 111111, version },
      { "X-Request-ID": crypto.randomUUID() }
    ),
    request(
      "PUT",
      "/eu/properties/5",
      { price: 222222, version },
      { "X-Request-ID": crypto.randomUUID() }
    ),
  ]);

  const oneSucceeded =
    (resUS.status === 200 && resEU.status === 409) ||
    (resUS.status === 409 && resEU.status === 200) ||
    (resUS.status === 200 && resEU.status === 200); // both could succeed on separate DBs

  assert(oneSucceeded, `Concurrent updates: US=${resUS.status}, EU=${resEU.status} (at least one 200, conflict possible)`);
}

async function testIdempotency() {
  console.log("\n--- Test: Idempotency via X-Request-ID ---");

  // Get current version
  const getProp = await request("GET", "/us/properties/4");
  assert(getProp.status === 200, "GET /us/properties/4 returns 200");
  const version = getProp.body.version;

  const requestId = crypto.randomUUID();

  // First request
  const first = await request(
    "PUT",
    "/us/properties/4",
    { price: 555555, version },
    { "X-Request-ID": requestId }
  );
  assert(first.status === 200, `First idempotent PUT returns 200`);

  // Duplicate request with same X-Request-ID
  const second = await request(
    "PUT",
    "/us/properties/4",
    { price: 555555, version },
    { "X-Request-ID": requestId }
  );
  assert(second.status === 422, `Duplicate PUT returns 422 (got ${second.status})`);
}

async function testKafkaReplication() {
  console.log("\n--- Test: Kafka cross-region replication ---");

  // Get current version of property 2 from US
  const getPropUS = await request("GET", "/us/properties/2");
  assert(getPropUS.status === 200, "GET /us/properties/2 returns 200");
  const version = getPropUS.body.version;

  // Update on US side
  const update = await request(
    "PUT",
    "/us/properties/2",
    { price: 777777, version },
    { "X-Request-ID": crypto.randomUUID() }
  );
  assert(update.status === 200, "PUT /us/properties/2 returns 200");

  // Wait for Kafka replication
  console.log("    (waiting 6s for Kafka replication...)");
  await sleep(6000);

  // Check EU database
  const getPropEU = await request("GET", "/eu/properties/2");
  assert(getPropEU.status === 200, "GET /eu/properties/2 returns 200");
  assert(
    getPropEU.body.price === 777777,
    `EU property 2 price replicated: expected 777777, got ${getPropEU.body.price}`
  );
  assert(
    getPropEU.body.version === version + 1,
    `EU property 2 version replicated: expected ${version + 1}, got ${getPropEU.body.version}`
  );
}

async function testReplicationLag() {
  console.log("\n--- Test: Replication lag endpoint ---");
  const lag = await request("GET", "/eu/replication-lag");
  assert(lag.status === 200, "GET /eu/replication-lag returns 200");
  assert(typeof lag.body.lag_seconds === "number", `lag_seconds is a number (${lag.body.lag_seconds})`);
  assert(lag.body.lag_seconds >= 0, `lag_seconds >= 0`);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------
async function main() {
  console.log("==============================================");
  console.log("  Multi-Region Property Backend – Integration Tests");
  console.log("==============================================");

  await testHealthEndpoints();
  await testOptimisticLocking();
  await testConcurrentUpdates();
  await testIdempotency();
  await testKafkaReplication();
  await testReplicationLag();

  console.log("\n==============================================");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("==============================================\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
