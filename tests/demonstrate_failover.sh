#!/usr/bin/env bash
# =============================================================================
# demonstrate_failover.sh
#
# Demonstrates NGINX failover: when the US backend goes down,
# requests to /us/* are automatically served by the EU backend.
#
# Usage:
#   bash tests/demonstrate_failover.sh
#
# Prerequisites:
#   docker compose must be available, and no conflicting containers running.
# =============================================================================

set -euo pipefail

COMPOSE="docker compose"
BASE_URL="http://localhost:8080"
CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No colour

echo -e "${CYAN}==========================================${NC}"
echo -e "${CYAN} Multi-Region Failover Demonstration${NC}"
echo -e "${CYAN}==========================================${NC}"

# ------------------------------------------------------------------
# Step 1 – Ensure services are running
# ------------------------------------------------------------------
echo -e "\n${CYAN}[1/5] Starting all services...${NC}"
$COMPOSE up -d --build

echo -e "${CYAN}[1/5] Waiting for services to become healthy (up to 120s)...${NC}"
for i in $(seq 1 24); do
  US_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/us/health" 2>/dev/null || echo "000")
  EU_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/eu/health" 2>/dev/null || echo "000")
  if [ "$US_HEALTH" = "200" ] && [ "$EU_HEALTH" = "200" ]; then
    echo -e "${GREEN}All services healthy.${NC}"
    break
  fi
  echo "  ...waiting (US=$US_HEALTH, EU=$EU_HEALTH) [$((i*5))s]"
  sleep 5
done

# ------------------------------------------------------------------
# Step 2 – Normal request to US backend
# ------------------------------------------------------------------
echo -e "\n${CYAN}[2/5] Sending request to US backend (should be served by backend-us)...${NC}"
RESPONSE=$(curl -s "$BASE_URL/us/health")
echo "  Response: $RESPONSE"

REGION=$(echo "$RESPONSE" | grep -o '"region":"[^"]*"' | head -1)
echo -e "  Served by: $REGION"
if echo "$REGION" | grep -q "us"; then
  echo -e "  ${GREEN}✅ Request served by US backend as expected.${NC}"
else
  echo -e "  ${RED}❌ Unexpected region.${NC}"
fi

# ------------------------------------------------------------------
# Step 3 – Stop the US backend
# ------------------------------------------------------------------
echo -e "\n${CYAN}[3/5] Stopping backend-us container to simulate failure...${NC}"
docker stop backend-us
echo "  backend-us stopped."
sleep 3

# ------------------------------------------------------------------
# Step 4 – Request to /us/ should now failover to EU
# ------------------------------------------------------------------
echo -e "\n${CYAN}[4/5] Sending request to /us/health (should failover to backend-eu)...${NC}"
RESPONSE=$(curl -s "$BASE_URL/us/health")
echo "  Response: $RESPONSE"

REGION=$(echo "$RESPONSE" | grep -o '"region":"[^"]*"' | head -1)
echo -e "  Served by: $REGION"
if echo "$REGION" | grep -q "eu"; then
  echo -e "  ${GREEN}✅ Failover successful! Request served by EU backend.${NC}"
else
  echo -e "  ${RED}❌ Failover did not work as expected.${NC}"
fi

echo -e "\n${CYAN}[4/5] Checking backend-eu logs for the forwarded request...${NC}"
docker logs backend-eu --tail 5

# ------------------------------------------------------------------
# Step 5 – Restart the US backend
# ------------------------------------------------------------------
echo -e "\n${CYAN}[5/5] Restarting backend-us...${NC}"
docker start backend-us
sleep 10

RESPONSE=$(curl -s "$BASE_URL/us/health")
echo "  Response after restart: $RESPONSE"
REGION=$(echo "$RESPONSE" | grep -o '"region":"[^"]*"' | head -1)
if echo "$REGION" | grep -q "us"; then
  echo -e "  ${GREEN}✅ US backend recovered. Requests routed back to US.${NC}"
else
  echo -e "  ${GREEN}✅ Request still served (by $REGION). US recovery may take a moment.${NC}"
fi

echo -e "\n${CYAN}==========================================${NC}"
echo -e "${GREEN} Failover demonstration complete.${NC}"
echo -e "${CYAN}==========================================${NC}"
