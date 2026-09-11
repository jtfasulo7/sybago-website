# CLAUDE.md — Sybago Website

Persistent context for the Sybago site (sybago.ai). Read this before changing any page.

---

## BUSINESS MODEL (current)

Sybago is a **done-for-you customer acquisition system** for service businesses.

Core promise: **"We turn ad spend into booked jobs."**

Sybago is a **full-system provider, not an ads freelancer.** That complete-system framing is
the entire competitive advantage — lead with it on every page. Most competitors run ads and
hand over a lead list; Sybago runs the whole path from ad click to job on the calendar.

The four deliverables, and the only four:

1. **Meta (Facebook/Instagram) ads management** — creative, copy, campaigns, ongoing optimization.
2. **Conversion funnel / landing page** — built for the ad traffic, or optimization of the
   client's existing site so it converts paid traffic.
3. **Speed-to-lead on booking** — the instant a lead books, an automated SMS fires so they
   never go cold.
4. **Lead & job tracking** — via the client's own GHL (GoHighLevel) sub-account.

Client covers ad spend directly to Meta from an ad account **in their own name**. Sybago never
touches or marks up ad spend. Never state dollar figures for ad budgets on the site.

---

## EXPLICITLY RETIRED — do not reintroduce

The old **$297/mo flat-price "lead-follow-up foundation"** offer is dead, along with its
five-feature stack:

- ❌ Missed-call text-back
- ❌ Review automation
- ❌ Dead-lead / database reactivation
- ❌ "One inbox" five-feature framing
- ❌ The "five things that just work / boring on purpose" narrative
- ❌ The 30-day money-back guarantee (replaced by no-contracts / month-to-month / you-own-it
  risk reversal — a refund promise is a bad fit when the client is also spending on ads)

**Speed-to-lead on booking is the ONLY automation currently sold.**

Leftover media assets `media/feature-02-missed-call.mp4`, `feature-03-reviews.mp4`, and
`feature-04-dead-leads.mp4` are from the retired offer and must not be referenced. Only
`feature-01-website-sms.mp4` (speed-to-lead) and `feature-05-dashboard.mp4` (tracking) are in use.

---

## PRICING

**Never display pricing anywhere on the site.** No numbers, no ranges, no "starting at."
All pricing is handled on the call. Every page drives to the **Book A Call** CTA.

---

## BRAND & VOICE

- Same brand throughout: Sybago, same logo, same domain. This was a repositioning, not a rebrand.
- Voice: **blunt, anti-agency, confident, lightly funny, zero corporate fluff.** Short sentences.
  Speak the owner's language, not marketing language.
- Energy: momentum — "we get you customers / we fill the calendar." Not the old model's
  "boring foundation that just runs."
- **Solo founder framing is a real differentiator — keep it prominent.** JT Fasulo, mechanical
  engineer turned founder, one guy who actually answers his phone. No account managers.
- Founder photo: `media/jt.jpg`.

---

## PAGE ARCHITECTURE

**Main site — broad.** Speaks to service businesses generally, never niche-locked, so the door
stays open to any trade.

| Path | File | Notes |
|---|---|---|
| `/` | `index.html` | Full new-model homepage: hero → problem → 4-stage system → deliverables → 2 video features → trades → process → why → testimonial → results placeholder → FAQ → CTA → booking |
| `/about` | `about.html` | JT's story, why the whole system, risk reversal, values |
| `/contact-us` | `contact-us.html` | Form + SMS consent. Different (older, simpler) style block than the rest — leave its design alone |
| `/leave-a-review` | `leave-a-review.html` | **Do not modify** |
| `/privacy-policy` | `privacy-policy.html` | Carries the social-publishing disclosure — read the section below before editing |
| `/terms` | `terms.html` | Carries the social-publishing disclosure — read the section below before editing |
| `/dashboard` | `dashboard.html` | **Internal ads dashboard.** Password-gated, `noindex`. Deliberately breaks several site conventions — see below. Also hosts the Social post tab |

**FAQ lives inside `index.html` at `#faq`.** There is no separate FAQ page.

**`/pricing` was deleted.** `vercel.json` 308-redirects `/pricing`, `/pricing.html`,
`/services`, `/services.html` → `/`. Never link to it again.

### Ad landing pages — niche-specific, cold traffic

| Path | File |
|---|---|
| `/lp/junk-removal` (alias `/junk-removal`) | `lp/junk-removal.html` |
| `/lp/concrete` (alias `/concrete`) | `lp/concrete.html` |

These are targets for **Sybago's own Meta ads** when prospecting for clients. Rules:

- **One per niche**, self-contained, cloneable. `lp/junk-removal.html` is the reference
  template and carries full clone instructions in an HTML comment at the top of the file.
- Cold-traffic structure: hook → pain → mechanism → deliverables → risk reversal → founder →
  proof → FAQ → book. **Do not add site navigation** — no links out except legal in the footer.
  One message, one CTA.
- `noindex, follow` on purpose — paid pages shouldn't compete with the main site in search.
- Same brand and design system as the main site; only the copy changes per niche.
- To clone: copy the file to `lp/<niche>.html`, swap copy, update the booking iframe `id`
  suffix and every `data-utm` value.

---

## PROOF

Currently **one testimonial and no ad-campaign case study.** Lead on (1) founder credibility,
(2) the strength of the system/mechanism, (3) risk reversal.

The one real testimonial is from a **wholesale client** and was a **website build + inbound
interest** result. **Never frame it as an ad-campaign result.** Both pages that use it carry an
explicit honesty note saying so. Keep that note if the quote moves.

Every page has a **commented-out, drop-in-ready results/case-study section** near the bottom
(`.results-head` / `.results-grid` / `.result-card` / `.result-metric` styles already exist).
When real campaign numbers exist, uncomment and fill in — no redesign needed. Only real,
verifiable numbers go there.

---

## TECH CONVENTIONS

**Stack:** Plain static HTML. No framework, no build step, no `package.json`, no bundler.
Deployed on **Vercel** (`.vercel/project.json`).

**Routing:** `vercel.json` sets `cleanUrls: true` and `trailingSlash: false`, so `about.html`
serves at `/about` and `lp/junk-removal.html` at `/lp/junk-removal`. Redirects live in the same file.

**Styling:** Each page carries its **own complete `<style>` block in `<head>`.** There is no
shared stylesheet — this is intentional for a site this size. Design tokens are duplicated as
CSS custom properties on `:root` in every page:

```
--bg #ffffff   --bg-2 #f4f5f7   --bg-3 #eaecef
--t1 #0f1419   --t2/--t3/--t4 (rgba text tints)   --line
--teal #2F6779   --teal-b #3a7d93   --teal-d #244e5b
--warn #e8b04a   --good #4dbf7a
--ff 'Inter' (Google Fonts)   --eo cubic-bezier(.16,1,.3,1)
```

Class naming is flat and semantic (`.nav`, `.section`, `.eyebrow`, `.btn-primary`, `.why-card`,
`.pipe-card`, `.book-frame`). Breakpoints: 980 / 880 / 720 / 600 / 520 / 380px. Every stylesheet
ends with a `prefers-reduced-motion` block.

