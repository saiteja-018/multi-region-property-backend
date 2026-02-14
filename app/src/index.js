/**
 * Multi-Region Property Backend – Main Entry Point
 *
 * Starts the Express server, connects to PostgreSQL, initialises
 * the Kafka producer and consumer, and registers all routes.
 */

const express = require("express");
const { Pool } = require("pg");
const { Kafka, logLevel } = require("kafkajs");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REGION = process.env.REGION || "us";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://propuser:proppass_us@db-us:5432/properties_us";
const KAFKA_BROKER = process.env.KAFKA_BROKER || "kafka:29092";
const KAFKA_TOPIC = process.env.KAFKA_TOPIC || "property-updates";
const PORT = parseInt(process.env.PORT, 10) || 8000;

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Kafka
// ---------------------------------------------------------------------------
const kafka = new Kafka({
  clientId: `backend-${REGION}`,
  brokers: [KAFKA_BROKER],
  retry: { initialRetryTime: 3000, retries: 30 },
  logLevel: logLevel.WARN,
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `backend-${REGION}-group` });

// ---------------------------------------------------------------------------
// Kafka consumer – replicate events from the OTHER region
// ---------------------------------------------------------------------------
async function startConsumer() {
  let ready = false;
  while (!ready) {
    try {
      await consumer.connect();
      await consumer.subscribe({ topic: KAFKA_TOPIC, fromBeginning: true });
      ready = true;
    } catch (err) {
      console.log(
        `[${REGION}] Kafka consumer not ready, retrying in 5s...`,
        err.message
      );
      try { await consumer.disconnect(); } catch (_) {}
      await sleep(5000);
    }
  }

  console.log(`[${REGION}] Kafka consumer started.`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const data = JSON.parse(message.value.toString());
        const origin = data.region_origin;

        // Skip events that originated from this region
        if (origin === REGION) return;

        console.log(
          `[${REGION}] Replicating property ${data.id} from region=${origin} (v${data.version})`
        );

        await pool.query(
          `INSERT INTO properties (id, price, bedrooms, bathrooms, region_origin, version, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp)
           ON CONFLICT (id) DO UPDATE
             SET price          = EXCLUDED.price,
                 bedrooms       = EXCLUDED.bedrooms,
                 bathrooms      = EXCLUDED.bathrooms,
                 version        = EXCLUDED.version,
                 updated_at     = EXCLUDED.updated_at
             WHERE properties.version < EXCLUDED.version`,
          [
            data.id,
            data.price,
            data.bedrooms,
            data.bathrooms,
            data.region_origin,
            data.version,
            data.updated_at,
          ]
        );

        // Update replication meta timestamp
        await pool.query(
          `UPDATE replication_meta SET last_updated_at = $1::timestamp WHERE id = 1`,
          [data.updated_at]
        );
      } catch (err) {
        console.error(`[${REGION}] Consumer error:`, err.message);
      }
    },
  });

  console.log(`[${REGION}] Kafka consumer started.`);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// --- Health check ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", region: REGION });
});

