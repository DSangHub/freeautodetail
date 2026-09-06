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
const PREVIEW_CLAIM_FEE_CENTS = 2500;
const LEAD_ACCESS_FEE_CENTS = 12500;
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const ALERT_FROM_EMAIL = process.env.ALERT_FROM_EMAIL || "Free Auto Detail <alerts@freeautodetail.com>";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || "";

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

function mileageBand(mileage) {
  if (!Number.isFinite(mileage)) return "Not provided";
  const floor = Math.floor(mileage / 10000) * 10000;
  return `${floor.toLocaleString()}–${(floor + 9999).toLocaleString()} miles`;
}

function htmlEscape(value) {
  return String(value || "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function sendEmailAlert(dealer, preview) {
  if (!RESEND_API_KEY || !dealer.email_alerts) return { channel: "email", status: "skipped" };
  const vehicle = `${preview.vehicle_year} ${preview.vehicle_make} ${preview.vehicle_model}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `preview-${preview.id}-dealer-${dealer.id}`,
    },
    body: JSON.stringify({
      from: ALERT_FROM_EMAIL,
      to: [dealer.email],
      subject: `Vehicle ready for detail: ${vehicle}`,
      html: `<h2>${htmlEscape(vehicle)} is ready for detail</h2><p>Area: ${htmlEscape(preview.city)}, ${htmlEscape(preview.state)}</p><p>No customer contact information is included. Sign in to claim the early preview for $25. A protected customer lead costs $125 separately.</p><p><a href="${PUBLIC_SITE_URL}/#dealer-portal">Open the Founding Dealer board</a></p>`,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Email alert failed.");
  return { channel: "email", status: "sent", providerId: data.id || null };
}

async function sendSmsAlert(dealer, preview) {
  if (!configured(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) ||
      (!TWILIO_FROM_NUMBER && !TWILIO_MESSAGING_SERVICE_SID) || !dealer.sms_alerts) {
    return { channel: "sms", status: "skipped" };
  }
  const form = new URLSearchParams({
    To: dealer.phone,
    Body: `${preview.vehicle_year} ${preview.vehicle_make} ${preview.vehicle_model} ready for detail near ${preview.city}, ${preview.state}. Claim preview $25; protected lead $125. ${PUBLIC_SITE_URL}/#dealer-portal Reply STOP to opt out.`,
  });
  if (TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", TWILIO_MESSAGING_SERVICE_SID);
  else form.set("From", TWILIO_FROM_NUMBER);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Text alert failed.");
  return { channel: "sms", status: "sent", providerId: data.sid || null };
}