**Repeated components** are copy-pasted per page, not imported: fixed `.nav`, `.btn-primary` /
`.btn-secondary` with inline arrow SVG, `.close-cta` band, `.book-section`, four-column `.footer`.
When changing one, **change it on every page** — nothing is shared.

**Booking CTA + GHL widget (the critical pattern):**

- Every CTA is `<a href="#book" class="js-cta" data-utm="...">`.
- They anchor-scroll to `<section class="book-section" id="book">`, which holds the GHL iframe:
  `https://api.leadconnectorhq.com/widget/booking/FsCLXfMJ7yiiM7zMb2nP`
- The iframe `id` is `FsCLXfMJ7yiiM7zMb2nP_<page>` — suffix must be unique per page so bookings
  can be attributed.
- `https://api.leadconnectorhq.com/js/form_embed.js` loads before the page script.
- A small inline script reads `data-utm` and fires a GA4 `cta_click` event.
- **One conversion point per page.** No popups, no multi-page redirect, no second calendar.

**Analytics:** GA4 `G-0JK4JY6SRH`, inline gtag snippet at the top of `<head>` on every page.

**Chat widget:** `/assets/chat-widget.css` + `/assets/chat-widget.js` load at the bottom of the
main-site pages. **Deliberately omitted from ad landing pages** to keep them single-action.

**Serverless functions:** `api/contact.js`, `api/lead.js`, `api/review.js`,
`api/dashboard-login.js`, `api/meta-insights.js` (the last two are the internal dashboard —
see its section below).

**Known placeholders in the footers** (main site): `tel:[PHONE]` and `href="#"` social links —
still unfilled, marked with HTML comments.

---

## INTERNAL ADS DASHBOARD (/dashboard)

Private page showing live Meta ad performance for the Peps by Dave Skool sign-up
campaigns. Not linked from anywhere on the site.

**Files**

| File | Role |
|---|---|
| `dashboard.html` | The page. Login view + dashboard view in one document. |
| `api/dashboard-login.js` | Password -> signed httpOnly session cookie carrying a role. |
| `api/meta-insights.js` | Calls the Meta Insights API. The ONLY place the token is read. |
| `lib/auth.js` | HMAC cookie sign/verify. Node builtins only. |
| `test/dashboard.test.mjs` | `node test/dashboard.test.mjs` — no deps, no credentials, stubs Meta. |

**Two dashboards, two tiers of access**

| Password | Role in cookie | Sees |
|---|---|---|
| `DASHBOARD_PASSWORD` | `dave` | Dave's account only. No tab bar. |
| `DASHBOARD_MASTER_PASSWORD` | `master` | Both, via a tablist at the top of the page. |

- The browser sends a **view name** (`dave` / `sybago`), never an account id. The
  name-to-account map and the `masterOnly` flag live in the `VIEWS` registry in
  `api/meta-insights.js`. Accepting an account id from the query string would let the
  narrow session read any account the token can see — do not add one.
- The role is inside the **signed** cookie payload, so editing it client-side breaks the
  signature rather than granting access. `requireSession()` returns the session (or null),
  not a boolean, so authorisation is decided in one place.
- The tab bar is a convenience, not the control. It is hidden for a narrow session, and the
  server still returns 403 `forbidden_view` if that session asks for the agency view anyway.
- A missing `META_ADS_ACCOUNT_ID_SYBAGO` is a 500 naming the variable — never a silent
  fallback to Dave's account.
- Both passwords are compared before either result is used, and a deployment that sets them
  to the same string does **not** promote the standard password to master.

**Meta tokens — one or two**

**In this deployment the two dashboards read two UNRELATED Meta businesses.** Dave's ads run
in a business partner's Meta entity; Montara Forge runs under Fasulo Studio. There is no shared
business, so asset assignment cannot bridge them and `META_ADS_TOKEN_SYBAGO` is genuinely
required — it is not an optional convenience here.

A Meta token is scoped to a **user**, not to an ad account. One token reads every ad
account that user holds a role on, so two dashboards on two different ad accounts still
normally need only `META_ADS_TOKEN`. A second token is required only when the accounts
sit under Business Managers with no user in common.

Each view therefore names its token with a fallback (`tokenEnv` in the `VIEWS` registry):

| View | Token used |
|---|---|
| `dave` | `META_ADS_TOKEN_DAVE` if set, else `META_ADS_TOKEN` |
| `sybago` | `META_ADS_TOKEN_SYBAGO` if set, else `META_ADS_TOKEN` |

- `buildUrl()` takes the token as an argument. Do not make it read the environment
  again — which account is queried and which credential is used must be decided together.
- `scrubSecrets()` iterates `allTokens()`. **If you add another token variable, add it to
  a view's `tokenEnv`**, or it becomes the one credential the safety net does not catch.
- Responses carry `tokenSource` — the variable NAME only, never any part of the value.
- Every Meta error message names the variables for the view that failed, via the `env` option
  threaded through `fetchWithBackoff`. Do not hardcode `META_ADS_TOKEN` in an error string:
  telling someone to regenerate it when the agency token expired points them at a different
  company's credential.
- `?debug=accounts` (master only) asks for each view's ad account using the token that view
  would actually use, and returns a plain-language summary. Use it before concluding a second
  token is needed. It must probe the account DIRECTLY — an earlier version asked
  `/me/adaccounts` and called anything missing unreachable, which is wrong for a System User
  token: a System User is assigned assets rather than owning them, so that list comes back
  empty and every account looks broken, including ones actively serving data.

**The role is fixed at sign-in.** It is baked into the signed cookie, which lasts 12 hours.
Setting `DASHBOARD_MASTER_PASSWORD` does not upgrade a session that is already open —
sign out and sign back in with the master password, or the tab bar stays hidden.

**Theming**

- Every colour that differs between the two views is a token on `:root`, overridden wholesale
  in `:root[data-view="dave"]`. Sybago = the site palette, unchanged. Dave = gold on
  near-black with warm white (`#F6F2E8`) text — pure white glares on that ground.
- The accent is stored as an RGB triplet (`--accent-rgb`) so tints are
  `rgba(var(--accent-rgb), a)` and a palette swap is one line. Do not reintroduce
  pre-mixed `rgba(47,103,121,…)`.
- Inverting only the text tokens is not enough: `--surface-solid`, `--thead-bg`,
  `--nav-bg`, `--seg-track`, `--on-accent` and the `--lift-*` shadows all have to be
  restated, or the glass edges and sticky table head stay white.
- `--on-accent` exists because text on the gold accent must be dark; warm white on gold
  fails contrast.
- **Chart colours cannot be CSS custom properties** — Chart.js paints to a canvas, where
  `var()` does not resolve. They live in the `PALETTES` object in the page script. Black
  and gold offers little hue for six series, so separation there is luminance plus dash
  pattern, which is what has to carry it regardless.
