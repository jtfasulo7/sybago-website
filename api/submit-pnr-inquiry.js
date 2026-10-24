// /pnr estimate-form handler — P&R General Contractors (Houston), a Sybago client.
// Isolated from every other route on this site: nothing here is shared with
// /book or the dashboard.
//
//   POST → validates the lead and forwards it to the GHL inbound webhook in
//          PNR_GHL_WEBHOOK_URL. The URL never reaches the browser.
//
// Mirrors montara-forge/app/api/submit-lead/route.ts:
//   200 { ok: true, captured: true }   → in GHL
//   200 { ok: true, captured: false }  → request fine, lead NOT in GHL (webhook
//                                        unset or failing). The page shows the
//                                        "call us" thank-you instead of
//                                        promising a callback. Full lead logged.
//   400 { ok: false, error }           → invalid input
//
// Option values must match pnr/index.html. The webhook gets readable labels.

const LABELS = {
  projectType: {
    'driveway-replacement': 'Driveway Replacement',
    'new-driveway': 'New Driveway',
    patio: 'Patio',
    sidewalk: 'Sidewalk',
    'pool-deck': 'Pool Deck',
    'foundation-slab': 'Foundation / Slab',
  },
  newOrReplacement: {
    new: 'New pour (no tear-out)',
    replacement: 'Replacing existing (tear-out required)',
  },
  sizeRange: {
    small: 'Small — under ~400 sq ft',
    medium: 'Medium — ~400–1,000 sq ft',
    large: 'Large — over ~1,000 sq ft',
    'not-sure': 'Not sure',
  },
  timeline: {
    asap: 'ASAP',
    'within-month': 'Within a month',
    '1-3-months': '1–3 months',
    pricing: 'Just getting prices',
  },
};

// Project types that answer new-vs-replacement themselves; the form skips the
// question for these, so the server fills it in the same way.
const IMPLIED = { 'driveway-replacement': 'replacement', 'new-driveway': 'new' };

const CHANNELS = new Set(['meta-paid', 'meta-organic', 'search', 'referral', 'direct', 'unknown']);
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];

// The exact text beside the checkbox, recorded as proof of SMS consent.
// Must match CONSENT_HTML in pnr/index.html.
const CONSENT_TEXT =
  'By checking this box, I agree to receive text messages from P&R General Contractors about my estimate request, including appointment confirmations, reminders, and follow-up about my project. Consent is not a condition of purchase. Message frequency varies. Message & data rates may apply. Reply STOP to opt out or HELP for help. See our Privacy Policy & SMS Terms.';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) return bad(res, 'Invalid body');

  // Honeypot: bots fill every field. Pretend success, log it, do nothing.
  if (clean(body.website, 200)) {
    console.warn('submit-pnr-inquiry: honeypot filled — dropped as spam');
    return res.status(200).json({ ok: true, captured: true });
  }

  const v = validate(body);
  if (!v.ok) return bad(res, v.error);
  const d = v.data;

  const payload = buildPayload(d);
  const webhook = (process.env.PNR_GHL_WEBHOOK_URL || '').trim();
  if (!webhook) {
    // Deliberately still a 200: the page must deploy and work before GHL is set up.
    console.error('submit-pnr-inquiry: PNR_GHL_WEBHOOK_URL not set — lead NOT forwarded:', JSON.stringify(payload));
    return res.status(200).json({ ok: true, captured: false, firstName: d.firstName });
  }

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      // The whole lead goes in the log so it can be recovered by hand.
      console.error('submit-pnr-inquiry: GHL webhook failed', resp.status, detail.slice(0, 500), JSON.stringify(payload));
      return res.status(200).json({ ok: true, captured: false, firstName: d.firstName });
    }
  } catch (err) {
    console.error('submit-pnr-inquiry: GHL webhook error', err, JSON.stringify(payload));
    return res.status(200).json({ ok: true, captured: false, firstName: d.firstName });
  }

  console.log('submit-pnr-inquiry: forwarded', JSON.stringify({ project: d.projectType, channel: payload.lead_channel, first_name: d.firstName }));
  return res.status(200).json({ ok: true, captured: true, firstName: d.firstName });
}

