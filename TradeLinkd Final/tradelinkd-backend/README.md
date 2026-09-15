# TradeLinkd backend

Node.js + Express + SQLite backend for TradeLinkd.

## What changed in this version (big one)

**State-based location model (replacing county-only)**
- Everyone now selects a **State** at signup — a real dropdown, required,
  no typing needed. It shows on every profile and business page.
- **County is now optional**, a separate plain text field with no
  autocomplete (by design). A checkbox lets each person choose whether
  their county is shown publicly — if left unchecked, only their state
  shows on listings, though the county is still used internally so
  distance search still works for them.
- **Same-state-first sorting**: the job board, contractor directory, and
  contractor network all automatically sort so people in your own state
  appear first — no filter needed, this just happens.
- **"Filter by Distance" is now a deliberate action**, not a background
  filter box. Clicking it opens a small popup asking for a State
  (required), County (optional), and a distance — only then does the
  list narrow to people within that range. Nothing is filtered by
  location until you explicitly ask.
- Anyone can update their state/county/privacy setting later from "My
  Profile" or "My Business Page" — a new `PATCH /api/auth/me/location`
  endpoint handles this for both account types.

**County-based location, everywhere**
- Contractors now enter **"County, State"** at signup (e.g. "Macomb County, MI")
  instead of a city — matching what homeowners already do. This applies
  everywhere a contractor's location shows up: signup, their business page,
  and the "filter by county" search boxes homeowners/contractors use to find
  people nearby.
- **Real, government-sourced county data** — I pulled actual U.S. Census
  Bureau-derived county names and centroid coordinates (not typed from
  memory) for **1,094 counties across all 50 states + DC**. That's every
  major and mid-size county, covering the huge majority of the U.S.
  population. Full note: the U.S. has 3,143 counties/county-equivalents
  total: some very rural/low-population ones aren't in this bundled list.
  The search box still accepts typing *any* county name — it just won't
  offer a suggestion or precise distance-matching for one outside this set.
  Expanding this list further is possible if you want closer to full
  coverage — it's a plain array in `constants.js`.
- **Autocomplete behavior changed**: suggestions no longer pop up the
  instant you click into a county field — you now have to type at least 3
  characters first. This applies to every county search box on the site.
- **Distance filtering uses real math again**: with contractors now also
  using counties, "filter by distance" (job board, contractor directory,
  contractor network) calculates real mile distances between the two
  selected counties' actual centroid coordinates — not a rough guess.

**Login & accounts**
- No more usernames — accounts are identified by **email**. Log in with
  email + password.
- Password rules: 6+ characters, and at least one number or special
  character.
- Choosing a profile picture now opens a **popup** where you position the
  photo inside a circle before confirming.
- Homeowners now provide their **city** at signup (used to match them
  with contractors searching nearby) and no longer have a "show my phone
  publicly" option — their phone stays private; contact info happens
  through messaging instead.
- Contractors: several new trade categories (Property Restoration,
  Handyman, Demolition, Junk Removal, Pest Control, Locksmith, Pools),
  plus an "Other" option that reveals as many text boxes as they want to
  fill in. Service Area is now "Service Area/Counties" with the same
  growing-list behavior. The logo now comes before the bio (renamed
  "About Your Business"), everything's centered, and there's an optional
  work-photo upload right there in the signup form.

**The homeowner ↔ contractor relationship**
- **Contractors get zero access to the job board without an active
  subscription** — not just claiming, browsing itself is gated.
- Contractors never see a homeowner's contact info on a job post anymore.
  The old "Message Poster" and "I'll Take This Job" buttons are merged
  into one **"Send Message"** button — everything happens through
  messaging now. *(Note: this means the old claim/mark-complete flow for
  contractors has no UI trigger anymore, since claiming was removed —
  the backend endpoint still exists if you want it back later.)*
- Contractors filtering the job board by distance no longer type a city —
  it automatically uses **their own registered city** as the center
  point.
