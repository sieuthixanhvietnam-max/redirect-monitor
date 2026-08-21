#!/bin/bash
# Backup SQLite hang ngay. Dung ".backup" cua sqlite3 chu KHONG copy file tho:
# app ghi o che do WAL, copy tho co the ra file hong hoac thieu giao dich cuoi.
set -euo pipefail

DB=/var/www/redirect-monitor/main-app/data/monitor.db
DEST=/var/backups/redirect-monitor
KEEP_DAYS=14

mkdir -p "$DEST"
sqlite3 "$DB" ".backup '$DEST/monitor-$(date +%F).db'"
gzip -f "$DEST/monitor-$(date +%F).db"
find "$DEST" -name 'monitor-*.db.gz' -mtime +$KEEP_DAYS -delete
