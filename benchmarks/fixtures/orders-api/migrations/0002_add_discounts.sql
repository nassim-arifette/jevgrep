-- 0002_add_discounts.sql
alter table orders
  add column if not exists discount_code text,
  add column if not exists discount_cents integer not null default 0;

create table if not exists discount_codes (
  code text primary key,
  percent integer not null check (percent between 0 and 30),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists discount_codes_expiry_idx on discount_codes (expires_at);
