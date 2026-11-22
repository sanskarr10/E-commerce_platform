-- Messaging tables for the checkout saga (see docs/events/README.md).

-- One row per order: the stock held for it, and why it is (or is not) held.
--   RESERVED  stock is held
--   RELEASED  stock was held and has been given back (order cancelled)
--   FAILED    reservation was refused, nothing is held
--   CANCELLED order.cancelled arrived first; blocks a late order.created (tombstone, nothing held)
CREATE TABLE stock_reservations (
  order_id   CHAR(36)    NOT NULL,
  status     VARCHAR(16) NOT NULL,
  items      TEXT        NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotent consumer: an event id is recorded in the same transaction as its effect.
CREATE TABLE inbox (
  event_id    CHAR(36)    NOT NULL,
  consumer    VARCHAR(64) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Transactional outbox: events are written with the state change and published afterwards.
-- claimed_until is a lease, so a relay that dies mid-batch does not block the rows forever.
CREATE TABLE outbox (
  seq           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  id            CHAR(36)        NOT NULL,
  event_type    VARCHAR(64)     NOT NULL,
  payload       TEXT            NOT NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at  DATETIME(3)     NULL,
  claimed_until DATETIME(3)     NULL,
  PRIMARY KEY (seq),
  UNIQUE KEY uq_outbox_id (id),
  KEY ix_outbox_unpublished (published_at, seq)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
