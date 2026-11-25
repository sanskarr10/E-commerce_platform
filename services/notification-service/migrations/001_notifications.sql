-- One row per (order, event type): the unique key makes a duplicate or re-emitted event harmless.
CREATE TABLE notifications (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL,
    user_email       TEXT,
    type             TEXT        NOT NULL,
    order_id         UUID        NOT NULL,
    title            TEXT        NOT NULL,
    body             TEXT        NOT NULL,
    -- pending -> sending (claimed with a lease) -> sent | failed; skipped when there is nothing to send to
    email_status     TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (email_status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
    email_claimed_at TIMESTAMPTZ,
    email_error      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at          TIMESTAMPTZ,
    CONSTRAINT uq_notifications_order_type UNIQUE (order_id, type)
);

CREATE INDEX ix_notifications_user_created ON notifications (user_id, created_at DESC);
CREATE INDEX ix_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX ix_notifications_email_open ON notifications (email_status) WHERE email_status IN ('pending', 'sending');