- The login screen always forces the Sybago palette, so signing out of Dave's view does not
  leave a black sign-in page.

**Security contract — do not weaken these**

- `META_ADS_TOKEN` is read only inside `api/meta-insights.js` and never appears in a
  response body, header or error message. `scrubSecrets()` is a backstop on the two
  outbound message paths; keep it if you add more.
- Every request to `api/meta-insights.js` must pass `requireSession`. An unauthenticated
  request must be rejected BEFORE any call to Meta.
- Responses are `private, no-store`. This data is behind a login and must never enter
  Vercel's shared edge cache.
- The tests exist to hold this boundary. Run them after touching auth or the endpoint.

**Deliberate deviations from the site conventions**

- **No GA4 gtag snippet.** Every other page has one; an internal authenticated tool
  should not send page views into the marketing property.
- **No site nav links or footer.** Single-purpose internal page, same reasoning as the
  ad landing pages.
- **Chart.js loaded from cdnjs.** The first third-party JS library on the site. There is
  no bundler here, so a CDN build is the only practical option; Recharts and friends
  need React.
- **Uses `--warn-text` / `--good-text`.** The brand `--warn #e8b04a` and `--good #4dbf7a`
  sit at roughly 2:1 on white, which is fine for a chart fill but fails WCAG for text.
  The darker variants are used wherever the colour carries words. Keep both.
- **Adds `lib/` and `test/`.** New directories for this project.

**Accessibility is a requirement here, not decoration.** Every chart has a real `<table>`
alternative carrying the same numbers, series are distinguished by dash pattern and point
shape as well as colour, the status line is an `aria-live` region, and sortable headers are
`<button>`s inside `<th>` with `aria-sort`. Do not replace a table alternative with a
caption, and do not remove focus outlines.

**The "Over time" panel**

- X is always the globally selected date range and is not configurable — that was the
  explicit request. The range is the spine: Meta only returns rows for days that had
  delivery, so the response is mapped onto every date in the window rather than the
  axis being built from the response.
- A missing value is zero for a counter and a gap for a rate (`RATE_METRICS`). Meta omits
  an action type entirely from a day that scored none of it, so registrations must read 0,
  while CPC on a day with no clicks is undefined, not free.
- Y is a list of up to six metrics. Each gets its OWN scale, because spend in dollars and
  impressions in tens of thousands cannot share an axis without one becoming a flat line.
  Only the first two scales are drawn as labelled axes; past that the readout and the table
  carry the figures. If you make them share an axis you will get a chart that looks fine
  and says nothing.
- Each series chip draws that series' exact `stroke-dasharray`, so the chips ARE the
  legend. There is deliberately no separate legend strip.

**Where each account lands.** `VIEW_DEFAULTS` in `dashboard.html` names the campaign and ad
set each view opens on, and the global range defaults to **Lifetime**. It is the only default
that is never empty: Today is blank until the day's delivery starts, and a blank dashboard on
open reads as broken rather than as early.

- Defaults are written as **names, not ids**, and matched loosely: case and punctuation are
  ignored, but the words must appear IN ORDER. That is what picks "Dave - Ad Set 1 (Paid)"
  over "Dave - Ad Set 2 (Paid)" and "Dave - Ad Set 1 (Organic)". A set-based match would let
  the "1" in "Campaign 1" satisfy the "1" in "Ad Set 1" and quietly select the wrong one.
- A default that matches nothing falls back to **All campaigns**. Renaming a campaign in Ads
  Manager costs a default, not a working dashboard.
- They are applied **once per account**, on the first campaign load, guarded by `pristine`.
  A deliberate "All campaigns" must survive a tab switch, so the default is never re-applied
  over a real choice.

**Reach comes from its own request and is NEVER summed.** It counts PEOPLE, so adding up a
month of daily reach counts somebody reached on Monday again on Tuesday, and the total climbs
past impressions — arithmetically impossible, and entirely plausible-looking on a tile. Summing
the per-entity breakdown double-counts the same way, across ad sets instead of across days. Only
Meta can deduplicate, and only for the window it is asked about, so there is a fourth request:
same filters, same period, no `time_increment`, no level breakdown. That absence IS the
mechanism. Frequency is then impressions over reach, recomputed from the two figures on the tile
so it agrees with them. No row back means no delivery, which is a real zero rather than a fault.

**The impressions tile carries reach**: "Impressions / Reach", "41,200 / 30,100". The two are
the same delivery seen from either side, and the ratio between them is the frequency — read
from separate tiles that is a division someone has to do for themselves. Its `<dd>` takes
`.is-pair`, which shrinks the type: the KPI row is a fixed 5-wide grid and a tile that
outgrows its column drags the whole row out of alignment.

**The KPI row is ten raised cards.** Solid surface, solid border, an inset top highlight and a
shadow that deepens on hover with a 3px lift. An earlier version tied them into one dashed
lattice with a blueprint pattern behind each cell; that read as a table ruled onto the page, and
a figure someone checks every morning should sit on top of it. The layout inside each card is
unchanged: icon alone on its line, a deliberate gap, then label, then figure — the gap is what
stops a dense grid of numbers reading as a spreadsheet.

- **The inset highlight is load-bearing**, not decoration. `inset 0 1px 0 var(--hairline-2)` is
  what makes a flat rectangle read as a raised surface; a light top edge is how any real object
  catches a light. Without it the shadow alone reads as a drop shadow on a sticker.
- **One accent per card**, at the top edge, where it cannot compete with the figure. The icon
  takes the accent colour too now that nothing sits behind it.
- **The entrance animation runs once per row**, guarded by `data-entered`. Replaying it on
  every three-minute refresh would draw the eye to a change that did not happen.

**KPI tiles are a fixed 5x2 grid.** `KPI_KEYS` has exactly ten entries and the order is the
layout. Do not append a metric conditionally (ROAS used to be) — an eleventh tile leaves the
second row ragged. Extra metrics belong in the chart pickers and the table.

**Freshness**

- The page auto-refreshes every 3 minutes, timed from when data last arrived, skipped while
  the tab is hidden, and caught up on `visibilitychange`. The "Live" pill pauses it.
- `refreshAll()` MUST clear the client-side response cache first. That cache has no
  expiry and exists only to stop the three panels re-requesting the same range within one
  render pass; without the clear, auto-refresh re-serves the session's first response forever.
- `use_unified_attribution_setting=true` is sent on both data requests. Without it the
  API answers on a legacy default window instead of the ad set's configured setting, and
  returns fewer conversions than the same range in Ads Manager.
- `?debug=actions` (session-gated) returns every action type Meta returned with its
  totals, tallied per source. Use it before theorising about a missing conversion.
  Verified 2026-09-06: every registration alias — `complete_registration`,
  `omni_complete_registration`, `offsite_conversion.fb_pixel_complete_registration` —
  agreed at the same figure, so an apparent shortfall against Skool's own member count is
  attribution, not extraction. Do not "fix" it by widening `REGISTRATION_TYPES`: those
  aliases are the same conversions counted again, and summing them double-counts.

