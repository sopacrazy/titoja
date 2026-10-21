CREATE TABLE titoja_orders (
  id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL REFERENCES titoja_users(id) ON DELETE RESTRICT,
  worker_id TEXT REFERENCES titoja_users(id) ON DELETE RESTRICT,
  store_id TEXT REFERENCES titoja_stores(id) ON DELETE RESTRICT,
  store_owner_id TEXT REFERENCES titoja_users(id) ON DELETE RESTRICT,
  store_name TEXT,
  service TEXT NOT NULL CHECK (service IN ('moto','car','delivery','food','market','pharmacy','beer')),
  delivery_type TEXT CHECK (delivery_type IS NULL OR length(delivery_type) BETWEEN 2 AND 80),
  pickup_address TEXT NOT NULL CHECK (length(pickup_address) BETWEEN 5 AND 400),
  dropoff_address TEXT NOT NULL CHECK (length(dropoff_address) BETWEEN 5 AND 400),
  pickup_area TEXT NOT NULL CHECK (length(pickup_area) BETWEEN 2 AND 100),
  dropoff_area TEXT NOT NULL CHECK (length(dropoff_area) BETWEEN 2 AND 100),
  pickup_latitude REAL CHECK (pickup_latitude IS NULL OR pickup_latitude BETWEEN -90 AND 90),
  pickup_longitude REAL CHECK (pickup_longitude IS NULL OR pickup_longitude BETWEEN -180 AND 180),
  dropoff_latitude REAL CHECK (dropoff_latitude IS NULL OR dropoff_latitude BETWEEN -90 AND 90),
  dropoff_longitude REAL CHECK (dropoff_longitude IS NULL OR dropoff_longitude BETWEEN -180 AND 180),
  note TEXT NOT NULL CHECK (length(note) <= 1000),
  status TEXT NOT NULL CHECK (status IN ('requested','merchant_accepted','preparing','ready','assigned','heading_to_pickup','picked_up','in_transit','completed','cancelled','rejected')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 16 AND 80),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  payment_status TEXT NOT NULL DEFAULT 'simulated' CHECK (payment_status = 'simulated'),
  subtotal_cents INTEGER CHECK (subtotal_cents IS NULL OR subtotal_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (customer_id, request_id),
  CHECK ((pickup_latitude IS NULL) = (pickup_longitude IS NULL)),
  CHECK ((dropoff_latitude IS NULL) = (dropoff_longitude IS NULL)),
  CHECK (
    (service IN ('moto','car','delivery') AND store_id IS NULL AND store_owner_id IS NULL AND store_name IS NULL AND subtotal_cents IS NULL)
    OR (service IN ('food','market','pharmacy','beer') AND store_id IS NOT NULL AND store_owner_id IS NOT NULL AND store_name IS NOT NULL AND subtotal_cents IS NOT NULL)
  ),
  CHECK ((worker_id IS NULL AND status IN ('requested','merchant_accepted','preparing','ready','cancelled','rejected'))
    OR (worker_id IS NOT NULL AND status IN ('assigned','heading_to_pickup','picked_up','in_transit','completed')))
);
CREATE INDEX titoja_orders_customer ON titoja_orders(customer_id, created_at DESC);
CREATE INDEX titoja_orders_store_owner ON titoja_orders(store_owner_id, created_at DESC);
CREATE INDEX titoja_orders_worker ON titoja_orders(worker_id, created_at DESC);
CREATE INDEX titoja_orders_queue ON titoja_orders(status, service, created_at);
CREATE UNIQUE INDEX titoja_worker_one_active_order ON titoja_orders(worker_id)
  WHERE worker_id IS NOT NULL AND status IN ('assigned','heading_to_pickup','picked_up','in_transit');

CREATE TABLE titoja_order_items (
  order_id TEXT NOT NULL REFERENCES titoja_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES titoja_products(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents BETWEEN 0 AND 10000000),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents = unit_price_cents * quantity),
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE titoja_order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES titoja_orders(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES titoja_users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('client','courier','driver','establishment')),
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX titoja_order_events_order ON titoja_order_events(order_id, id);

CREATE TABLE titoja_order_locations (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES titoja_orders(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL REFERENCES titoja_users(id) ON DELETE RESTRICT,
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy REAL NOT NULL CHECK (accuracy BETWEEN 0 AND 1000000),
  updated_at TEXT NOT NULL
);

CREATE TABLE titoja_delivery_codes (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES titoja_orders(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  salt TEXT NOT NULL CHECK (length(salt) = 32),
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
