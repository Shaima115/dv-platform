-- verification owns: compliance.verification_request, compliance.outbox_event, compliance.outbox_delivery
CREATE SCHEMA compliance AUTHORIZATION dv_migrator;

CREATE TABLE compliance.verification_request (
  id                     uuid PRIMARY KEY,
  company_id             uuid NOT NULL,
  requested_by_client    text NOT NULL,
  requested_by_subject   text NOT NULL,
  idempotency_key        text NOT NULL,
  request_fingerprint    char(64) NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  decision_reason_code   text,
  decision_comment       text,
  decided_by_subject     text,
  decided_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  -- Idempotency is enforced by the database, scoped to the calling service.
  CONSTRAINT verification_request_idempotency_uq UNIQUE (requested_by_client, idempotency_key),
  CONSTRAINT verification_request_status_ck CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT verification_request_decision_ck CHECK (
    (status = 'pending' AND decided_at IS NULL) OR
    (status <> 'pending' AND decided_at IS NOT NULL AND decision_reason_code IS NOT NULL)
  ),
  CONSTRAINT verification_request_comment_len CHECK (decision_comment IS NULL OR length(decision_comment) <= 500)
);
-- At most one open request per company.
CREATE UNIQUE INDEX verification_request_one_pending_uq ON compliance.verification_request (company_id)
  WHERE status = 'pending';

CREATE TABLE compliance.outbox_event (
  event_id        uuid PRIMARY KEY,
  event_type      text NOT NULL,
  schema_version  integer NOT NULL,
  aggregate_id    uuid NOT NULL,
  request_id      text NOT NULL,
  traceparent     text NOT NULL,
  country         char(2) NOT NULL,
  payload         jsonb NOT NULL,
  occurred_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  fanned_out_at   timestamptz
);
CREATE INDEX outbox_event_unfanned_idx ON compliance.outbox_event (created_at) WHERE fanned_out_at IS NULL;

CREATE TABLE compliance.outbox_delivery (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES compliance.outbox_event (event_id),
  subscriber        text NOT NULL,
  target_url        text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  lease_until       timestamptz,
  last_status_code  integer,
  last_error        text,
  delivered_at      timestamptz,
  dead_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_delivery_event_subscriber_uq UNIQUE (event_id, subscriber),
  CONSTRAINT outbox_delivery_status_ck CHECK (status IN ('pending', 'in_flight', 'delivered', 'dead')),
  CONSTRAINT outbox_delivery_attempts_ck CHECK (attempts >= 0)
);
CREATE INDEX outbox_delivery_due_idx ON compliance.outbox_delivery (next_attempt_at)
  WHERE status IN ('pending', 'in_flight');

GRANT USAGE ON SCHEMA compliance TO dv_verification;
GRANT SELECT, INSERT, UPDATE ON compliance.verification_request TO dv_verification;
GRANT SELECT, INSERT, UPDATE ON compliance.outbox_event, compliance.outbox_delivery TO dv_verification;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA compliance TO dv_verification;
