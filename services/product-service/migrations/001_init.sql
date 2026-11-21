-- Product catalog schema. Money is stored as integer minor units (paise/cents), never floats.

CREATE TABLE categories (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(100) NOT NULL,
  slug       VARCHAR(120) NOT NULL,
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_categories_name (name),
  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku         VARCHAR(64)     NOT NULL,
  name        VARCHAR(200)    NOT NULL,
  description TEXT            NULL,
  price_minor INT UNSIGNED    NOT NULL,
  currency    CHAR(3)         NOT NULL DEFAULT 'INR',
  -- Signed on purpose: the CHECK below rejects negatives, and unsigned arithmetic would raise
  -- an "out of range" error instead of letting the guarded UPDATE simply match no row.
  stock       INT             NOT NULL DEFAULT 0,
  category_id INT UNSIGNED    NULL,
  image_url   VARCHAR(500)    NULL,
  is_active   TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku),
  KEY ix_products_category_active_price (category_id, is_active, price_minor),
  KEY ix_products_active_created (is_active, created_at),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL,
  CONSTRAINT chk_products_stock_nonneg CHECK (stock >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