- Homeowners posting a job now see their **city as a fixed confirmation**
  (not a free-text field, since it's already on their account), can
  select **multiple trades needed**, and the budget field only accepts
  numbers, `$`, commas, and hyphens (so ranges like `200-400` work).

**Messaging**
- Now inbox-style: a search box (matches names or message text) and the
  ability to **pin** conversations to the top.

**Contractor network**
- Threads can now include up to 3 photos.

**Everywhere**
- Bolder background gradients and a subtle texture site-wide for more
  visual "pop," while keeping it clean.

## Database — schema changed again, delete your local database

This version restructures the `users` table (email replaces username,
city moves here from a contractor-only table) and adds new tables
(`job_trades`, `pinned_threads`, `network_post_photos`). **Delete your
local database before running this version:**

```bash
# with the server stopped, from inside tradelink-backend:
del db\homeconnect.db db\homeconnect.db-shm db\homeconnect.db-wal   (Windows)
rm db/homeconnect.db*                                                (Mac/Linux)
```

A fresh database is created automatically on next `npm start`.

## Setup

```bash
npm install
cp .env.example .env
# set JWT_SECRET; optionally SMTP_*, DATA_DIR, STRIPE_* (see below)
npm start
```

Visit `http://localhost:3001`.

## Contractor subscriptions (billing) — currently disabled

Payments are turned off for now — every contractor account has full,
free access to browsing and claiming jobs, no subscription required.
This was a deliberate call: no reason to ask contractors to pay before
the site has real traffic to offer them.

The Stripe integration itself is still here, just dormant — `routes/billing.js`,
`utils/stripeClient.js`, the `stripe` dependency, the database columns
tracking subscription status, and the webhook endpoint are all untouched.
Nothing in the UI links to any of it anymore, so it won't affect anyone
using the site. When you're ready to turn payments back on, the
"Setting up payments" steps from before still apply — you'd mainly need
to re-add the gating checks that were removed from `routes/jobs.js`
(`GET /` and `POST /:id/claim`) and the "Subscribe" UI on the business
page and job board, both of which are straightforward to restore.

## Password reset

Now supported — "Forgot Password?" on the login form emails a reset link
(valid 1 hour) using the same mailer as everything else. Requires
`SMTP_*` to be configured to actually deliver the email; without it, the
request still "succeeds" (for security, the response never reveals
whether an email exists) but no email goes out — check your terminal for
a `[mailer] SMTP not configured` note if you're testing this locally.

## Launch readiness — what this audit covered and what's still on you

This pass fixed one real bug (a couple of screens could show a raw
permission error instead of redirecting cleanly if your account type
didn't match the page — e.g. switching accounts mid-session) and added
password reset, which was a genuine gap: without it, anyone who forgot
their password would have been locked out for good.

I also re-checked every route for the access rules that matter here —
homeowners only ever seeing their own job posts, contractors blocked
from the customer-facing directory and from job posts without a
subscription, contractors never seeing a poster's contact info, business
page edits restricted to the owner, and so on. All of that checked out
correctly enforced on the server (not just hidden in the UI), which is
the part that actually matters for security.

What I can't verify from here, and what's still worth doing before real
users show up:

- **A real look in a browser.** I can't render the page myself, so a
  pass where you actually click through every form on desktop and mobile
  is worth doing before launch, even though the CSS patterns are
  consistent throughout.
- **HTTPS + real hosting** — walk through the Railway steps from earlier
  (or Render/Fly.io) if you haven't yet.
- **Stripe live mode** — right now this almost certainly points at
  Stripe's test mode. Switching to live keys requires verifying your
  business with Stripe first.
- **Email verification at signup** — right now anyone can sign up with
  any email address without confirming they own it. Not a security hole,
  but it means typos or fake addresses go unnoticed until someone tries
  to use "forgot password" or misses a message notification.
- **Terms of Service / Privacy Policy** — worth having before you're
  collecting real people's contact info and payments, even a simple one.
- **Resizing/compressing uploaded images** — currently stored as-is, up
  to 5MB each; could add up in storage costs at scale.
- **A geocoding API** if you need radius filtering to work for cities
  beyond the ~55 bundled in `constants.js`.
- Moving off SQLite to Postgres if you outgrow a single file.
- If you want contractors to be assignable to a specific job again (the
  old claim/complete flow), the backend endpoints are still there
  (`POST /api/jobs/:id/claim`, `POST /api/jobs/:id/complete`) — they just
  don't have a button in the UI anymore since "I'll Take This Job" was
  merged into "Send Message."
