const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { getStripe } = require('../utils/stripeClient');

const router = express.Router();

function requireContractor(req, res, next) {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'Subscriptions are only for contractor accounts.' });
  }
  next();
}

function baseUrl(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

// GET /api/billing/status - the current subscription status for the logged-in contractor
router.get('/status', requireAuth, requireContractor, (req, res) => {
  const user = db.prepare('SELECT subscription_status FROM users WHERE id = ?').get(req.user.id);
  res.json({ status: user.subscription_status });
});

// POST /api/billing/create-checkout-session - starts a Stripe Checkout flow for the
// monthly contractor subscription. Returns a URL to redirect the browser to.
router.post('/create-checkout-session', requireAuth, requireContractor, async (req, res) => {
  if (!process.env.STRIPE_PRICE_ID) {
    return res.status(503).json({ error: 'A subscription price has not been configured yet.' });
  }
  try {
    const stripe = getStripe();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { userId: String(user.id) }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${baseUrl(req)}/?billing=success`,
      cancel_url: `${baseUrl(req)}/?billing=cancel`,
      metadata: { userId: String(user.id) }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not start checkout.' });
  }
});

// POST /api/billing/create-portal-session - lets a subscribed contractor manage or
// cancel their subscription through Stripe's hosted billing portal.
router.post('/create-portal-session', requireAuth, requireContractor, async (req, res) => {
  try {
    const stripe = getStripe();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No subscription found for this account yet.' });
    }
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${baseUrl(req)}/`
    });
    res.json({ url: portalSession.url });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not open the billing portal.' });
  }
});

// Maps Stripe's subscription statuses down to a simple set the rest of the app uses.
function simplifyStatus(stripeStatus) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') return 'active';
  return 'inactive';
}

// POST /api/billing/webhook - Stripe calls this when subscription events happen.
// Mounted in server.js BEFORE the JSON body parser, since Stripe requires the raw
// request body to verify the signature.
async function webhookHandler(req, res) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[billing] STRIPE_WEBHOOK_SECRET is not set - cannot verify webhook.');
    return res.status(503).send('Webhook not configured.');
  }

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[billing] webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata && session.metadata.userId;
      if (userId) {
        db.prepare('UPDATE users SET stripe_subscription_id = ?, subscription_status = ? WHERE id = ?')
          .run(session.subscription, 'active', userId);
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const status = event.type === 'customer.subscription.deleted' ? 'inactive' : simplifyStatus(subscription.status);
      db.prepare('UPDATE users SET subscription_status = ? WHERE stripe_customer_id = ?')
        .run(status, subscription.customer);
    }
  } catch (err) {
    console.error('[billing] error handling webhook event:', err.message);
  }

  res.json({ received: true });
}

module.exports = { router, webhookHandler };
