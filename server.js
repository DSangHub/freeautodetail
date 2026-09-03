// FreeAutoDetail.com — signup backend
// Run: node server.js  (PORT and ADMIN_KEY via env)

const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me";

const db = new Database(path.join(__dirname, "freeautodetail.db"));
try {
  db.pragma("journal_mode = WAL"); // better concurrency where supported
} catch {
  db.pragma("journal_mode = DELETE"); // fallback for filesystems without WAL support
}

db.exec(`
CREATE TABLE IF NOT EXISTS dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealership_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  dealer_license TEXT,
  monthly_acquisitions TEXT,
  notes TEXT,
  founding_partner INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS detail_shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  full_detail_price TEXT,
  has_liability_insurance INTEGER NOT NULL,
  has_business_license INTEGER NOT NULL,
  insurance_carrier TEXT,
  license_number TEXT,
  accepted_terms INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS founding_partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  partner_type TEXT NOT NULL,       -- 'dealer' | 'detail_shop'
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  notify_radius_miles TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path === "/sw.js") res.setHeader("Cache-Control", "no-cache");
  next();
});
app.use(express.json());
app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/manifest.webmanifest", (req, res) => res.sendFile(path.join(__dirname, "manifest.webmanifest")));
app.get("/sw.js", (req, res) => res.sendFile(path.join(__dirname, "sw.js")));
app.get("/offline.html", (req, res) => res.sendFile(path.join(__dirname, "offline.html")));
app.use("/icons", express.static(path.join(__dirname, "icons"), { fallthrough: false }));

// ---------- helpers ----------
const clean = (v, max = 200) =>
  typeof v === "string" ? v.trim().slice(0, max) : "";
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhone = (v) => /^[\d\s().+-]{7,20}$/.test(v);

// ---------- messages (EN/ES) ----------
const MSG = {
  en: {
    dealershipRequired: "Dealership name is required.",
    businessRequired: "Business name is required.",
    shopRequired: "Shop name is required.",
    contactRequired: "Contact name is required.",
    emailInvalid: "Enter a valid email address.",
    phoneInvalid: "Enter a valid phone number.",
    cityStateRequired: "City and state are required.",
    addressRequired: "Full shop address is required.",
    insuranceRequired: "Liability insurance is required to participate.",
    licenseRequired: "A current business license is required to participate.",
    termsRequired: "You must accept the participation terms.",
    dupDealer: "That email is already registered as a dealer.",
    dupShop: "That email is already registered as a detail shop.",
    dupPartner: "That email is already on the Founding Partner list.",
    okDealer: "Dealer application received. We'll reach out within 2 business days.",
    okShop: "Shop application received. We'll verify your documents and reach out within 2 business days.",
    okPartner: "You're on the Founding Partner list. You'll get first notification when a detail completes in your area.",
  },
  es: {
    dealershipRequired: "El nombre del concesionario es obligatorio.",
    businessRequired: "El nombre del negocio es obligatorio.",
    shopRequired: "El nombre del taller es obligatorio.",
    contactRequired: "El nombre de contacto es obligatorio.",
    emailInvalid: "Ingrese un correo electr\u00f3nico v\u00e1lido.",
    phoneInvalid: "Ingrese un n\u00famero de tel\u00e9fono v\u00e1lido.",
    cityStateRequired: "La ciudad y el estado son obligatorios.",
    addressRequired: "La direcci\u00f3n completa del taller es obligatoria.",
    insuranceRequired: "Se requiere seguro de responsabilidad civil para participar.",
    licenseRequired: "Se requiere una licencia comercial vigente para participar.",
    termsRequired: "Debe aceptar los t\u00e9rminos de participaci\u00f3n.",
    dupDealer: "Ese correo ya est\u00e1 registrado como concesionario.",
    dupShop: "Ese correo ya est\u00e1 registrado como taller de detailing.",
    dupPartner: "Ese correo ya est\u00e1 en la lista de Socios Fundadores.",
    okDealer: "Solicitud de concesionario recibida. Nos comunicaremos en un plazo de 2 d\u00edas h\u00e1biles.",
    okShop: "Solicitud del taller recibida. Verificaremos sus documentos y nos comunicaremos en un plazo de 2 d\u00edas h\u00e1biles.",
    okPartner: "Ya est\u00e1 en la lista de Socios Fundadores. Recibir\u00e1 la primera notificaci\u00f3n cuando se complete un detailing en su zona.",
  },
};
const t = (req, key) => {
  const lang = (req.body && req.body.lang) === "es" ? "es" : "en";
  return MSG[lang][key];
};

function fail(res, message) {
  return res.status(400).json({ ok: false, message });
}
function dupe(res, message) {
  return res.status(409).json({ ok: false, message });
}

// ---------- dealer signup ----------
app.post("/api/signup/dealer", (req, res) => {
  const b = req.body || {};
  const row = {
    dealership_name: clean(b.dealershipName),
    contact_name: clean(b.contactName),
    email: clean(b.email).toLowerCase(),
    phone: clean(b.phone, 30),
    city: clean(b.city, 80),
    state: clean(b.state, 30),
    dealer_license: clean(b.dealerLicense, 60),
    monthly_acquisitions: clean(b.monthlyAcquisitions, 30),
    notes: clean(b.notes, 1000),
  };
  if (!row.dealership_name) return fail(res, t(req, "dealershipRequired"));
  if (!row.contact_name) return fail(res, t(req, "contactRequired"));
  if (!isEmail(row.email)) return fail(res, t(req, "emailInvalid"));
  if (!isPhone(row.phone)) return fail(res, t(req, "phoneInvalid"));
  if (!row.city || !row.state) return fail(res, t(req, "cityStateRequired"));
  try {
    db.prepare(
      `INSERT INTO dealers (dealership_name, contact_name, email, phone, city, state, dealer_license, monthly_acquisitions, notes)
       VALUES (@dealership_name, @contact_name, @email, @phone, @city, @state, @dealer_license, @monthly_acquisitions, @notes)`
    ).run(row);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return dupe(res, t(req, "dupDealer"));
    throw e;
  }
  res.json({ ok: true, message: t(req, "okDealer") });
});

// ---------- detail shop signup ----------
app.post("/api/signup/detail-shop", (req, res) => {
  const b = req.body || {};
  const row = {
    shop_name: clean(b.shopName),
    contact_name: clean(b.contactName),
    email: clean(b.email).toLowerCase(),
    phone: clean(b.phone, 30),
    address: clean(b.address, 200),
    city: clean(b.city, 80),
    state: clean(b.state, 30),
    full_detail_price: clean(b.fullDetailPrice, 30),
    has_liability_insurance: b.hasLiabilityInsurance ? 1 : 0,
    has_business_license: b.hasBusinessLicense ? 1 : 0,
    insurance_carrier: clean(b.insuranceCarrier, 120),
    license_number: clean(b.licenseNumber, 60),
    accepted_terms: b.acceptedTerms ? 1 : 0,
  };
  if (!row.shop_name) return fail(res, t(req, "shopRequired"));
  if (!row.contact_name) return fail(res, t(req, "contactRequired"));
  if (!isEmail(row.email)) return fail(res, t(req, "emailInvalid"));
  if (!isPhone(row.phone)) return fail(res, t(req, "phoneInvalid"));
  if (!row.address || !row.city || !row.state)
    return fail(res, t(req, "addressRequired"));
  if (!row.has_liability_insurance)
    return fail(res, t(req, "insuranceRequired"));
  if (!row.has_business_license)
    return fail(res, t(req, "licenseRequired"));
  if (!row.accepted_terms)
    return fail(res, t(req, "termsRequired"));
  try {
    db.prepare(
      `INSERT INTO detail_shops (shop_name, contact_name, email, phone, address, city, state, full_detail_price,
        has_liability_insurance, has_business_license, insurance_carrier, license_number, accepted_terms)
       VALUES (@shop_name, @contact_name, @email, @phone, @address, @city, @state, @full_detail_price,
        @has_liability_insurance, @has_business_license, @insurance_carrier, @license_number, @accepted_terms)`
    ).run(row);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return dupe(res, t(req, "dupShop"));
    throw e;
  }
  res.json({ ok: true, message: t(req, "okShop") });
});

// ---------- founding partner signup ----------
app.post("/api/signup/founding-partner", (req, res) => {
  const b = req.body || {};
  const row = {
    business_name: clean(b.businessName),
    partner_type: b.partnerType === "detail_shop" ? "detail_shop" : "dealer",
    contact_name: clean(b.contactName),
    email: clean(b.email).toLowerCase(),
    phone: clean(b.phone, 30),
    city: clean(b.city, 80),
    state: clean(b.state, 30),
    notify_radius_miles: clean(b.notifyRadiusMiles, 10),
  };
  if (!row.business_name) return fail(res, t(req, "businessRequired"));
  if (!row.contact_name) return fail(res, t(req, "contactRequired"));
  if (!isEmail(row.email)) return fail(res, t(req, "emailInvalid"));
  if (!isPhone(row.phone)) return fail(res, t(req, "phoneInvalid"));
  if (!row.city || !row.state) return fail(res, t(req, "cityStateRequired"));
  try {
    db.prepare(
      `INSERT INTO founding_partners (business_name, partner_type, contact_name, email, phone, city, state, notify_radius_miles)
       VALUES (@business_name, @partner_type, @contact_name, @email, @phone, @city, @state, @notify_radius_miles)`
    ).run(row);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return dupe(res, t(req, "dupPartner"));
    throw e;
  }
  res.json({ ok: true, message: t(req, "okPartner") });
});

// ---------- simple admin readout ----------
app.get("/api/admin/signups", (req, res) => {
  if (req.query.key !== ADMIN_KEY)
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  res.json({
    ok: true,
    dealers: db.prepare("SELECT * FROM dealers ORDER BY created_at DESC").all(),
    detail_shops: db.prepare("SELECT * FROM detail_shops ORDER BY created_at DESC").all(),
    founding_partners: db.prepare("SELECT * FROM founding_partners ORDER BY created_at DESC").all(),
  });
});

app.listen(PORT, () =>
  console.log(`FreeAutoDetail.com running on http://localhost:${PORT}`)
);
