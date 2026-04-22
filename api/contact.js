// Handles submissions from /contact-us.
// Forwards to a GHL webhook if GHL_CONTACT_WEBHOOK is set in Vercel env vars.
// Otherwise just validates + returns 200 so the form doesn't error.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({error: 'Method not allowed'});
  }

  const body = req.body || {};
  const {firstName, lastName, email, phone, business, message, consentCare, consentMarketing} = body;

  if (!firstName || !email) {
    return res.status(400).json({error: 'First name and email are required.'});
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) {
    return res.status(400).json({error: 'Please provide a valid email address.'});
  }

  // If either SMS checkbox is checked, phone must be provided.
  if ((consentCare || consentMarketing) && !phone) {
    return res.status(400).json({error: 'Phone number is required if you opt in to SMS messages.'});
  }

  const payload = {
    firstName: String(firstName).trim().slice(0, 80),
    lastName: lastName ? String(lastName).trim().slice(0, 80) : '',
    email: String(email).trim().toLowerCase().slice(0, 160),
    phone: phone ? String(phone).trim().slice(0, 32) : '',
    business: business ? String(business).trim().slice(0, 160) : '',
    message: message ? String(message).trim().slice(0, 2000) : '',
    consent: {
      customerCare: Boolean(consentCare),
      marketing: Boolean(consentMarketing),
      timestamp: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
      userAgent: req.headers['user-agent'] || '',
    },
    source: 'sybago.ai/contact-us',
  };

  const webhook = process.env.GHL_CONTACT_WEBHOOK;
  if (webhook) {
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.error('Webhook forward failed:', resp.status, await resp.text().catch(() => ''));
      }
    } catch (err) {
      console.error('Webhook forward error:', err);
    }
  } else {
    console.log('contact form submission (no webhook configured):', payload);
  }

  return res.status(200).json({ok: true});
}
