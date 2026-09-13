const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Stripe = require("stripe");
const supabase = require("../lib/supabase");
const { authenticateAdmin } = require("../middleware/adminAuth");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// POST /api/admin/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    if (
      email !== process.env.ADMIN_EMAIL ||
      password !== process.env.ADMIN_PASSWORD
    ) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ admin: true, email }, process.env.ADMIN_JWT_SECRET, {
      expiresIn: "12h",
    });

    return res.json({ token });
  } catch (err) {
    console.error("Admin login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/stats
router.get("/stats", authenticateAdmin, async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: totalVideos },
      { data: revenueRows },
      { count: pendingPayouts },
      { data: commissionRows },
    ] = await Promise.all([
      supabase.from("clients").select("id", { count: "exact", head: true }),
      supabase.from("videos").select("id", { count: "exact", head: true }),
      supabase.from("payments").select("amount").eq("status", "paid"),
      supabase
        .from("affiliate_payouts")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase.from("affiliate_commissions").select("amount"),
    ]);

    const totalRevenue = (revenueRows || []).reduce(
      (sum, r) => sum + (r.amount || 0),
      0,
    );
    const totalCommissions = (commissionRows || []).reduce(
      (sum, c) => sum + parseFloat(c.amount || 0),
      0,
    );

    return res.json({
      total_users: totalUsers || 0,
      total_videos: totalVideos || 0,
      total_revenue_cents: totalRevenue,
      total_commissions: parseFloat(totalCommissions.toFixed(2)),
      pending_payouts: pendingPayouts || 0,
    });
  } catch (err) {
    console.error("Admin stats error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/users?page=1&q=search
router.get("/users", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;
    const q = req.query.q;

    let query = supabase
      .from("clients")
      .select("id, name, email, plan, plan_type, credit_hours, usage_hours_used, created_at, referred_by", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%`);

    const { data: users, count } = await query;
    return res.json({ users: users || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/videos?page=1
router.get("/videos", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { data: videos, count } = await supabase
      .from("videos")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ videos: videos || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin videos error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/revenue?page=1
router.get("/revenue", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { data: payments, count } = await supabase
      .from("payments")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ payments: payments || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin revenue error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/affiliates?page=1
router.get("/affiliates", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { data: affiliates, count } = await supabase
      .from("affiliates")
      .select(
        "id, name, email, referral_code, stripe_account_status, payout_balance, total_earned, status, created_at",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ affiliates: affiliates || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin affiliates error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/commissions?page=1
router.get("/commissions", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { data: commissions, count } = await supabase
      .from("affiliate_commissions")
      .select(
        "id, event_type, month_number, commission_amount, status, created_at, affiliates(name, email)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ commissions: commissions || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin commissions error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/payouts?page=1
router.get("/payouts", authenticateAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 25;
    const offset = (page - 1) * limit;

    const { data: payouts, count } = await supabase
      .from("affiliate_payouts")
      .select("id, amount, status, created_at, affiliates(name, email, stripe_account_id)", {
        count: "exact",
      })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    return res.json({ payouts: payouts || [], total: count, page, limit });
  } catch (err) {
    console.error("Admin payouts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/affiliates/:id/suspend
router.post("/affiliates/:id/suspend", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from("affiliates")
      .update({ status: "suspended" })
      .eq("id", id);
    if (error) return res.status(500).json({ error: "Failed to suspend affiliate" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Admin suspend error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/affiliates/:id/unsuspend
router.post("/affiliates/:id/unsuspend", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from("affiliates")
      .update({ status: "active" })
      .eq("id", id);
    if (error) return res.status(500).json({ error: "Failed to unsuspend affiliate" });
    return res.json({ success: true });
  } catch (err) {
    console.error("Admin unsuspend error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/payouts/:id/approve
router.post("/payouts/:id/approve", authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: payout } = await supabase
      .from("affiliate_payouts")
      .select("*, affiliates(stripe_account_id, stripe_account_status)")
      .eq("id", id)
      .single();

    if (!payout) return res.status(404).json({ error: "Payout not found" });
    if (payout.status !== "pending")
      return res.status(400).json({ error: "Payout is not pending" });

    const stripeAccountId = payout.affiliates?.stripe_account_id;
    if (!stripeAccountId)
      return res.status(400).json({ error: "Affiliate has no Stripe account" });

    const amountCents = Math.round(parseFloat(payout.amount) * 100);

    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: "usd",
      destination: stripeAccountId,
      metadata: { payout_id: id },
    });

    await supabase
      .from("affiliate_payouts")
      .update({ status: "paid", stripe_transfer_id: transfer.id })
      .eq("id", id);

    return res.json({ success: true, transfer_id: transfer.id });
  } catch (err) {
    console.error("Admin payout approve error:", err);
    return res.status(500).json({ error: "Failed to process payout" });
  }
});

module.exports = router;
