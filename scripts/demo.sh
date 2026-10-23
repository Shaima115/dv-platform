#!/usr/bin/env bash
# Runs the eleven assessment scenarios against the running stack (PM2 + Nginx + Keycloak + PostgreSQL).
# Every scenario checks the HTTP result AND the persisted state. Exits non-zero if any check fails.
#
#   npm run demo                 # all scenarios
#   bash scripts/demo.sh 1 4 9   # selected scenarios
#
# Development credentials only (keycloak/realm-jo.json). Scenarios 7, 8 and 10 stop and start PM2
# processes and toggle the development fault-injection file; they restore everything they change.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/demo-helpers.sh
source "$ROOT/scripts/lib/demo-helpers.sh"
if [[ -f "${DOTENV_PATH:-$ROOT/.env}" ]]; then set -a; source "${DOTENV_PATH:-$ROOT/.env}"; set +a; fi

PUBLIC_URL=${DEMO_PUBLIC_URL:-http://127.0.0.1:8080}
KEYCLOAK_URL=${DEMO_KEYCLOAK_URL:-http://127.0.0.1:8180}
KEYCLOAK_TOKEN_URL="$KEYCLOAK_URL/realms/jo/protocol/openid-connect/token"
OTHER_REALM_TOKEN_URL="$KEYCLOAK_URL/realms/other/protocol/openid-connect/token"
CORE_INTERNAL=http://svc-core.internal
VERIFICATION_INTERNAL=http://svc-verification.internal
FAULT_FILE=${NOTIFICATION_FAULT_FILE:-}
RUN_ID=$(date +%s)

SELECTED=("$@")
cd "$ROOT"
want() { [[ ${#SELECTED[@]} -eq 0 ]] && return 0; local s; for s in "${SELECTED[@]}"; do [[ "$s" == "$1" ]] && return 0; done; return 1; }

restore() {
  pm2 start dv-verification >/dev/null 2>&1 || true
  pm2 start dv-notification >/dev/null 2>&1 || true
  [[ -n "$FAULT_FILE" ]] && : > "$FAULT_FILE"
}
trap restore EXIT

# ---- Preconditions -------------------------------------------------------------------------------
for tool in curl jq psql pm2; do command -v "$tool" >/dev/null || { echo "missing tool: $tool"; exit 2; }; done
for host in svc-core svc-verification svc-notification; do
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://$host.internal/ready")
  [[ "$status" == 200 ]] || { echo "$host is not ready (HTTP $status). Start the stack first: npm run start:pm2"; exit 2; }
done

OWNER=$(user_token "$DEMO_OWNER_USERNAME" "$DEMO_OWNER_PASSWORD")
REVIEWER=$(user_token "$DEMO_REVIEWER_USERNAME" "$DEMO_REVIEWER_PASSWORD")
EMPLOYEE=$(user_token "$DEMO_EMPLOYEE_USERNAME" "$DEMO_EMPLOYEE_PASSWORD")
SVC_CORE=$(service_token "$CORE_CLIENT_ID" "$CORE_CLIENT_SECRET")
SVC_VERIFICATION=$(service_token "$VERIFICATION_CLIENT_ID" "$VERIFICATION_CLIENT_SECRET")
for t in OWNER REVIEWER EMPLOYEE SVC_CORE SVC_VERIFICATION; do
  [[ -n "${!t}" ]] || { echo "could not obtain token $t from Keycloak at $KEYCLOAK_URL"; exit 2; }
done
info "tokens acquired for owner, reviewer, employee, svc-core, svc-verification"

# Approve a company end to end and print "<company_id> <verification_id>".
approve_flow() { # <name> [extra curl args for the decision call...]
  local name=$1; shift
  local cid vid
  create_company "$OWNER" "$name"; cid=$COMPANY_ID
  api POST "$PUBLIC_URL/api/v1/companies/$cid/verification" "$OWNER" -
  vid=$(json '.verificationId // empty')
  api POST "$PUBLIC_URL/api/v1/admin/verifications/$vid/decision" "$REVIEWER" '{"decision":"approved","reasonCode":"documents_valid"}' "$@"
  echo "$cid $vid"
}

# ==================================================================================================
if want 1; then
  CURRENT_SCENARIO=1; scenario "1 — happy path: create, request verification, approve, notify"
  create_company "$OWNER" "Happy Path $RUN_ID"; S1_COMPANY=$COMPANY_ID
  expect_eq "owner creates a company (201)" 201 "$HTTP_STATUS"
  expect_eq "company starts as draft (DB)" draft "$(company_status "$S1_COMPANY")"
  expect_eq "company_created written to core outbox in the same transaction (DB)" 1 \
    "$(db_core "SELECT count(*) FROM core.outbox_event WHERE aggregate_id = '$S1_COMPANY' AND event_type = 'dv.jo.core.company_created.v1'")"

  api POST "$PUBLIC_URL/api/v1/companies/$S1_COMPANY/verification" "$OWNER" -
  expect_eq "owner requests verification (202)" 202 "$HTTP_STATUS"
  S1_VERIFICATION=$(json '.verificationId // empty')
  expect_eq "company is pending (DB)" pending "$(company_status "$S1_COMPANY")"

  api POST "$PUBLIC_URL/api/v1/admin/verifications/$S1_VERIFICATION/decision" "$REVIEWER" '{"decision":"approved","reasonCode":"documents_valid"}'
  expect_eq "reviewer approves (200)" 200 "$HTTP_STATUS"

  expect_eq "company becomes approved via verification.completed (DB)" approved "$(wait_for 20 approved company_status "$S1_COMPANY")"
  expect_eq "exactly one notification row for the owner (DB)" 1 "$(wait_for 20 1 notification_count "$S1_COMPANY")"
  sleep 1
  expect_eq "still exactly one notification a moment later (DB)" 1 "$(notification_count "$S1_COMPANY")"
  api GET "$PUBLIC_URL/api/v1/notifications?limit=100" "$OWNER" -
  expect_eq "owner sees the notification via the API" 1 "$(jq --arg c "$S1_COMPANY" '[.items[] | select(.company_id == $c)] | length' <<<"$HTTP_BODY")"
fi

# ==================================================================================================
if want 2; then
  CURRENT_SCENARIO=2; scenario "2 — no token, expired token, token from another realm → 401"
  api GET "$PUBLIC_URL/api/v1/me/companies" -
  expect_eq "no token → 401" 401 "$HTTP_STATUS"; expect_eq "error code" AUTH_MISSING_TOKEN "$(json .code)"

  SHORT=$(user_token "$DEMO_OWNER_USERNAME" "$DEMO_OWNER_PASSWORD" web-short-lived)
  exp=$(token_exp "$SHORT"); wait_s=$(( exp - $(date +%s) + 1 ))
  info "short-lived token expires at $exp; waiting ${wait_s}s"
  (( wait_s > 0 && wait_s <= 10 )) && sleep "$wait_s"
  api GET "$PUBLIC_URL/api/v1/me/companies" "$SHORT" -
  expect_eq "expired token → 401" 401 "$HTTP_STATUS"; expect_eq "error code" AUTH_TOKEN_EXPIRED "$(json .code)"

  FOREIGN=$(curl -sS "$OTHER_REALM_TOKEN_URL" -d grant_type=password -d client_id=web \
    --data-urlencode 'username=intruder@other.test' --data-urlencode 'password=Intruder#Demo2026' | jq -r '.access_token // empty')
  [[ -n "$FOREIGN" ]] || fail "obtained a token from realm 'other'" "import keycloak/demo-realm-other.json"
  api GET "$PUBLIC_URL/api/v1/me/companies" "$FOREIGN" -
  expect_eq "token from realm 'other' → 401" 401 "$HTTP_STATUS"; expect_eq "error code" AUTH_INVALID_TOKEN "$(json .code)"

  api GET "$PUBLIC_URL/api/v1/notifications" "$FOREIGN" -
  expect_eq "foreign token also rejected by notification → 401" 401 "$HTTP_STATUS"
fi

# ==================================================================================================
if want 3; then
  CURRENT_SCENARIO=3; scenario "3 — employee requests verification; owner calls the decision endpoint → 403"
  create_company "$OWNER" "Employee Test $RUN_ID"; S3_COMPANY=$COMPANY_ID
  api GET "$PUBLIC_URL/api/v1/me" "$EMPLOYEE" -
  EMPLOYEE_ACCOUNT=$(json '.userAccountId // empty')
  api POST "$PUBLIC_URL/api/v1/companies/$S3_COMPANY/members" "$OWNER" "{\"userAccountId\":\"$EMPLOYEE_ACCOUNT\",\"role\":\"employee\"}"
  expect_eq "owner adds an employee (role stored in company_member)" 201 "$HTTP_STATUS"
  expect_eq "membership row says employee (DB)" employee \
    "$(db_core "SELECT role FROM profile.company_member WHERE company_id = '$S3_COMPANY' AND user_account_id = '$EMPLOYEE_ACCOUNT'")"

  api POST "$PUBLIC_URL/api/v1/companies/$S3_COMPANY/verification" "$EMPLOYEE" -
  expect_eq "employee requests verification → 403" 403 "$HTTP_STATUS"
  expect_eq "company still draft (DB)" draft "$(company_status "$S3_COMPANY")"

  # A real pending request owned by this owner, so the 403 is about the role, not a missing id.
  api POST "$PUBLIC_URL/api/v1/companies/$S3_COMPANY/verification" "$OWNER" -
  S3_VERIFICATION=$(json '.verificationId // empty')
  api POST "$PUBLIC_URL/api/v1/admin/verifications/$S3_VERIFICATION/decision" "$OWNER" '{"decision":"approved","reasonCode":"documents_valid"}'
  expect_eq "owner calls the decision endpoint → 403" 403 "$HTTP_STATUS"
  expect_eq "verification request still pending (DB)" pending \
    "$(db_verification "SELECT status FROM compliance.verification_request WHERE id = '$S3_VERIFICATION'")"
fi

# ==================================================================================================
if want 4; then
  CURRENT_SCENARIO=4; scenario "4 — user tokens on internal endpoints → 403"
  before=$(db_verification "SELECT count(*) FROM compliance.verification_request")
  api POST "$VERIFICATION_INTERNAL/internal/v1/verifications" "$OWNER" "{\"company_id\":\"$(uuid4)\",\"requested_by_subject\":\"x\"}" -H "idempotency-key: demo-user-token-$RUN_ID"
  expect_eq "user token on POST /internal/v1/verifications → 403" 403 "$HTTP_STATUS"
  expect_eq "error code" AUTH_WRONG_TOKEN_KIND "$(json .code)"
  expect_eq "no verification row created (DB)" "$before" "$(db_verification "SELECT count(*) FROM compliance.verification_request")"

  api POST "$CORE_INTERNAL/internal/v1/events" "$REVIEWER" '{}'
  expect_eq "user token (even a reviewer) on POST /internal/v1/events → 403" 403 "$HTTP_STATUS"

  api POST "$CORE_INTERNAL/internal/v1/events" "$SVC_CORE" '{}'
  expect_eq "a service token not addressed to core (audience) is rejected → 401" 401 "$HTTP_STATUS"

  api POST "$PUBLIC_URL/internal/v1/events" "$SVC_VERIFICATION" '{}'
  expect_eq "internal paths are not exposed on the public listener → 404" 404 "$HTTP_STATUS"
fi

# ==================================================================================================
if want 5; then
  CURRENT_SCENARIO=5; scenario "5 — approve a draft company / approve twice → 409, status unchanged"
  create_company "$OWNER" "Draft Approval $RUN_ID"; S5_COMPANY=$COMPANY_ID
  EVENT=$(jq -n --arg e "$(node -e "console.log(require('uuid').v7())")" --arg c "$S5_COMPANY" --arg v "$(uuid4)" '{
    event_id: $e, event_type: "dv.jo.verification.completed.v1", schema_version: 1,
    occurred_at: (now | todate), country: "jo", aggregate_id: $c, request_id: "demo-s5",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    data: { verification_id: $v, company_id: $c, decision: "approved", reason_code: "documents_valid" } }')
  api POST "$CORE_INTERNAL/internal/v1/events" "$SVC_VERIFICATION" "$EVENT"
  expect_eq "approving a draft company → 409" 409 "$HTTP_STATUS"
  expect_eq "error code" COMPANY_INVALID_STATE_TRANSITION "$(json .code)"
  expect_eq "company still draft (DB)" draft "$(company_status "$S5_COMPANY")"
  expect_eq "rolled back: no inbox row for the refused event (DB)" 0 \
    "$(db_core "SELECT count(*) FROM core.inbox_processed WHERE event_id = '$(jq -r .event_id <<<"$EVENT")'")"

  read -r S5_APPROVED S5_VERIFICATION < <(approve_flow "Approve Twice $RUN_ID")
  wait_for 20 approved company_status "$S5_APPROVED" >/dev/null
  api POST "$PUBLIC_URL/api/v1/admin/verifications/$S5_VERIFICATION/decision" "$REVIEWER" '{"decision":"approved","reasonCode":"documents_valid"}'
  expect_eq "approving the same verification twice → 409" 409 "$HTTP_STATUS"
  expect_eq "error code" VERIFICATION_ALREADY_DECIDED "$(json .code)"
  api POST "$PUBLIC_URL/api/v1/companies/$S5_APPROVED/verification" "$OWNER" -
  expect_eq "requesting verification for an approved company → 409" 409 "$HTTP_STATUS"
  expect_eq "error code" COMPANY_INVALID_STATE_TRANSITION "$(json .code)"
  expect_eq "company still approved (DB)" approved "$(company_status "$S5_APPROVED")"
  expect_eq "only one verification.completed event for it (DB)" 1 \
    "$(db_verification "SELECT count(*) FROM compliance.outbox_event WHERE payload->'data'->>'verification_id' = '$S5_VERIFICATION'")"
fi

# ==================================================================================================
if want 6; then
  CURRENT_SCENARIO=6; scenario "6 — same verification request twice with the same Idempotency-Key"
  KEY="demo-idem-$RUN_ID"; S6_COMPANY=$(uuid4)
  BODY="{\"company_id\":\"$S6_COMPANY\",\"requested_by_subject\":\"demo-subject\"}"
  api POST "$VERIFICATION_INTERNAL/internal/v1/verifications" "$SVC_CORE" "$BODY" -H "idempotency-key: $KEY"
  first_status=$HTTP_STATUS; first_body=$(jq -S . <<<"$HTTP_BODY")
  api POST "$VERIFICATION_INTERNAL/internal/v1/verifications" "$SVC_CORE" "$BODY" -H "idempotency-key: $KEY"
  expect_eq "first call → 201" 201 "$first_status"
  expect_eq "replay → same status" "$first_status" "$HTTP_STATUS"
  expect_eq "replay → identical response body" "$first_body" "$(jq -S . <<<"$HTTP_BODY")"
  expect_eq "exactly one verification_request row (DB)" 1 \
    "$(db_verification "SELECT count(*) FROM compliance.verification_request WHERE idempotency_key = '$KEY'")"
  api POST "$VERIFICATION_INTERNAL/internal/v1/verifications" "$SVC_CORE" "{\"company_id\":\"$(uuid4)\",\"requested_by_subject\":\"demo-subject\"}" -H "idempotency-key: $KEY"
  expect_eq "same key with different parameters → 409" 409 "$HTTP_STATUS"
  expect_eq "error code" IDEMPOTENCY_KEY_REUSED "$(json .code)"
fi

# ==================================================================================================
if want 7; then
  CURRENT_SCENARIO=7; scenario "7 — verification stopped: 503 within ~2s, company stays draft, circuit opens"
  pm2 stop dv-verification >/dev/null
  create_company "$OWNER" "Outage $RUN_ID"; S7_COMPANY=$COMPANY_ID
  api POST "$PUBLIC_URL/api/v1/companies/$S7_COMPANY/verification" "$OWNER" -
  expect_eq "request verification → 503" 503 "$HTTP_STATUS"
  expect_eq "error code" VERIFICATION_UNAVAILABLE "$(json .code)"
  if awk "BEGIN{exit !($HTTP_TIME < 2.5)}"; then pass "answered within about 2 seconds (${HTTP_TIME}s)"; else fail "answered within about 2 seconds" "took ${HTTP_TIME}s"; fi
  expect_eq "company stays draft (DB)" draft "$(company_status "$S7_COMPANY")"
  # The breaker opens once failures exceed the threshold within its rolling window; how many calls
  # that takes depends on earlier successes still in the window, so call until it opens (bounded).
  calls=1; code=''
  while (( calls < 10 )); do
    api POST "$PUBLIC_URL/api/v1/companies/$S7_COMPANY/verification" "$OWNER" -
    calls=$((calls + 1)); code=$(json .code)
    [[ "$code" == VERIFICATION_CIRCUIT_OPEN ]] && break
    expect_eq "failed call #$calls → 503" 503 "$HTTP_STATUS"
  done
  expect_eq "after repeated failures the circuit opens (call #$calls)" VERIFICATION_CIRCUIT_OPEN "$code"
  expect_eq "open circuit → 503" 503 "$HTTP_STATUS"
  if awk "BEGIN{exit !($HTTP_TIME < 0.2)}"; then pass "open circuit fails fast without calling verification (${HTTP_TIME}s)"; else fail "open circuit fails fast" "took ${HTTP_TIME}s"; fi
  expect_eq "company still draft (DB)" draft "$(company_status "$S7_COMPANY")"

  pm2 start dv-verification >/dev/null
  info "verification restarted; waiting for the circuit to half-open and close (reset ${BREAKER_RESET_TIMEOUT_MS:-15000}ms)"
  recovered=$(wait_for 45 202 bash -c "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'authorization: Bearer $OWNER' '$PUBLIC_URL/api/v1/companies/$S7_COMPANY/verification'; sleep 1")
  expect_eq "after recovery the same company can be submitted (202)" 202 "$recovered"
  expect_eq "company now pending (DB)" pending "$(company_status "$S7_COMPANY")"
  expect_eq "one verification request for it despite all the retries (DB)" 1 \
    "$(db_verification "SELECT count(*) FROM compliance.verification_request WHERE company_id = '$S7_COMPANY'")"
fi

# ==================================================================================================
if want 8; then
  CURRENT_SCENARIO=8; scenario "8 — notification stopped, company approved, notification restarted: nothing lost"
  pm2 stop dv-notification >/dev/null
  read -r S8_COMPANY _ < <(approve_flow "Restart $RUN_ID")
  expect_eq "company approved while notification is down (DB)" approved "$(wait_for 20 approved company_status "$S8_COMPANY")"
  S8_DELIVERY="SELECT d.status || ':' || (d.attempts > 0)::text FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = '$S8_COMPANY' AND e.event_type = 'dv.jo.core.company_approved.v1'"
  expect_eq "delivery to notification is waiting for retry (DB)" "pending:true" "$(wait_for 15 pending:true db_core "$S8_DELIVERY")"
  expect_eq "no notification yet (DB)" 0 "$(notification_count "$S8_COMPANY")"
  pm2 start dv-notification >/dev/null
  expect_eq "after restart the notification arrives (DB)" 1 "$(wait_for 60 1 notification_count "$S8_COMPANY")"
  expect_eq "delivery marked delivered (DB)" "delivered:true" "$(wait_for 10 delivered:true db_core "$S8_DELIVERY")"
fi

# ==================================================================================================
if want 9; then
  CURRENT_SCENARIO=9; scenario "9 — the same verification.completed posted to core twice by hand"
  read -r S9_COMPANY S9_VERIFICATION < <(approve_flow "Duplicate $RUN_ID")
  wait_for 20 1 notification_count "$S9_COMPANY" >/dev/null
  EVENT=$(db_verification "SELECT payload FROM compliance.outbox_event WHERE payload->'data'->>'verification_id' = '$S9_VERIFICATION'")
  EVENT_ID=$(jq -r .event_id <<<"$EVENT")
  version_before=$(db_core "SELECT version FROM profile.company WHERE id = '$S9_COMPANY'")
  for n in 1 2; do
    api POST "$CORE_INTERNAL/internal/v1/events" "$SVC_VERIFICATION" "$EVENT"
    expect_eq "manual post #$n → 200 duplicate (already processed by the relay)" "200 duplicate" "$HTTP_STATUS $(json .status)"
  done
  expect_eq "company changed once: version unchanged (DB)" "$version_before" "$(db_core "SELECT version FROM profile.company WHERE id = '$S9_COMPANY'")"
  expect_eq "one inbox row for the event (DB)" 1 "$(db_core "SELECT count(*) FROM core.inbox_processed WHERE event_id = '$EVENT_ID'")"
  expect_eq "one company_approved event (DB)" 1 \
    "$(db_core "SELECT count(*) FROM core.outbox_event WHERE aggregate_id = '$S9_COMPANY' AND event_type = 'dv.jo.core.company_approved.v1'")"
  sleep 1
  expect_eq "one notification only (DB)" 1 "$(notification_count "$S9_COMPANY")"

  # The stale-event rule: a late "rejected" for an approved company is acknowledged and ignored.
  STALE=$(jq --arg e "$(node -e "console.log(require('uuid').v7())")" '.event_id = $e | .data.decision = "rejected" | .data.reason_code = "late_rejection"' <<<"$EVENT")
  api POST "$CORE_INTERNAL/internal/v1/events" "$SVC_VERIFICATION" "$STALE"
  expect_eq "late 'rejected' after 'approved' → 200 ignored" "200 ignored" "$HTTP_STATUS $(json .outcome)"
  expect_eq "company still approved (DB)" approved "$(company_status "$S9_COMPANY")"
fi

# ==================================================================================================
if want 10; then
  CURRENT_SCENARIO=10; scenario "10 — notification handler throws for one event: dead after 5 tries, others flow"
  if [[ -z "$FAULT_FILE" ]]; then
    fail "NOTIFICATION_FAULT_FILE is configured" "set it in .env (development only) and restart dv-notification"
  else
    create_company "$OWNER" "Poison $RUN_ID"; S10_BAD=$COMPANY_ID
    echo "$S10_BAD" > "$FAULT_FILE"
    api POST "$PUBLIC_URL/api/v1/companies/$S10_BAD/verification" "$OWNER" -; v=$(json .verificationId)
    api POST "$PUBLIC_URL/api/v1/admin/verifications/$v/decision" "$REVIEWER" '{"decision":"approved","reasonCode":"documents_valid"}'
    read -r S10_GOOD _ < <(approve_flow "Healthy $RUN_ID")
    expect_eq "an unrelated approval is still notified (DB)" 1 "$(wait_for 20 1 notification_count "$S10_GOOD")"
    S10_Q="SELECT d.status || ':' || d.attempts FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = '$S10_BAD' AND e.event_type = 'dv.jo.core.company_approved.v1'"
    info "waiting for 5 attempts with exponential backoff (base ${RELAY_BACKOFF_BASE_MS:-1000}ms)"
    expect_eq "failing delivery marked dead after 5 attempts (DB)" "dead:5" "$(wait_for 90 dead:5 db_core "$S10_Q")"
    expect_eq "no notification for the poisoned event (DB)" 0 "$(notification_count "$S10_BAD")"
    read -r S10_AFTER _ < <(approve_flow "After Dead $RUN_ID")
    expect_eq "events still flow after the dead delivery (DB)" 1 "$(wait_for 20 1 notification_count "$S10_AFTER")"

    : > "$FAULT_FILE"
    dead_id=$(db_core "SELECT d.id FROM core.outbox_delivery d JOIN core.outbox_event e USING (event_id) WHERE e.aggregate_id = '$S10_BAD' AND d.status = 'dead'")
    (cd "$ROOT" && node scripts/dead-letter-requeue.js --service core --id "$dead_id" >/dev/null)
    expect_eq "after fixing the fault, re-queue delivers it (DB)" 1 "$(wait_for 20 1 notification_count "$S10_BAD")"
  fi
fi

# ==================================================================================================
if want 11; then
  CURRENT_SCENARIO=11; scenario "11 — one request id and trace id through the logs of all three services"
  TRACE_ID=$(openssl rand -hex 16); REQUEST_ID="demo-trace-$RUN_ID"
  read -r S11_COMPANY _ < <(approve_flow "Traced $RUN_ID" -H "x-request-id: $REQUEST_ID" -H "traceparent: 00-$TRACE_ID-$(openssl rand -hex 8)-01")
  wait_for 20 1 notification_count "$S11_COMPANY" >/dev/null
  sleep 1
  info "request_id=$REQUEST_ID trace_id=$TRACE_ID"
  for proc in dv-verification dv-verification-relay dv-core dv-core-relay dv-notification; do
    log=$(pm2_log_file "$proc")
    lines=$(grep -F "\"request_id\":\"$REQUEST_ID\"" "$log" 2>/dev/null | grep -cF "\"trace_id\":\"$TRACE_ID\"")
    if (( lines > 0 )); then pass "$proc logs carry the request id and trace id ($lines lines)"; else fail "$proc logs carry the request id and trace id" "none in $log"; fi
  done
  event_trace=$(db_core "SELECT traceparent FROM core.outbox_event WHERE aggregate_id = '$S11_COMPANY' AND event_type = 'dv.jo.core.company_approved.v1'")
  expect_eq "company_approved event carries the same trace (DB)" "$TRACE_ID" "$(cut -d- -f2 <<<"$event_trace")"
  expect_eq "company_approved event carries the same request id (DB)" "$REQUEST_ID" \
    "$(db_core "SELECT request_id FROM core.outbox_event WHERE aggregate_id = '$S11_COMPANY' AND event_type = 'dv.jo.core.company_approved.v1'")"
fi

# ==================================================================================================
printf '\n%sSummary:%s %s passed, %s failed\n' "$c_bold" "$c_reset" "$PASS_COUNT" "$FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
  printf '%sFailed checks:%s\n' "$c_red" "$c_reset"; printf '  - %s\n' "${FAILED_CHECKS[@]}"
  exit 1
fi
exit 0
