#!/usr/bin/env bash
# Crash-recovery demo, for recording.
#
#   npm run demo
#
# Starts the fake providers and the API, places an order with a slow payment,
# kills the API with kill -9 mid-charge, shows what Postgres recorded, restarts
# the API, and shows the order finishing with exactly one charge.
set -euo pipefail
cd "$(dirname "$0")/.."

API=http://localhost:3000
FAKES=http://localhost:4000
LOGS=$(mktemp -d)
API_PID=""
FAKES_PID=""

cleanup() { kill "$API_PID" "$FAKES_PID" 2>/dev/null || true; }
trap cleanup EXIT

say()   { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; sleep "${PAUSE:-1.5}"; }
psql_() { docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -P pager=off -c "$0"' "$1"; }
wait_up() { until curl -sf "$1" >/dev/null; do sleep 0.1; done; }
pretty() { python3 -m json.tool; }

start_api() {
  node --import tsx src/server.ts >"$LOGS/api.log" 2>&1 &
  API_PID=$!
  wait_up "$API/health"
}

say "Starting Postgres, the fake providers and the API"
docker compose up -d --wait >/dev/null 2>&1
node --import tsx src/fakes/server.ts >"$LOGS/fakes.log" 2>&1 &
FAKES_PID=$!
wait_up "$FAKES/admin/state"
curl -s -X POST "$FAKES/admin/reset" >/dev/null
start_api

say "Making the payment provider slow (3 seconds per charge)"
curl -s -X PUT "$FAKES/admin/faults/payment" -H 'content-type: application/json' -d '{"latencyMs":3000}' >/dev/null

say "Placing an order"
KEY="demo-$(date +%s)"
ORDER_ID=$(curl -s -X POST "$API/orders" \
  -H 'content-type: application/json' -H "Idempotency-Key: $KEY" \
  -d '{"customerEmail":"ana@example.com","sku":"SKU-BOOK","quantity":2,"amountCents":2500}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "order id: $ORDER_ID"
sleep 1

say "The charge is in flight. Pulling the plug: kill -9 $API_PID"
kill -9 "$API_PID"
wait "$API_PID" 2>/dev/null || true
echo "API process is dead."

say "What Postgres recorded at the moment of the crash"
psql_ "SELECT status, locked_by FROM workflows WHERE id = '$ORDER_ID'"
psql_ "SELECT name, status, attempts FROM workflow_steps WHERE workflow_id = '$ORDER_ID' ORDER BY step_index"
echo "charge_payment = running: we called the provider but never saw the answer."

say "Payment provider is fast again. Restarting the API"
curl -s -X PUT "$FAKES/admin/faults/payment" -H 'content-type: application/json' -d '{"latencyMs":0}' >/dev/null
start_api
grep '\[recovery\]' "$LOGS/api.log" || true

say "Waiting for the order to finish"
until [ "$(curl -s "$API/orders/$ORDER_ID" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" = "completed" ]; do sleep 0.2; done
sleep 3 # let the request sent before the crash land at the provider too
curl -s "$API/orders/$ORDER_ID" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("status:", d["status"])
for s in d["steps"]:
    print("  %-18s %-10s attempts=%d" % (s["name"], s["status"], s["attempts"]))'

say "The full history"
curl -s "$API/orders/$ORDER_ID/history" | python3 -c '
import json, sys
for e in json.load(sys.stdin)["events"]:
    print("  %s  %-24s %s" % (e["at"][11:23], e["type"], e.get("step") or ""))'

say "What the payment provider actually recorded"
curl -s "$FAKES/admin/state" | python3 -c '
import json, sys
t = json.load(sys.stdin)["totals"]
print("  charges: %d   captured: $%.2f   emails: %d" % (t["charges"], t["capturedCents"] / 100, t["emails"]))'
echo
echo "The charge ran twice (attempts=2) but the customer was charged once:"
echo "both calls carried the same idempotency key, so the provider replayed the first result."
