-- core owns: identity.user_account, profile.company, profile.company_member,
-- core.outbox_event, core.outbox_delivery, core.inbox_processed
CREATE SCHEMA identity AUTHORIZATION dv_migrator;
CREATE SCHEMA profile AUTHORIZATION dv_migrator;
CREATE SCHEMA core AUTHORIZATION dv_migrator;

CREATE TABLE identity.user_account (
  id            uuid PRIMARY KEY,
  keycloak_sub  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_account_keycloak_sub_uq UNIQUE (keycloak_sub),
  CONSTRAINT user_account_keycloak_sub_len CHECK (length(keycloak_sub) BETWEEN 1 AND 64)
);
COMMENT ON TABLE identity.user_account IS 'One row per Keycloak user seen by core. No passwords or tokens are stored.';

CREATE TABLE profile.company (
  id                           uuid PRIMARY KEY,
  name                         text NOT NULL,
  registration_number          text,
  country_code                 char(2) NOT NULL,
  status                       text NOT NULL DEFAULT 'draft',
  verification_id              uuid,
  verification_submission_key  text,
  submission_claimed_until     timestamptz,
  decision_reason_code         text,
  decided_at                   timestamptz,
  created_by                   uuid NOT NULL REFERENCES identity.user_account (id),
  version                      integer NOT NULL DEFAULT 1,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_status_ck CHECK (status IN ('draft', 'pending', 'approved', 'rejected')),
  CONSTRAINT company_name_ck CHECK (length(name) BETWEEN 2 AND 200),
  CONSTRAINT company_country_ck CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT company_pending_has_verification_ck CHECK (status = 'draft' OR verification_id IS NOT NULL),
  CONSTRAINT company_submission_key_uq UNIQUE (verification_submission_key)
);
CREATE INDEX company_status_idx ON profile.company (status);

CREATE TABLE profile.company_member (
  company_id       uuid NOT NULL REFERENCES profile.company (id) ON DELETE CASCADE,
  user_account_id  uuid NOT NULL REFERENCES identity.user_account (id),
  role             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_account_id),
  CONSTRAINT company_member_role_ck CHECK (role IN ('owner', 'representative', 'employee'))
);
CREATE INDEX company_member_user_idx ON profile.company_member (user_account_id);

CREATE TABLE core.outbox_event (
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
CREATE INDEX outbox_event_unfanned_idx ON core.outbox_event (created_at) WHERE fanned_out_at IS NULL;

CREATE TABLE core.outbox_delivery (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id          uuid NOT NULL REFERENCES core.outbox_event (event_id),
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
CREATE INDEX outbox_delivery_due_idx ON core.outbox_delivery (next_attempt_at)
  WHERE status IN ('pending', 'in_flight');

CREATE TABLE core.inbox_processed (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  event_type    text NOT NULL,
  outcome       text NOT NULL DEFAULT 'applied',
  note          text,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id),
  CONSTRAINT inbox_outcome_ck CHECK (outcome IN ('applied', 'ignored'))
);

-- Least privilege: dv_core reaches only its three schemas, with no DDL and no DELETE.
GRANT USAGE ON SCHEMA identity, profile, core TO dv_core;
GRANT SELECT, INSERT, UPDATE ON identity.user_account, profile.company, profile.company_member TO dv_core;
GRANT SELECT, INSERT, UPDATE ON core.outbox_event, core.outbox_delivery TO dv_core;
GRANT SELECT, INSERT, UPDATE ON core.inbox_processed TO dv_core;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA core TO dv_core;