async function alertFoundingDealers(preview) {
  const dealers = await supabase("founding_partners", {
    query: {
      select: "id,business_name,email,phone,email_alerts,sms_alerts",
      partner_type: "eq.dealer",
      approved: "is.true",
      state: `eq.${preview.state}`,
      order: "created_at.asc",
    },
  });
  for (const dealer of dealers) {
    for (const send of [sendEmailAlert, sendSmsAlert]) {
      let result;
      try {
        result = await send(dealer, preview);
      } catch (error) {
        result = { channel: send === sendEmailAlert ? "email" : "sms", status: "failed", error: error.message };
      }
      await supabase("dealer_alert_deliveries", {
        method: "POST",
        body: {
          vehicle_preview_id: preview.id,
          founding_partner_id: dealer.id,
          channel: result.channel,
          delivery_status: result.status,
          provider_message_id: result.providerId || null,
          error_message: result.error || null,
        },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
    }
  }
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
      if (session.payment_status === "paid" && session.metadata?.purchase_type === "preview_claim" && session.metadata?.claim_id) {
        await supabase("dealer_preview_claims", {
          method: "PATCH",
          query: { id: `eq.${session.metadata.claim_id}` },
          body: {
            payment_status: "paid",
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: session.payment_intent || null,
            paid_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        });
        if (session.metadata?.preview_id) {
          await supabase("vehicle_previews", {
            method: "PATCH",
            query: { id: `eq.${session.metadata.preview_id}`, status: "eq.open" },
            body: { status: "claimed" },
            prefer: "return=minimal",
          });
        }
      }
      if (session.payment_status === "paid" && session.metadata?.purchase_type === "seller_lead" && session.metadata?.access_id) {
        await supabase("dealer_lead_access", {
          method: "PATCH",
          query: { id: `eq.${session.metadata.access_id}` },
          body: {
            payment_status: "paid",
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: session.payment_intent || null,
            paid_at: new Date().toISOString(),
          },
          prefer: "return=minimal",
        });
        if (session.metadata?.preview_id) {
          await supabase("vehicle_previews", {
            method: "PATCH",
            query: { id: `eq.${session.metadata.preview_id}` },
            body: { status: "lead_sold" },
            prefer: "return=minimal",
          });
        }
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

app.get("/api/vehicle-previews", async (req, res) => {
  try {
    const previews = await supabase("vehicle_previews", {
      query: {
        select: "id,vehicle_year,vehicle_make,vehicle_model,mileage_band,vehicle_condition,city,state,status,posted_at,expires_at",
        status: "in.(open,claimed)",
        expires_at: `gt.${new Date().toISOString()}`,
        order: "posted_at.desc",
        limit: 50,
      },
    });
    res.json({
      ok: true,
      refreshedAt: new Date().toISOString(),
      previews: previews.map(preview => ({
        id: preview.id,
        vehicleYear: preview.vehicle_year,
        vehicleMake: preview.vehicle_make,
        vehicleModel: preview.vehicle_model,
        mileageBand: preview.mileage_band,
        vehicleCondition: preview.vehicle_condition,
        city: preview.city,
        state: preview.state,
        claimAvailability: preview.status === "open" ? "Available" : "Claims open",
        postedAt: preview.posted_at,
        expiresAt: preview.expires_at,
      })),
    });
  } catch (error) {
    apiError(res, error, "Unable to load the vehicle preview board.");
  }
});

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
    const previews = await supabase("vehicle_previews", {
      method: "POST",
      body: {
        seller_lead_id: saved.id,
        vehicle_year: lead.vehicle_year,
        vehicle_make: lead.vehicle_make,
        vehicle_model: lead.vehicle_model,
        mileage_band: mileageBand(lead.mileage),
        vehicle_condition: lead.vehicle_condition || null,
        sell_timeline: lead.sell_timeline || null,
        city: lead.city,
        state: lead.state,
      },
      prefer: "return=representation",
    });
    const preview = previews[0];
    try {
      await alertFoundingDealers(preview);
    } catch (alertError) {
      console.error("[seller/alerts]", alertError.message);
    }
    res.json({
      ok: true,
      message: "Your private information is secured in the Free Auto Detail vault. Only the vehicle type and general area were posted to the dealer preview board.",
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
      email_alerts: body.emailAlerts === true,
      sms_alerts: body.smsAlerts === true,
      alert_consent_at: body.smsAlerts === true ? new Date().toISOString() : null,
    };
    if (!row.business_name || !row.contact_name || !isEmail(row.email) || !isPhone(row.phone) || !row.city || !row.state) {
      return res.status(400).json({ ok: false, message: "Complete all required Founding Partner fields." });
    }
    if (row.partner_type === "dealer" && !row.email_alerts && !row.sms_alerts) {
      return res.status(400).json({ ok: false, message: "Choose email alerts, text alerts, or both." });
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
    const [previews, dealerClaims, dealerAccess, paidClaims] = await Promise.all([
      supabase("vehicle_previews", {
        query: {
          select: "id,seller_lead_id,vehicle_year,vehicle_make,vehicle_model,mileage_band,vehicle_condition,sell_timeline,city,state,status,posted_at,expires_at,max_claims",
          status: "in.(open,claimed,lead_sold)",
          expires_at: `gt.${new Date().toISOString()}`,
          order: "posted_at.desc",
          limit: 50,
        },
      }),
      supabase("dealer_preview_claims", {
        query: {
          select: "id,vehicle_preview_id,payment_status,claim_fee_cents,created_at",
          founding_partner_id: `eq.${dealer.id}`,
        },
      }),
      supabase("dealer_lead_access", {
        query: {
          select: "id,preview_claim_id,seller_lead_id,payment_status,lead_fee_cents,created_at",
          founding_partner_id: `eq.${dealer.id}`,
        },
      }),
      supabase("dealer_preview_claims", {
        query: { select: "vehicle_preview_id", payment_status: "eq.paid" },
      }),
    ]);
    const claimByPreview = new Map(dealerClaims.map(claim => [claim.vehicle_preview_id, claim]));
    const accessByClaim = new Map(dealerAccess.map(access => [access.preview_claim_id, access]));
    const claimCounts = paidClaims.reduce((counts, claim) => {
      counts.set(claim.vehicle_preview_id, (counts.get(claim.vehicle_preview_id) || 0) + 1);
      return counts;
    }, new Map());
    const paidSellerIds = dealerAccess.filter(access => access.payment_status === "paid").map(access => access.seller_lead_id);
    const sellers = paidSellerIds.length ? await supabase("seller_leads", {
      query: {
        select: "id,first_name,last_name,email,phone,zip_code,mileage,notes",
        id: `in.(${paidSellerIds.join(",")})`,
      },
    }) : [];
    const sellerById = new Map(sellers.map(seller => [seller.id, seller]));
    res.json({
      ok: true,
      dealer: dealer.business_name,
      leads: previews.map(preview => {
        const claim = claimByPreview.get(preview.id);
        const access = claim ? accessByClaim.get(claim.id) : null;
        const seller = access?.payment_status === "paid" ? sellerById.get(preview.seller_lead_id) : null;
        const claimsRemaining = Math.max(0, preview.max_claims - (claimCounts.get(preview.id) || 0));
        return {
          previewId: preview.id,
          claimId: claim?.id || null,
          claimStatus: claim?.payment_status || null,
          claimFeeCents: PREVIEW_CLAIM_FEE_CENTS,
          accessId: access?.id || null,
          leadStatus: access?.payment_status || null,
          leadFeeCents: LEAD_ACCESS_FEE_CENTS,
          claimsRemaining,
          city: preview.city,
          state: preview.state,
          vehicleYear: preview.vehicle_year,
          vehicleMake: preview.vehicle_make,
          vehicleModel: preview.vehicle_model,
          mileageBand: preview.mileage_band,
          vehicleCondition: preview.vehicle_condition,
          sellTimeline: preview.sell_timeline,
          postedAt: preview.posted_at,
          ...(seller ? {
            firstName: seller.first_name,
            lastName: seller.last_name,
            email: seller.email,
            phone: seller.phone,
            fullZipCode: seller.zip_code,
            mileage: seller.mileage,
            notes: seller.notes,
          } : {}),
        };
      }),
    });
  } catch (error) {
    apiError(res, error, error.status === 403 ? error.message : "Unable to load dealer leads.");
  }
});

app.post("/api/dealer/claim-checkout", async (req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) return res.status(503).json({ ok: false, message: "Payments are not configured yet." });
    const { dealer } = await requireDealer(req);
    const previewId = clean(req.body?.previewId, 80);
    const previews = await supabase("vehicle_previews", {
      query: {
        select: "id,vehicle_year,vehicle_make,vehicle_model,max_claims,status,expires_at",
        id: `eq.${previewId}`,
        limit: 1,
      },
    });
    const preview = previews[0];
    if (!preview || new Date(preview.expires_at) <= new Date()) return res.status(404).json({ ok: false, message: "Vehicle preview is no longer available." });
    const existing = await supabase("dealer_preview_claims", {
      query: { select: "id,claim_rank,payment_status", vehicle_preview_id: `eq.${preview.id}`, founding_partner_id: `eq.${dealer.id}`, limit: 1 },
    });
    if (existing[0]?.payment_status === "paid") return res.status(409).json({ ok: false, message: "You already claimed this preview." });
    const occupied = await supabase("dealer_preview_claims", {
      query: { select: "id,claim_rank", vehicle_preview_id: `eq.${preview.id}`, payment_status: "in.(checkout_pending,paid)", order: "claim_rank.asc" },
    });
    let claim = existing[0];
    if (!claim) {
      const used = new Set(occupied.map(item => item.claim_rank));
      const rank = [1, 2, 3].find(value => !used.has(value));
      if (!rank || occupied.length >= preview.max_claims) return res.status(409).json({ ok: false, message: "All early-preview claims have been taken." });
      const inserted = await supabase("dealer_preview_claims", {
        method: "POST",
        body: { vehicle_preview_id: preview.id, founding_partner_id: dealer.id, claim_rank: rank },
        prefer: "return=representation",
      });
      claim = inserted[0];
    }

    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(PREVIEW_CLAIM_FEE_CENTS),
      "line_items[0][price_data][product_data][name]": `Early preview claim — ${preview.vehicle_year} ${preview.vehicle_make} ${preview.vehicle_model}`,
      "line_items[0][quantity]": "1",
      success_url: `${PUBLIC_SITE_URL}/?preview_payment=success#dealer-portal`,
      cancel_url: `${PUBLIC_SITE_URL}/?preview_payment=cancelled#dealer-portal`,
      client_reference_id: claim.id,
      "metadata[purchase_type]": "preview_claim",
      "metadata[claim_id]": claim.id,
      "metadata[preview_id]": preview.id,
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
    await supabase("dealer_preview_claims", {
      method: "PATCH",
      query: { id: `eq.${claim.id}` },
      body: { stripe_checkout_session_id: session.id },
      prefer: "return=minimal",
    });
    res.json({ ok: true, url: session.url });
  } catch (error) {
    apiError(res, error, "Unable to start the $25 preview claim.");
  }
});

app.post("/api/dealer/lead-checkout", async (req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) return res.status(503).json({ ok: false, message: "Payments are not configured yet." });
    const { dealer } = await requireDealer(req);
    const claimId = clean(req.body?.claimId, 80);
    const claims = await supabase("dealer_preview_claims", {
      query: { select: "id,vehicle_preview_id,payment_status", id: `eq.${claimId}`, founding_partner_id: `eq.${dealer.id}`, limit: 1 },
    });
    const claim = claims[0];
    if (!claim || claim.payment_status !== "paid") return res.status(403).json({ ok: false, message: "Pay the $25 preview claim before purchasing the protected lead." });
    const previews = await supabase("vehicle_previews", {
      query: { select: "id,seller_lead_id,vehicle_year,vehicle_make,vehicle_model", id: `eq.${claim.vehicle_preview_id}`, limit: 1 },
    });
    const preview = previews[0];
    if (!preview) return res.status(404).json({ ok: false, message: "Vehicle preview not found." });
    const existing = await supabase("dealer_lead_access", {
      query: { select: "id,payment_status", preview_claim_id: `eq.${claim.id}`, limit: 1 },
    });
    if (existing[0]?.payment_status === "paid") return res.status(409).json({ ok: false, message: "This protected lead is already unlocked." });
    let access = existing[0];
    if (!access) {
      const inserted = await supabase("dealer_lead_access", {
        method: "POST",
        body: { preview_claim_id: claim.id, seller_lead_id: preview.seller_lead_id, founding_partner_id: dealer.id },
        prefer: "return=representation",
      });
      access = inserted[0];
    }
    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(LEAD_ACCESS_FEE_CENTS),
      "line_items[0][price_data][product_data][name]": `Protected seller lead — ${preview.vehicle_year} ${preview.vehicle_make} ${preview.vehicle_model}`,
      "line_items[0][quantity]": "1",
      success_url: `${PUBLIC_SITE_URL}/?lead_payment=success#dealer-portal`,
      cancel_url: `${PUBLIC_SITE_URL}/?lead_payment=cancelled#dealer-portal`,
      client_reference_id: access.id,
      "metadata[purchase_type]": "seller_lead",
      "metadata[access_id]": access.id,
      "metadata[preview_id]": preview.id,
      "metadata[dealer_id]": dealer.id,
    });
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const session = await stripeResponse.json();
    if (!stripeResponse.ok || !session.url) throw new Error(session.error?.message || "Stripe checkout failed.");
    await supabase("dealer_lead_access", {
      method: "PATCH",
      query: { id: `eq.${access.id}` },
      body: { stripe_checkout_session_id: session.id },
      prefer: "return=minimal",
    });
    res.json({ ok: true, url: session.url });
  } catch (error) {
    apiError(res, error, "Unable to start the secure $125 lead checkout.");
  }
});

