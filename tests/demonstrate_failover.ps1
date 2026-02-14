# Demonstrate NGINX failover on Windows PowerShell
# Usage:
#   powershell -ExecutionPolicy Bypass -File tests\demonstrate_failover.ps1

$ErrorActionPreference = "Stop"

$baseUrl = "http://localhost:8080"

Write-Host "=========================================="
Write-Host " Multi-Region Failover Demonstration (PS)"
Write-Host "=========================================="

Write-Host "`n[1/5] Starting all services..."
docker compose up -d --build | Out-Host

Write-Host "`n[1/5] Waiting for services to become healthy (up to 180s)..."
$healthy = $false
for ($i = 1; $i -le 36; $i++) {
    try {
        $ps = docker compose ps --format "json" | ConvertFrom-Json
        $unhealthy = $ps | Where-Object { $_.Health -and $_.Health -ne "healthy" }
        if (-not $unhealthy) {
            $healthy = $true
            break
        }
    } catch {
        # ignore transient failures
    }
    Write-Host "  ...waiting [$($i*5)s]"
    Start-Sleep -Seconds 5
}

if (-not $healthy) {
    Write-Host "Services did not become healthy in time. Current status:"
    docker compose ps | Out-Host
    throw "Services did not become healthy in time."
}

# Extra check: ensure endpoints respond via NGINX
Write-Host "`n[1/5] Verifying /us/health and /eu/health through NGINX..."
for ($j = 1; $j -le 24; $j++) {
    try {
        $us = Invoke-RestMethod "$baseUrl/us/health" -TimeoutSec 3
        $eu = Invoke-RestMethod "$baseUrl/eu/health" -TimeoutSec 3
        if ($us.region -eq "us" -and $eu.region -eq "eu") {
            break
        }
    } catch {
        # ignore transient failures
    }
    Write-Host "  ...waiting for NGINX routes [$($j*5)s]"
    Start-Sleep -Seconds 5
}

Write-Host "`n[2/5] Sending request to US backend (expect region=us)..."
$resp = Invoke-RestMethod "$baseUrl/us/health"
Write-Host "  Response: $(ConvertTo-Json $resp -Compress)"

if ($resp.region -eq "us") {
    Write-Host "  OK: served by US backend"
} else {
    Write-Host "  WARNING: unexpected region '$($resp.region)'"
}

Write-Host "`n[3/5] Stopping backend-us to simulate failure..."
docker stop backend-us | Out-Host
Start-Sleep -Seconds 3

Write-Host "`n[4/5] Requesting /us/health again (expect region=eu)..."
$resp2 = Invoke-RestMethod "$baseUrl/us/health"
Write-Host "  Response: $(ConvertTo-Json $resp2 -Compress)"

if ($resp2.region -eq "eu") {
    Write-Host "  OK: failover to EU backend"
} else {
    Write-Host "  WARNING: unexpected region '$($resp2.region)'"
}

Write-Host "`n[4/5] Recent backend-eu logs:"
docker logs backend-eu --tail 5 | Out-Host

Write-Host "`n[5/5] Restarting backend-us..."
docker start backend-us | Out-Host
Start-Sleep -Seconds 10

$resp3 = Invoke-RestMethod "$baseUrl/us/health"
Write-Host "  Response after restart: $(ConvertTo-Json $resp3 -Compress)"

Write-Host "`n=========================================="
Write-Host " Failover demonstration complete."
Write-Host "=========================================="
