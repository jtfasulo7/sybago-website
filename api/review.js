// Handles submissions from /leave-a-review.
// Forwards to GHL_REVIEW_WEBHOOK if set, otherwise logs and returns 200.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({error: 'Method not allowed'});
  }

  const body = req.body || {};
  const {name, email, rating, review} = body;

  if (!name || !rating || !review) {
    return res.status(400).json({error: 'Name, star rating, and review text are required.'});
  }

  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({error: 'Rating must be an integer between 1 and 5.'});
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({error: 'Please provide a valid email address.'});
  }

  const payload = {
    name: String(name).trim().slice(0, 120),
    email: email ? String(email).trim().toLowerCase().slice(0, 160) : '',
    rating: ratingNum,
    review: String(review).trim().slice(0, 4000),
    timestamp: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
    userAgent: req.headers['user-agent'] || '',
    source: 'sybago.ai/leave-a-review',
  };

  const webhook = process.env.GHL_REVIEW_WEBHOOK;
  if (webhook) {
    try {
      const resp = await fetch(webhook, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        console.error('Review webhook forward failed:', resp.status, await resp.text().catch(() => ''));
      }
    } catch (err) {
      console.error('Review webhook forward error:', err);
    }
  } else {
    console.log('review submission (no webhook configured):', payload);
  }

  return res.status(200).json({ok: true});
}
