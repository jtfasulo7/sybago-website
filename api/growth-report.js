// Growth Intelligence — the weekly report, by email.
//
//   GET                -> { email }                   is delivery configured? (names only)
//   POST { to? }       -> { sent, to, text }          build last week's report and send it now
//   GET  ?cron=1       -> { ok }                      the Monday scheduled send (Vercel Cron)
//
// The report on screen is built in the browser and printed to PDF from there.
// This endpoint exists for the one thing the browser cannot do: send it when
// nobody has the page open. It therefore replays the member history ON THE
// SERVER, with the same engine file the page loads — there is one definition
// of every figure, not a second one that can drift.
//
// Delivery is optional and needs an outside account: RESEND_API_KEY, plus a
// verified sender in GROWTH_REPORT_FROM. Without them every figure is still
// produced; it just is not mailed.

import { requireSession, noStore } from '../lib/auth.js';
import { loadDb, loadMeta, loadAllImports, storeStatus } from '../lib/growth/store.js';
import { buildContext, weeklyReport, reportText, emptyDb } from '../assets/growth/engine.js';
import { isCron } from './growth-meta.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailConfig(env = process.env) {
  return {
    configured: !!String(env.RESEND_API_KEY || '').trim(),
    from: String(env.GROWTH_REPORT_FROM || '').trim() || 'Peps by Dave Reports <onboarding@resend.dev>',
    defaultTo: String(env.GROWTH_REPORT_TO || '').trim(),
    needs: ['RESEND_API_KEY', 'GROWTH_REPORT_FROM'],
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function reportHtml(rep) {
  const row = ([label, cur, prev, d]) =>
    `<tr><td style="padding:6px 12px 6px 0;border-bottom:1px solid #e6e2d6">${esc(label)}</td>` +
    `<td style="padding:6px 12px;border-bottom:1px solid #e6e2d6;text-align:right;font-weight:600">${esc(cur)}</td>` +
    `<td style="padding:6px 0 6px 12px;border-bottom:1px solid #e6e2d6;text-align:right;color:#5b6b62">${esc(prev)}${d == null ? '' : ` (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)`}</td></tr>`;
  const list = (items) => `<ul style="padding-left:18px;margin:8px 0">${items.map((i) => `<li style="margin:4px 0">${esc(i)}</li>`).join('')}</ul>`;
  return `<div style="font-family:Inter,Arial,sans-serif;color:#22302a;max-width:640px;line-height:1.5">
<h1 style="font-size:20px;color:#123B31;margin:0 0 4px">${esc(rep.title)}</h1>
<p style="margin:0 0 16px;color:#5b6b62">${esc(rep.range.from)} to ${esc(rep.range.to)}</p>
${rep.demo ? '<p style="background:#fdf3d7;padding:8px 12px;border-radius:6px"><b>Demonstration data — not real business data.</b></p>' : ''}
<table style="border-collapse:collapse;width:100%;font-size:14px"><tr><th></th><th style="text-align:right;padding:0 12px">This week</th><th style="text-align:right">Previous</th></tr>${rep.rows.map(row).join('')}</table>
<h2 style="font-size:15px;color:#123B31;margin:20px 0 4px">Advertising vs member growth</h2>${list(rep.insights.map((i) => `[${i.kind}] ${i.text}`))}
<h2 style="font-size:15px;color:#123B31;margin:20px 0 4px">Recommendations</h2>${list(rep.recommendations)}
${rep.quality.length ? `<h2 style="font-size:15px;color:#123B31;margin:20px 0 4px">Data quality</h2>${list(rep.quality.map((q) => q.message))}` : ''}
<p style="font-size:12px;color:#5b6b62;margin-top:20px">Membership figures cover the whole community and are compared with advertising; no member is attributed to a specific ad.</p>
</div>`;
}

async function send({ to, rep, cfg }) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: cfg.from, to: [to],
      subject: `${rep.demo ? '[DEMO] ' : ''}Peps by Dave — week of ${rep.range.from}`,
      text: reportText(rep), html: reportHtml(rep),
    }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    const key = String(process.env.RESEND_API_KEY || '');
    throw new Error(String(j.message || j.error || `The mail service answered HTTP ${resp.status}.`).split(key).join('[redacted]').slice(0, 300));
  }
}

export default async function handler(req, res) {
  noStore(res);

  const cron = req.method === 'GET' && req.query && req.query.cron && isCron(req);
  if (!cron) {
    if (req.method === 'GET' && req.query && req.query.cron) {
      return res.status(401).json({ error: 'unauthenticated', message: 'The scheduled report needs CRON_SECRET to be set on this deployment.' });
    }
    const session = requireSession(req, res);
    if (!session) return;
  }

  const cfg = emailConfig();
  if (req.method === 'GET' && !cron) {
    return res.status(200).json({ email: { configured: cfg.configured, from: cfg.from, defaultTo: cfg.defaultTo, needs: cfg.needs } });
  }
  if (req.method !== 'POST' && !cron) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!storeStatus().configured) return res.status(503).json({ error: 'store_unavailable', message: storeStatus().hint });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }

  try {
    const db = (await loadDb()) || emptyDb();
    const [imports, meta] = await Promise.all([loadAllImports(db), loadMeta().catch(() => null)]);
    const ctx = buildContext(db, imports, meta);
    const rep = weeklyReport(ctx);
    const text = reportText(rep);

    const to = (body && EMAIL_RE.test(String(body.to || '')) && String(body.to)) || ctx.settings.reportEmail || cfg.defaultTo;
    if (!cfg.configured || !to) {
      const reason = !cfg.configured
        ? 'Email delivery is not connected. Set RESEND_API_KEY (and a verified sender in GROWTH_REPORT_FROM) on this deployment.'
        : 'No recipient is set. Add a report email in Settings.';
      // A scheduled run with nowhere to send is a quiet no-op, not a failure
      // that pages somebody every Monday.
      if (cron) return res.status(200).json({ ok: true, sent: false, reason });
      return res.status(200).json({ sent: false, reason, text });
    }
    await send({ to, rep, cfg });
    return res.status(200).json(cron ? { ok: true, sent: true } : { sent: true, to, text });
  } catch (e) {
    return res.status(502).json({ error: 'report_failed', message: String(e.message || 'The report could not be sent.').slice(0, 300) });
  }
}