**The conversion metric is called Leads, and the event it counts is a property of the
ACCOUNT.** `VIEWS[view].conversion` names the family: `registration` for Dave, whose Skool
sign-up fires CompleteRegistration, and `lead` for Montara Forge, whose form fires Lead.
`REGISTRATION_TYPES` and `LEAD_TYPES` stay separate lists and are never merged.

- **Adding the lead aliases is what fixed Montara Forge reporting zero.** It was producing
  leads the whole time; the extractor only knew registration names.
- **DO NOT merge the two lists.** The first attempt did, and Dave's total went from 17 to 33.
  His account really does carry both — 17 `complete_registration` from Skool AND 16 `lead`
  left over from unrelated older lawyer campaigns. Extraction is per row and first-match, so
  the Skool rows resolved to registrations, the old rows resolved to leads, and the totals
  summed them into a single number that is two different conversions added together. That is
  precisely the "mixture of two different metrics" failure this file already warned about,
  reintroduced by trying to be accommodating. Naming the family per view is the fix.
- **The family is never selectable from the query string.** A caller that could pick it could
  relabel one account's conversions as another's. Tested.
- **The alias double-counting trap still applies within a family.** Montara Forge returns
  `lead`, `offsite_conversion.fb_pixel_lead`, `onsite_web_lead` and
  `offsite_lead_add_20_s_calls` all reading the SAME figure; summing them reports 8 from 2,
  and it looks entirely reasonable on the tile. First-match, never sum.
- **Order is the contract.** Pixel-specific names first, because they are the events an
  advertiser deliberately configured; the generic rollups are the fallback.
- **The KEYS are still `registrations` and `costPerRegistration`.** Only the labels changed.
  Those keys are in the flat `=META("…")` namespace the finance spreadsheet reads, where a
  rename turns a saved cell into `#NAME?` with nothing on screen to explain it. Renaming
  them is a migration, not an edit.

**KPI targets — researched per account, September 2026**

Live in `KPI_TARGETS` in `dashboard.html`. The two accounts run in different markets
under different rules, so a shared target would be wrong for both.

| Metric | Peps by Dave | Montara Forge |
|---|---|---|
| CTR | 3.00% | 1.80% |
| CPC | $0.50 | $1.80 |
| CPM | $40.00 | $18.00 |
| Cost / registration | $25.00 | $40.00 |
| Cost / LP view | $1.00 | $1.20 |

*Peps by Dave* — **set for a SALES campaign optimising on CompleteRegistration**, not the broad
traffic campaign these started as. Conversion optimisation changes everything: Meta stops buying
the cheapest reachable impression and starts buying people it thinks will register, so CPM rises
steeply and a high CPM is the price of intent rather than waste. The sales campaign runs near $43
CPM and produces every registration the account gets; the broad campaign sits at $9 CPM and
produces none. An earlier $2.00 CPM target, set against broad delivery, flagged a working
conversion campaign as failing. **Cost per registration is now the metric that matters; CPM is
context for it, not a goal.**

e-learning is the strongest vertical on Meta (2.74% CTR, $26.80 median CPA,
the only category whose CPM fell year over year). **But peptides sit in Meta's Health and
Wellness Special Ad Category**, which removes interest, behaviour and sub-15-mile geo
targeting. That forced-broad audience is why the account runs a ~$1.22 CPM against roughly
$12 for unrestricted e-learning, and why CTR sits near 0.7% rather than 2.7% — cheap
unfiltered reach that converts at a lower rate. Targets are set against what broad reach can
realistically do. **Do not "fix" the CTR target upward to the e-learning benchmark** without
first checking whether the account has left the Special Ad Category.

*Montara Forge* — home improvement CTR ~2.0%, construction CPM ~$20.55, home improvement CPC
~$2.45, concrete leads $30–60 with construction averaging $45. Utah CPCs run about 28% under
the US average, so click and impression targets are discounted and the lead target sits near
the low end of the concrete range.

**Direction matters.** `KPI_DIRECTION` marks each metric up or down. A cost metric is scored
inverted — being UNDER a CPC target is the win — so a cheap click is never reported as a
failure. Adding a metric without adding its direction leaves it unscored, which is the safe
default.

**Only rate and cost metrics are scored.** Spend, impressions, reach, clicks and conversion
counts scale with budget and date range, so no fixed target applies and they stay uncoloured.
The legend says so explicitly rather than leaving it to be inferred.

**Time granularity — hourly is the floor**

Meta's Insights API has no sub-hourly reporting. `time_increment` accepts 1–90 (days),
`monthly` or `all_days` — nothing below a day. Sub-daily exists only as the
`hourly_stats_aggregated_by_advertiser_time_zone` **breakdown**, which is what a single-day
range uses. There is no minute-level ad reporting to build on; do not go looking for one.

- Hourly is a breakdown, not a finer increment. `time_increment=1` over one day returns one
  row, not twenty-four, and the two cannot be combined.
- Today stops the axis at the hour in progress; a past day gets all 24. Truncating a completed
  day at the current clock hour hides almost all of it.
- The Today button sends `preset=today` so **Meta** resolves the day in the ad account's
  timezone. Computing it from the browser asks for the wrong day whenever the two differ, and
  returns an empty set that reads as a fault. Ads Manager reports on the same timezone, so the
  two agree by construction.
- Meta lags real time by up to about an hour, so an empty Today shortly after midnight is
  normal, not a bug.

**Lifetime is Meta's `date_preset=maximum`, not a start date we invent.** Guessing a start
means guessing wrong in one of two ways: too early and every chart carries months of empty
leading axis, too late and the account's first weeks silently vanish. Meta resolves it against
what the account actually has, capped at 37 months.

- The response therefore reports **`range` as what Meta resolved**, `requestedRange` as what
  was asked for, and `rangePreset` naming which preset was in play. For a preset the client
  builds its x-axis from `range`, not from its own arithmetic — otherwise the axis and the data
  sitting on it disagree.
- A lifetime range that comes back three days wide means the account is three days old. That is
  an answer, not a failure.
- `days` on a range is a NUMBER for the day presets and the STRING `'max'` for lifetime.
  `Number('max')` is `NaN`, which `|| 30` would silently turn into a 30-day window — so every
  path that reads it checks for `'max'` first.

**A missing timestamp prints nothing, not "Invalid Date".** An unparseable `fetchedAt` rendered
as "Invalid Date" reads as a fault in the data rather than in the clock.

**Known upstream caveats surfaced in the UI**

- Meta conversion values under-report for some date ranges and attribution keeps filling
  in for days. The results panel carries a standing note saying so.
- `action_attribution_windows` is deliberately NOT sent. The 7-day and 28-day view-through
  windows were removed from the API in January 2026; omitting the parameter uses the
  account default. If explicit windows are ever needed, use click-based windows plus
  `1d_view` only.
- If no pixel is reporting, the endpoint says so and labels the figures as a click proxy
  rather than silently showing clicks where sign-ups are implied.

---