function validate(b) {
  const firstName = clean(b.firstName, 60);
  const lastName = clean(b.lastName, 60);
  const phone = toE164(clean(b.phone, 30));
  const emailRaw = clean(b.email, 120).toLowerCase();
  const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : '';
  const location = clean(b.location, 200);

  if (!firstName) return { ok: false, error: 'First name is required' };
  if (!lastName) return { ok: false, error: 'Last name is required' };
  if (!phone) return { ok: false, error: 'A valid US phone number is required' };
  if (!(b.projectType in LABELS.projectType)) return { ok: false, error: 'Invalid project type' };
  const newOrReplacement = IMPLIED[b.projectType] || b.newOrReplacement;
  if (!(newOrReplacement in LABELS.newOrReplacement)) return { ok: false, error: 'Invalid new/replacement value' };
  if (!(b.sizeRange in LABELS.sizeRange)) return { ok: false, error: 'Invalid size range' };
  if (!(b.timeline in LABELS.timeline)) return { ok: false, error: 'Invalid timeline' };
  if (!location) return { ok: false, error: 'Location is required' };
  if (b.consent !== true) return { ok: false, error: 'SMS consent is required' };

  return {
    ok: true,
    data: {
      firstName, lastName, phone, email, location,
      projectType: b.projectType,
      newOrReplacement,
      sizeRange: b.sizeRange,
      timeline: b.timeline,
      inServiceArea: b.inServiceArea === true,
      attribution: validateAttribution(b.attribution),
    },
  };
}

/** Cleaned attribution. Every field optional and every failure silent: it annotates a lead and must never reject one. */
function validateAttribution(v) {
  const a = v && typeof v === 'object' ? v : {};
  const utmIn = a.utm && typeof a.utm === 'object' ? a.utm : {};
  const utm = {};
  for (const k of UTM_KEYS) utm[k] = clean(utmIn[k], 200);
  const channel = clean(a.channel, 20);
  return {
    channel: CHANNELS.has(channel) ? channel : 'unknown',
    fbclid: clean(a.fbclid, 300) ? 'present' : '',
    utm,
    referrer: clean(a.referrer, 500),
    landingPath: clean(a.landingPath, 200),
    firstSeen: clean(a.firstSeen, 40),
  };
}

/** Flat on purpose: GHL's inbound-webhook trigger maps top-level keys most easily. */
function buildPayload(d) {
  const L = {
    projectType: LABELS.projectType[d.projectType],
    newOrReplacement: LABELS.newOrReplacement[d.newOrReplacement],
    sizeRange: LABELS.sizeRange[d.sizeRange],
    timeline: LABELS.timeline[d.timeline],
  };
  const location = d.location + (d.inServiceArea ? '' : ' (not a listed city — confirm)');
  return {
    first_name: d.firstName,
    last_name: d.lastName,
    full_name: `${d.firstName} ${d.lastName}`,
    phone: d.phone,
    email: d.email,
    project_type: L.projectType,
    new_or_replacement: L.newOrReplacement,
    size_range: L.sizeRange,
    timeline: L.timeline,
    location: d.location,
    in_service_area: d.inServiceArea,
    estimate_summary: [
      `PROJECT: ${L.projectType}`,
      `TEAR-OUT: ${d.newOrReplacement === 'replacement' ? 'Yes (replacing existing)' : 'No (new pour)'}`,
      `SIZE: ${L.sizeRange}`,
      `TIMELINE: ${L.timeline}`,
      `LOCATION: ${location}`,
    ].join(' | '),
    sms_consent: true,
    consent_text: CONSENT_TEXT,
    lead_channel: d.attribution.channel,
    fbclid: d.attribution.fbclid,
    ...d.attribution.utm,
    referrer: d.attribution.referrer,
    landing_path: d.attribution.landingPath,
    first_seen: d.attribution.firstSeen,
    source: 'P&R landing page (sybago.ai/pnr)',
    submitted_at: new Date().toISOString(),
  };
}

function bad(res, error) {
  console.warn('submit-pnr-inquiry: rejected', error);
  return res.status(400).json({ ok: false, error });
}

// Strip control characters, collapse whitespace, cap length.
function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toE164(input) {
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? '+1' + d : null;
}
