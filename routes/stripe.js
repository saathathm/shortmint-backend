const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const supabase = require("../lib/supabase");
const { authenticateJWT } = require("../middleware/auth");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PLAN_MAP = {
  price_1ToKspHTjUJCdbgvSu1udGJC: {
    plan: "starter",
    hours: 10,
    type: "subscription",
  },
  price_1TuQU2HTjUJCdbgvt51virST: {
    plan: "starter",
    hours: 10,
    type: "one_time",
  },
  price_1ToKu7HTjUJCdbgvcLG0Qni0: {
    plan: "growth",
    hours: 25,
    type: "subscription",
  },
  price_1TuQTQHTjUJCdbgvdlk1AiyS: {
    plan: "growth",
    hours: 25,
    type: "one_time",
  },
  price_1ToKuUHTjUJCdbgv7XRLSwIk: {
    plan: "pro",
    hours: 60,
    type: "subscription",
  },
  price_1TuQScHTjUJCdbgvYhlKeJqN: { plan: "pro", hours: 60, type: "one_time" },
};

// POST /api/stripe/checkout
router.post("/checkout", authenticateJWT, async (req, res) => {
  try {
    const { price_id, payment_type } = req.body;
    const client = req.client;

    if (!price_id)
      return res.status(400).json({ error: "price_id is required" });

    const planDetails = PLAN_MAP[price_id];
    if (!planDetails)
      return res.status(400).json({ error: "Invalid price ID" });

    const mode = payment_type === "one_time" ? "payment" : "subscription";

    const session = await stripe.checkout.sessions.create({
      mode,
      payment_method_types: ["card"],
      line_items: [{ price: price_id, quantity: 1 }],
      client_reference_id: client.id,
      customer_email: client.email,
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { price_id, payment_type: mode },
    });

    return res.json({ checkout_url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/stripe/webhook
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message);
      return res
        .status(400)
        .json({ error: "Webhook signature verification failed" });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const clientId = session.client_reference_id;
      const priceId = session.metadata?.price_id;
      const paymentType = session.metadata?.payment_type;

      const planDetails = PLAN_MAP[priceId];
      if (!planDetails) {
        console.error("Unknown price_id:", priceId);
        return res.json({ received: true });
      }

      const now = new Date();

      if (paymentType === "payment") {
        // One-time — ADD hours to existing balance
        const { data: currentClient } = await supabase
          .from("clients")
          .select("usage_hours_limit")
          .eq("id", clientId)
          .single();

        const currentLimit = parseFloat(currentClient?.usage_hours_limit || 0);
        const newLimit = currentLimit + planDetails.hours;

        await supabase
          .from("clients")
          .update({
            plan: planDetails.plan,
            plan_type: "one_time",
            usage_hours_limit: newLimit,
            plan_started_at: now.toISOString(),
            plan_expires_at: null,
            stripe_subscription_id: null,
          })
          .eq("id", clientId);
      } else {
        // Subscription — RESET hours
        const expiresAt = new Date(now);
        expiresAt.setMonth(expiresAt.getMonth() + 1);

        await supabase
          .from("clients")
          .update({
            plan: planDetails.plan,
            plan_type: "subscription",
            usage_hours_limit: planDetails.hours,
            usage_hours_used: 0,
            plan_started_at: now.toISOString(),
            plan_expires_at: expiresAt.toISOString(),
            stripe_subscription_id: session.subscription,
            stripe_customer_id: session.customer,
          })
          .eq("id", clientId);
      }

      console.log(
        `Plan updated for ${clientId}: ${planDetails.plan} (${paymentType})`,
      );
    }

    // Subscription cancelled
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { data: client } = await supabase
        .from("clients")
        .select("id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (client) {
        await supabase
          .from("clients")
          .update({
            plan: "trial",
            plan_type: "one_time",
            usage_hours_limit: 0.25,
            usage_hours_used: 0,
            stripe_subscription_id: null,
            plan_expires_at: null,
          })
          .eq("id", client.id);

        console.log(
          `Subscription cancelled — client ${client.id} downgraded to trial`,
        );
      }
    }

    // Subscription cancel_at_period_end set
    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      if (subscription.cancel_at_period_end) {
        console.log(
          `Subscription will cancel at period end: ${subscription.id}`,
        );
      }
    }

    return res.json({ received: true });
  },
);

// POST /api/stripe/cancel
router.post("/cancel", authenticateJWT, async (req, res) => {
  try {
    const client = req.client;

    if (!client.stripe_subscription_id) {
      return res.status(400).json({ error: "No active subscription found." });
    }

    await stripe.subscriptions.update(client.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    return res.json({
      success: true,
      message:
        "Your subscription will be cancelled at the end of the billing period. You'll keep access until then.",
    });
  } catch (err) {
    console.error("Cancel subscription error:", err);
    return res.status(500).json({ error: "Failed to cancel subscription." });
  }
});

module.exports = router;
