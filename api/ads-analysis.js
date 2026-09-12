/**
 * AI analysis of the ads dashboard — two panels, cached.
 *
 *   GET  ?panel=kpi|trend&view=dave|sybago   read the cached analysis, if any
 *   POST { panel, view, payload }            generate a new one and cache it
 *
 * GET NEVER GENERATES. The client asks on load, and only calls POST when the
 * answer is null (first ever) or the reader pressed refresh. That keeps the
 * expensive, side-effecting operation on the verb that means it, and it is
 * what stops every page load from costing a model call.
 *
 * SECURITY
 *   - Session-gated before anything else, same as api/meta-insights.js.
 *   - ANTHROPIC_API_KEY is read here and never sent to the browser.
 *   - The cache is encrypted at rest via lib/secure-store, because Vercel Blob
 *     only offers public access and this is account performance data.
 *
 * The prompts are NOT in this file. They live in lib/analysis-prompts.js so
 * that tuning an analysis never means reading transport code.
 */
import { requireSession, noStore, ROLE_MASTER } from '../lib/auth.js';
import { loadJson, saveJson, storeStatus } from '../lib/secure-store.js';
import {
  ACCOUNTS,
  kpiSystemPrompt,
  trendSystemPrompt,
  kpiUserMessage,
  trendUserMessage,
} from '../lib/analysis-prompts.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/* Sonnet is the right tier here: the diagnostic framework needs real reasoning
   across a dozen interacting numbers, which Haiku flattens, and Opus costs
   several times more for a judgement Sonnet already makes correctly. */
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const PANELS = new Set(['kpi', 'trend']);

/* Montara Forge is master-only, exactly as in api/meta-insights.js. Repeated
   rather than imported because an access rule that lives in one place and is
   assumed in another is how a view leaks. */
const VIEW_ROLES = { dave: null, sybago: ROLE_MASTER };

/** Where one analysis lives. Per view and panel — both roles that can see an
 *  account see the same numbers, so a per-person cache would just pay for the
 *  same answer twice. */
const cachePath = (view, panel) => `ads-analysis/${view}-${panel}.json`;

/* ------------------------------------------------------------- sanitising */

/** Strings reaching the prompt are capped and stripped of control characters. */
function clean(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => (DATE_RE.test(String(v || '')) ? String(v) : null);

/**
 * The snapshot, rebuilt field by field from what the client sent.
 *
 * The browser is the source here because the analysis must describe the
 * numbers ON SCREEN — re-fetching server-side risks analysing a different
 * window than the reader is looking at. It is still rebuilt rather than passed
 * through: every value is coerced, every string capped, and nothing unknown
 * survives into the prompt.
 */
function buildKpiPayload(body) {
  const t = body.totals && typeof body.totals === 'object' ? body.totals : {};
  const keys = [
    'spend', 'impressions', 'reach', 'frequency', 'clicks', 'linkClicks',
    'ctr', 'cpc', 'cpm', 'registrations', 'costPerRegistration',
    'landingPageViews', 'costPerLandingPageView',
  ];
  const totals = {};
  for (const k of keys) totals[k] = num(t[k]);

  /* The per-ad rows exist for one reason: the kill-threshold check is about a
     SINGLE ad passing its spend limit with nothing to show, which an account
     total can never reveal. Capped at 25 so a large account cannot inflate the
     request without limit. */
  const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 25).map((r) => ({
    name: clean(r.name, 120),
    level: clean(r.level, 20),
    spend: num(r.spend),
    impressions: num(r.impressions),
    linkClicks: num(r.linkClicks),
    ctr: num(r.ctr),
    registrations: num(r.registrations),
    costPerRegistration: num(r.costPerRegistration),
    landingPageViews: num(r.landingPageViews),
  }));

  return {
    range: {
      since: date(body.range && body.range.since) || 'unknown',
      until: date(body.range && body.range.until) || 'unknown',
    },
    scope: clean(body.scope, 200),
    totals,
    rows,
  };
}

/**
 * The daily series, as { kpi: [{date, value}, ...] }.
 *
 * Last 14 days, or everything when there is less — a longer window costs
 * tokens without changing a fatigue or saturation reading, both of which play
 * out inside two weeks.
 */
function buildTrendPayload(body) {
  const daily = (Array.isArray(body.daily) ? body.daily : [])
    .filter((d) => date(d && d.date))
    .slice(-14);

  const keys = [
    'spend', 'impressions', 'reach', 'frequency', 'linkClicks',
    'ctr', 'cpc', 'cpm', 'registrations', 'costPerRegistration', 'landingPageViews',
  ];

  const series = {};
  for (const k of keys) {
    const points = daily
      .map((d) => ({ date: date(d.date), value: num(d[k]) }))
      .filter((p) => p.value !== null);
    // A metric with nothing in it is noise in the prompt, not information.
    if (points.length) series[k] = points;
  }

  return {
    range: {
      since: date(body.range && body.range.since) || (daily[0] && daily[0].date) || 'unknown',
      until: date(body.range && body.range.until) || (daily[daily.length - 1] && daily[daily.length - 1].date) || 'unknown',
    },
    scope: clean(body.scope, 200),
    days: daily.length,
    series,
  };
}

/* --------------------------------------------------------------- the model */

/** The model answers in JSON. Parsed defensively — a fence or stray prose
 *  around it is a formatting slip, not a reason to show the reader an error. */
