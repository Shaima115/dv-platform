-- notification owns: notification.notification, notification.inbox_processed
CREATE SCHEMA notification AUTHORIZATION dv_migrator;

CREATE TABLE notification.notification (
  id                 uuid PRIMARY KEY,
  recipient_subject  text NOT NULL,
  company_id         uuid NOT NULL,
  event_id           uuid NOT NULL,
  message_code       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz,
  -- Defence in depth on top of the inbox: one notification per event and recipient.
  CONSTRAINT notification_event_recipient_uq UNIQUE (event_id, recipient_subject),
  CONSTRAINT notification_message_code_ck CHECK (message_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
);
CREATE INDEX notification_recipient_idx ON notification.notification (recipient_subject, created_at DESC);

CREATE TABLE notification.inbox_processed (
  consumer      text NOT NULL,
  event_id      uuid NOT NULL,
  event_type    text NOT NULL,
  outcome       text NOT NULL DEFAULT 'applied',
  note          text,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id),
  CONSTRAINT inbox_outcome_ck CHECK (outcome IN ('applied', 'ignored'))
);

GRANT USAGE ON SCHEMA notification TO dv_notification;
GRANT SELECT, INSERT, UPDATE ON notification.notification, notification.inbox_processed TO dv_notification;