## SOCIAL POSTING (/dashboard → Peps by Dave → Social post)

Upload a finished video, generate a caption per platform, post to all four at once.
Instagram, Facebook, YouTube Shorts, TikTok. **X is out of scope by decision** — posting
video there needs a paid API tier. Do not add it back without that being agreed.

| File | Role |
|---|---|
| `lib/social/platforms.js` | Registry: limits, hashtag ranges, required env vars, constraints. |
| `lib/social/adapters.js` | One publish function per platform. |
| `api/social-upload.js` | Issues the Blob client token. Web-standard handler, not (req,res). |
| `api/social-captions.js` | Anthropic call. The ONLY place ANTHROPIC_API_KEY is read. |
| `api/social-publish.js` | GET = status, POST = publish. |
| `test/social.test.mjs` | `node test/social.test.mjs` — no creds, no network. |

**This is why package.json now exists.** The static site still has no build step. The
dependency is `@vercel/blob`, needed because a finished video is far past the 4.5 MB
serverless request body limit, so the browser uploads straight to Blob. `"type": "module"`
is load-bearing: without it every existing ESM function silently becomes CommonJS.

**The browser half has no bundler.** `@vercel/blob/client` is imported from a pinned
esm.sh URL, lazily, the first time an upload starts. Keep the version pinned.

**Rules that are load-bearing, not preferences**

- Captions are written per platform, never one caption reshaped. That is the feature.
- Limits are re-checked server-side AND in the UI. The model is not trusted to have
  counted, and the count must include hashtags — they come out of the same budget on all
  four, so counting the caption alone reads as passing until the platform rejects it.
- Publishing is concurrent and independent. A video already live on Facebook cannot be
  un-posted because TikTok refused it, so **partial success is a real outcome** and each
  platform reports its own result. Never collapse that into one status line.
- An unconfigured platform fails the whole request BEFORE anything posts. Not starting is
  far easier to recover from than half-posting.
- `videoUrl` is restricted to our own Blob host. Accepting an arbitrary URL would turn
  the endpoint into a way to make the server fetch anything.

**Credentials — posting is a SEPARATE Meta app from ads**

App Review is per app and per permission, so an app awaiting review for
`pages_manage_posts` cannot disturb the ads dashboard, and a revoked posting token does
not take insights down. The env vars are deliberately independent of the ads ones.

