const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const supabase = require("../lib/supabase");
const { authenticateJWT } = require("../middleware/auth");
const { sendMail } = require("../lib/mailer");

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
        // One-time — fetch remaining hours and ADD to new plan hours
        const { data: currentClient } = await supabase
          .from("clients")
          .select("usage_hours_limit, usage_hours_used")
          .eq("id", clientId)
          .single();

        const currentLimit = parseFloat(currentClient?.usage_hours_limit || 0);
        const currentUsed = parseFloat(currentClient?.usage_hours_used || 0);
        const remainingHours = Math.max(currentLimit - currentUsed, 0);
        const newLimit = remainingHours + planDetails.hours;

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

        // Send payment confirmation email — fire and forget
        const { data: clientData } = await supabase
          .from("clients")
          .select("name, email")
          .eq("id", clientId)
          .single();

        if (clientData) {
          const planName =
            planDetails.plan.charAt(0).toUpperCase() +
            planDetails.plan.slice(1);
          const isOneTime = paymentType === "payment";

          sendMail({
            to: clientData.email,
            subject: `You're on ShortMint ${planName} 🎉`,
            html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Payment confirmed!</h1>
        <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
          Hi ${clientData.name}, your <strong>${planName}</strong> plan is now active.
        </p>
        <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin: 24px 0;">
          <p style="margin: 0 0 8px 0; color: #111827; font-weight: 600;">Plan summary</p>
          <p style="margin: 0; color: #6B7280; font-size: 14px;">Plan: <strong>${planName}</strong></p>
          <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Hours: <strong>${planDetails.hours} hours</strong></p>
          <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Type: <strong>${isOneTime ? "One-time purchase — hours never expire" : "Monthly subscription — renews automatically"}</strong></p>
        </div>
        <a href="https://shortmint.addmora.com/dashboard"
          style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
          Start creating →
        </a>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
        <p style="color: #9CA3AF; font-size: 13px;">
          Need help or have a payment issue? Reply to this email or chat with us at shortmint.addmora.com.<br/>
          — The ShortMint team
        </p>
      </div>
    `,
          }).catch((err) => console.error("Payment email error:", err.message));
        }

        console.log(
          `One-time purchase for ${clientId}: ${planDetails.plan} — ${planDetails.hours}hrs + ${remainingHours.toFixed(2)}hrs remaining = ${newLimit.toFixed(2)}hrs total`,
        );
      } else {
        // Subscription — clean reset, Stripe handles monetary proration
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
            subscription_cancel_at_period_end: false,
          })
          .eq("id", clientId);

        // Send payment confirmation email — fire and forget
        const { data: clientData } = await supabase
          .from("clients")
          .select("name, email")
          .eq("id", clientId)
          .single();

        if (clientData) {
          const planName =
            planDetails.plan.charAt(0).toUpperCase() +
            planDetails.plan.slice(1);
          const isOneTime = paymentType === "payment";

          sendMail({
            to: clientData.email,
            subject: `You're on ShortMint ${planName} 🎉`,
            html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
        <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Payment confirmed!</h1>
        <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
          Hi ${clientData.name}, your <strong>${planName}</strong> plan is now active.
        </p>
        <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin: 24px 0;">
          <p style="margin: 0 0 8px 0; color: #111827; font-weight: 600;">Plan summary</p>
          <p style="margin: 0; color: #6B7280; font-size: 14px;">Plan: <strong>${planName}</strong></p>
          <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Hours: <strong>${planDetails.hours} hours</strong></p>
          <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Type: <strong>${isOneTime ? "One-time purchase — hours never expire" : "Monthly subscription — renews automatically"}</strong></p>
        </div>
        <a href="https://shortmint.addmora.com/dashboard"
          style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
          Start creating →
        </a>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
        <p style="color: #9CA3AF; font-size: 13px;">
          Need help or have a payment issue? Reply to this email or chat with us at shortmint.addmora.com.<br/>
          — The ShortMint team
        </p>
      </div>
    `,
          }).catch((err) => console.error("Payment email error:", err.message));
        }

        console.log(
          `Subscription for ${clientId}: ${planDetails.plan} — clean ${planDetails.hours}hrs, Stripe handles proration`,
        );
      }
    }

    // Subscription cancelled at period end — fully deleted
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
            subscription_cancel_at_period_end: false,
          })
          .eq("id", client.id);

        console.log(
          `Subscription deleted — client ${client.id} downgraded to trial`,
        );
      }
    }

    // Subscription updated
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

    await supabase
      .from("clients")
      .update({
        subscription_cancel_at_period_end: true,
      })
      .eq("id", client.id);

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
