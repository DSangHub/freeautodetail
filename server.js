// FreeAutoDetail.com — Supabase + Stripe lead backend
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, PUBLIC_SITE_URL, ADMIN_KEY

const crypto = require("crypto");
const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || "https://www.freeautodetail.com").replace(/\/$/, "");
const LEAD_FEE_CENTS = 2500;

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.path === "/sw.js") res.setHeader("Cache-Control", "no-cache");
  next();
});

function configured(...values) {
  return values.every(Boolean);
}

async function supabase(table, { method = "GET", query = {}, body, prefer } = {}) {
  if (!configured(SUPABASE_URL, SUPABASE_KEY)) {
    const error = new Error("Supabase is not configured.");
    error.status = 503;
    throw error;
  }
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || "Database request failed.");
    error.status = response.status;
    error.code = data?.code;
    throw error;
  }
  return data;
}

async function authRequest(route, { method = "POST", body, bearer } = {}) {
  if (!configured(SUPABASE_URL, SUPABASE_KEY)) {
    const error = new Error("Supabase Auth is not configured.");
    error.status = 503;
    throw error;
  }
  const response = await fetch(`${SUPABASE_URL}/auth/v1/${route}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${bearer || SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || data?.error_description || "Authentication request failed.");
    error.status = response.status;
    throw error;
  }
  return data;
}

const clean = (value, max = 200) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isPhone = value => /^[\d\s().+-]{7,20}$/.test(value);
const normalizeState = value => clean(value, 30).toUpperCase();
const numberOrNull = value => {
  const parsed = Number.parseInt(String(value || "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

function apiError(res, error, fallback = "Something went wrong. Please try again.") {
  console.error("[api]", { message: error.message, status: error.status, code: error.code });
  const duplicate = error.code === "23505";
  const status = duplicate ? 409 : (error.status >= 400 && error.status < 600 ? error.status : 500);
  res.status(status).json({ ok: false, message: duplicate ? "That email is already registered." : fallback });
}

async function requireDealer(req) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    const error = new Error("Sign in required.");
    error.status = 401;
    throw error;
  }
  const user = await authRequest("user", { method: "GET", bearer: token });
  const email = clean(user.email).toLowerCase();
  const partners = await supabase("founding_partners", {
    query: {
      select: "id,business_name,email,city,state,approved,partner_type,auth_user_id",
      email: `ilike.${email}`,
      partner_type: "eq.dealer",
      limit: 1,
    },
  });
  const dealer = partners?.[0];
  if (!dealer || !dealer.approved) {
    const error = new Error("This Founding Dealer account has not been approved.");
    error.status = 403;
    throw error;
  }
  if (!dealer.auth_user_id) {
    await supabase("founding_partners", {
      method: "PATCH",
      query: { id: `eq.${dealer.id}`, auth_user_id: "is.null" },
      body: { auth_user_id: user.id },
      prefer: "return=minimal",
    });
  } else if (dealer.auth_user_id !== user.id) {
    const error = new Error("This dealer email is linked to another account.");
    error.status = 403;
    throw error;
  }
  return { user, dealer };
}

// Stripe must receive the untouched request body for signature verification.
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!STRIPE_WEBHOOK_SECRET) return res.status(503).json({ ok: false });
    const header = req.headers["stripe-signature"] || "";
    const parts = Object.fromEntries(
      String(header).split(",").map(item => item.split("=", 2))
    );
    const timestamp = Number(parts.t);
    const expected = crypto
      .createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(`${parts.t}.`)
      .update(req.body)
      .digest("hex");
    const received = parts.v1 || "";
    const validLength = expected.length === received.length;
    const validSignature = validLength && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
    if (!validSignature || !timestamp || Math.abs(Date.now() / 1000 - timestamp) > 300) {
      return res.status(400).send("Invalid Stripe signature.");
    }

    const event = JSON.parse(req.body.toString("utf8"));
    const seen = await supabase("stripe_webhook_events", {
      query: { select: "stripe_event_id", stripe_event_id: `eq.${event.id}`, limit: 1 },
    });
    if (seen.length) return res.json({ received: true, duplicate: true });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      if (session.payment_status === "paid" && session.metadata?.match_id) {
        await supabase("dealer_lead_matches", {
          method: "PATCH",
          query: { id: `eq.${session.metadata.match_id}` },
          body: {
            payment_status: "paid",
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: session.payment_intent || null,
            paid_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        });
      }
    }
    await supabase("stripe_webhook_events", {
      method: "POST",
      body: { stripe_event_id: event.id, event_type: event.type },
      prefer: "return=minimal",
    });
    res.json({ received: true });
  } catch (error) {
    apiError(res, error, "Webhook processing failed.");
  }
});

app.use(express.json({ limit: "32kb" }));

app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/manifest.webmanifest", (req, res) => res.sendFile(path.join(__dirname, "manifest.webmanifest")));
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "sw.js")));
app.get("/offline.html", (req, res) => res.sendFile(path.join(__dirname, "offline.html")));
app.use("/icons", express.static(path.join(__dirname, "icons"), { fallthrough: false }));

app.post("/api/signup/seller", async (req, res) => {
  try {
    const body = req.body || {};
    if (clean(body.website)) return res.json({ ok: true, message: "Thank you." });
    const lead = {
      first_name: clean(body.firstName, 80),
      last_name: clean(body.lastName, 80),
      email: clean(body.email, 160).toLowerCase(),
      phone: clean(body.phone, 30),
      zip_code: clean(body.zipCode, 10),
      city: clean(body.city, 80),
      state: normalizeState(body.state),
      vehicle_year: numberOrNull(body.vehicleYear),
      vehicle_make: clean(body.vehicleMake, 80),
      vehicle_model: clean(body.vehicleModel, 80),
      mileage: numberOrNull(body.mileage),
      vehicle_condition: clean(body.vehicleCondition, 80),
      sell_timeline: clean(body.sellTimeline, 80),
      notes: clean(body.notes, 1000),
      consent_to_contact: body.consentToContact === true,
    };
    if (!lead.first_name || !lead.last_name || !isEmail(lead.email) || !isPhone(lead.phone)) {
      return res.status(400).json({ ok: false, message: "Enter your name, valid email, and valid phone number." });
    }
    if (!lead.zip_code || !lead.city || !lead.state || !lead.vehicle_year || !lead.vehicle_make || !lead.vehicle_model) {
      return res.status(400).json({ ok: false, message: "Enter your location and vehicle year, make, and model." });
    }
    if (!lead.consent_to_contact) {
      return res.status(400).json({ ok: false, message: "Consent to dealer contact is required." });
    }

    const inserted = await supabase("seller_leads", {
      method: "POST",
      body: lead,
      prefer: "return=representation",
    });
    const saved = inserted[0];
    const candidates = await supabase("founding_partners", {
      query: {
        select: "id,city,created_at",
        partner_type: "eq.dealer",
        approved: "is.true",
        state: `eq.${lead.state}`,
        order: "created_at.asc",
        limit: 25,
      },
    });
    const ranked = candidates
      .sort((a, b) => Number(b.city.toLowerCase() === lead.city.toLowerCase()) - Number(a.city.toLowerCase() === lead.city.toLowerCase()))
      .slice(0, 3);
    if (ranked.length) {
      await supabase("dealer_lead_matches", {
        method: "POST",
        body: ranked.map((dealer, index) => ({
          seller_lead_id: saved.id,
          founding_partner_id: dealer.id,
          match_rank: index + 1,
          lead_fee_cents: LEAD_FEE_CENTS,
        })),
        prefer: "return=minimal",
      });
      await supabase("seller_leads", {
        method: "PATCH",
        query: { id: `eq.${saved.id}` },
        body: { status: "matched" },
        prefer: "return=minimal",
      });
    }
    res.json({
      ok: true,
      message: ranked.length
        ? `Your vehicle was securely matched with ${ranked.length} Founding Dealer${ranked.length === 1 ? "" : "s"}.`
        : "Your vehicle is saved. We will match you when a Founding Dealer is approved in your area.",
    });
  } catch (error) {
    apiError(res, error, "We could not save your vehicle. Please try again.");
  }
});

app.post("/api/signup/dealer", async (req, res) => {
  try {
    const body = req.body || {};
    const row = {
      dealership_name: clean(body.dealershipName),
      contact_name: clean(body.contactName),
      email: clean(body.email).toLowerCase(),
      phone: clean(body.phone, 30),
      city: clean(body.city, 80),
      state: normalizeState(body.state),
      dealer_license: clean(body.dealerLicense, 60) || null,
      monthly_acquisitions: clean(body.monthlyAcquisitions, 30) || null,
      notes: clean(body.notes, 1000) || null,
    };
    if (!row.dealership_name || !row.contact_name || !isEmail(row.email) || !isPhone(row.phone) || !row.city || !row.state) {
      return res.status(400).json({ ok: false, message: "Complete all required dealer fields." });
    }
    await supabase("dealer_applications", { method: "POST", body: row, prefer: "return=minimal" });
    res.json({ ok: true, message: "Dealer application received. We'll reach out within 2 business days." });
  } catch (error) {
    apiError(res, error, "We could not save the dealer application.");
  }
});

app.post("/api/signup/detail-shop", async (req, res) => {
  try {
    const body = req.body || {};
    const row = {
      shop_name: clean(body.shopName),
      contact_name: clean(body.contactName),
      email: clean(body.email).toLowerCase(),
      phone: clean(body.phone, 30),
      address: clean(body.address),
      city: clean(body.city, 80),
      state: normalizeState(body.state),
      full_detail_price: clean(body.fullDetailPrice, 30) || null,
      has_liability_insurance: body.hasLiabilityInsurance === true,
      has_business_license: body.hasBusinessLicense === true,
      insurance_carrier: clean(body.insuranceCarrier, 120) || null,
      license_number: clean(body.licenseNumber, 60) || null,
      accepted_terms: body.acceptedTerms === true,
    };
    if (!row.shop_name || !row.contact_name || !isEmail(row.email) || !isPhone(row.phone) || !row.address || !row.city || !row.state) {
      return res.status(400).json({ ok: false, message: "Complete all required detail-shop fields." });
    }
    if (!row.has_liability_insurance || !row.has_business_license || !row.accepted_terms) {
      return res.status(400).json({ ok: false, message: "Insurance, licensing, and participation terms are required." });
    }
    await supabase("detail_shop_applications", { method: "POST", body: row, prefer: "return=minimal" });
    res.json({ ok: true, message: "Detail shop application received. We'll verify your documents and follow up." });
  } catch (error) {
    apiError(res, error, "We could not save the detail-shop application.");
  }
});

app.post("/api/signup/founding-partner", async (req, res) => {
  try {
    const body = req.body || {};
    const row = {
      business_name: clean(body.businessName),
      partner_type: body.partnerType === "detail_shop" ? "detail_shop" : "dealer",
      contact_name: clean(body.contactName),
      email: clean(body.email).toLowerCase(),
      phone: clean(body.phone, 30),
      city: clean(body.city, 80),
      state: normalizeState(body.state),
      notify_radius_miles: Math.min(250, Math.max(5, numberOrNull(body.notifyRadiusMiles) || 25)),
    };
    if (!row.business_name || !row.contact_name || !isEmail(row.email) || !isPhone(row.phone) || !row.city || !row.state) {
      return res.status(400).json({ ok: false, message: "Complete all required Founding Partner fields." });
    }
    await supabase("founding_partners", { method: "POST", body: row, prefer: "return=minimal" });
    res.json({ ok: true, message: "Founding Partner application received. Dealer lead access begins after approval." });
  } catch (error) {
    apiError(res, error, "We could not save the Founding Partner application.");
  }
});

app.post("/api/dealer/magic-link", async (req, res) => {
  try {
    const email = clean(req.body?.email, 160).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ ok: false, message: "Enter a valid email." });
    await authRequest("otp", {
      body: { email, create_user: true, options: { email_redirect_to: `${PUBLIC_SITE_URL}/#dealer-portal` } },
    });
    res.json({ ok: true, message: "If that email belongs to a Founding Dealer, check your inbox for the secure sign-in link." });
  } catch (error) {
    // Avoid revealing whether an email is registered.
    console.error("[dealer/magic-link]", error.message);
    res.json({ ok: true, message: "If that email belongs to a Founding Dealer, check your inbox for the secure sign-in link." });
  }
});

