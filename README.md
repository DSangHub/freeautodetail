# FreeAutoDetail.com

Vehicle acquisition platform for auto dealers. Sellers submit a vehicle once and
are securely matched with up to three approved Founding Dealers.

## Lead flow

1. A seller submits contact, location, vehicle details, and contact consent.
2. The server saves the lead in Supabase.
3. Up to three approved Founding Dealers in the same state are matched, with
   same-city dealers ranked first.
4. Dealers sign in with a Supabase magic link and see a masked preview.
5. Stripe Checkout charges a $25 one-time lead fee.
6. A verified Stripe webhook unlocks the seller's contact details for that
   purchasing dealer only.

Seller PII is never queried directly from the browser. All public-schema tables
have RLS enabled, and direct `anon` and `authenticated` access is revoked.

## Included

- `index.html` — bilingual landing page, seller form, business applications,
  and Founding Dealer lead portal.
- `server.js` — Express API for Supabase persistence, dealer authentication,
  masked leads, Stripe Checkout, and webhook fulfillment.
- `supabase/migrations/` — reproducible lead and application schema.
- `manifest.webmanifest`, `sw.js`, `offline.html`, and `icons/` — PWA shell.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/signup/seller` | Save and match a seller lead |
| POST | `/api/signup/dealer` | Save a dealer application |
| POST | `/api/signup/detail-shop` | Save a detail-shop application |
| POST | `/api/signup/founding-partner` | Save a Founding Partner application |
| POST | `/api/dealer/magic-link` | Send secure dealer sign-in link |
| GET | `/api/dealer/leads` | Return masked or paid-unlocked dealer leads |
| POST | `/api/dealer/checkout` | Create the $25 Stripe Checkout |
| POST | `/api/stripe/webhook` | Verify payment and unlock a lead |
| GET | `/api/admin/signups?key=...` | Server-protected admin export |

## Configuration

| Environment variable | Required | Notes |
|---|---:|---|
| `SUPABASE_URL` | Yes | Free Auto Detail project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-only secret; never expose in HTML |
| `STRIPE_SECRET_KEY` | Yes | Server-only Stripe key |
| `STRIPE_WEBHOOK_SECRET` | Yes | Signing secret for the webhook endpoint |
| `PUBLIC_SITE_URL` | Yes | `https://www.freeautodetail.com` |
| `ADMIN_KEY` | Yes | Long random secret for the admin endpoint |
| `PORT` | No | Defaults to `3000` |

Add `https://www.freeautodetail.com/` to the Supabase Auth redirect allow list.
Register `https://www.freeautodetail.com/api/stripe/webhook` in Stripe for
`checkout.session.completed` events.

## Run locally

```bash
npm install
npm test
node server.js
```
