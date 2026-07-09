const express = require('express')
const router = express.Router()
const Stripe = require('stripe')
const supabase = require('../lib/supabase')
const { authenticateJWT } = require('../middleware/auth')

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

const PLAN_MAP = {
  // Replace with real Stripe price IDs
  price_starter: { plan: 'starter', hours: 10 },
  price_growth:  { plan: 'growth',  hours: 25 },
  price_pro:     { plan: 'pro',     hours: 60 },
}

// Create Stripe checkout session
router.post('/checkout', authenticateJWT, async (req, res) => {
  try {
    const { price_id } = req.body
    const client = req.client

    if (!price_id) return res.status(400).json({ error: 'price_id is required' })

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: price_id, quantity: 1 }],
      client_reference_id: client.id,
      customer_email: client.email,
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { price_id }
    })

    return res.json({ checkout_url: session.url })
  } catch (err) {
    console.error('Stripe checkout error:', err)
    return res.status(500).json({ error: 'Failed to create checkout session' })
  }
})

// Stripe webhook handler (raw body required for signature verification)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET)
  } catch (err) {
    console.error('Stripe webhook signature failed:', err.message)
    return res.status(400).json({ error: 'Webhook signature verification failed' })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const clientId = session.client_reference_id
    const priceId = session.metadata?.price_id

    const planDetails = PLAN_MAP[priceId]
    if (!planDetails) {
      console.error('Unknown price_id:', priceId)
      return res.json({ received: true })
    }

    const now = new Date()
    const expiresAt = new Date(now)
    expiresAt.setMonth(expiresAt.getMonth() + 1)

    const { error } = await supabase
      .from('clients')
      .update({
        plan: planDetails.plan,
        usage_hours_limit: planDetails.hours,
        usage_hours_used: 0,
        plan_started_at: now.toISOString(),
        plan_expires_at: expiresAt.toISOString(),
      })
      .eq('id', clientId)

    if (error) console.error('Failed to update client plan:', error.message)
    else console.log(`Plan updated for client ${clientId}: ${planDetails.plan}`)
  }

  return res.json({ received: true })
})

module.exports = router