function parseAnalysis(text) {
  let raw = String(text || '').trim();

  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in the response');

  const parsed = JSON.parse(raw.slice(start, end + 1));

  const verdicts = new Set(['positive', 'concerning', 'mixed']);
  const levels = new Set(['critical', 'warning', 'positive']);

  const flag = parsed.flag && typeof parsed.flag === 'object' && clean(parsed.flag.text, 400)
    ? {
        level: levels.has(parsed.flag.level) ? parsed.flag.level : 'warning',
        text: clean(parsed.flag.text, 400),
      }
    : null;

  const out = {
    verdict: verdicts.has(parsed.verdict) ? parsed.verdict : 'mixed',
    headline: clean(parsed.headline, 400),
    // Paragraph breaks survive; everything else is collapsed.
    finding: String(parsed.finding || '')
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 3000),
    recommendation: String(parsed.recommendation || '')
      .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 1500),
    flag,
  };

  if (!out.headline && !out.finding) throw new Error('the response had no analysis in it');
  return out;
}

/** Never let a key fragment reach the browser in an error string. */
function scrub(message) {
  const key = process.env.ANTHROPIC_API_KEY;
  let out = String(message || '');
  if (key && key.length > 8) out = out.split(key).join('[redacted]');
  return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
}

async function generate({ panel, account, payload, key }) {
  const system = panel === 'kpi' ? kpiSystemPrompt(account) : trendSystemPrompt(account);
  const user = panel === 'kpi' ? kpiUserMessage(payload) : trendUserMessage(payload);

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1400,
      // The framework is long and identical on every call for an account, so
      // it is the system prompt rather than part of the message.
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const detail = json?.error?.message || `HTTP ${resp.status}`;
    const err = new Error(scrub(detail));
    err.status = resp.status;
    throw err;
  }

  const text = (json.content || []).map((c) => c.text || '').join('');
  return parseAnalysis(text);
}

/* ------------------------------------------------------------------ handler */

export default async function handler(req, res) {
  noStore(res);

  const session = requireSession(req, res);
  if (!session) return;                     // requireSession has already answered

  const view = String(req.query.view || (req.body && req.body.view) || 'dave');
  const panel = String(req.query.panel || (req.body && req.body.panel) || '');

  if (!PANELS.has(panel)) {
    return res.status(400).json({ error: 'bad_panel', message: 'panel must be "kpi" or "trend".' });
  }
  if (!Object.prototype.hasOwnProperty.call(ACCOUNTS, view)) {
    return res.status(400).json({ error: 'bad_view', message: 'Unknown view.' });
  }

  /* The server decides what this session may read. A view is a request, never
     an instruction — the same rule the insights endpoint follows. */
  const required = VIEW_ROLES[view];
  if (required && session.role !== required) {
    return res.status(403).json({ error: 'forbidden_view', message: 'This account is not available on your login.' });
  }

  const account = ACCOUNTS[view];
  const path = cachePath(view, panel);
  const canCache = storeStatus().configured;

  /* ---------------------------------------------------------------- GET -- */
  if (req.method === 'GET') {
    if (!canCache) {
      // Nothing stored anywhere, so every load is a first load. Said plainly
      // rather than pretending an empty cache.
      return res.status(200).json({ analysis: null, cached: false, storageConfigured: false });
    }
    try {
      const doc = await loadJson(path, 'ads-analysis');
      return res.status(200).json({
        analysis: doc ? doc.analysis : null,
        generatedAt: doc ? doc.generatedAt : null,
        model: doc ? doc.model : null,
        cached: !!doc,
        storageConfigured: true,
        provisionalContext: account.provisional,
      });
    } catch (e) {
      // A cache that cannot be read is not an error the reader can act on.
      // Report empty; the client will generate.
      return res.status(200).json({ analysis: null, cached: false, storageConfigured: true });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  /* --------------------------------------------------------------- POST -- */
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message:
        'ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel → Settings → ' +
        'Environment Variables, then redeploy.',
    });
  }

  const body = req.body || {};
  const payload = panel === 'kpi' ? buildKpiPayload(body) : buildTrendPayload(body);

  // Nothing to analyse is not a model call. Saying so costs nothing and
  // reading a confident diagnosis of an empty account costs trust.
  const empty = panel === 'kpi'
    ? !payload.totals.impressions
    : payload.days === 0;
  if (empty) {
    return res.status(200).json({
      analysis: {
        verdict: 'mixed',
        headline: 'Not enough delivery in this range to analyse.',
        finding: 'Meta reported no impressions for the selected window and scope, so there is nothing to diagnose yet.',
        recommendation: 'Widen the date range, or clear the ad set filter, and refresh this panel.',
        flag: null,
      },
      generatedAt: new Date().toISOString(),
      model: null,
      cached: false,
      skipped: 'no_data',
    });
  }

  try {
    const analysis = await generate({ panel, account, payload, key });
    const generatedAt = new Date().toISOString();

    if (canCache) {
      // A cache write that fails must not lose the analysis that was just paid
      // for — it is returned either way.
      try {
        await saveJson(path, { analysis, generatedAt, model: MODEL }, 'ads-analysis');
      } catch (e) {
        /* ignored on purpose */
      }
    }

    return res.status(200).json({
      analysis,
      generatedAt,
      model: MODEL,
      cached: false,
      storageConfigured: canCache,
      provisionalContext: account.provisional,
    });
  } catch (e) {
    const status = e.status || 502;
    if (status === 401) {
      return res.status(401).json({
        error: 'anthropic_unauthorized',
        message: 'The Anthropic API rejected the key. Check ANTHROPIC_API_KEY is current and complete.',
      });
    }
    if (status === 429) {
      return res.status(429).json({
        error: 'anthropic_rate_limited',
        message: 'The Anthropic API is rate limiting this key. Wait a moment and try again.',
      });
    }
    /* The cached analysis is deliberately left untouched — an error must never
       overwrite a good answer the reader already had. */
    return res.status(502).json({ error: 'analysis_failed', message: scrub(e.message) });
  }
}
