# FreeAutoDetail.com

Vehicle acquisition platform for auto dealers. Local sellers get a full detail at no cost; if they sell or trade to a participating dealer within 30 days, the dealer pays for the detail plus a $150 referral fee.

## What's included

- `index.html` — full landing page: hero, how-it-works, auction-vs-FreeAutoDetail cost comparison, **Founding Partner signup**, dealer signup, and detail shop signup (with required liability insurance / business license attestations and the liability disclaimer), plus plain-English terms.
- `manifest.webmanifest`, `sw.js`, `offline.html`, and `icons/` — installable PWA shell with branded home-screen icons and an offline fallback.
- `server.js` — Express + SQLite backend with three signup endpoints and a simple admin readout.

## Run locally

```bash
npm install
node server.js
# open http://localhost:3000
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/signup/dealer` | Dealer application |
| POST | `/api/signup/detail-shop` | Detail shop application (rejects without insurance + license + terms) |
| POST | `/api/signup/founding-partner` | Founding Partner list — first notification when a detail completes |
| GET | `/api/admin/signups?key=ADMIN_KEY` | JSON dump of all signups |

Duplicate emails return `409`. All input is validated and length-limited server-side.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_KEY` | `change-me` | **Set this before deploying** |

Data is stored in `freeautodetail.db` (SQLite) next to `server.js`.

## Deploying

Works as-is on Railway, Render, Fly.io, or any Node host:

1. Push this folder to a Git repo.
2. Set `ADMIN_KEY` in the host's environment variables.
3. Start command: `node server.js`.
4. Use a persistent volume (or the host's disk) so `freeautodetail.db` survives restarts.

## Next steps you'll likely want

- Email notifications to Founding Partners when a detail completes (the table is ready; wire it to SendGrid/Postmark).
- Stripe card holds for the seller-side 30-day authorization.
- Document upload for shop insurance certificates and business licenses.
