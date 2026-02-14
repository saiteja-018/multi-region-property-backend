# Multi-Region Property Backend

A distributed property-listing backend that simulates **two geographic regions** (US and EU) with NGINX-based global routing and automatic failover, Apache Kafka for asynchronous cross-region data replication, and PostgreSQL with optimistic locking for data consistency.

---

## Architecture Overview

```
                     ┌────────────┐
         :8080       │   NGINX    │
  Client ──────────► │  (proxy)   │
                     └──┬─────┬──┘
                /us/    │     │    /eu/
           ┌────────────┘     └────────────┐
           ▼                               ▼
    ┌─────────────┐                 ┌─────────────┐
    │ backend-us  │                 │ backend-eu  │
    │  (Node.js)  │                 │  (Node.js)  │
    └──┬──────┬───┘                 └──┬──────┬───┘
       │      │   ┌───────────┐        │      │
       │      └──►│   Kafka   │◄───────┘      │
       │          │ (replicate│               │
       │          │  events)  │               │
       ▼          └───────────┘               ▼
   ┌────────┐                            ┌────────┐
   │ db-us  │                            │ db-eu  │
   │(PG 14) │                            │(PG 14) │
   └────────┘                            └────────┘
```

### Key Components

| Service | Purpose |
|---------|---------|
| **NGINX** | Reverse proxy — routes `/us/*` → `backend-us`, `/eu/*` → `backend-eu`. Automatic failover to the healthy region. |
| **backend-us / backend-eu** | Node.js (Express) API servers. Each manages its own PostgreSQL DB and publishes updates to Kafka. |
| **Kafka + Zookeeper** | Message broker for asynchronous cross-region replication via the `property-updates` topic. |
| **db-us / db-eu** | PostgreSQL 14 databases, each seeded with 1 200 properties. |

---

## Features

- **Path-based routing** with NGINX (`/us/*`, `/eu/*`)
- **Automatic failover** — if one backend is down, NGINX routes to the other
- **Optimistic locking** — concurrent writes are detected via a `version` column; stale updates return `409 Conflict`
- **Idempotent writes** — `X-Request-ID` header prevents duplicate processing (returns `422`)
- **Kafka replication** — every successful write publishes an event; the other region's consumer applies it
- **Replication-lag endpoint** — `GET /:region/replication-lag` reports seconds since last consumed message
- **Custom NGINX logging** — includes `upstream_response_time`

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) & Docker Compose v2
- `curl` (for manual testing)
- `bash` (for the failover demo script)
- Node.js ≥ 18 (only if running tests outside Docker)

---

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url> && cd multi-region-property-backend

# 2. Copy the env file (defaults already work)
cp .env.example .env

# 3. Build & start everything
docker compose up -d --build

# 4. Wait ~30s for all services to become healthy, then verify
docker compose ps          # all services should show "healthy"
curl http://localhost:8080/us/health
curl http://localhost:8080/eu/health
```

---

## API Reference

All endpoints are accessed through the NGINX proxy at `http://localhost:8080`.

### Health Check

```
GET /:region/health
```

**Response** `200 OK`
```json
{ "status": "ok", "region": "us" }
```

### Get Property

```
GET /:region/properties/:id
```

**Response** `200 OK`
```json
{
  "id": 1,
  "price": 350000.00,
  "bedrooms": 3,
  "bathrooms": 2,
  "region_origin": "us",
  "version": 1,
  "updated_at": "2026-02-14T12:00:00.000Z"
}
```

### Update Property (with optimistic locking)

```
PUT /:region/properties/:id
Content-Type: application/json
X-Request-ID: <uuid>       # optional, enables idempotency

{ "price": 500000.00, "version": 1 }
```

**Success** `200 OK`
```json
{
  "id": 1,
  "price": 500000.00,
  "version": 2,
  "updated_at": "2026-02-14T12:05:00.000Z"
}
```

**Version conflict** `409 Conflict`
```json
{ "detail": "Version conflict: expected version 1, current version is 2" }
```

**Duplicate request** `422 Unprocessable Entity`
```json
{ "detail": "Duplicate request", "original_response": { ... } }
```

### Replication Lag

```
GET /:region/replication-lag
```

**Response** `200 OK`
```json
{ "lag_seconds": 2.5 }
```

---

## Conflict Resolution Strategy

This system uses **optimistic locking** to prevent lost updates:

1. Every `properties` row has a `version` column (starts at `1`).
2. A `PUT` request must include the **current** version the client last read.
3. The database update uses `WHERE id = $id AND version = $version`. If the row was already modified, zero rows match and the API returns **409 Conflict**.
4. On success the version is atomically incremented (`version + 1`).

### What should a client do on 409?

1. **Re-fetch** the latest property data (`GET /:region/properties/:id`).
2. **Merge** the remote changes with the intended local changes (application-specific logic).
3. **Retry** the `PUT` with the new version number.

This approach avoids database-level locks and scales well across regions.

---

## Running Tests

### Integration Tests

```bash
# Ensure services are up
docker compose up -d --build

# Wait ~30s then run
node tests/integration.test.js
```

The test suite covers:
- Health endpoints for both regions
- Optimistic locking (409 on stale version)
- Concurrent updates from US and EU
- Idempotency (422 on duplicate X-Request-ID)
- Kafka cross-region replication
- Replication-lag endpoint

### Failover Demonstration

```bash
bash tests/demonstrate_failover.sh
```

This script:
1. Starts all services
2. Sends a request to `/us/health` → served by `backend-us`
3. Stops `backend-us`
4. Sends `GET /us/health` again → NGINX fails over to `backend-eu`
5. Restarts `backend-us` and confirms recovery

---

## Environment Variables

All variables are documented in `.env.example`.

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_US_USER` | `propuser` | US database user |
| `POSTGRES_US_PASSWORD` | `proppass_us` | US database password |
| `POSTGRES_US_DB` | `properties_us` | US database name |
| `POSTGRES_EU_USER` | `propuser` | EU database user |
| `POSTGRES_EU_PASSWORD` | `proppass_eu` | EU database password |
| `POSTGRES_EU_DB` | `properties_eu` | EU database name |
| `KAFKA_BROKER` | `kafka:29092` | Internal Kafka bootstrap server |
| `KAFKA_TOPIC` | `property-updates` | Kafka topic for replication events |
| `PORT` | `8000` | Backend HTTP port (internal) |

---

## Project Structure

```
multi-region-property-backend/
├── docker-compose.yml          # All services orchestration
├── .env / .env.example         # Environment variables
├── nginx/
│   └── nginx.conf              # Reverse proxy + failover config
├── app/
│   ├── package.json            # Node.js dependencies
│   └── src/
│       └── index.js            # Express backend (shared by both regions)
├── backend-us/
│   └── Dockerfile              # US backend image
├── backend-eu/
│   └── Dockerfile              # EU backend image
├── seeds/
│   └── init.sql                # Schema + 1200-row seed data
├── tests/
│   ├── integration.test.js     # Automated integration tests
│   └── demonstrate_failover.sh # Failover demo script
└── README.md
```

---

## License

MIT
