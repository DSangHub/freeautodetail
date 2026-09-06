# FreeAutoDetail.com

Private seller-lead vault and local vehicle-preview marketplace for approved auto dealers.

## Seller and dealer flow

1. A seller submits contact, location, vehicle details, and consent.
2. The complete record is stored server-side in Supabase. It is never queried directly from the browser.
3. A separate safe preview posts the vehicle year, make, model, mileage band, condition, city, and state. It contains no name, phone, email, exact ZIP, exact mileage, or seller notes.
4. Approved Founding Dealers in the same state receive email and text alerts containing only safe preview information.
5. An approved dealer signs in with a Supabase magic link and may claim one of up to three early-preview positions for a one-time $25 Stripe payment.
6. The $25 claim never reveals customer contact information. The dealer may separately purchase the protected seller lead for $125.
7. Only a verified Stripe webhook marks the $125 purchase paid and releases that seller's contact information to that dealer.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/vehicle-previews` | Public safe vehicle-preview board |
| POST | `/api/signup/seller` | Save seller in the vault and create safe preview |
| POST | `/api/signup/dealer` | Dealer application |
| POST | `/api/signup/detail-shop` | Detail-shop application |
| POST | `/api/signup/founding-partner` | Founding Partner application and alert consent |
| POST | `/api/dealer/magic-link` | Secure dealer sign-in link |
| GET | `/api/dealer/leads` | Dealer preview, claim, and protected-lead state |
| POST | `/api/dealer/claim-checkout` | $25 early-preview claim checkout |
| POST | `/api/dealer/lead-checkout` | $125 protected-lead checkout |
| POST | `/api/stripe/webhook` | Verify payments and unlock the purchased tier |
| GET | `/api/admin/signups?key=...` | Server-protected admin export |

## Production environment variables

| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Free Auto Detail Supabase project URL |
| `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access |
| `STRIPE_SECRET_KEY` | Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `PUBLIC_SITE_URL` | `https://www.freeautodetail.com` |
| `RESEND_API_KEY` | Founding Dealer email alerts |
| `ALERT_FROM_EMAIL` | Verified Resend sender |
| `TWILIO_ACCOUNT_SID` | Founding Dealer text alerts |
| `TWILIO_AUTH_TOKEN` | Twilio server credential |
| `TWILIO_FROM_NUMBER` | Sending number; optional with a Messaging Service |
| `TWILIO_MESSAGING_SERVICE_SID` | Recommended alternative to `TWILIO_FROM_NUMBER` |
| `ADMIN_KEY` | Optional private admin-export key |

Register `https://www.freeautodetail.com/api/stripe/webhook` for `checkout.session.completed`. Add `https://www.freeautodetail.com/` to the Supabase Auth redirect allowlist. Verify `freeautodetail.com` in Resend before using `alerts@freeautodetail.com`.

## Security

All tables have RLS enabled. `anon` and `authenticated` have no direct table privileges. Every secret remains server-only. Dealer access is checked against an approved Founding Dealer row on every protected request.

## Local checks

```bash
npm install
npm test
npm start
```
