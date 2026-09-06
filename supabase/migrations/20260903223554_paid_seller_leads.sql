create table if not exists public.founding_partners (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  business_name text not null,
  partner_type text not null check (partner_type in ('dealer','detail_shop')),
  contact_name text not null,
  email text not null,
  phone text not null,
  city text not null,
  state text not null,
  dealer_license text,
  notify_radius_miles integer not null default 25 check (notify_radius_miles between 5 and 250),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists founding_partners_email_lower_idx on public.founding_partners (lower(email));
create index if not exists founding_partners_matching_idx on public.founding_partners (partner_type, approved, state, city);

create table if not exists public.seller_leads (
  id uuid primary key default gen_random_uuid(),
  first_name text not null, last_name text not null, email text not null, phone text not null,
  zip_code text not null, city text not null, state text not null,
  vehicle_year integer not null check (vehicle_year between 1900 and 2100),
  vehicle_make text not null, vehicle_model text not null,
  mileage integer check (mileage between 0 and 2000000),
  vehicle_condition text, sell_timeline text, notes text,
  status text not null default 'new' check (status in ('new','matched','closed','withdrawn')),
  consent_to_contact boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists seller_leads_matching_idx on public.seller_leads (status, state, city, created_at desc);

create table if not exists public.dealer_lead_matches (
  id uuid primary key default gen_random_uuid(),
  seller_lead_id uuid not null references public.seller_leads(id) on delete cascade,
  founding_partner_id uuid not null references public.founding_partners(id) on delete cascade,
  match_rank smallint not null check (match_rank between 1 and 3),
  lead_fee_cents integer not null default 2500 check (lead_fee_cents = 2500),
  currency text not null default 'usd' check (currency = 'usd'),
  payment_status text not null default 'locked' check (payment_status in ('locked','checkout_pending','paid','refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (seller_lead_id, founding_partner_id),
  unique (seller_lead_id, match_rank)
);
create index if not exists dealer_lead_matches_dealer_idx on public.dealer_lead_matches (founding_partner_id, created_at desc);
create index if not exists dealer_lead_matches_lead_idx on public.dealer_lead_matches (seller_lead_id, payment_status);

create table if not exists public.stripe_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

create table if not exists public.dealer_applications (
  id uuid primary key default gen_random_uuid(),
  dealership_name text not null, contact_name text not null, email text not null, phone text not null,
  city text not null, state text not null, dealer_license text, monthly_acquisitions text, notes text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create unique index if not exists dealer_applications_email_lower_idx on public.dealer_applications (lower(email));

create table if not exists public.detail_shop_applications (
  id uuid primary key default gen_random_uuid(),
  shop_name text not null, contact_name text not null, email text not null, phone text not null,
  address text not null, city text not null, state text not null, full_detail_price text,
  has_liability_insurance boolean not null, has_business_license boolean not null,
  insurance_carrier text, license_number text, accepted_terms boolean not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now()
);
create unique index if not exists detail_shop_applications_email_lower_idx on public.detail_shop_applications (lower(email));

alter table public.founding_partners enable row level security;
alter table public.seller_leads enable row level security;
alter table public.dealer_lead_matches enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.dealer_applications enable row level security;
alter table public.detail_shop_applications enable row level security;

revoke all on table public.founding_partners, public.seller_leads, public.dealer_lead_matches,
  public.stripe_webhook_events, public.dealer_applications, public.detail_shop_applications
  from anon, authenticated;
grant select, insert, update, delete on table public.founding_partners, public.seller_leads,
  public.dealer_lead_matches, public.stripe_webhook_events, public.dealer_applications,
  public.detail_shop_applications to service_role;