// --- Replication lag ---
app.get("/replication-lag", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT last_updated_at FROM replication_meta WHERE id = 1"
    );
    if (rows.length === 0) {
      return res.json({ lag_seconds: 0 });
    }
    const lastTs = new Date(rows[0].last_updated_at);
    const now = new Date();
    const lagSeconds = (now - lastTs) / 1000;
    res.json({ lag_seconds: parseFloat(lagSeconds.toFixed(3)) });
  } catch (err) {
    console.error(`[${REGION}] replication-lag error:`, err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- GET property ---
app.get("/properties/:id", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  try {
    const { rows } = await pool.query(
      "SELECT * FROM properties WHERE id = $1",
      [propertyId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ detail: "Property not found" });
    }
    const p = rows[0];
    res.json({
      id: p.id,
      price: parseFloat(p.price),
      bedrooms: p.bedrooms,
      bathrooms: p.bathrooms,
      region_origin: p.region_origin,
      version: p.version,
      updated_at: new Date(p.updated_at).toISOString(),
    });
  } catch (err) {
    console.error(`[${REGION}] GET property error:`, err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- PUT property (update with optimistic locking + idempotency) ---
app.put("/properties/:id", async (req, res) => {
  const propertyId = parseInt(req.params.id, 10);
  const { price, version } = req.body;

  if (price == null || version == null) {
    return res
      .status(400)
      .json({ detail: "Request body must include 'price' and 'version'" });
  }

  // --- Idempotency check ---
  const requestId = req.headers["x-request-id"];
  if (requestId) {
    try {
      const { rows } = await pool.query(
        "SELECT response FROM processed_requests WHERE request_id = $1",
        [requestId]
      );
      if (rows.length > 0) {
        return res.status(422).json({
          detail: "Duplicate request",
          original_response: rows[0].response,
        });
      }
    } catch (err) {
      console.error(`[${REGION}] Idempotency check error:`, err.message);
    }
  }

  try {
    // Optimistic locking update
    const { rows } = await pool.query(
      `UPDATE properties
       SET price = $1,
           version = version + 1,
           updated_at = NOW()
       WHERE id = $2 AND version = $3
       RETURNING id, price, bedrooms, bathrooms, region_origin, version, updated_at`,
      [price, propertyId, version]
    );

    if (rows.length === 0) {
      // Check existence
      const exists = await pool.query(
        "SELECT id, version FROM properties WHERE id = $1",
        [propertyId]
      );
      if (exists.rows.length === 0) {
        return res.status(404).json({ detail: "Property not found" });
      }
      return res.status(409).json({
        detail: `Version conflict: expected version ${version}, current version is ${exists.rows[0].version}`,
      });
    }

    const updated = rows[0];
    const responseData = {
      id: updated.id,
      price: parseFloat(updated.price),
      version: updated.version,
      updated_at: new Date(updated.updated_at).toISOString(),
    };

    // Store idempotency record
    if (requestId) {
      try {
        await pool.query(
          `INSERT INTO processed_requests (request_id, response)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [requestId, JSON.stringify(responseData)]
        );
      } catch (err) {
        console.error(`[${REGION}] Idempotency store error:`, err.message);
      }
    }

    // Publish Kafka event for cross-region replication
    const kafkaEvent = {
      id: updated.id,
      price: parseFloat(updated.price),
      bedrooms: updated.bedrooms,
      bathrooms: updated.bathrooms,
      region_origin: updated.region_origin,
      version: updated.version,
      updated_at: new Date(updated.updated_at).toISOString(),
    };

    try {
      await producer.send({
        topic: KAFKA_TOPIC,
        messages: [{ key: String(updated.id), value: JSON.stringify(kafkaEvent) }],
      });
      console.log(
        `[${REGION}] Published Kafka event for property ${updated.id} (v${updated.version})`
      );
    } catch (err) {
      console.error(`[${REGION}] Kafka publish error:`, err.message);
    }

    res.json(responseData);
  } catch (err) {
    console.error(`[${REGION}] PUT property error:`, err.message);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // Wait for DB to be ready
  let dbReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query("SELECT 1");
      dbReady = true;
      break;
    } catch {
      console.log(`[${REGION}] DB not ready, retrying in 2s... (${i + 1}/30)`);
      await sleep(2000);
    }
  }
  if (!dbReady) {
    console.error(`[${REGION}] Could not connect to database. Exiting.`);
    process.exit(1);
  }
  console.log(`[${REGION}] Database connected.`);

  // Connect Kafka producer
  let prodReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      await producer.connect();
      prodReady = true;
      break;
    } catch {
      console.log(
        `[${REGION}] Kafka producer not ready, retrying in 2s... (${i + 1}/30)`
      );
      await sleep(2000);
    }
  }
  if (!prodReady) {
    console.error(`[${REGION}] Could not connect Kafka producer. Exiting.`);
    process.exit(1);
  }
  console.log(`[${REGION}] Kafka producer connected.`);

  // Start Kafka consumer (async, runs in background)
  startConsumer().catch((err) =>
    console.error(`[${REGION}] Consumer start error:`, err.message)
  );

  // Start HTTP server
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[${REGION}] Server listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
