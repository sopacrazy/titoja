CREATE TABLE titoja_stores (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL UNIQUE REFERENCES titoja_users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('food', 'market', 'pharmacy', 'beer')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  pickup_address TEXT NOT NULL CHECK (length(pickup_address) BETWEEN 5 AND 240),
  pickup_area TEXT NOT NULL CHECK (length(pickup_area) BETWEEN 2 AND 100),
  pickup_latitude REAL,
  pickup_longitude REAL,
  is_open INTEGER NOT NULL DEFAULT 0 CHECK (is_open IN (0, 1)),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((pickup_latitude IS NULL AND pickup_longitude IS NULL) OR
    (pickup_latitude IS NOT NULL AND pickup_longitude IS NOT NULL AND
      pickup_latitude BETWEEN -90 AND 90 AND pickup_longitude BETWEEN -180 AND 180))
) STRICT;
CREATE INDEX titoja_stores_catalog ON titoja_stores(is_published, category, created_at, id);

CREATE TABLE titoja_products (
  id TEXT PRIMARY KEY NOT NULL,
  store_id TEXT NOT NULL REFERENCES titoja_stores(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  price_cents INTEGER NOT NULL CHECK (price_cents BETWEEN 0 AND 10000000),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX titoja_products_store ON titoja_products(store_id, is_available, created_at, id);

CREATE TRIGGER titoja_store_establishment_only
BEFORE INSERT ON titoja_stores
WHEN COALESCE((SELECT role FROM titoja_profiles WHERE user_id = NEW.owner_id), '') <> 'establishment'
BEGIN SELECT RAISE(ABORT, 'store owner must have an establishment profile'); END;

CREATE TRIGGER titoja_store_owner_immutable
BEFORE UPDATE OF owner_id ON titoja_stores
WHEN NEW.owner_id <> OLD.owner_id
BEGIN SELECT RAISE(ABORT, 'store owner is immutable'); END;

CREATE TRIGGER titoja_product_store_immutable
BEFORE UPDATE OF store_id ON titoja_products
WHEN NEW.store_id <> OLD.store_id
BEGIN SELECT RAISE(ABORT, 'product store is immutable'); END;