| Platform | Variables |
|---|---|
| Instagram | `IG_USER_ID`, `IG_ACCESS_TOKEN` |
| Facebook | `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN` |
| YouTube | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` |
| Captions | `ANTHROPIC_API_KEY` |

Use `?debug=meta-assets` on `api/meta-insights` (master only) to discover Page and
Instagram ids and check which scopes a token actually holds.

**Known platform gates — surfaced in the UI, not worked around**

- **TikTok** restricts an unaudited app to **SELF_ONLY** posts — visible to the account holder
  and nobody else. Not drafts: they publish, they are just invisible. `publishTikTok` therefore
  calls `creator_info/query` FIRST and posts at the most public level in the
  `privacy_level_options` TikTok actually returns. **Never hardcode a privacy level** — an
  earlier version sent `PUBLIC_TO_EVERYONE` unconditionally, so the very first post any new
  integration made was rejected. Querying creator info is also a TikTok UX requirement, and it
  is where `comment_disabled` / `duet_disabled` / `stitch_disabled` come from; those are the
  creator's own settings and sending `false` over them is refused.
  The success message leads with the visibility, because "posted" for a video only the owner can
  see is the half-truth that costs weeks of waiting for engagement.
  PULL_FROM_URL also needs the hosting domain verified — a Blob URL is refused until
  `blob.vercel-storage.com` is verified or the file is served from a verified domain.
  TikTok access tokens expire every **24 hours**, so a failure here is usually staleness rather
  than a wrong value, and the error says so.

  **TikTok is connected by OAuth, not by a pasted token.** A 24-hour token cannot live in an
  environment variable — it would need replacing before most days were out — so
  `api/tiktok-auth.js` runs the Login Kit round trip and `lib/social/tiktok-auth.js` stores the
  pair encrypted, refreshing the access token in place. Refresh tokens last a year.

  - **Two credential sets, either sufficient.** `envAlt` on the registry entry is what says so:
    the app keys, or a `TIKTOK_ACCESS_TOKEN` pasted in whole. Requiring both would mean the
    OAuth path could never report itself configured; requiring only the token would mean the
    app keys never did.
  - **Configured is not connected**, and the pill says so. `needsAuth` marks a platform whose
    credentials being present proves nothing about an account being attached; the panel upgrades
    the pill to Connected only once `creator_info` answers. A pill reading Connected up until
    the first post fails is the failure mode this exists to prevent.
  - **The Connect button is a link, not a fetch.** OAuth is a full-page journey to TikTok and
    back; there is nothing for an XHR to do with a 302 to another origin.
  - **`/api/tiktok-auth` is session-gated and always was.** Pasting it into a fresh tab returns
    `unauthenticated` — correct behaviour, and the reason the flow has to start from a button
    inside the signed-in page.
  - **The redirect URI is pinned** by `TIKTOK_REDIRECT_URI`. It is otherwise derived from
    `x-forwarded-host`, so reaching the dashboard on a `*.vercel.app` host would send TikTok a
    redirect_uri that does not match the registered one, and the flow dies on a bare
    `invalid_request`. TikTok compares it byte for byte, twice — once for the code, once for
    the exchange — which is also why one endpoint serves both legs.
  - **The success leg redirects to `/dashboard?tiktok=connected`**, and the page opens
    that tab and strips the marker. The failure legs stay on their own page: a message that
    vanishes into a redirect is a message nobody reads.

  **The panel asks nothing — deliberately, and against TikTok's UX guidelines.** It was an
  audience selector, three interaction toggles and a commercial-disclosure block. It is now two
  lines of text: who is being posted to and at what visibility, then the required declaration.
  Only the caption box remains as an input. **This was an explicit product decision, taken
  knowing the cost** — TikTok's Content Sharing guidelines require the creator to pick the
  audience with no default, and a reviewer who sees no picker may reject the submission. If the
  app is rejected on UX grounds, this is the first thing to restore; the removed markup is one
  commit back.

  What did NOT change, and must not:

  - **The privacy level is still `mostPublicLevel(j.privacyOptions)`, never a hardcoded
    string.** "Locked to Everyone" is not implementable today: an unaudited app is offered only
    `SELF_ONLY`, so sending `PUBLIC_TO_EVERYONE` fails `validateTikTokOptions` and nothing
    posts. Reading TikTok's own list means the panel says SELF_ONLY now and resolves to Everyone
    by itself the day the audit lands — with no edit, and no window where it silently posts
    somewhere unintended.
  - **The interaction toggles track the account** (`allowComment = !j.commentDisabled`), rather
    than asserting `true`. A creator who has switched comments off in TikTok cannot have them
    switched back on from here; sending `true` over their own setting is refused by the API.
  - **The server-side check is untouched.** `validateTikTokOptions` still demands a privacy
    level that is actually in the allowed list. The client settling the value instead of asking
    for it does not make the backstop redundant — it is the only thing standing between a bad
    resolve and a rejected post.
  - **The visibility is stated in the panel**, leading the line, because "posted" for a video
    only the account holder can see is the half-truth that costs weeks of waiting on engagement
    that cannot arrive.
- **YouTube** forces uploads to private until the API project passes its audit, and an upload
  costs 1600 of the default 10,000 daily quota units, so about six uploads a day.

  **A video uploaded by an unaudited project is locked private PERMANENTLY.** Not until the
  audit — for good. There is no appeal, and YouTube Studio cannot change it; the only fix is
  re-uploading by hand. This is strictly worse than the TikTok gate, where the post survives and
  visibility lifts on approval. **Do not push real content through this pipeline before the
  audit passes** — every video spent that way is spent for nothing.

  The **YouTube Data API compliance audit is a THIRD approval**, distinct from both Google
  verifications and very easy to conflate with them:

  | Approval | What it lifts |
  |---|---|
  | OAuth branding verification | App name and logo on the consent screen. Cosmetic. Triggered by uploading a logo — remove the logo and the requirement disappears. |
  | OAuth sensitive-scope verification | The "Google hasn't verified this app" interstitial. |
  | **YouTube Data API audit** | **The permanent private lock. This is the one that matters.** |

  **YouTube is connected by OAuth too**, through `api/youtube-auth.js` and
  `lib/social/youtube-auth.js`, in the same shape as TikTok: app keys in the environment, the
  refresh token obtained by the round trip and stored encrypted, a **Connect YouTube** button in
  the Social post tab. `envAlt` keeps a hand-pasted `YOUTUBE_REFRESH_TOKEN` working.

  It exists for a different reason than TikTok's, and the difference matters:

  - **Google's refresh tokens do not expire on a clock — unless the OAuth app was in "Testing"
    when the token was minted, in which case they die after 7 DAYS.** The failure arrives as
    `invalid_grant`, whose raw description is "Bad Request", which sends people to check their
    client secret. `tokenRequest()` rewrites that one error to name the actual cause. Publishing
    status lives at **Google Auth Platform → Audience**, not under APIs & Services any more.
  - **`access_type=offline` AND `prompt=consent` are both required, and both fail silently.**
    Without the first, Google returns no refresh token at all. Without the second, it omits one
    on every authorisation after the first — so reconnecting to fix a problem stores a document
    with nothing to renew from, and the integration works for exactly one hour. Tested.
  - **A refresh response carries no `refresh_token`.** `shape()` takes the previous document
    so the existing one is carried forward; overwriting it with a null would break the *next*
    refresh rather than this one, which is the hardest kind of bug to trace back.
  - **An exchange that yields no refresh token is refused, never stored.** A document with an
    access token and no refresh token looks connected and works until the hour is up.
  - **Only `youtube.upload` is requested.** It is a SENSITIVE scope; the broader `youtube` and
    `youtube.force-ssl` are RESTRICTED and would pull in a security assessment for access this
    app never uses.
  - **The redirect URI is pinned** by `YOUTUBE_REDIRECT_URI` for the same reason TikTok's is,
    and must be registered on an OAuth client of type **Web application** — a Desktop client has
    no redirect-URI field at all, which is what produces "Access blocked: this app's request is
    invalid". That error reads like a verification wall and is not one.
- **Instagram** caps publishing at 25 per account per rolling day.
- **YouTube is the only platform we PUSH bytes to.** The other three fetch the URL
  themselves, which costs one small call regardless of file size. The YouTube adapter
  streams blob → function → Google without buffering, but a large file can still exceed
  the function time limit. That is the known weak point.

---

## FINANCES (/dashboard → Peps by Dave → Finances)

Cash flow for Dave's business: what is coming in against what is going out, this month.
Sits behind the same sub-tabs as Social post, so it is **Dave's view only** and hidden
entirely on Montara Forge.

| File | Role |
|---|---|
| `api/finance.js` | Reads Meta, projects the month, syncs and reads the sheet. |
| `lib/finance/config.js` | Fallback figures, the include filter, month/day arithmetic. |
| `lib/finance/sheets.js` | Google Sheets: JWT auth, read, write, first-run setup. |
| `test/finance.test.mjs` | `node test/finance.test.mjs` — no creds, no network. |

**Two kinds of figure, kept visibly apart.** Every row carries a `live` or `entered` tag.
That is not decoration — a stale number nobody can tell is stale is worse than a blank. Do
not remove the tags or merge the two kinds into one undifferentiated table.

### Ad spend = already spent + still to come

The month's cost has two halves and the page shows both, because the decision usually turns
on which half is moving:

- **Already spent** — real spend, per ad set, `date_preset=this_month`, so Meta resolves the
  month in the ad account's timezone exactly as Ads Manager does.
- **Still to come** — the daily budgets currently set, times the whole days left in the month.
  This is what makes a new ad set appear in the forecast the moment it is created, before it
  has delivered anything, and what makes editing a budget in Ads Manager move this page.

Today is deliberately excluded from "days left": month-to-date already covers the part of
today that has happened. The rest of today is a small, known understatement.

The day is read in the **ad account's timezone** (`todayIn()`), never the server's. Off by one
for most of every day is bad enough; on the 1st or the 31st it is the whole figure.

Things that are easy to get wrong here, all covered by tests:

- **Meta returns budgets in MINOR UNITS.** A `daily_budget` of `1000` is ten dollars. Reading
  it as whole currency overstates the costs a hundredfold and the page still looks entirely
  normal. `minorToMajor()` is the only place that conversion happens.
- **Campaign budget optimisation vs ad set budgets.** A CBO campaign holds the budget and its
  ad sets hold none, but Meta returns both objects. Summing both levels doubles the total, so
  a campaign with a budget short-circuits its ad sets and its ad sets' spend rolls up to it.
- **A lifetime budget is a total, not a monthly rate.** Listed and warned about, never
  projected across the days left.
- **Only ACTIVE entities project forward.** An active ad set under a paused campaign spends
  nothing. But **spend already incurred by a paused line still counts** — the money is gone
  whether or not it is configured to spend more.
- **Margin on zero revenue is `null`, not zero.** The UI renders it as an em dash.

### Recurring costs, cadence and who paid

`RECURRING_COSTS` holds the fixed monthly outgoings. Three today: Higgsfield
($99/mo), the Skool subscription ($99/mo, paid by Mouayed) and the domain
($24/yr, paid by JT). Monthly recurring is therefore **$200, not $222**.

**`cadence` is load-bearing now and was not before.** It sat on the cost shape
with nothing reading it, so every amount went straight into a monthly total. A
$24/yr domain entered that way adds $24 to ONE month rather than $2 — a figure
wrong by $22 that looks completely ordinary on the page. `monthlyAmount()` does
the conversion, and `normaliseCost()` is what the endpoint and the sheet seeder
both call.

- **The config states the REAL BILLED AMOUNT**, not a pre-divided one: `24` with
  `cadence: 'annual'`, never `2` with a comment explaining it. A figure someone
  can check against an invoice is worth more than one already in the right units.
- **`billedAmount` survives normalisation** and the detail line says
  "$24 billed annual", because $2 shown against a $24 receipt reads as a bug in
  the page rather than as a monthly share.
- **An unrecognised cadence falls back to monthly rather than being dropped.**
  Showing a cost in the wrong period is recoverable; silently omitting it from a
  cash flow is not.

**`paidBy` renders as a tag in the Detail column.** These costs come out of
different pockets, and a shared cash-flow page that cannot say whose money it
was is missing the one fact the page gets settled from. Omit it for anything the
business pays itself.

### The include filter

`AD_SPEND_INCLUDE` names which campaigns and ad sets count. Set it in the environment (one
pattern per line, or semicolon separated) or leave it unset to use the list in
`lib/finance/config.js`; an explicitly empty value means count everything.

Matching is loose on case and punctuation but the words must appear **IN ORDER**. That
ordering is what keeps `Dave Campaign 1 Ad Set 1` from also matching `… Ad Set - Paid` — a
set-based match would let the `1` from "Campaign 1" stand in for the missing one.

Two failure modes are handled rather than left to surprise someone:

- A filter that **matches nothing** is treated as a typo. Every line is shown and the warning
  lists the names Meta actually returned, so the fix is obvious. Obeying it would look
  identical to an account with no spend.
- An **excluded line that is still spending** is named in a warning with its figures. Silently
  dropping it would make this page disagree with the bill.

### The spreadsheet

The revenue and expense panel is a spreadsheet built here, not an embed. It is the
default view; a connected Google Sheet overrides it, and the computed table is the floor
if the ledger cannot load at all.

| File | Role |
|---|---|
| `assets/spreadsheet.js` | The engine: tokenizer, parser, evaluator, model, formats. |
| `api/finance-ledger.js` | GET/PUT the document, plus the seeded starting sheet. |
| `lib/finance/store.js` | Encrypted persistence in Vercel Blob. |
| `lib/blob-token.js` | Finding the Blob read-write token. Shared with the uploader. |
| `test/spreadsheet.test.mjs` | The engine. `node test/spreadsheet.test.mjs` |
| `test/ledger.test.mjs` | The endpoint and storage. `node test/ledger.test.mjs` |

**Scope is a ledger, not Excel.** Formulas, ranges, ~30 functions, number formats, undo,
copy/paste, insert/delete with reference rewriting, CSV export. **No** charts, pivot tables,
conditional formatting, real-time collaboration, revision history, data validation or merged
cells. Everyone knows what a spreadsheet does, so every gap is felt — adding features here
rather than admitting the gap is how a small honest tool becomes a large dishonest one.

**`assets/spreadsheet.js` is a classic script, not a module**, because this site has no
bundler. It is written so `test/spreadsheet.test.mjs` can EVALUATE the same file the browser
loads — there is one copy of the engine and the tests run the bytes that ship. Do not convert
it to ESM without changing how the test loads it.

**Computed values are never stored.** Only what someone typed is persisted, and every value on
screen is recalculated on load. There is no cache to invalidate, so a figure cannot be older
than the Meta data behind it — which is the same principle as the rest of this page.

**Recalculation is the whole sheet, every time.** At this size that is well under a
millisecond and it makes staleness structurally impossible. Cycles return `#CYCLE!` via a
visiting set rather than hanging. Do not add dependency-graph invalidation for speed here;
the correctness is worth more than the microseconds.

