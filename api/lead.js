// Sybago lead-capture form handler.
// Validates input, normalizes phone to E.164 US, forwards to a GHL inbound
// webhook. All routing/tagging/SMS logic lives in the GHL workflow that
// owns GHL_LEAD_WEBHOOK — this route is intentionally dumb.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  if (body.company_website) {
    return res.status(200).json({ ok: true });
  }

  const firstName = typeof body.firstName === 'string' ? body.firstName.trim() : '';
  const lastName = typeof body.lastName === 'string' ? body.lastName.trim() : '';
  const phoneRaw = typeof body.phone === 'string' ? body.phone.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';

  if (!firstName) return res.status(400).json({ error: 'First name is required.' });
  if (!lastName) return res.status(400).json({ error: 'Last name is required.' });
  if (!phoneRaw) return res.status(400).json({ error: 'Phone number is required.' });
  if (!message) return res.status(400).json({ error: 'Message is required.' });

  const phone = normalizeUSPhone(phoneRaw);
  if (!phone) {
    return res.status(400).json({ error: 'Please provide a valid US phone number.' });
  }

  const webhook = process.env.GHL_LEAD_WEBHOOK;
  if (!webhook) {
    console.error('GHL_LEAD_WEBHOOK env var not set');
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  const payload = {
    firstName: firstName.slice(0, 80),
    lastName: lastName.slice(0, 80),
    phone,
    message: message.slice(0, 2000),
    source: typeof body.source === 'string' ? body.source.slice(0, 200) : 'sybago.ai/widget',
  };

  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('GHL webhook failed:', resp.status, detail.slice(0, 500));
      return res.status(502).json({ error: 'Could not reach the lead system. Please try again.' });
    }
  } catch (err) {
    console.error('GHL webhook error:', err);
    return res.status(502).json({ error: 'Could not reach the lead system. Please try again.' });
  }

  return res.status(200).json({ ok: true });
}

function normalizeUSPhone(input) {
  const digits = String(input).replace(/\D/g, '');
  let core = digits;
  if (core.length === 11 && core[0] === '1') core = core.slice(1);
  if (core.length !== 10) return null;
  if (core[0] === '0' || core[0] === '1') return null;
  return '+1' + core;
}
