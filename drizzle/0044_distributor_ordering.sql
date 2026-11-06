CREATE TABLE distributor_links (
  customer_id TEXT PRIMARY KEY REFERENCES wholesale_customers(id),
  token_hash TEXT UNIQUE,
  version INTEGER NOT NULL CHECK(version>0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE distributor_orders (
  order_id TEXT PRIMARY KEY REFERENCES wholesale_orders(id),
  customer_id TEXT NOT NULL REFERENCES wholesale_customers(id),
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  UNIQUE(customer_id,request_id)
);