app.get("/api/admin/signups", async (req, res) => {
  try {
    if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, message: "Unauthorized." });
    const [dealers, detailShops, foundingPartners, sellerLeads, vehiclePreviews, previewClaims, leadAccess, alertDeliveries] = await Promise.all([
      supabase("dealer_applications", { query: { select: "*", order: "created_at.desc" } }),
      supabase("detail_shop_applications", { query: { select: "*", order: "created_at.desc" } }),
      supabase("founding_partners", { query: { select: "*", order: "created_at.desc" } }),
      supabase("seller_leads", { query: { select: "*", order: "created_at.desc" } }),
      supabase("vehicle_previews", { query: { select: "*", order: "posted_at.desc" } }),
      supabase("dealer_preview_claims", { query: { select: "*", order: "created_at.desc" } }),
      supabase("dealer_lead_access", { query: { select: "*", order: "created_at.desc" } }),
      supabase("dealer_alert_deliveries", { query: { select: "*", order: "created_at.desc" } }),
    ]);
    res.json({ ok: true, dealers, detail_shops: detailShops, founding_partners: foundingPartners, seller_leads: sellerLeads, vehicle_previews: vehiclePreviews, preview_claims: previewClaims, lead_access: leadAccess, alert_deliveries: alertDeliveries });
  } catch (error) {
    apiError(res, error, "Unable to load signups.");
  }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`FreeAutoDetail.com running on http://localhost:${PORT}`));
}

module.exports = app;
