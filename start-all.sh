#!/bin/bash
# Tien ich khoi dong ca hai thanh phan tren CUNG mot may (dung de thu nghiem).
# Khi trien khai that, relay phai nam o Viet Nam va main-app o VPS nuoc ngoai.
set -e
cd "$(dirname "$0")"
echo "==> VN Relay"
(cd vn-relay && docker compose up -d --build)
echo "==> Main App"
(cd main-app && docker compose up -d --build)
echo
echo "Dashboard: http://localhost:8000"
echo "Relay health: curl -H 'x-api-key: <KEY>' http://localhost:8787/health"
