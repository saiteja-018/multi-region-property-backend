-- seeds/init.sql
-- Schema creation and seeding for the properties database.
-- This script runs automatically on first container startup via
-- PostgreSQL's /docker-entrypoint-initdb.d/ mechanism.

-- Create the idempotency store table
CREATE TABLE IF NOT EXISTS processed_requests (
    request_id  VARCHAR(255) PRIMARY KEY,
    response    JSONB        NOT NULL,
    created_at  TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Create the properties table
CREATE TABLE IF NOT EXISTS properties (
    id             BIGINT        PRIMARY KEY,
    price          DECIMAL       NOT NULL,
    bedrooms       INTEGER,
    bathrooms      INTEGER,
    region_origin  VARCHAR(2)    NOT NULL,
    version        INTEGER       NOT NULL DEFAULT 1,
    updated_at     TIMESTAMP     NOT NULL DEFAULT NOW()
);

-- Create index on region_origin for faster filtering
CREATE INDEX IF NOT EXISTS idx_properties_region ON properties (region_origin);

-- Create a replication_meta table to track last consumed Kafka message
CREATE TABLE IF NOT EXISTS replication_meta (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    last_updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO replication_meta (id, last_updated_at) VALUES (1, NOW())
ON CONFLICT (id) DO NOTHING;

-- Seed 1200 properties: 600 with region_origin='us', 600 with region_origin='eu'
-- Using generate_series to produce synthetic data.

INSERT INTO properties (id, price, bedrooms, bathrooms, region_origin, version, updated_at)
SELECT
    s AS id,
    ROUND((50000 + random() * 950000)::numeric, 2) AS price,
    1 + (random() * 5)::integer AS bedrooms,
    1 + (random() * 3)::integer AS bathrooms,
    CASE WHEN s <= 600 THEN 'us' ELSE 'eu' END AS region_origin,
    1 AS version,
    NOW() AS updated_at
FROM generate_series(1, 1200) AS s
ON CONFLICT (id) DO NOTHING;