**Live figures are a function, not a paste.** `=META("adSpend.monthToDate")` reads the flat
namespace `metaNamespace()` in `api/finance.js` builds on every load. That namespace is a
public contract: **add keys freely, rename them never** — a rename silently turns somebody's
cell into `#NAME?`. The toolbar dropdown is generated from the real keys, so the figures are
discoverable without documenting them somewhere that can drift.

Things that are easy to get wrong, all covered by tests:

- **A range is not two independent references.** Deleting a line inside `=SUM(A1:D1)` must
  shrink it to `=SUM(A1:C1)`. Endpoint-by-endpoint rewriting turns that into `#REF!` whenever
  either end happens to be the deleted line. `deleteAxis()` moves the start when it is PAST the
  deleted line and the end when it is past OR ON it; that asymmetry is what shrinks rather than
  slides. Only a range whose every line is gone becomes `#REF!`.
- **Moving cells without rewriting formulas** leaves `=SUM(A1:A3)` pointing at the wrong rows.
  It still produces a number, just the wrong one, which is the worst kind of wrong.
- **`"$1,200.00"` pasted from a statement must become the NUMBER 1200**, formatted as currency.
  Stored as text it drops silently out of every SUM beneath it.
- **`&` binds looser than `+`.** `="Total: "&2+3` is `Total: 5`. Get the precedence table wrong
  and the error is invisible until someone reads a label.
- **A formula copied down moves its relative references and not its anchored ones.** That
  distinction is the only reason `$` exists.

**Closing an editor is a paint, not an edit.** `commitCell()` does nothing when the text is
unchanged; `endEdit()` used to skip its repaint on that path, which left the `<input>` sitting
in the cell — showing the formula instead of its value, with an outline that read as a selection
nothing could clear, one per cell ever opened that way. **Never make the repaint conditional on
the edit having happened.**

**A line selection is just a range.** Clicking a row or column header selects from one end to
the other, so colour, format, delete and copy all work on a whole line with no special case
anywhere. Headers light up only when their entire line is covered.

**Resize grips are absolutely positioned over the headers**, not children of them: a sticky
`<th>` clips its overflow, so a handle inside one is only half grabbable at the boundary that
matters. They are re-laid out on render, on scroll and on window resize, all from live
geometry. A drag writes the size live but records **one** undo entry, at the end — otherwise a
single drag buries the previous edit under sixty identical snapshots.

**Row heights and column widths are keyed by POSITION** — a row index, a column letter — so
every structural edit has to move them (`shiftSizes`). An edit that leaves them alone silently
reassigns every size below the change to the wrong line: not a crash, just a layout that stops
being the one that was laid out.

**Background tints are NAMES, not colours.** This page has a light palette and a near-black
one; a colour picked against either is often unreadable on the other. A name (`amber`,
`green`, `red`, `blue`, `purple`, `grey`) resolves to a translucent tint in the stylesheet,
so it reads on both grounds, cannot carry markup, and is trivial to validate server-side. Cell
borders (`thin`/`medium`/`thick`) use `outline` rather than `border` so a weight change never
moves anything and they compose with the selection's inset shadow. **`Sheet.TINTS` and
`Sheet.BORDERS` must match the classes in the stylesheet** — a name with no class is a silent
no-op that looks exactly like the click not registering.

**Every toolbar style is a toggle**, and the decision is made across the WHOLE selection
(`uniformStyle`), never per cell. Deciding per cell turns one click on a mixed selection into
a checkerboard — half the cells switching on while the other half switch off. So: if every
selected cell already has that fill, border or format, the click removes it; otherwise the
click applies it to all of them.

