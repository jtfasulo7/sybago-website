// Growth Intelligence — the stored Meta advertising history.
//
//   GET                  -> { meta, configured }     read what is stored. Never calls Meta.
//   POST { full? }       -> { meta }                 sync now, then store
//   GET  ?cron=1         -> { ok }                   the daily scheduled sync (Vercel Cron)
//
// GET READS, POST SYNCS — the same split as the rest of this dashboard. Opening
// the page costs nothing at Meta; pressing "Sync now" does what it says.
//
// The scheduled run is authenticated by CRON_SECRET, which Vercel sends as a
// bearer token when the variable is set. Without the variable there is no way
// to tell Vercel's scheduler from anybody else, so the cron path refuses.

import { requireSession, noStore, safeEqual } from '../lib/auth.js';
import { loadMeta, saveMeta, storeStatus } from '../lib/growth/store.js';
import { syncMeta } from '../lib/growth/meta-sync.js';
import { resolveAccount, resolveToken, scrubSecrets } from './meta-insights.js';

export function isCron(req, env = process.env) {
  const secret = String(env.CRON_SECRET || '');
  const header = String((req.headers && req.headers.authorization) || '');
  return secret.length >= 8 && header.startsWith('Bearer ') && safeEqual(header.slice(7), secret);
}

function connection() {
  const account = resolveAccount('dave');
  const token = resolveToken('dave');
  return { configured: !!(account.id && token.value), tokenSource: token.envName, accountSource: account.envName };
}

export default async function handler(req, res) {
  noStore(res);

  const cron = req.method === 'GET' && req.query && req.query.cron && isCron(req);
  if (!cron) {
    if (req.method === 'GET' && req.query && req.query.cron) {
      return res.status(401).json({ error: 'unauthenticated', message: 'The scheduled sync needs CRON_SECRET to be set on this deployment.' });
    }
    const session = requireSession(req, res);
    if (!session) return;                    // rejected BEFORE any call to Meta
  }

  const store = storeStatus();
  const conn = connection();

  if (req.method === 'GET' && !cron) {
    if (!store.configured) return res.status(200).json({ meta: null, store, ...conn });
    try {
      return res.status(200).json({ meta: await loadMeta(), store, ...conn });
    } catch (e) {
      return res.status(502).json({ error: 'store_error', message: e.message, store, ...conn });
    }
  }

  if (req.method !== 'POST' && !cron) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!store.configured) return res.status(503).json({ error: 'store_unavailable', message: store.hint, store, ...conn });
  if (!conn.configured) {
    return res.status(500).json({
      error: 'meta_unconfigured',
      message: `Meta is not connected. Set ${conn.tokenSource} and ${conn.accountSource} on this deployment.`,
      ...conn,
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }

  try {
    const stored = await loadMeta().catch(() => null);
    const meta = await syncMeta(stored, { full: !!(body && body.full), trigger: cron ? 'scheduled' : 'manual' });
    await saveMeta(meta);
    if (cron) return res.status(200).json({ ok: true, syncedAt: meta.syncedAt, rows: meta.daily.length });
    return res.status(200).json({ meta, store, ...conn });
  } catch (e) {
    // A failed sync leaves the stored history exactly as it was.
    return res.status(e.http || 502).json({
      error: e.error || e.code || 'sync_failed',
      message: scrubSecrets(e.message || 'The Meta sync failed.'),
      ...conn,
    });
  }
}
