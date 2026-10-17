// /book qualification-form handler.
// Validates the submission, applies spam checks, and forwards the lead to the
// GHL inbound webhook in GHL_WEBHOOK_URL. The URL never reaches the browser.
// Qualification is decided by the ROUTING config in book.html; this route only
// checks that what it receives is well-formed. Every lead (qualified or not)
// is forwarded, so GHL holds the full record.
//
// Response contract (the page relies on it):
//   200 { ok: true }                 → forwarded (or silently dropped as spam)
//   400 { ok: false, error }         → invalid input; message is user-facing
//   500/502 { ok: false, error }     → not configured / GHL unreachable; retry

// Keep these lists identical to the answer text in book.html. GHL receives the
// human-readable text, so any drift would show up as a new value in the CRM.
const ANSWERS = {
  work_type: [
    'Mostly residential (driveways, patios, walkways)',
    'Mix of residential and commercial',
    'Mostly commercial or new construction',
  ],
  monthly_revenue: ['Under $20k', '$20k–$50k', '$50k–$100k', '$100k+'],
  capacity: ["None, we're booked out", '1–3', '4–8', '9+'],
  lead_source: [
    'Referrals and word of mouth',
    'Angi, HomeAdvisor, or Thumbtack',
    'My own ads (Facebook or Google)',
    'Nothing consistent',
  ],
  timeline: ['As soon as possible', 'In the next 30 days', 'Just looking into options'],
};

const TRACKING_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'];

// Nobody answers five questions and types a name and phone number this fast.
const MIN_FORM_MS = 4000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // Spam: honeypot filled, or submitted impossibly fast. Pretend success so
  // bots get no signal, but log it so real leads caught by mistake are visible.
  const elapsed = Number(body.form_ms);
  if (body.company_website || !Number.isFinite(elapsed) || elapsed < MIN_FORM_MS) {
    console.warn('book-lead: dropped as spam', {
      honeypot: Boolean(body.company_website),
      form_ms: body.form_ms,
    });
    return res.status(200).json({ ok: true });
  }

  const first_name = clean(body.first_name, 80);
  const last_name = clean(body.last_name, 80);
  if (!first_name) return bad(res, 'Please enter your first name.');
  if (!last_name) return bad(res, 'Please enter your last name.');

  const phone = normalizeUSPhone(body.phone);
  if (!phone) return bad(res, 'Please enter a valid US phone number.');

  for (const [field, allowed] of Object.entries(ANSWERS)) {
    if (!allowed.includes(body[field])) {
      return bad(res, 'One of your answers was missing. Please go back and pick an option.');
    }
  }

  if (body.sms_consent !== true) {
    return bad(res, 'Please check the box so we can contact you.');
  }
  const consent_text = clean(body.consent_text, 600);
  if (!consent_text) return bad(res, 'Please check the box so we can contact you.');

  if (typeof body.qualified !== 'boolean') return bad(res, 'Invalid submission.');
  const disqualify_reasons = Array.isArray(body.disqualify_reasons)
    ? body.disqualify_reasons.filter((r) => typeof r === 'string').map((r) => clean(r, 200)).slice(0, 10)
    : [];

  const webhook = process.env.GHL_WEBHOOK_URL;
  if (!webhook) {
    console.error('book-lead: GHL_WEBHOOK_URL env var not set');
    return res.status(500).json({ ok: false, error: 'Something went wrong on our end. Please try again shortly.' });
  }

  const payload = {
    first_name,
    last_name,
    phone,
    work_type: body.work_type,
    monthly_revenue: body.monthly_revenue,
    capacity: body.capacity,
    lead_source: body.lead_source,
    timeline: body.timeline,
    qualified: body.qualified,
    disqualify_reasons,
    sms_consent: true,
    consent_text,
    submitted_at: new Date().toISOString(),
    ...Object.fromEntries(TRACKING_FIELDS.map((f) => [f, clean(body[f], 300)])),
    page_url: clean(body.page_url, 1000),
  };

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      // Log the full lead so it can be recovered from the Vercel logs.
      console.error('book-lead: GHL webhook failed', resp.status, detail.slice(0, 500), JSON.stringify(payload));
      return res.status(502).json({ ok: false, error: "We couldn't send that just now. Please try again." });
    }
  } catch (err) {
    console.error('book-lead: GHL webhook error', err, JSON.stringify(payload));
    return res.status(502).json({ ok: false, error: "We couldn't send that just now. Please try again." });
  }

  return res.status(200).json({ ok: true });
}

function bad(res, error) {
  return res.status(400).json({ ok: false, error });
}

// Strip control characters, collapse whitespace, cap length.
function clean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeUSPhone(input) {
  if (typeof input !== 'string') return null;
  let core = input.replace(/\D/g, '');
  if (core.length === 11 && core[0] === '1') core = core.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(core)) return null;
  return '+1' + core;
}
