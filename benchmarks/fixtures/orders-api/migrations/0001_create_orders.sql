-- 0001_create_orders.sql
create table if not exists orders (
  id uuid primary key,
  customer_id uuid not null,
  status text not null default 'pending',
  total_cents integer not null check (total_cents >= 0),
  currency char(3) not null default 'EUR',
  placed_at timestamptz not null default now()
);

create index if not exists orders_customer_idx on orders (customer_id, placed_at desc);

create table if not exists order_items (
  order_id uuid not null references orders (id) on delete cascade,
  sku text not null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  primary key (order_id, sku)
);
