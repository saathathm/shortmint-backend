const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
const supabase = require("../lib/supabase");
const { authenticateAffiliate } = require("../middleware/affiliateAuth");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// --- Crypto helpers (no bcrypt dependency) ---

const hashPassword = (password) =>
  new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString("hex");
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(`${salt}:${key.toString("hex")}`);
    });
  });

const verifyPassword = (password, stored) =>
  new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(key.toString("hex") === hash);
    });
  });

const generateCode = async () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = Array.from(crypto.randomBytes(8))
      .map((b) => chars[b % chars.length])
      .join("");
    const { data } = await supabase
      .from("affiliates")
      .select("id")
      .eq("referral_code", code)
      .maybeSingle();
    if (!data) return code;
  }
  throw new Error("Could not generate unique referral code");
};

const issueToken = (affiliate) =>
  jwt.sign(
    { id: affiliate.id, email: affiliate.email },
    process.env.AFFILIATE_JWT_SECRET,
    { expiresIn: "24h" },
  );

// POST /api/affiliate/register
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password are required" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    const { data: existing } = await supabase
      .from("affiliates")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (existing) return res.status(400).json({ error: "Email already registered" });

    const password_hash = await hashPassword(password);
    const referral_code = await generateCode();

    const { data: affiliate, error } = await supabase
      .from("affiliates")
      .insert({ name, email: email.toLowerCase(), password_hash, referral_code })
      .select()
      .single();
    if (error) return res.status(500).json({ error: "Registration failed" });

    return res.json({ token: issueToken(affiliate), affiliate: safeAffiliate(affiliate) });
  } catch (err) {
    console.error("Affiliate register error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/affiliate/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("*")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (!affiliate) return res.status(401).json({ error: "Invalid credentials" });
    if (affiliate.status === "suspended")
      return res.status(403).json({ error: "Account suspended" });

    const valid = await verifyPassword(password, affiliate.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    return res.json({ token: issueToken(affiliate), affiliate: safeAffiliate(affiliate) });
  } catch (err) {
    console.error("Affiliate login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/affiliate/me
router.get("/me", authenticateAffiliate, async (req, res) => {
  const { data: affiliate } = await supabase
    .from("affiliates")
    .select("*")
    .eq("id", req.affiliate.id)
    .single();
  if (!affiliate) return res.status(404).json({ error: "Affiliate not found" });
  return res.json({ affiliate: safeAffiliate(affiliate) });
});

// GET /api/affiliate/stats
router.get("/stats", authenticateAffiliate, async (req, res) => {
  try {
    const affiliateId = req.affiliate.id;

    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("referral_code, total_earned")
      .eq("id", affiliateId)
      .single();

    const { count: referralCount } = await supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("referred_by", affiliate.referral_code);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const cutoff = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

    const [{ data: monthCommissions }, { data: pendingCommissions }] = await Promise.all([
      supabase
        .from("affiliate_commissions")
        .select("commission_amount")
        .eq("affiliate_id", affiliateId)
        .gte("created_at", startOfMonth.toISOString()),
      supabase
        .from("affiliate_commissions")
        .select("commission_amount, created_at")
        .eq("affiliate_id", affiliateId)
        .eq("status", "pending"),
    ]);

    const monthEarned = (monthCommissions || []).reduce(
      (sum, c) => sum + parseFloat(c.commission_amount),
      0,
    );

    const available_balance = (pendingCommissions || [])
      .filter((c) => c.created_at <= cutoff)
      .reduce((sum, c) => sum + parseFloat(c.commission_amount), 0);

    const clearingCommissions = (pendingCommissions || []).filter((c) => c.created_at > cutoff);
    const clearing_balance = clearingCommissions.reduce(
      (sum, c) => sum + parseFloat(c.commission_amount),
      0,
    );

    const oldestClearing = clearingCommissions
      .map((c) => new Date(c.created_at))
      .sort((a, b) => a - b)[0];
    const next_available_at = oldestClearing
      ? new Date(oldestClearing.getTime() + 9 * 24 * 60 * 60 * 1000).toISOString()
      : null;

    return res.json({
      total_earned: parseFloat(affiliate.total_earned || 0),
      available_balance: parseFloat(available_balance.toFixed(2)),
      clearing_balance: parseFloat(clearing_balance.toFixed(2)),
      next_available_at,
      referral_count: referralCount || 0,
      month_earned: parseFloat(monthEarned.toFixed(2)),
    });
  } catch (err) {
    console.error("Affiliate stats error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/affiliate/commissions?page=1
router.get("/commissions", authenticateAffiliate, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const { data: commissions, count } = await supabase
      .from("affiliate_commissions")
      .select("id, event_type, month_number, commission_amount, status, created_at, client_id", {
        count: "exact",
      })
      .eq("affiliate_id", req.affiliate.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const anonymized = (commissions || []).map(({ client_id, event_type, ...rest }) => ({
      ...rest,
      commission_type: event_type,
      client_id: `User #${(client_id || "").slice(-4).toUpperCase()}`,
    }));

    return res.json({ commissions: anonymized, total: count, page, limit });
  } catch (err) {
    console.error("Affiliate commissions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/affiliate/payouts?page=1
router.get("/payouts", authenticateAffiliate, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const { data: payouts, count } = await supabase
      .from("affiliate_payouts")
      .select("*", { count: "exact" })
      .eq("affiliate_id", req.affiliate.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ payouts: payouts || [], total: count, page, limit });
  } catch (err) {
    console.error("Affiliate payouts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/affiliate/payout/request
router.post("/payout/request", authenticateAffiliate, async (req, res) => {
  try {
    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("stripe_account_status, payout_balance")
      .eq("id", req.affiliate.id)
      .single();

    if (!affiliate) return res.status(404).json({ error: "Affiliate not found" });
    if (affiliate.stripe_account_status !== "active")
      return res.status(400).json({ error: "Stripe Connect account must be active before requesting a payout" });

    const cutoff = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();

    const { data: eligibleCommissions } = await supabase
      .from("affiliate_commissions")
      .select("id, commission_amount")
      .eq("affiliate_id", req.affiliate.id)
      .eq("status", "pending")
      .lte("created_at", cutoff);

    const availableAmount = (eligibleCommissions || []).reduce(
      (sum, c) => sum + parseFloat(c.commission_amount),
      0,
    );

    if (availableAmount < 3)
      return res.status(400).json({
        error: "No eligible balance yet. Commissions are available 9 days after they are earned.",
      });

    const { data: payout, error: payoutErr } = await supabase
      .from("affiliate_payouts")
      .insert({ affiliate_id: req.affiliate.id, amount: parseFloat(availableAmount.toFixed(2)) })
      .select()
      .single();

    if (payoutErr || !payout)
      return res.status(500).json({ error: "Failed to create payout request" });

    const eligibleIds = eligibleCommissions.map((c) => c.id);
    await supabase
      .from("affiliate_commissions")
      .update({ status: "paid" })
      .in("id", eligibleIds);

    await supabase
      .from("affiliates")
      .update({ payout_balance: Math.max(0, parseFloat(affiliate.payout_balance || 0) - availableAmount) })
      .eq("id", req.affiliate.id);

    return res.json({ payout });
  } catch (err) {
    console.error("Payout request error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/affiliate/connect/onboard
router.get("/connect/onboard", authenticateAffiliate, async (req, res) => {
  try {
    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("email, stripe_account_id")
      .eq("id", req.affiliate.id)
      .single();

    let accountId = affiliate.stripe_account_id;

    const createAccountLink = async (acctId) => {
      return stripe.accountLinks.create({
        account: acctId,
        refresh_url: `${process.env.FRONTEND_URL}/affiliate/dashboard/payouts`,
        return_url: `${process.env.FRONTEND_URL}/affiliate/dashboard/payouts`,
        type: "account_onboarding",
      });
    };

    if (!accountId) {
      const account = await stripe.accounts.create({ type: "express", email: affiliate.email });
      accountId = account.id;
      await supabase
        .from("affiliates")
        .update({ stripe_account_id: accountId, stripe_account_status: "pending" })
        .eq("id", req.affiliate.id);
    }

    let accountLink;
    try {
      accountLink = await createAccountLink(accountId);
    } catch (linkErr) {
      // Stale account ID (e.g. test vs live mode mismatch) – recreate
      if (linkErr?.message?.includes("not connected to your platform") || linkErr?.message?.includes("does not exist")) {
        const account = await stripe.accounts.create({ type: "express", email: affiliate.email });
        accountId = account.id;
        await supabase
          .from("affiliates")
          .update({ stripe_account_id: accountId, stripe_account_status: "pending" })
          .eq("id", req.affiliate.id);
        accountLink = await createAccountLink(accountId);
      } else {
        throw linkErr;
      }
    }

    return res.json({ url: accountLink.url });
  } catch (err) {
    console.error("Stripe Connect onboard error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Failed to start Stripe onboarding" });
  }
});

// GET /api/affiliate/connect/status
router.get("/connect/status", authenticateAffiliate, async (req, res) => {
  try {
    const { data: affiliate } = await supabase
      .from("affiliates")
      .select("stripe_account_id, stripe_account_status")
      .eq("id", req.affiliate.id)
      .single();

    if (!affiliate.stripe_account_id) {
      return res.json({ connected: false, status: "not_connected" });
    }

    const account = await stripe.accounts.retrieve(affiliate.stripe_account_id);
    const isActive = account.charges_enabled && account.details_submitted;
    const newStatus = isActive ? "active" : "pending";

    if (newStatus !== affiliate.stripe_account_status) {
      await supabase
        .from("affiliates")
        .update({ stripe_account_status: newStatus })
        .eq("id", req.affiliate.id);
    }

    return res.json({
      connected: true,
      status: newStatus,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
    });
  } catch (err) {
    console.error("Stripe Connect status error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/affiliate/profile
router.patch("/profile", authenticateAffiliate, async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email.toLowerCase();

    if (!Object.keys(updates).length)
      return res.status(400).json({ error: "Nothing to update" });

    const { error } = await supabase
      .from("affiliates")
      .update(updates)
      .eq("id", req.affiliate.id);
    if (error) return res.status(500).json({ error: "Update failed" });

    return res.json({ success: true });
  } catch (err) {
    console.error("Affiliate profile update error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const safeAffiliate = (a) => {
  const { password_hash, ...rest } = a;
  return rest;
};

module.exports = router;
