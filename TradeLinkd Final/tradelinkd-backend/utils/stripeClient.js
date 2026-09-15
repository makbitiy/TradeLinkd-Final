const Stripe = require('stripe');

let stripe = null;

// Only initializes when actually needed (not at server startup), so the app
// still runs fine locally without Stripe configured - billing routes will
// just return a clear error until STRIPE_SECRET_KEY is set.
function getStripe() {
  if (stripe) return stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error('Payments are not configured on this server yet.');
    err.status = 503;
    throw err;
  }
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}

module.exports = { getStripe };