app.get("/api/dealer/leads", async (req, res) => {
  try {
    const { dealer } = await requireDealer(req);
    const matches = await supabase("dealer_lead_matches", {
      query: {
        select: "id,seller_lead_id,payment_status,lead_fee_cents,currency,created_at",
        founding_partner_id: `eq.${dealer.id}`,
        order: "created_at.desc",
      },
    });
    if (!matches.length) return res.json({ ok: true, dealer: dealer.business_name, leads: [] });
    const ids = matches.map(match => match.seller_lead_id).join(",");
    const leads = await supabase("seller_leads", {
      query: {
        select: "id,first_name,last_name,email,phone,zip_code,city,state,vehicle_year,vehicle_make,vehicle_model,mileage,vehicle_condition,sell_timeline,notes,created_at",
        id: `in.(${ids})`,
      },
    });
    const byId = new Map(leads.map(lead => [lead.id, lead]));
    res.json({
      ok: true,
      dealer: dealer.business_name,
      leads: matches.map(match => {
        const lead = byId.get(match.seller_lead_id);
        const paid = match.payment_status === "paid";
        return {
          matchId: match.id,
          paymentStatus: match.payment_status,
          leadFeeCents: match.lead_fee_cents,
          city: lead.city,
          state: lead.state,
          zipCode: lead.zip_code.slice(0, 3) + "**",
          vehicleYear: lead.vehicle_year,
          vehicleMake: lead.vehicle_make,
          vehicleModel: lead.vehicle_model,
          mileage: lead.mileage,
          vehicleCondition: lead.vehicle_condition,
          sellTimeline: lead.sell_timeline,
          createdAt: lead.created_at,
          ...(paid ? {
            firstName: lead.first_name,
            lastName: lead.last_name,
            email: lead.email,
            phone: lead.phone,
            fullZipCode: lead.zip_code,
            notes: lead.notes,
          } : {}),
        };
      }),
    });
  } catch (error) {
    apiError(res, error, error.status === 403 ? error.message : "Unable to load dealer leads.");
  }
});

