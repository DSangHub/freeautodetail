alter table public.founding_partners
  add column if not exists email_alerts boolean not null default true,
  add column if not exists sms_alerts boolean not null default false,
  add column if not exists alert_consent_at timestamptz;

create table if not exists public.vehicle_previews (
  id uuid primary key default gen_random_uuid(),
  seller_lead_id uuid not null unique references public.seller_leads(id) on delete cascade,
  vehicle_year integer not null check (vehicle_year between 1900 and 2100),
  vehicle_make text not null,
  vehicle_model text not null,
  mileage_band text,
  vehicle_condition text,
  sell_timeline text,
  city text not null,
  state text not null,
  status text not null default 'open' check (status in ('open','claimed','lead_sold','closed')),
  max_claims smallint not null default 3 check (max_claims between 1 and 3),
  posted_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days')
);
create index if not exists vehicle_previews_board_idx
  on public.vehicle_previews (status, state, posted_at desc);

create table if not exists public.dealer_preview_claims (
  id uuid primary key default gen_random_uuid(),
  vehicle_preview_id uuid not null references public.vehicle_previews(id) on delete cascade,
  founding_partner_id uuid not null references public.founding_partners(id) on delete cascade,
  claim_rank smallint not null check (claim_rank between 1 and 3),
  claim_fee_cents integer not null default 2500 check (claim_fee_cents = 2500),
  currency text not null default 'usd' check (currency = 'usd'),
  payment_status text not null default 'checkout_pending'
    check (payment_status in ('checkout_pending','paid','refunded','cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (vehicle_preview_id, founding_partner_id),
  unique (vehicle_preview_id, claim_rank)
);
create index if not exists dealer_preview_claims_dealer_idx
  on public.dealer_preview_claims (founding_partner_id, created_at desc);

create table if not exists public.dealer_lead_access (
  id uuid primary key default gen_random_uuid(),
  preview_claim_id uuid not null unique references public.dealer_preview_claims(id) on delete cascade,
  seller_lead_id uuid not null references public.seller_leads(id) on delete cascade,
  founding_partner_id uuid not null references public.founding_partners(id) on delete cascade,
  lead_fee_cents integer not null default 12500 check (lead_fee_cents = 12500),
  currency text not null default 'usd' check (currency = 'usd'),
  payment_status text not null default 'checkout_pending'
    check (payment_status in ('checkout_pending','paid','refunded','cancelled')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (seller_lead_id, founding_partner_id)
);
create index if not exists dealer_lead_access_dealer_idx
  on public.dealer_lead_access (founding_partner_id, created_at desc);

create table if not exists public.dealer_alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  vehicle_preview_id uuid not null references public.vehicle_previews(id) on delete cascade,
  founding_partner_id uuid not null references public.founding_partners(id) on delete cascade,
  channel text not null check (channel in ('email','sms')),
  delivery_status text not null check (delivery_status in ('sent','failed','skipped')),
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now(),
  unique (vehicle_preview_id, founding_partner_id, channel)
);
create index if not exists dealer_alert_deliveries_preview_idx
  on public.dealer_alert_deliveries (vehicle_preview_id, created_at desc);

alter table public.vehicle_previews enable row level security;
alter table public.dealer_preview_claims enable row level security;
alter table public.dealer_lead_access enable row level security;
alter table public.dealer_alert_deliveries enable row level security;

revoke all on table public.vehicle_previews, public.dealer_preview_claims,
  public.dealer_lead_access, public.dealer_alert_deliveries
  from anon, authenticated;
grant select, insert, update, delete on table public.vehicle_previews,
  public.dealer_preview_claims, public.dealer_lead_access,
  public.dealer_alert_deliveries to service_role;
