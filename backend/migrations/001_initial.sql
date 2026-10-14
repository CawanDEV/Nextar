CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE products (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 sku TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 unit TEXT NOT NULL DEFAULT 'un',
 quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
 min_quantity INTEGER NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
 price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE movements (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id UUID NOT NULL REFERENCES products(id),
 type TEXT NOT NULL CHECK (type IN ('in','out')),
 quantity INTEGER NOT NULL CHECK (quantity > 0),
 note TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX movements_created_at_idx ON movements(created_at DESC);