app.post("/api/dealer/checkout", async (req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) return res.status(503).json({ ok: false, message: "Lead payments are not configured yet." });
    const { dealer } = await requireDealer(req);
    const matchId = clean(req.body?.matchId, 80);
    const matches = await supabase("dealer_lead_matches", {
      query: {
        select: "id,payment_status,lead_fee_cents,seller_lead_id",
        id: `eq.${matchId}`,
        founding_partner_id: `eq.${dealer.id}`,
        limit: 1,
      },
    });
    const match = matches[0];
    if (!match) return res.status(404).json({ ok: false, message: "Lead not found." });
    if (match.payment_status === "paid") return res.status(409).json({ ok: false, message: "This lead is already unlocked." });

    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(LEAD_FEE_CENTS),
      "line_items[0][price_data][product_data][name]": "Free Auto Detail seller lead",
      "line_items[0][quantity]": "1",
      success_url: `${PUBLIC_SITE_URL}/?lead_payment=success#dealer-portal`,
      cancel_url: `${PUBLIC_SITE_URL}/?lead_payment=cancelled#dealer-portal`,
      client_reference_id: match.id,
      "metadata[match_id]": match.id,
      "metadata[dealer_id]": dealer.id,
    });
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
    const session = await stripeResponse.json();
    if (!stripeResponse.ok || !session.url) throw new Error(session.error?.message || "Stripe checkout failed.");
    await supabase("dealer_lead_matches", {
      method: "PATCH",
      query: { id: `eq.${match.id}` },
      body: { payment_status: "checkout_pending", stripe_checkout_session_id: session.id },
      prefer: "return=minimal",
    });
    res.json({ ok: true, url: session.url });
  } catch (error) {
    apiError(res, error, "Unable to start the secure $25 checkout.");
  }
});

app.get("/api/admin/signups", async (req, res) => {
  try {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, message: "Unauthorized." });
    const [dealers, detailShops, foundingPartners, sellerLeads, leadMatches] = await Promise.all([
      supabase("dealer_applications", { query: { select: "*", order: "created_at.desc" } }),
      supabase("detail_shop_applications", { query: { select: "*", order: "created_at.desc" } }),
      supabase("founding_partners", { query: { select: "*", order: "created_at.desc" } }),
      supabase("seller_leads", { query: { select: "*", order: "created_at.desc" } }),
      supabase("dealer_lead_matches", { query: { select: "*", order: "created_at.desc" } }),
    ]);
    res.json({ ok: true, dealers, detail_shops: detailShops, founding_partners: foundingPartners, seller_leads: sellerLeads, lead_matches: leadMatches });
  } catch (error) {
    apiError(res, error, "Unable to load signups.");
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FreeAutoDetail.com running on http://localhost:${PORT}`));
}

module.exports = app;
