#!/usr/bin/env bash
# Lightweight health watchdog for slizm-gateway under systemd.
# Restarts the service automatically if /health fails MAX_FAILURES consecutive times,
# while respecting intentional manual `systemctl stop`.
set -euo pipefail

SERVICE="${GATEWAY_SERVICE:-slizm-gateway}"
HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:4000/health}"
MAX_FAILURES="${GATEWAY_WATCHDOG_MAX_FAILURES:-3}"
STATE_FILE="${GATEWAY_WATCHDOG_STATE_FILE:-/run/slizm-gateway-watchdog.fails}"

# Only watch when the service is enabled and supposed to be running (active/activating).
# If an operator deliberately ran `systemctl stop slizm-gateway`, do nothing.
if ! systemctl is-active --quiet "$SERVICE"; then
  rm -f "$STATE_FILE"
  exit 0
fi

BODY=""
if BODY="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" && [[ "$BODY" == *'"status":"ok"'* ]]; then
  rm -f "$STATE_FILE"
  exit 0
fi

FAILS=0
if [ -f "$STATE_FILE" ]; then
  RAW="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
  [[ "$RAW" =~ ^[0-9]+$ ]] && FAILS="$RAW"
fi
FAILS=$((FAILS + 1))

if [ "$FAILS" -ge "$MAX_FAILURES" ]; then
  echo "[slizm-gateway-watchdog] $HEALTH_URL failed $FAILS consecutive checks; restarting $SERVICE" >&2
  rm -f "$STATE_FILE"
  systemctl restart "$SERVICE"
else
  echo "$FAILS" > "$STATE_FILE"
  echo "[slizm-gateway-watchdog] $HEALTH_URL check failed ($FAILS/$MAX_FAILURES)" >&2
fi
