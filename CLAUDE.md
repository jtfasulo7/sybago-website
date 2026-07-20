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

**Sybago fronts the Meta ad spend up front**, then bills it back to the client afterward
**at cost — never marked up.** The client isn't out of pocket to Meta to get started. The
separate system fee (building + running) is what Sybago actually earns on. Never state dollar
figures for ad budgets on the site.

> Note: because Sybago fronts and runs the spend, do **not** claim the ad account is "in the
> client's name" or that they "own the ad account." The client owns what matters and walks away
> with it — their page, domain, leads, and customer list. The old direct-pay copy ("you pay Meta
> directly," "ad account in your name") has been retired everywhere — `lp/junk-removal.html`,
> `index.html`, and `about.html`. Do not reintroduce it.

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
| `/privacy-policy` | `privacy-policy.html` | **Do not modify** |
| `/terms` | `terms.html` | **Do not modify** |

**FAQ lives inside `index.html` at `#faq`.** There is no separate FAQ page.

**`/pricing` was deleted.** `vercel.json` 308-redirects `/pricing`, `/pricing.html`,
`/services`, `/services.html` → `/`. Never link to it again.

### Ad landing pages — niche-specific, cold traffic

| Path | File |
|---|---|
| `/lp/junk-removal` (alias `/junk-removal`) | `lp/junk-removal.html` |

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

**Serverless functions:** `api/contact.js`, `api/lead.js`, `api/review.js`.

**Known placeholders in the footers** (main site): `tel:[PHONE]` and `href="#"` social links —
still unfilled, marked with HTML comments.

---

## WORKING RULES

- Match the existing design language exactly. Do not introduce a new component pattern,
  styling approach, or framework.
- Reuse existing classes before writing new CSS.
- After any change: verify no dead links (especially to `/pricing`), the GHL widget is present
  and uniquely IDed, and no page mentions the retired offer or any price.