- The explicit **No fill** / **No border** controls at the end of each group always clear,
  whatever the current state. That is what makes them useful on a mixed selection, where no
  swatch is lit and there is nothing to "click again".
- `paintToolbarState()` lights the swatch, border and format that the selection actually has,
  and lights nothing when the selection is mixed. Without it a toggle is a guess — nothing on
  screen would say which colour is already on, so nobody would think to click it twice. It
  runs from `paintSelection()` rather than `syncFormulaBar()`, because Ctrl+A and Escape
  repaint the selection without going through the formula bar.

**`saveLedgerNow()` names every field it sends.** `version` and `updatedAt` are the server's
to set, so the payload is built explicitly rather than sending the document whole. Anything
that becomes part of the sheet must be added there too — omitting `rowHeights` once already
cost a round of resizing that silently did not save.

**A selection that has lost focus dims rather than disappearing.** It is still where you left
it, and it is visibly no longer taking your keystrokes.

**Storage is encrypted.** A Vercel Blob store is PUBLIC — every object is served at a URL with
no authentication in front of it — and this document is a business's revenue and costs. So
`lib/finance/store.js` encrypts with AES-256-GCM before writing and decrypts after reading. The
key is derived with HKDF from `DASHBOARD_SESSION_SECRET`, under a distinct salt so it can never
coincide with the cookie signing key. **Do not store this document in plaintext**, and do not
"simplify" the encryption away because Blob URLs look unguessable.

**Concurrent saves are refused, not merged.** A PUT carries `baseVersion`; a mismatch is a 409
that hands back the version that won. Last-write-wins would be fine for one person and silently
destructive for two, and the destroyed work is unrecoverable.

**A document from a browser is untrusted.** `sanitise()` checks every cell key against a
reference pattern, allows only known formats, and caps formula length, text length, cell count,
row and column counts and column widths. Unbounded input is how an internal tool becomes a way
to fill someone else's storage bill.

**`lib/finance/store.js` exposes `useBlobClient()`.** An ES module namespace is frozen, so a
test cannot swap `@vercel/blob`'s exports the way it can swap `globalThis.fetch`. The seam
exists so the half that can lose someone's work is testable. Nothing in production calls it.

**The grid states its own alignment and select width.** This page's base styles are written for
the metrics tables: `th, td { text-align:right }` and `select { width:100% }`. Both are right
there and wrong in a grid, so `.ss-cell` sets `text-align:left` and `.ss-bar select` sets
`width:auto`. Removing either re-breaks it.

### The Google Sheet

An ALTERNATIVE to the built-in grid above, used when it is configured: a real Google
spreadsheet, embedded and editable in place. Setting three environment variables is an explicit
choice to use it, so it wins when present. Two tabs, and the split is the whole contract:

- **`Entered`** — yours. Columns: Type (`Revenue`/`Expense`), Line, Monthly, Note. Created and
  seeded once, then never written to again. Rows are classified by the Type column rather than
  by position, so reordering rows cannot move a figure to the other side of the ledger.
- **`Live`** — the dashboard's. Cleared and rewritten on every sync; anything typed there is
  lost. Carries the spend figures and the per-line breakdown.

Setup is three environment variables: `FINANCE_SHEET_ID`, `GOOGLE_SHEETS_CLIENT_EMAIL`,
`GOOGLE_SHEETS_PRIVATE_KEY` (a service account with Editor access to the sheet). Both tabs are
created on first sync, so a blank spreadsheet is enough to start.

- **No SDK.** Minting the JWT is one `crypto.sign` call and the REST API is three endpoints —
  a smaller surface than a dependency to pin and audit. The access token is cached in module
  scope, keyed by the account email so a rotation cannot serve the old one.
- **A PEM pasted into a dashboard env var arrives with escaped newlines**, sometimes wrapped in
  quotes. `sheetsConfig()` handles both; without that, setup fails with an opaque OpenSSL
  decoder error that points nowhere.
- **GET reads, POST syncs.** Opening the page never writes to the sheet as a side effect of
  being looked at; pressing Refresh does what it says.
- **`src` is set once.** Reassigning it on every refresh would reload the iframe and discard
  whatever cell was being typed into.
- **The table is the fallback, not dead code.** If the sheet is unconfigured or unreachable the
  panel reverts to it and says which. A finance page showing nothing because a third party is
  down is worse than one showing the figures it already has, clearly labelled.

**Skool has no public API** — no REST, no webhooks, no analytics export. Stripe is the only
programmatic surface, via Skool's payment flow. Until that is wired, MRR is typed into the
sheet. Do not go looking for a Skool API; there isn't one.

**`buildRichTable()` exists because these rows carry markup** — source tags and signed,
coloured figures — which `buildTable()`'s `textContent` cannot express. Its cell strings are
built in the page, never from user input.

**The sticky time selector is pane-aware.** `#controls` lives inside the Performance pane, so
on any other pane its rect is all zeros, which reads as "scrolled past" and floats a date
picker over a page it does not drive. `evaluate()` therefore tests
`social.pane === 'performance'` first, and `showPane()` re-runs it — no scroll event fires on
a tab click.

---

---

## THE LEGAL PAGES AND THE TIKTOK SUBMISSION

`/terms` and `/privacy-policy` were marked do-not-modify. That no longer holds: both now carry a
**Social Media Publishing** section describing the posting tool, and **they are the URLs on the
TikTok app submission**. TikTok rejected a `*.vercel.app` hostname as not a real domain, and
sybago.ai is a domain the same legal entity owns — Sybago LLC operates Peps by Dave, so this is
the right company's policy rather than a convenient stand-in.

- Terms §9 and Privacy §6, both anchored `#social-publishing` so they can be linked directly.
- **If the tool changes what it stores or who it sends data to, these change with it.** A privacy
  policy describing last month's behaviour is worse than none, and this one is under review by a
  platform that can revoke posting access.
- The disclosure says the tool posts **only to accounts Sybago owns or operates** and is **not
  offered to anyone as a service**. That is true today. If it is ever pointed at a client's
  account that is a materially different claim — TikTok treats posting on behalf of third parties
  differently — and both documents must be rewritten before it happens.

**Sections are numbered in the heading text**, with no table of contents and no anchors on the
other headings. Inserting a section means renumbering every heading below it AND repairing the
cross-references in the prose — adding §9 to the terms silently broke "in accordance with
Section 13", which had pointed at Governing Law and afterwards pointed at Termination. Grep for
`Section [0-9]` after any insertion.

`peps-by-dave.vercel.app` still exists and is still Dave's public site. It simply is not what
TikTok is pointed at.

---

## WORKING RULES

- Match the existing design language exactly. Do not introduce a new component pattern,
  styling approach, or framework.
- Reuse existing classes before writing new CSS.
- After any change: verify no dead links (especially to `/pricing`), the GHL widget is present
  and uniquely IDed, and no page mentions the retired offer or any price.
