const express = require("express");
const router = express.Router();
const Stripe = require("stripe");
const supabase = require("../lib/supabase");
const { authenticateJWT } = require("../middleware/auth");
const { sendMail } = require("../lib/mailer");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const TRIAL_PRICE_ID = "price_1ToKspHTjUJCdbgvSu1udGJC"; // Starter monthly
const TRIAL_HOURS = 10;
const TRIAL_DAYS = 7;

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

const mapSubscriptionStatus = (stripeStatus) => {
  const statusMap = {
    active: "active",
    past_due: "past_due",
    canceled: "inactive",
    incomplete: "past_due",
    incomplete_expired: "inactive",
    trialing: "active",
    unpaid: "past_due",
  };
  return statusMap[stripeStatus] || "inactive";
};

const savePayment = async (data) => {
  const { error } = await supabase.from("payments").insert(data);
  if (error) console.error("Failed to save payment record:", error.message);
};

const sendPaymentEmail = async (clientId, planDetails, paymentType) => {
  const { data: clientData } = await supabase
    .from("clients")
    .select("name, email")
    .eq("id", clientId)
    .single();
  if (!clientData) return;
  const planName =
    planDetails.plan.charAt(0).toUpperCase() + planDetails.plan.slice(1);
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
        <a href="https://shorttrim.com/dashboard"
          style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
          Start creating →
        </a>
        <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
        <p style="color: #9CA3AF; font-size: 13px;">
          Need help? Reply to this email or chat with us at shorttrim.com.<br/>
          — The ShortMint team
        </p>
      </div>
    `,
  }).catch((err) => console.error("Payment email error:", err.message));
};

// POST /api/stripe/trial — start 7-day free trial
router.post("/trial", authenticateJWT, async (req, res) => {
  try {
    const client = req.client;

    // Block if already used trial
    if (client.has_used_trial) {
      return res.status(400).json({
        error:
          "You have already used your free trial. Please choose a plan to continue.",
      });
    }

    // Block if already on active subscription
    if (
      client.stripe_subscription_id &&
      client.subscription_status === "active"
    ) {
      return res.status(400).json({
        error: "You already have an active subscription.",
      });
    }

    // Create or reuse Stripe customer
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: client.email,
        name: client.name,
        metadata: { client_id: client.id },
      });
      customerId = customer.id;
      await supabase
        .from("clients")
        .update({
          stripe_customer_id: customerId,
        })
        .eq("id", client.id);
    }

    // Create Stripe checkout session with trial
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [{ price: TRIAL_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { is_trial: "true", client_id: client.id },
      },
      client_reference_id: client.id,
      success_url: `${process.env.FRONTEND_URL}/dashboard?trial=started`,
      cancel_url: `${process.env.FRONTEND_URL}/dashboard`,
      metadata: {
        price_id: TRIAL_PRICE_ID,
        payment_type: "subscription",
        is_trial: "true",
      },
    });

    return res.json({ checkout_url: session.url });
  } catch (err) {
    console.error("Trial checkout error:", err);
    return res.status(500).json({ error: "Failed to start trial." });
  }
});

// POST /api/stripe/checkout — direct subscription or one-time
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

    // If upgrading subscription — set old one to cancel at period end
    if (client.stripe_subscription_id && mode === "subscription") {
      try {
        await stripe.subscriptions.update(client.stripe_subscription_id, {
          cancel_at_period_end: true,
        });
        await supabase
          .from("clients")
          .update({
            subscription_cancel_at_period_end: true,
          })
          .eq("id", client.id);
        console.log(
          `Set old subscription ${client.stripe_subscription_id} to cancel at period end`,
        );
      } catch (err) {
        console.error("Failed to update old subscription:", err.message);
      }
    }

    const sessionConfig = {
      mode,
      payment_method_types: ["card"],
      line_items: [{ price: price_id, quantity: 1 }],
      client_reference_id: client.id,
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { price_id, payment_type: mode },
    };

    if (client.stripe_customer_id) {
      sessionConfig.customer = client.stripe_customer_id;
    } else {
      sessionConfig.customer_email = client.email;
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
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

    // ✅ checkout.session.completed
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const clientId = session.client_reference_id;
      const priceId = session.metadata?.price_id;
      const paymentType = session.metadata?.payment_type;
      const isTrial = session.metadata?.is_trial === "true";
      const planDetails = PLAN_MAP[priceId];

      if (!planDetails) {
        console.error("Unknown price_id:", priceId);
        return res.json({ received: true });
      }

      // Idempotency check
      const { data: existing } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_session_id", session.id)
        .maybeSingle();

      if (existing) {
        console.log("Duplicate checkout event ignored:", session.id);
        return res.json({ received: true });
      }

      const now = new Date();

      if (paymentType === "payment") {
        // One-time — additive, never touch subscription fields
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
          })
          .eq("id", clientId);

        await savePayment({
          client_id: clientId,
          stripe_session_id: session.id,
          stripe_payment_intent_id: session.payment_intent,
          stripe_customer_id: session.customer,
          amount: session.amount_total,
          currency: session.currency,
          status: "paid",
          plan: planDetails.plan,
          plan_type: "one_time",
          hours_granted: planDetails.hours,
          event_type: "checkout.session.completed",
        });

        await sendPaymentEmail(clientId, planDetails, paymentType);
        console.log(
          `One-time: ${clientId} — ${planDetails.plan} — ${newLimit.toFixed(2)}hrs total`,
        );
      } else if (isTrial) {
        // Trial subscription — grant hours immediately, no charge yet
        const stripeSubscription = await stripe.subscriptions.retrieve(
          session.subscription,
        );
        const trialEnd = new Date(stripeSubscription.trial_end * 1000);
        const periodEnd = new Date(
          stripeSubscription.current_period_end * 1000,
        );
        const periodStart = new Date(
          stripeSubscription.current_period_start * 1000,
        );

        await supabase
          .from("clients")
          .update({
            plan: "starter",
            plan_type: "subscription",
            subscription_status: "active",
            usage_hours_limit: TRIAL_HOURS,
            usage_hours_used: 0,
            plan_started_at: now.toISOString(),
            plan_expires_at: periodEnd.toISOString(),
            current_period_start: periodStart.toISOString(),
            current_period_end: periodEnd.toISOString(),
            stripe_subscription_id: session.subscription,
            stripe_customer_id: session.customer,
            subscription_cancel_at_period_end: false,
            has_used_trial: true,
            trial_ends_at: trialEnd.toISOString(),
          })
          .eq("id", clientId);

        // No payment record — no charge yet
        // Send trial started email
        const { data: clientData } = await supabase
          .from("clients")
          .select("name, email")
          .eq("id", clientId)
          .single();

        if (clientData) {
          sendMail({
            to: clientData.email,
            subject: "Your ShortMint free trial has started 🎉",
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
                <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Your free trial is active!</h1>
                <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                  Hi ${clientData.name}, your 7-day free trial has started. You have <strong>10 hours</strong> to use — no charge until ${trialEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.
                </p>
                <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                  If you cancel before ${trialEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}, you won't be charged anything.
                </p>
                <a href="https://shorttrim.com/dashboard"
                  style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                  Start creating →
                </a>
                <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
                <p style="color: #9CA3AF; font-size: 13px;">
                  — The ShortMint team
                </p>
              </div>
            `,
          }).catch((err) => console.error("Trial email error:", err.message));
        }

        console.log(
          `Trial started: ${clientId} — 10hrs — trial ends ${trialEnd.toISOString()}`,
        );
      } else {
        // Direct subscription — no trial
        const stripeSubscription = await stripe.subscriptions.retrieve(
          session.subscription,
        );
        const periodStart = new Date(
          stripeSubscription.current_period_start * 1000,
        );
        const periodEnd = new Date(
          stripeSubscription.current_period_end * 1000,
        );

        const { data: currentClient } = await supabase
          .from("clients")
          .select("usage_hours_limit, usage_hours_used, stripe_subscription_id")
          .eq("id", clientId)
          .single();

        const currentLimit = parseFloat(currentClient?.usage_hours_limit || 0);
        const currentUsed = parseFloat(currentClient?.usage_hours_used || 0);
        const remainingHours = Math.max(currentLimit - currentUsed, 0);
        const isUpgrade = !!currentClient?.stripe_subscription_id;
        const newLimit = isUpgrade
          ? Math.min(planDetails.hours + remainingHours, planDetails.hours * 2)
          : planDetails.hours;

        await supabase
          .from("clients")
          .update({
            plan: planDetails.plan,
            plan_type: "subscription",
            subscription_status: "active",
            usage_hours_limit: newLimit,
            usage_hours_used: 0,
            plan_started_at: now.toISOString(),
            plan_expires_at: periodEnd.toISOString(),
            current_period_start: periodStart.toISOString(),
            current_period_end: periodEnd.toISOString(),
            stripe_subscription_id: session.subscription,
            stripe_customer_id: session.customer,
            subscription_cancel_at_period_end: false,
          })
          .eq("id", clientId);

        await savePayment({
          client_id: clientId,
          stripe_session_id: session.id,
          stripe_subscription_id: session.subscription,
          stripe_customer_id: session.customer,
          amount: session.amount_total,
          currency: session.currency,
          status: "paid",
          plan: planDetails.plan,
          plan_type: "subscription",
          hours_granted: planDetails.hours,
          event_type: "checkout.session.completed",
        });

        await sendPaymentEmail(clientId, planDetails, paymentType);
        console.log(
          `Subscription: ${clientId} — ${planDetails.plan} — ${newLimit}hrs`,
        );
      }
    }

    // ✅ invoice.paid — handles both trial conversion and monthly renewal
    if (event.type === "invoice.paid") {
      const invoice = event.data.object;
      const customerId = invoice.customer;
      const subscriptionId = invoice.subscription;

      // Handle trial conversion (billing_reason: subscription_cycle after trial)
      const isTrial =
        invoice.billing_reason === "subscription_create" &&
        invoice.amount_paid === 0;

      // Skip free trial invoice (no charge)
      if (isTrial) {
        console.log(`Trial invoice ignored (no charge): ${invoice.id}`);
        return res.json({ received: true });
      }

      // Only handle renewals and trial conversions with actual charge
      if (
        invoice.billing_reason !== "subscription_cycle" &&
        invoice.billing_reason !== "subscription_update"
      ) {
        return res.json({ received: true });
      }

      const { data: client } = await supabase
        .from("clients")
        .select("id, name, email")
        .eq("stripe_customer_id", customerId)
        .single();

      if (!client) return res.json({ received: true });

      // Idempotency check
      const { data: existingInvoice } = await supabase
        .from("payments")
        .select("id")
        .eq("stripe_invoice_id", invoice.id)
        .maybeSingle();

      if (existingInvoice) {
        console.log("Duplicate invoice event ignored:", invoice.id);
        return res.json({ received: true });
      }

      const stripeSubscription =
        await stripe.subscriptions.retrieve(subscriptionId);
      const periodStart = new Date(
        stripeSubscription.current_period_start * 1000,
      );
      const periodEnd = new Date(stripeSubscription.current_period_end * 1000);

      const priceId = stripeSubscription.items.data[0]?.price?.id;
      const planDetails = PLAN_MAP[priceId];
      if (!planDetails) return res.json({ received: true });

      // Check if this is trial converting to paid
      const isTrialConversion =
        invoice.billing_reason === "subscription_cycle" &&
        stripeSubscription.trial_end &&
        Math.abs(new Date(stripeSubscription.trial_end * 1000) - new Date()) <
          86400000 * 2;

      await supabase
        .from("clients")
        .update({
          plan: planDetails.plan,
          plan_type: "subscription",
          usage_hours_used: isTrialConversion ? 0 : 0, // always reset on billing
          usage_hours_limit: planDetails.hours,
          subscription_status: "active",
          plan_expires_at: periodEnd.toISOString(),
          current_period_start: periodStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          subscription_cancel_at_period_end: false,
          trial_ends_at: null, // clear trial end date
        })
        .eq("id", client.id);

      await savePayment({
        client_id: client.id,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: subscriptionId,
        stripe_customer_id: customerId,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        status: "paid",
        plan: planDetails.plan,
        plan_type: "subscription",
        hours_granted: planDetails.hours,
        event_type: isTrialConversion ? "trial_converted" : "invoice.paid",
      });

      const planName =
        planDetails.plan.charAt(0).toUpperCase() + planDetails.plan.slice(1);

      if (isTrialConversion) {
        // Trial converted to paid — send conversion email
        sendMail({
          to: client.email,
          subject: `Your ShortMint trial has converted — $29 charged`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
              <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Your trial has ended</h1>
              <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                Hi ${client.name}, your 7-day free trial has ended and your Starter plan subscription has started.
              </p>
              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 8px 0; color: #111827; font-weight: 600;">Billing summary</p>
                <p style="margin: 0; color: #6B7280; font-size: 14px;">Plan: <strong>Starter</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Amount charged: <strong>$${(invoice.amount_paid / 100).toFixed(2)}</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Hours: <strong>10 hours/month</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Next renewal: <strong>${periodEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</strong></p>
              </div>
              <a href="https://shorttrim.com/dashboard"
                style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                Continue creating →
              </a>
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
              <p style="color: #9CA3AF; font-size: 13px;">
                — The ShortMint team
              </p>
            </div>
          `,
        }).catch((err) =>
          console.error("Trial conversion email error:", err.message),
        );

        console.log(
          `Trial converted to paid: ${client.id} — $${(invoice.amount_paid / 100).toFixed(2)}`,
        );
      } else {
        // Regular renewal email
        sendMail({
          to: client.email,
          subject: `ShortMint ${planName} renewed 🔄`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
              <h1 style="color: #4F46E5; font-size: 24px; margin-bottom: 8px;">Your plan has renewed!</h1>
              <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                Hi ${client.name}, your <strong>${planName}</strong> plan has renewed and your hours have been reset.
              </p>
              <div style="background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px; margin: 24px 0;">
                <p style="margin: 0 0 8px 0; color: #111827; font-weight: 600;">Renewal summary</p>
                <p style="margin: 0; color: #6B7280; font-size: 14px;">Plan: <strong>${planName}</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Hours reset to: <strong>${planDetails.hours} hours</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Amount charged: <strong>$${(invoice.amount_paid / 100).toFixed(2)}</strong></p>
                <p style="margin: 4px 0 0 0; color: #6B7280; font-size: 14px;">Next renewal: <strong>${periodEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</strong></p>
              </div>
              <a href="https://shorttrim.com/dashboard"
                style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                Start creating →
              </a>
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
              <p style="color: #9CA3AF; font-size: 13px;">
                Need help? Reply to this email or chat with us at shorttrim.com.<br/>
                — The ShortMint team
              </p>
            </div>
          `,
        }).catch((err) => console.error("Renewal email error:", err.message));

        console.log(
          `Renewal: ${client.id} — ${planDetails.plan} — hours reset to ${planDetails.hours}`,
        );
      }
    }

    // ✅ invoice.payment_failed
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      if (!invoice.subscription) return res.json({ received: true });

      const customerId = invoice.customer;
      const { data: client } = await supabase
        .from("clients")
        .select("id, name, email")
        .eq("stripe_customer_id", customerId)
        .single();

      if (!client) return res.json({ received: true });

      await supabase
        .from("clients")
        .update({
          subscription_status: "past_due",
        })
        .eq("id", client.id);

      await savePayment({
        client_id: client.id,
        stripe_invoice_id: invoice.id,
        stripe_customer_id: customerId,
        amount: invoice.amount_due,
        currency: invoice.currency,
        status: "failed",
        plan_type: "subscription",
        event_type: "invoice.payment_failed",
        failure_reason: invoice.last_payment_error?.message || "Payment failed",
      });

      sendMail({
        to: client.email,
        subject: "Action needed — ShortMint payment failed",
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
            <h1 style="color: #EF4444; font-size: 22px; margin-bottom: 8px;">Payment failed</h1>
            <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
              Hi ${client.name}, we couldn't process your payment for ShortMint.
            </p>
            <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
              Please update your payment method to keep your account active.
              Stripe will retry automatically over the next few days.
            </p>
            <a href="https://shorttrim.com/settings"
              style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
              Update payment method →
            </a>
            <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
            <p style="color: #9CA3AF; font-size: 13px;">
              Need help? Reply to this email or chat with us at shorttrim.com.<br/>
              — The ShortMint team
            </p>
          </div>
        `,
      }).catch((err) =>
        console.error("Payment failed email error:", err.message),
      );

      sendMail({
        to: "hello@addmora.com",
        subject: `⚠️ Payment failed — ${client.email}`,
        html: `
          <div style="font-family: sans-serif; padding: 24px;">
            <h2 style="color: #EF4444;">Payment Failed</h2>
            <p><strong>User:</strong> ${client.name} (${client.email})</p>
            <p><strong>Amount:</strong> $${(invoice.amount_due / 100).toFixed(2)}</p>
            <p><strong>Reason:</strong> ${invoice.last_payment_error?.message || "Unknown"}</p>
          </div>
        `,
      }).catch((err) =>
        console.error("Admin payment failed email error:", err.message),
      );

      console.log(`Payment failed: ${client.id} — marked past_due`);
    }

    // ✅ customer.subscription.updated
    if (event.type === "customer.subscription.updated") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { data: client } = await supabase
        .from("clients")
        .select("id, stripe_subscription_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (!client) return res.json({ received: true });

      if (client.stripe_subscription_id !== subscription.id) {
        console.log(`Subscription updated event for old sub — ignoring`);
        return res.json({ received: true });
      }

      const periodEnd = new Date(subscription.current_period_end * 1000);
      const periodStart = new Date(subscription.current_period_start * 1000);

      await supabase
        .from("clients")
        .update({
          subscription_cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_start: periodStart.toISOString(),
          current_period_end: periodEnd.toISOString(),
          plan_expires_at: periodEnd.toISOString(),
          subscription_status: mapSubscriptionStatus(subscription.status),
        })
        .eq("id", client.id);

      console.log(
        `Subscription updated: ${client.id} — status: ${subscription.status}`,
      );
    }

    // ✅ customer.subscription.deleted
    if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      const customerId = subscription.customer;

      const { data: client } = await supabase
        .from("clients")
        .select("id, name, email, stripe_subscription_id")
        .eq("stripe_customer_id", customerId)
        .single();

      if (client) {
        if (client.stripe_subscription_id !== subscription.id) {
          console.log(`Old subscription deleted — ignoring`);
          return res.json({ received: true });
        }

        // Reset to no access — hours to 0
        await supabase
          .from("clients")
          .update({
            plan: "trial",
            plan_type: "one_time",
            subscription_status: "inactive",
            usage_hours_limit: 0,
            usage_hours_used: 0,
            stripe_subscription_id: null,
            plan_expires_at: null,
            current_period_start: null,
            current_period_end: null,
            subscription_cancel_at_period_end: false,
            trial_ends_at: null,
          })
          .eq("id", client.id);

        // Check if this was cancelled during trial
        const wasTrial =
          subscription.trial_end &&
          new Date(subscription.trial_end * 1000) > new Date();

        sendMail({
          to: client.email,
          subject: wasTrial
            ? "Your ShortMint trial has been cancelled"
            : "Your ShortMint subscription has ended",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
              <h1 style="color: #4F46E5; font-size: 22px; margin-bottom: 8px;">
                ${wasTrial ? "Trial cancelled" : "Subscription ended"}
              </h1>
              <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                Hi ${client.name}, ${
                  wasTrial
                    ? "your free trial has been cancelled. You have not been charged."
                    : "your ShortMint subscription has ended and your account has been moved back to the free tier."
                }
              </p>
              <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                We'd love to have you back. You can subscribe anytime.
              </p>
              <a href="https://shorttrim.com/pricing"
                style="display: inline-block; padding: 12px 28px; background: #4F46E5; color: white; text-decoration: none; border-radius: 10px; font-weight: 600; font-size: 15px;">
                View plans →
              </a>
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
              <p style="color: #9CA3AF; font-size: 13px;">
                — The ShortMint team
              </p>
            </div>
          `,
        }).catch((err) =>
          console.error("Cancellation email error:", err.message),
        );

        console.log(
          `Subscription deleted — ${client.id} — ${wasTrial ? "trial cancelled" : "downgraded"}`,
        );
      }
    }

    // ✅ charge.refunded
    if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const paymentIntentId = charge.payment_intent;
      const isFullRefund = charge.amount_refunded === charge.amount;

      if (paymentIntentId) {
        await supabase
          .from("payments")
          .update({ status: isFullRefund ? "refunded" : "partially_refunded" })
          .eq("stripe_payment_intent_id", paymentIntentId);

        const { data: paymentRecord } = await supabase
          .from("payments")
          .select("client_id")
          .eq("stripe_payment_intent_id", paymentIntentId)
          .maybeSingle();

        if (paymentRecord?.client_id) {
          const { data: clientData } = await supabase
            .from("clients")
            .select("name, email")
            .eq("id", paymentRecord.client_id)
            .single();

          if (clientData) {
            sendMail({
              to: clientData.email,
              subject: `ShortMint refund processed ✅`,
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
                  <h1 style="color: #4F46E5; font-size: 22px; margin-bottom: 8px;">Refund processed</h1>
                  <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                    Hi ${clientData.name}, your ${isFullRefund ? "full" : "partial"} refund of
                    <strong>$${(charge.amount_refunded / 100).toFixed(2)}</strong> has been processed.
                  </p>
                  <p style="color: #6B7280; font-size: 16px; line-height: 1.6;">
                    It may take 5–10 business days to appear on your statement depending on your bank.
                  </p>
                  <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 32px 0;" />
                  <p style="color: #9CA3AF; font-size: 13px;">
                    Questions? Reply to this email or chat with us at shorttrim.com.<br/>
                    — The ShortMint team
                  </p>
                </div>
              `,
            }).catch((err) =>
              console.error("Refund email error:", err.message),
            );
          }
        }

        console.log(
          `Refund recorded: ${isFullRefund ? "full" : "partial"} for ${paymentIntentId}`,
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

    const isOnTrial =
      client.trial_ends_at && new Date(client.trial_ends_at) > new Date();

    if (isOnTrial) {
      // Cancel immediately — user hasn't been charged
      await stripe.subscriptions.cancel(client.stripe_subscription_id);
      // DB will be updated by customer.subscription.deleted webhook
    } else {
      // Regular subscription — cancel at period end, keep access
      await stripe.subscriptions.update(client.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
      await supabase
        .from("clients")
        .update({
          subscription_cancel_at_period_end: true,
        })
        .eq("id", client.id);
    }

    return res.json({
      success: true,
      message: isOnTrial
        ? "Your trial has been cancelled. You will not be charged."
        : "Your subscription will be cancelled at the end of the billing period. You'll keep access until then.",
    });
  } catch (err) {
    console.error("Cancel subscription error:", err);
    return res.status(500).json({ error: "Failed to cancel subscription." });
  }
});

module.exports = router;
